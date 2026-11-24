import { readFileSync, appendFileSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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

const DAY_SLOTS = [[9, 0], [13, 0], [16, 5]]
const NEWS_HORIZON_DAYS = 2
const MAX_NEWS_PER_RUN = 3
const BUFFER_CAP = 30

function newsSlots(busyIso) {
  const busy = new Set(busyIso.map((s) => new Date(s).toISOString().slice(0, 16)))
  const slots = []
  const now = new Date()
  const day = new Date()
  day.setUTCHours(0, 0, 0, 0)
  for (let d = 0; d < NEWS_HORIZON_DAYS; d++) {
    for (const [h, m] of DAY_SLOTS) {
      const slot = new Date(day)
      slot.setUTCHours(h, m, 0, 0)
      if (slot > now && !busy.has(slot.toISOString().slice(0, 16))) slots.push(slot.toISOString())
    }
    day.setUTCDate(day.getUTCDate() + 1)
  }
  return slots.slice(0, MAX_NEWS_PER_RUN)
}

function runQwen(prompt) {
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

function buildPrompt(newsPath, count, ctaTypes) {
  const example = Array.from({ length: count }, (_, i) =>
    `{"body":"текст поста ${i + 1}","source_url":"https://t.me/...","image_prompt":"scene description"}`).join(',')
  const ctaPlan = ctaTypes.map((t, i) =>
    `Пост ${i + 1}: приписка про ${t === 'game' ? 'ИГРУ «ИнвестИгра»' : 'КНИГИ (выбери книгу, ближайшую к теме поста)'}`).join('\n')
  return `Ты — автор Telegram-канала о личных финансах «Мой путь к Финансовой Свободе». Стиль: коротко, по делу, без воды, умеренные эмодзи, практическая польза для читателя.

Задача:
1. Через Read прочитай файл свежих постов: ${newsPath}. В нём посты Telegram-каналов и официальных AI-блогов (OpenAI, Google AI, DeepMind, Meta). Каждый пост — дата и ссылка (t.me или статья блога), затем текст; у Telegram-постов указаны просмотры.
2. Выбери ${count} РАЗНЫЕ свежие новости (за последние 1-2 дня), важные для читателя: личные финансы, экономика, вклады, кредиты, ипотека, налоги, пенсии; допускаются технологии и ИИ, если они влияют на деньги или работу. Предпочитай заметные новости с высокими просмотрами. Английские новости переводи на русский.
3. Напиши по каждой пост на 400-600 символов своими словами: суть новости + что это значит для читателя. Не копируй текст источника. Без заголовков-кликбейта, без HTML.
4. В конце каждого поста отдельным абзацем добавь приписку — 1-2 предложения: логичный вывод из темы поста, который естественно подводит к продукту автора, и ссылку на него. Это полезный переход, а не рекламный лозунг. Для книги укажи её название и ссылку. Распределение приписок:
${ctaPlan}
5. Для каждой новости укажи source_url — ссылку на выбранный пост из файла (t.me или статья блога).
6. Для каждого поста составь image_prompt — краткую выжимку сути поста как визуальную сцену на английском (1-2 предложения, без названий и брендов). Пример: "a glass piggy bank full of coins on a conveyor belt between two bank buildings, paperwork and rubber stamps".
7. Верни ТОЛЬКО JSON без пояснений и без markdown-ограждений, ровно ${count} элементов в drafts (приписка входит в body):
{"drafts":[${example}]}

${CTA_PRODUCTS}`
}

async function main() {
  const { posts } = await api('/ai/schedule')
  if (!DRY && posts.length >= BUFFER_CAP) {
    log(`buffer full (${posts.length}/${BUFFER_CAP} future posts) - skipping generation`)
    return
  }
  const slots = newsSlots(posts.map((p) => p.scheduled_at))
  if (slots.length === 0) {
    log('ближайшие новостные слоты заполнены - пропускаю генерацию')
    return
  }
  log(`generating ${slots.length} news drafts for slots: ${slots.join(', ')}`)

  const newsPath = await runNewsFetch()
  try {
    await runRssFetch(newsPath)
  } catch (err) {
    log(`RSS fetch failed (continuing with Telegram only): ${err.message}`)
  }
  const collected = (readFileSync(newsPath, 'utf8').match(/^=== /gm) || []).length
  log(`collected ${collected} posts (${NEWS_CHANNELS.length} TG channels + AI blog RSS)`)
  if (collected === 0) throw new Error('источники не дали свежих постов за последние 2 дня')

  const ctaTypes = nextCtaTypes(slots.length)
  const output = await runQwen(buildPrompt(newsPath, slots.length, ctaTypes))
  const drafts = parseDrafts(output)
  if (drafts.length === 0) throw new Error('no valid drafts generated')

  const payload = drafts.slice(0, slots.length).map((d, i) => {
    const source = typeof d.source_url === 'string' && /^https?:\/\//.test(d.source_url) ? d.source_url : null
    const body = source && !d.body.includes(source) ? `${d.body}\n\nИсточник: ${source}` : d.body
    const scene = typeof d.image_prompt === 'string' && d.image_prompt.trim()
      ? d.image_prompt.trim()
      : d.body.slice(0, 200)
    return { type: 'news', body, source_url: source, image_prompt: scene, scheduled_at: slots[i] }
  })
  if (DRY) {
    log('DRY RUN — черновики не вставляются:')
    console.log(JSON.stringify(payload, null, 2))
    return
  }
  let result
  try {
    result = await api('/ai/drafts', { drafts: payload })
  } catch (err) {
    log(`drafts insert response lost (${err.message}); verifying via schedule`)
    const { posts } = await api('/ai/schedule')
    const slotTimes = slots.slice(0, payload.length).map((s) => new Date(s).getTime())
    const mine = posts.filter(
      (p) => p.status === 'draft' && slotTimes.includes(new Date(p.scheduled_at).getTime()),
    )
    if (mine.length === 0) throw err
    result = { inserted: mine.length, ids: mine.map((p) => Number(p.id)) }
  }
  log(`inserted ${result.inserted} drafts: ids ${result.ids.join(', ')}`)
  writeFileSync(ctaStatePath, JSON.stringify({ last: ctaTypes[payload.length - 1] }))

  const lines = ['📝 Новые черновики готовы:']
  result.ids.forEach((id, i) => {
    const when = new Date(slots[i]).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
    const preview = payload[i].body.slice(0, 150).replace(/\n/g, ' ')
    lines.push(`\n#${id} → ${when}\n${preview}…\nОдобрить: /approve ${id}`)
  })
  await api('/ai/notify', { text: lines.join('\n') })
  log('admin notified')
}

main().catch(async (err) => {
  log(`ERROR: ${err.message}`)
  await api('/ai/notify', { text: `⚠️ Генератор черновиков не сработал: ${err.message.slice(0, 300)}` }).catch(() => {})
  process.exit(1)
})
