import { readFileSync, appendFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = dirname(fileURLToPath(import.meta.url))
const config = JSON.parse(readFileSync(join(dir, '..', 'bridge', 'config.json'), 'utf8'))
const logPath = join(dir, 'generator.log')

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

function freeSlots(busyIso, count) {
  const busy = new Set(busyIso.map((s) => new Date(s).toISOString().slice(0, 16)))
  const slots = []
  const day = new Date()
  day.setUTCDate(day.getUTCDate() + 1)
  day.setUTCHours(0, 0, 0, 0)
  while (slots.length < count) {
    for (const [h, m] of [[9, 0], [16, 5]]) {
      const slot = new Date(day)
      slot.setUTCHours(h, m, 0, 0)
      if (!busy.has(slot.toISOString().slice(0, 16))) {
        slots.push(slot.toISOString())
        if (slots.length === count) break
      }
    }
    day.setUTCDate(day.getUTCDate() + 1)
  }
  return slots
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

const PROMPT = `Ты — автор Telegram-канала о личных финансах «Мой путь к Финансовой Свободе». Стиль: коротко, по делу, без воды, умеренные эмодзи, практическая польза для читателя.

Задача:
1. Через WebFetch посмотри свежие новости (за последние 1-2 дня) на https://www.rbc.ru/economics/ и https://www.banki.ru/news/lenta/ — выбери 2 РАЗНЫЕ новости, важные для личных финансов россиян (вклады, кредиты, ипотека, налоги, пенсии, экономика).
2. Напиши по каждой пост на 500-900 символов: суть новости + что это значит для читателя. Без заголовков-кликбейта, без HTML.
3. Для каждой новости укажи source_url — прямую ссылку на страницу новости (не главную страницу сайта).
4. Для каждого поста составь image_prompt — краткую выжимку сути поста как визуальную сцену на английском (1-2 предложения, без названий и брендов). Пример: "a glass piggy bank full of coins on a conveyor belt between two bank buildings, paperwork and rubber stamps".
5. Верни ТОЛЬКО JSON без пояснений и без markdown-ограждений:
{"drafts":[{"body":"текст поста 1","source_url":"https://...","image_prompt":"scene description"},{"body":"текст поста 2","source_url":"https://...","image_prompt":"scene description"}]}`

async function main() {
  const { posts } = await api('/ai/schedule')
  if (posts.length >= 4) {
    log(`buffer full (${posts.length} future posts) - skipping generation`)
    return
  }
  const slots = freeSlots(posts.map((p) => p.scheduled_at), 2)
  log(`generating 2 drafts for slots: ${slots.join(', ')}`)

  const output = await runQwen(PROMPT)
  const drafts = parseDrafts(output)
  if (drafts.length === 0) throw new Error('no valid drafts generated')

  const payload = drafts.slice(0, 2).map((d, i) => {
    const source = typeof d.source_url === 'string' && /^https?:\/\//.test(d.source_url) ? d.source_url : null
    const body = source && !d.body.includes(source) ? `${d.body}\n\nИсточник: ${source}` : d.body
    const scene = typeof d.image_prompt === 'string' && d.image_prompt.trim()
      ? d.image_prompt.trim()
      : d.body.slice(0, 200)
    const prompt = `${scene}, clean modern editorial illustration, calm daylight, no text, no letters`
    const imageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1280&height=720&model=flux&nologo=true&seed=${Date.now() % 100000 + i}`
    return { type: 'news', body, source_url: source, image_url: imageUrl, scheduled_at: slots[i] }
  })
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
