import { readFileSync, appendFileSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const dir = dirname(fileURLToPath(import.meta.url))
const config = JSON.parse(readFileSync(join(dir, '..', 'bridge', 'config.json'), 'utf8'))
const logPath = join(dir, 'generator.log')
const DRY = process.argv.includes('--dry-run')

const log = (...args) => {
  const line = `${new Date().toISOString()} ${args.join(' ')}`
  console.log(line)
  appendFileSync(logPath, line + '\n')
}

const headers = {
  Authorization: `Bearer ${config.aiApiKey}`,
  'Content-Type': 'application/json',
}

async function api(path, body) {
  const retryable = path !== '/ai/drafts'
  let lastErr
  for (let attempt = 1; attempt <= (retryable ? 3 : 1); attempt++) {
    try {
      const res = await fetch(config.workerUrl + path, {
        method: body ? 'POST' : 'GET',
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(120000),
      })
      if (!res.ok) throw new Error(`${path} HTTP ${res.status}`)
      return await res.json()
    } catch (err) {
      lastErr = err
      if (attempt < 3 && retryable) {
        log(`retry ${path} (attempt ${attempt}): ${err.message}`)
        await new Promise((r) => setTimeout(r, 3000 * attempt))
      }
    }
  }
  throw lastErr
}

const MSK_OFFSET_H = 3
const ARTICLE_SLOT = [16, 0] // МСК, длинная статья для Дзена
const NEWS_SLOTS = [[12, 0], [19, 5]] // МСК, короткие новости
const HORIZON_DAYS = 2
const BUFFER_CAP = 30

const dow = new Date().getDay()
const WEEKEND_FILL = dow === 5 || dow === 6 || dow === 0
const daysToMonday = dow === 5 ? 3 : dow === 6 ? 2 : 1
const NEWS_HORIZON = WEEKEND_FILL ? daysToMonday + 1 : HORIZON_DAYS

function freeSlots(busyIso, slotDefs, max, horizon = HORIZON_DAYS) {
  const busy = new Set(busyIso.map((s) => new Date(s).toISOString().slice(0, 16)))
  const slots = []
  const now = new Date()
  const day = new Date()
  day.setUTCHours(0, 0, 0, 0)
  for (let d = 0; d < horizon; d++) {
    for (const [h, m] of slotDefs) {
      const slot = new Date(day)
      slot.setUTCHours(h - MSK_OFFSET_H, m, 0, 0)
      if (slot > now && !busy.has(slot.toISOString().slice(0, 16))) slots.push(slot.toISOString())
    }
    day.setUTCDate(day.getUTCDate() + 1)
  }
  return slots.slice(0, max)
}

async function runQwen(prompt) {
  let lastErr
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await runQwenOnce(prompt)
    } catch (err) {
      lastErr = err
      if (attempt === 1) log(`qwen сбой (${err.message.slice(0, 120)}), повторная попытка...`)
    }
  }
  throw lastErr
}

function runQwenOnce(prompt) {
  return new Promise((resolve, reject) => {
    const args = [
      '-p',
      '--permission-mode', 'bypass_permissions',
      '--no-session-persistence',
      '--tools', 'WebFetch', 'Read', 'Glob', 'Grep',
      '--', prompt,
    ]
    const child = spawn(config.qwenPath, args, { cwd: config.cwd, windowsHide: true })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('qwen timeout (10 min)'))
    }, 600000)
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', (err) => { clearTimeout(timer); reject(err) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) reject(new Error(`qwen exit ${code}: ${stderr.slice(-400)}`))
      else resolve(stdout.trim())
    })
  })
}

function parseDrafts(output) {
  const start = output.indexOf('{')
  const end = output.lastIndexOf('}')
  if (start === -1 || end === -1) throw new Error('no JSON in qwen output')
  const data = JSON.parse(output.slice(start, end + 1))
  if (!Array.isArray(data.drafts)) throw new Error('drafts array missing')
  return data.drafts.filter((d) => typeof d.body === 'string' && d.body.trim().length > 50)
}

const NEWS_CHANNELS = ['centralbank_russia', 'rbc_news', 'ai_newz', 'aipost', 'hiaimediaen']
const NEWS_DAYS = 2

const CTA_PRODUCTS = `Продукты автора для приписки в конце поста:
- ИГРА «ИнвестИгра» — бесплатный симулятор финансовой грамотности: проживи жизнь инвестора и выйди из крысиных бегов (пассивный доход не меньше расходов) до 60 лет. Ссылка: https://mywaygame.netlify.app/
- КНИГИ Дмитрия Савченко на Литрес:
  • «Деньги, время и первый капитал» — про старт с нуля и первый капитал. https://www.litres.ru/74722082/
  • «Куда вложить 100–300 тысяч рублей» — практические кейсы инвестирования небольшой суммы. https://www.litres.ru/74748789/
  • «Не повторяй за мной. 10 денежных ошибок обычной семьи» — разбор денежных ошибок обычной семьи. https://www.litres.ru/74727923/`

const ctaStatePath = join(dir, 'cta-state.json')
function nextCtaTypes(count) {
  let last = 'books'
  try { last = JSON.parse(readFileSync(ctaStatePath, 'utf8')).last || 'books' } catch {}
  const types = []
  let cur = last
  for (let i = 0; i < count; i++) {
    cur = cur === 'game' ? 'books' : 'game'
    types.push(cur)
  }
  return types
}

function runNewsFetch() {
  return new Promise((resolve, reject) => {
    const outPath = join(dir, 'news-raw.txt')
    const script = join(dir, '..', 'news_fetch.py')
    const args = [script, outPath, String(NEWS_DAYS), ...NEWS_CHANNELS]
    const child = spawn('python', args, { cwd: dir, windowsHide: true })
    let stderr = ''
    const timer = setTimeout(() => { child.kill(); reject(new Error('news_fetch timeout (120s)')) }, 120000)
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', (err) => { clearTimeout(timer); reject(err) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) reject(new Error(`news_fetch exit ${code}: ${stderr.slice(-300)}`))
      else resolve(outPath)
    })
  })
}

function runRssFetch(outPath) {
  return new Promise((resolve, reject) => {
    const script = join(dir, '..', 'news_fetch_rss.py')
    const args = [script, outPath, String(NEWS_DAYS)]
    const child = spawn('python', args, { cwd: dir, windowsHide: true })
    let stderr = ''
    const timer = setTimeout(() => { child.kill(); reject(new Error('news_fetch_rss timeout (120s)')) }, 120000)
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', (err) => { clearTimeout(timer); reject(err) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) reject(new Error(`news_fetch_rss exit ${code}: ${stderr.slice(-300)}`))
      else resolve()
    })
  })
}

async function coveredTopics() {
  try {
    const { posts } = await api('/ai/recent?days=14')
    return posts.map((p) => {
      const first = (p.snippet || '').split('\n').find((l) => l.trim()) || ''
      return `- #${p.id} (${p.type}): ${first.replace(/^#+\s*/, '').slice(0, 120)}`
    }).join('\n')
  } catch {
    return ''
  }
}

function buildPrompt(newsPath, count, ctaTypes, covered) {
  const example = Array.from({ length: count }, (_, i) =>
    `{"body":"текст поста ${i + 1}","source_url":"https://t.me/...","image_prompt":"scene description"}`).join(',')
  const ctaPlan = ctaTypes.map((t, i) =>
    `Пост ${i + 1}: приписка про ${t === 'game' ? 'ИГРУ «ИнвестИгра»' : 'КНИГИ (выбери книгу, ближайшую к теме поста)'}`).join('\n')
  return `Ты — автор Telegram-канала о личных финансах «Мой путь к Финансовой Свободе». Стиль: коротко, по делу, без воды, умеренные эмодзи, практическая польза для читателя.

Задача:
1. Через Read прочитай файл свежих постов: ${newsPath}. В нём посты Telegram-каналов и официальных AI-блогов (OpenAI, Google AI, DeepMind, Meta). Каждый пост — дата и ссылка (t.me или статья блога), затем текст; у Telegram-постов указаны просмотры.
2. Выбери ${count} РАЗНЫЕ свежие новости (за последние 1-2 дня), важные для читателя: личные финансы, экономика, вклады, кредиты, ипотека, налоги, пенсии; допускаются технологии и ИИ, если они влияют на деньги или работу. Предпочитай заметные новости с высокими просмотрами. Английские новости переводи на русский. НЕ выбирай темы, уже освещённые в списке в конце промта, и не пиши похожие посты.
3. Напиши по каждой пост на 400-600 символов своими словами: суть новости + что это значит для читателя. Не копируй текст источника. Без заголовков-кликбейта, без HTML.
4. В конце каждого поста отдельным абзацем добавь приписку — 1-2 предложения: логичный вывод из темы поста, который естественно подводит к продукту автора, и ссылку на него. Это полезный переход, а не рекламный лозунг. Для книги укажи её название и ссылку. Распределение приписок:
${ctaPlan}
5. Для каждой новости укажи source_url — ссылку на выбранный пост из файла (t.me или статья блога).
6. Для каждого поста составь image_prompt — краткую выжимку сути поста как визуальную сцену на английском (1-2 предложения, без названий и брендов). Пример: "a glass piggy bank full of coins on a conveyor belt between two bank buildings, paperwork and rubber stamps".
7. Верни ТОЛЬКО JSON без пояснений и без markdown-ограждений, ровно ${count} элементов в drafts (приписка входит в body):
{"drafts":[${example}]}

Уже освещённые темы за последние 2 недели — НЕ повторяй их и не пиши похожие посты:
${covered || '(пока нет)'}

${CTA_PRODUCTS}`
}

function parseArticle(output) {
  const start = output.indexOf('{')
  const end = output.lastIndexOf('}')
  if (start === -1 || end === -1) throw new Error('no JSON in article output')
  const data = JSON.parse(output.slice(start, end + 1))
  if (typeof data.body !== 'string' || data.body.trim().length < 500) throw new Error('article body missing or too short')
  return data
}

function buildArticlePrompt(newsPath, covered) {
  return `Ты — автор канала о личных финансах «Мой путь к Финансовой Свободе». Напиши длинную статью для Дзена на основе свежих новостей.

1. Через Read прочитай файл свежих постов: ${newsPath} (Telegram-каналы и AI-блоги; дата, ссылка, текст).
2. Выбери ОДНУ заметную свежую тему (личные финансы, экономика, инвестиции, технологии/ИИ, влияющие на деньги) и раскрой её глубоко. Тема ОБЯЗАТЕЛЬНО должна отличаться от уже освещённых в списке в конце промта — не пиши статью на ту же или похожую тему.
3. Напиши статью на 3500-3900 знаков, по-русски, своими словами, БЕЗ выдумок — только факты из файла. Английские новости переводи.
4. Структура (markdown): заголовок (# ...), лид-абзац (1-2 предложения — суть и интрига), 2-3 подзаголовка (## ...) с раскрытием темы, финальный вывод.
5. Финальный вывод свяжи с инвестированием или бизнес-мышлением: как эта новость отразится на рынке и деньгах читателя, что делать.
6. В конце статьи блок «Ссылки»: источник новости + 1-2 уместных по теме материала автора (игра или книги из списка ниже).
7. Составь image_prompt — визуальная сцена по теме на английском (1-2 предложения, без брендов и текста).
8. Верни ТОЛЬКО JSON без пояснений и без markdown-ограждений:
{"body":"полный текст статьи со структурой","source_url":"ссылка на источник из файла","image_prompt":"scene description"}

Уже освещённые темы за последние 2 недели — выбери ДРУГУЮ тему, не пиши на эти и похожие:
${covered || '(пока нет)'}

${CTA_PRODUCTS}`
}

function buildFactCheckPrompt(newsPath, article) {
  return `Ты — редактор-фактчекер. Проверь статью на актуальность, фактические ошибки и выдуманную информацию.

1. Через Read прочитай файл исходных данных: ${newsPath}.
2. Статья (JSON): ${JSON.stringify(article)}
3. Сверь факты статьи с исходными данными. Исправь ошибки, убери выдуманные факты, цифры и утверждения, которых нет в источниках. Сохрани структуру (заголовок, лид, ## подзаголовки, вывод), объём 3500-3900 знаков и ссылки в конце.
4. Верни ТОЛЬКО исправленный JSON без пояснений и без markdown-ограждений:
{"body":"...","source_url":"...","image_prompt":"..."}`
}

export async function generateArticle(newsPath, covered) {
  const draft = parseArticle(await runQwen(buildArticlePrompt(newsPath, covered)))
  return parseArticle(await runQwen(buildFactCheckPrompt(newsPath, draft)))
}

async function insertDrafts(payload, slots) {
  try {
    return await api('/ai/drafts', { drafts: payload })
  } catch (err) {
    log(`drafts insert response lost (${err.message}); verifying via schedule`)
    const { posts } = await api('/ai/schedule')
    const slotTimes = slots.slice(0, payload.length).map((s) => new Date(s).getTime())
    const mine = posts.filter(
      (p) => p.status === 'draft' && slotTimes.includes(new Date(p.scheduled_at).getTime()),
    )
    if (mine.length === 0) throw err
    return { inserted: mine.length, ids: mine.map((p) => Number(p.id)) }
  }
}

function describeFailure(err) {
  const m = (err && err.message) || String(err)
  if (/news_fetch exit 2/i.test(m)) return { network: true, cause: 'проблема с сетью — не удалось связаться с Telegram-каналами' }
  if (/fetch failed|ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(m)) return { network: true, cause: 'проблема с сетью — нет связи с воркером' }
  if (/qwen/i.test(m)) return { network: false, cause: `сбой Qwen при генерации текста, 2 попытки не удались (${m.slice(0, 150)})` }
  if (/источники ответили/i.test(m)) return { network: false, cause: 'источники ответили, но свежих постов за последние 2 дня нет' }
  return { network: false, cause: m.slice(0, 200) }
}

function scheduleRetry() {
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(dir, 'schedule-retry.ps1')], { windowsHide: true })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.on('error', () => resolve(''))
    child.on('close', () => resolve(out.trim()))
  })
}

function cancelRetry() {
  const child = spawn('schtasks', ['/Delete', '/TN', 'MyWayDraftGeneratorRetry', '/F'], { windowsHide: true })
  child.on('error', () => {})
}

async function main() {
  const { posts } = await api('/ai/schedule')
  if (!DRY) cancelRetry()
  if (!DRY && posts.length >= BUFFER_CAP) {
    log(`buffer full (${posts.length}/${BUFFER_CAP} future posts) - skipping generation`)
    return false
  }
  const busy = posts.map((p) => p.scheduled_at)
  const artSlots = freeSlots(busy, [ARTICLE_SLOT], 1, 4)
  const nSlots = freeSlots(busy, NEWS_SLOTS, 2, NEWS_HORIZON)
  if (artSlots.length === 0 && nSlots.length === 0) {
    log('ближайшие слоты заполнены - пропускаю генерацию')
    return false
  }
  if (WEEKEND_FILL) log('режим выходных: заполняю слоты до понедельника включительно')
  log(`article slots: ${artSlots.join(', ') || '-'}; news slots: ${nSlots.join(', ') || '-'}`)

  const newsPath = await runNewsFetch()
  try {
    await runRssFetch(newsPath)
  } catch (err) {
    log(`RSS fetch failed (continuing with Telegram only): ${err.message}`)
  }
  const collected = (readFileSync(newsPath, 'utf8').match(/^=== /gm) || []).length
  log(`collected ${collected} posts (${NEWS_CHANNELS.length} TG channels + AI blog RSS)`)
  if (collected === 0) throw new Error('источники ответили, но свежих постов за последние 2 дня нет')

  const covered = await coveredTopics()
  const payload = []
  const slots = []

  if (artSlots.length) {
    log('generating article (write + fact-check)...')
    const art = await generateArticle(newsPath, covered)
    const source = typeof art.source_url === 'string' && /^https?:\/\//.test(art.source_url) ? art.source_url : null
    const scene = typeof art.image_prompt === 'string' && art.image_prompt.trim() ? art.image_prompt.trim() : art.body.slice(0, 200)
    payload.push({ type: 'article', body: art.body, source_url: source, image_prompt: scene, scheduled_at: artSlots[0] })
    slots.push(artSlots[0])
  }

  let ctaTypes = []
  let newsCount = 0
  if (nSlots.length) {
    ctaTypes = nextCtaTypes(nSlots.length)
    const drafts = parseDrafts(await runQwen(buildPrompt(newsPath, nSlots.length, ctaTypes, covered)))
    if (drafts.length === 0 && !payload.length) throw new Error('no valid drafts generated')
    drafts.slice(0, nSlots.length).forEach((d, i) => {
      const source = typeof d.source_url === 'string' && /^https?:\/\//.test(d.source_url) ? d.source_url : null
      const body = source && !d.body.includes(source) ? `${d.body}\n\nИсточник: ${source}` : d.body
      const scene = typeof d.image_prompt === 'string' && d.image_prompt.trim() ? d.image_prompt.trim() : d.body.slice(0, 200)
      payload.push({ type: 'news', body, source_url: source, image_prompt: scene, scheduled_at: nSlots[i] })
      slots.push(nSlots[i])
      newsCount++
    })
  }

  if (DRY) {
    log('DRY RUN — черновики не вставляются:')
    console.log(JSON.stringify(payload, null, 2))
    return true
  }

  const result = await insertDrafts(payload, slots)
  log(`inserted ${result.inserted} drafts: ids ${result.ids.join(', ')}`)
  if (newsCount > 0) writeFileSync(ctaStatePath, JSON.stringify({ last: ctaTypes[newsCount - 1] }))

  const lines = ['📝 Новые черновики готовы:']
  result.ids.forEach((id, i) => {
    const when = new Date(new Date(slots[i]).getTime() + MSK_OFFSET_H * 3600000).toISOString().slice(0, 16).replace('T', ' ') + ' МСК'
    const kind = payload[i].type === 'article' ? '📄 статья (Дзен)' : '📝 новость'
    const preview = payload[i].body.slice(0, 150).replace(/\n/g, ' ')
    lines.push(`\n#${id} ${kind} → ${when}\n${preview}…\nОдобрить: /approve ${id}`)
  })
  await api('/ai/notify', { text: lines.join('\n') })
  log('admin notified')
  return true
}

async function run() {
  const maxCycles = WEEKEND_FILL && !DRY ? 5 : 1
  for (let cycle = 1; cycle <= maxCycles; cycle++) {
    if (cycle > 1) log(`режим выходных: цикл ${cycle}`)
    const generated = await main()
    if (!generated) break
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch(async (err) => {
    const { network, cause } = describeFailure(err)
    log(`ERROR: ${cause}`)
    let nextStep
    if (network) {
      const res = await scheduleRetry()
      const at = res.match(/retry at (.+)/)
      nextStep = at
        ? `Повтор через 3 часа: ${at[1]}. Если ПК будет выключен — попытка пройдёт при ближайшем включении.`
        : 'Сегодня уже поздно для повтора — следующая попытка завтра в 08:00.'
    } else {
      nextStep = 'Черновики не созданы. Можно запустить генератор вручную или попросить меня в боте.'
    }
    await api('/ai/notify', { text: `⚠️ Генератор черновиков не сработал.\nПричина: ${cause}.\n${nextStep}` }).catch(() => {})
    process.exit(1)
  })
}
