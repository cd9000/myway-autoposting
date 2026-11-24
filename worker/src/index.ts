import { Hono } from 'hono'
import { neon, type NeonQueryFunction } from '@neondatabase/serverless'

type Env = {
  NEON_DATABASE_URL: string
  TELEGRAM_BOT_TOKEN: string
  TELEGRAM_WEBHOOK_SECRET: string
  ADMIN_TELEGRAM_ID: string
  AI_API_KEY: string
  TELEGRAM_CHANNEL_ID: string
  AI: Ai
}

type TelegramUpdate = {
  message?: {
    text?: string
    chat: { id: number }
    from?: { id: number }
  }
}

type DraftInput = {
  type?: string
  body?: string
  source_url?: string
  image_url?: string
  image_prompt?: string
  scheduled_at?: string
}

const HELP = [
  'Команды:',
  '/status — статистика постов',
  '/queue — ближайшие запланированные посты',
  '/post <id> — детали поста',
  '/approve <id> — одобрить: сгенерирует картинку и поставит в план',
  '/cancel <id> — отменить пост',
  '/redo <id> [описание] — новая картинка поста',
  'Кнопки под строкой ввода дублируют основные команды.',
].join('\n')

const IMAGE_STYLE = ', clean modern editorial illustration, calm daylight, no text, no letters'
const IMAGE_MODEL = '@cf/black-forest-labs/flux-1-schnell'
const SCENE_MODEL = '@cf/meta/llama-3.2-3b-instruct'

type Sql = NeonQueryFunction<false, false>

let schemaReady: Promise<unknown> | null = null
function ensureSchema(sql: Sql) {
  if (!schemaReady) {
    schemaReady = sql`ALTER TABLE posts ADD COLUMN IF NOT EXISTS image_prompt TEXT`.catch((err) => {
      schemaReady = null
      throw err
    })
  }
  return schemaReady
}

async function generatePhoto(env: Env, chatId: number, prompt: string, caption: string) {
  const result = await env.AI.run(IMAGE_MODEL, { prompt: truncate(prompt, 2000) })
  if (!result.image) throw new Error('модель не вернула картинку')
  const bytes = Uint8Array.from(atob(result.image), (ch) => ch.charCodeAt(0))
  const form = new FormData()
  form.append('chat_id', String(chatId))
  form.append('caption', truncate(caption, 1024))
  form.append('photo', new Blob([bytes], { type: 'image/jpeg' }), 'image.jpg')
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendPhoto`, {
    method: 'POST',
    body: form,
  })
  const data = (await res.json()) as {
    ok: boolean
    result?: { photo?: { file_id: string }[] }
    description?: string
  }
  const photos = data.result?.photo
  if (!data.ok || !photos?.length) throw new Error(data.description || 'sendPhoto failed')
  return photos[photos.length - 1].file_id
}

async function deriveScene(env: Env, body: string) {
  const result = await env.AI.run(SCENE_MODEL, {
    messages: [
      {
        role: 'system',
        content:
          'You write a short visual scene for an editorial illustration that captures the essence of a finance news post. Reply with ONLY 1-2 sentences in English describing a concrete visual scene: objects, setting, action. No brand names, no names of people, no words or letters or numbers visible in the image, no preamble, no quotes.',
      },
      { role: 'user', content: truncate(body, 1500) },
    ],
    max_tokens: 120,
    temperature: 0.7,
  })
  const scene = result.response?.trim()
  if (!scene) throw new Error('текстовая модель не вернула описание сцены')
  return scene
}

const app = new Hono<{ Bindings: Env }>()

function tgApi(env: Env, method: string, payload: Record<string, unknown>) {
  return fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

function reply(env: Env, chatId: number, text: string, markup?: Record<string, unknown>) {
  return tgApi(env, 'sendMessage', {
    chat_id: chatId,
    text,
    ...(markup ? { reply_markup: markup } : {}),
  })
}

const KEYBOARD = {
  keyboard: [
    ['📋 Запланированные посты'],
    ['🖼 Картинки', '🆕 Черновики'],
    ['📊 Статус', '❓ Помощь'],
  ],
  resize_keyboard: true,
  is_persistent: true,
}

const BUTTON_COMMANDS: Record<string, string> = {
  '📋 Запланированные посты': '/queue',
  '🖼 Картинки': '/pictures',
  '🆕 Черновики': '/drafts',
  '📊 Статус': '/status',
  '❓ Помощь': '/start',
}

function truncate(text: string, max: number) {
  return text.length > max ? text.slice(0, max - 1) + '…' : text
}

function formatMoment(value: string | null) {
  if (!value) return '—'
  return new Date(value).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
}

function parseId(arg: string | undefined) {
  return arg && /^\d+$/.test(arg) ? Number(arg) : null
}

async function handleCommand(env: Env, chatId: number, text: string) {
  const sql = neon(env.NEON_DATABASE_URL)
  const normalized = BUTTON_COMMANDS[text.trim()] ?? text
  const [command, arg] = normalized.trim().split(/\s+/)

  switch (command) {
    case '/start':
      await reply(env, chatId, 'Привет! Бот работает.\n\n' + HELP, KEYBOARD)
      return

    case '/status': {
      const rows = await sql`SELECT status, COUNT(*)::int AS count FROM posts GROUP BY status`
      const counts: Record<string, number> = {}
      for (const row of rows) counts[row.status] = row.count
      const lines = ['draft', 'approved', 'published', 'cancelled'].map(
        (status) => `${status}: ${counts[status] ?? 0}`,
      )
      await reply(env, chatId, 'Посты:\n' + lines.join('\n'))
      return
    }

    case '/queue': {
      const rows = await sql`
        SELECT id, status, scheduled_at, body
        FROM posts
        WHERE status IN ('approved', 'draft') AND scheduled_at > NOW()
        ORDER BY scheduled_at ASC
        LIMIT 10`
      if (rows.length === 0) {
        await reply(env, chatId, 'Очередь пуста.')
        return
      }
      const lines = rows.map(
        (row) =>
          `#${row.id} [${row.status}] ${formatMoment(row.scheduled_at)}\n${truncate(row.body, 80)}`,
      )
      await reply(env, chatId, truncate(lines.join('\n\n'), 4096))
      return
    }

    case '/pictures': {
      const rows = await sql`
        SELECT id, status, scheduled_at, photo_file_id, image_url
        FROM posts
        WHERE status IN ('draft', 'approved')
          AND (photo_file_id IS NOT NULL OR image_url IS NOT NULL)
        ORDER BY scheduled_at ASC NULLS FIRST
        LIMIT 3`
      if (rows.length === 0) {
        await reply(env, chatId, 'В очереди нет постов с картинками. Добавить: /redo <id>')
        return
      }
      for (const row of rows) {
        await tgApi(env, 'sendPhoto', {
          chat_id: chatId,
          photo: row.photo_file_id || row.image_url,
          caption: `#${row.id} [${row.status}] ${formatMoment(row.scheduled_at)}\nНовая картинка: /redo ${row.id}`,
        })
      }
      return
    }

    case '/drafts': {
      const rows = await sql`
        SELECT id, scheduled_at, body
        FROM posts
        WHERE status = 'draft'
        ORDER BY scheduled_at ASC NULLS FIRST
        LIMIT 10`
      if (rows.length === 0) {
        await reply(env, chatId, 'Черновиков нет — очередь одобрений пуста.')
        return
      }
      const lines = rows.map(
        (row) =>
          `#${row.id} ${formatMoment(row.scheduled_at)}\n${truncate(row.body, 80)}\nОдобрить: /approve ${row.id}`,
      )
      await reply(env, chatId, truncate(lines.join('\n\n'), 4096))
      return
    }

    case '/post': {
      const id = parseId(arg)
      if (id === null) {
        await reply(env, chatId, 'Использование: /post <id>')
        return
      }
      const rows = await sql`
        SELECT id, type, body, status, scheduled_at, photo_file_id, image_url
        FROM posts WHERE id = ${id}`
      if (rows.length === 0) {
        await reply(env, chatId, `Пост #${id} не найден.`)
        return
      }
      const post = rows[0]
      const details =
        `#${post.id} [${post.status}] тип: ${post.type}\n` +
        `scheduled: ${formatMoment(post.scheduled_at)}\n\n${post.body}`
      const photo = post.photo_file_id || post.image_url
      if (photo) {
        await tgApi(env, 'sendPhoto', {
          chat_id: chatId,
          photo,
          caption: truncate(details, 1024),
        })
      } else {
        await reply(env, chatId, truncate(details, 4096))
      }
      return
    }

    case '/redo': {
      const parts = text.trim().split(/\s+/)
      const id = parseId(parts[1])
      if (id === null) {
        await reply(env, chatId, 'Использование: /redo <id> [описание сцены]')
        return
      }
      await ensureSchema(sql)
      const rows = await sql`SELECT id, body FROM posts WHERE id = ${id}`
      if (rows.length === 0) {
        await reply(env, chatId, `Пост #${id} не найден.`)
        return
      }
      const post = rows[0]
      const sceneArg = parts.slice(2).join(' ')
      try {
        const scene = sceneArg || (await deriveScene(env, post.body))
        const sceneText = truncate(scene, 500)
        const fileId = await generatePhoto(
          env,
          chatId,
          scene + IMAGE_STYLE,
          `Новая картинка поста #${id}\nСцена: ${sceneText}\n\nНе нравится — /redo ${id} ещё раз или /redo ${id} <своё описание>.`,
        )
        await sql`
          UPDATE posts
          SET photo_file_id = ${fileId}, image_prompt = ${scene}, image_url = NULL, updated_at = NOW()
          WHERE id = ${id}`
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        await reply(env, chatId, `Не удалось сгенерировать картинку поста #${id}: ${truncate(message, 300)}`)
      }
      return
    }

    case '/approve': {
      const id = parseId(arg)
      if (id === null) {
        await reply(env, chatId, 'Использование: /approve <id>')
        return
      }
      await ensureSchema(sql)
      const rows = await sql`SELECT id, body, image_prompt FROM posts WHERE id = ${id}`
      if (rows.length === 0) {
        await reply(env, chatId, `Пост #${id} не найден.`)
        return
      }
      const post = rows[0]
      await sql`UPDATE posts SET status = 'approved', updated_at = NOW() WHERE id = ${id}`
      await reply(env, chatId, `Пост #${id} одобрен и поставлен в план. Генерирую картинку…`)
      try {
        const scene = post.image_prompt || (await deriveScene(env, post.body))
        const fileId = await generatePhoto(
          env,
          chatId,
          scene + IMAGE_STYLE,
          `Картинка поста #${id} (одобрен, в плане)\nСцена: ${truncate(scene, 500)}\n\nНе нравится — /redo ${id} или /redo ${id} <своё описание>.`,
        )
        await sql`
          UPDATE posts
          SET photo_file_id = ${fileId}, image_prompt = ${scene}, image_url = NULL, updated_at = NOW()
          WHERE id = ${id}`
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        await reply(env, chatId, `Пост #${id} одобрен, но картинка не сгенерирована: ${truncate(message, 300)}\nПопробуй /redo ${id}. Без картинки пост выйдет текстом.`)
      }
      return
    }

    case '/cancel': {
      const id = parseId(arg)
      if (id === null) {
        await reply(env, chatId, 'Использование: /cancel <id>')
        return
      }
      const rows = await sql`
        UPDATE posts SET status = 'cancelled', updated_at = NOW()
        WHERE id = ${id} RETURNING id`
      await reply(env, chatId, rows.length > 0 ? `Пост #${id} отменён.` : `Пост #${id} не найден.`)
      return
    }

    default:
      await reply(env, chatId, HELP)
  }
}

app.get('/', (c) => c.json({ status: 'ok' }))

app.post('/tg', async (c) => {
  const secret = c.req.header('X-Telegram-Bot-Api-Secret-Token')
  if (secret !== c.env.TELEGRAM_WEBHOOK_SECRET) {
    return c.json({ error: 'unauthorized' }, 401)
  }

  const update = await c.req.json<TelegramUpdate>()
  const message = update.message
  if (!message?.text || String(message.from?.id) !== c.env.ADMIN_TELEGRAM_ID) {
    return c.json({ ok: true })
  }

  try {
    if (message.text.startsWith('/') || BUTTON_COMMANDS[message.text.trim()]) {
      await handleCommand(c.env, message.chat.id, message.text)
    } else {
      const sql = neon(c.env.NEON_DATABASE_URL)
      await sql`
        INSERT INTO agent_inbox (chat_id, text)
        VALUES (${message.chat.id}, ${message.text})`
      await reply(c.env, message.chat.id, 'Принято. Думаю…')
    }
  } catch (err) {
    console.error(err)
    try {
      await reply(c.env, message.chat.id, 'Ошибка: ' + (err instanceof Error ? err.message : String(err)))
    } catch {
      // Telegram недоступен — ошибка уже залогирована
    }
  }
  return c.json({ ok: true })
})

app.post('/ai/drafts', async (c) => {
  if (c.req.header('Authorization') !== `Bearer ${c.env.AI_API_KEY}`) {
    return c.json({ error: 'unauthorized' }, 401)
  }

  const payload = await c.req.json<{ drafts?: DraftInput[] }>().catch(() => null)
  const drafts = payload?.drafts
  if (!Array.isArray(drafts) || drafts.length === 0) {
    return c.json({ error: 'drafts array required' }, 400)
  }

  const sql = neon(c.env.NEON_DATABASE_URL)
  await ensureSchema(sql)
  let inserted = 0
  const ids: number[] = []
  for (const draft of drafts) {
    if (typeof draft.body !== 'string' || draft.body.trim() === '') continue
    let scheduledAt: string | null = null
    if (draft.scheduled_at) {
      const date = new Date(draft.scheduled_at)
      if (Number.isNaN(date.getTime())) {
        return c.json({ error: `invalid scheduled_at: ${draft.scheduled_at}` }, 400)
      }
      scheduledAt = date.toISOString()
    }
    const scene = typeof draft.image_prompt === 'string' && draft.image_prompt.trim()
      ? draft.image_prompt.trim()
      : null
    const rows = await sql`
      INSERT INTO posts (type, body, source_url, image_url, image_prompt, scheduled_at, status)
      VALUES (${draft.type ?? 'manual'}, ${draft.body}, ${draft.source_url ?? null}, ${draft.image_url ?? null}, ${scene}, ${scheduledAt}, 'draft')
      RETURNING id`
    inserted++
    ids.push(Number(rows[0].id))
  }
  return c.json({ ok: true, inserted, ids })
})

app.get('/ai/schedule', async (c) => {
  if (!agentAuthorized(c.req.header('Authorization'), c.env)) {
    return c.json({ error: 'unauthorized' }, 401)
  }
  const sql = neon(c.env.NEON_DATABASE_URL)
  const rows = await sql`
    SELECT id, status, scheduled_at
    FROM posts
    WHERE status IN ('draft', 'approved') AND scheduled_at > NOW()
    ORDER BY scheduled_at ASC`
  return c.json({ posts: rows })
})

app.get('/ai/post/:id', async (c) => {
  if (!agentAuthorized(c.req.header('Authorization'), c.env)) {
    return c.json({ error: 'unauthorized' }, 401)
  }
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id)) return c.json({ error: 'invalid id' }, 400)
  const sql = neon(c.env.NEON_DATABASE_URL)
  const rows = await sql`
    SELECT id, type, body, status, scheduled_at, source_url
    FROM posts WHERE id = ${id}`
  if (rows.length === 0) return c.json({ error: 'not found' }, 404)
  return c.json({ post: rows[0] })
})

app.post('/ai/notify', async (c) => {
  if (!agentAuthorized(c.req.header('Authorization'), c.env)) {
    return c.json({ error: 'unauthorized' }, 401)
  }
  const body = await c.req.json<{ text?: string }>().catch(() => null)
  if (!body?.text) return c.json({ error: 'text required' }, 400)
  for (const chunk of splitMessage(body.text)) {
    await tgApi(c.env, 'sendMessage', { chat_id: Number(c.env.ADMIN_TELEGRAM_ID), text: chunk })
  }
  return c.json({ ok: true })
})

function splitMessage(text: string, max = 4096): string[] {
  const chunks: string[] = []
  let rest = text
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max)
    if (cut < max / 2) cut = max
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  if (rest.length > 0) chunks.push(rest)
  return chunks
}

function agentAuthorized(header: string | undefined, env: Env) {
  return header === `Bearer ${env.AI_API_KEY}`
}

app.get('/agent/pending', async (c) => {
  if (!agentAuthorized(c.req.header('Authorization'), c.env)) {
    return c.json({ error: 'unauthorized' }, 401)
  }
  const sql = neon(c.env.NEON_DATABASE_URL)
  const rows = await sql`
    UPDATE agent_inbox SET status = 'processing', processed_at = NOW()
    WHERE id IN (
      SELECT id FROM agent_inbox
      WHERE status = 'pending'
         OR (status = 'processing' AND processed_at < NOW() - INTERVAL '10 minutes')
      ORDER BY created_at
      LIMIT 3
    )
    RETURNING id, chat_id, text`
  return c.json({ messages: rows })
})

app.post('/agent/reply', async (c) => {
  if (!agentAuthorized(c.req.header('Authorization'), c.env)) {
    return c.json({ error: 'unauthorized' }, 401)
  }
  const body = await c.req.json<{ id?: number; text?: string }>().catch(() => null)
  if (!body?.id || typeof body.text !== 'string') {
    return c.json({ error: 'id and text required' }, 400)
  }
  const sql = neon(c.env.NEON_DATABASE_URL)
  const rows = await sql`
    UPDATE agent_inbox SET status = 'done', reply = ${body.text}, processed_at = NOW()
    WHERE id = ${body.id} RETURNING chat_id`
  if (rows.length === 0) return c.json({ error: 'not found' }, 404)
  for (const chunk of splitMessage(body.text)) {
    await tgApi(c.env, 'sendMessage', { chat_id: rows[0].chat_id, text: chunk })
  }
  return c.json({ ok: true })
})

app.post('/agent/fail', async (c) => {
  if (!agentAuthorized(c.req.header('Authorization'), c.env)) {
    return c.json({ error: 'unauthorized' }, 401)
  }
  const body = await c.req.json<{ id?: number; error?: string }>().catch(() => null)
  if (!body?.id) return c.json({ error: 'id required' }, 400)
  const message = truncate(body.error ?? 'unknown error', 500)
  const sql = neon(c.env.NEON_DATABASE_URL)
  const rows = await sql`
    UPDATE agent_inbox SET status = 'failed', error = ${message}, processed_at = NOW()
    WHERE id = ${body.id} RETURNING chat_id`
  if (rows.length === 0) return c.json({ error: 'not found' }, 404)
  await reply(c.env, rows[0].chat_id, `Не удалось обработать сообщение: ${message}`)
  return c.json({ ok: true })
})

const MAX_ATTEMPTS = 3

async function publishDuePosts(env: Env) {
  const sql = neon(env.NEON_DATABASE_URL)
  const rows = await sql`
    SELECT id, body, photo_file_id, image_url
    FROM posts
    WHERE status = 'approved' AND attempts < ${MAX_ATTEMPTS}
      AND (scheduled_at IS NULL OR scheduled_at <= NOW())
    ORDER BY scheduled_at ASC NULLS FIRST
    LIMIT 5`

  for (const post of rows) {
    try {
      const photo = post.photo_file_id || post.image_url
      const res = photo
        ? await tgApi(env, 'sendPhoto', {
            chat_id: env.TELEGRAM_CHANNEL_ID,
            photo,
            caption: truncate(post.body, 1024),
          })
        : await tgApi(env, 'sendMessage', {
            chat_id: env.TELEGRAM_CHANNEL_ID,
            text: truncate(post.body, 4096),
          })
      const data = (await res.json()) as {
        ok: boolean
        result?: { message_id: number }
        description?: string
      }
      if (!data.ok || !data.result) {
        throw new Error(data.description || 'Telegram API error')
      }
      await sql`
        UPDATE posts
        SET status = 'published', published_at = NOW(),
            tg_message_id = ${data.result.message_id}, updated_at = NOW()
        WHERE id = ${post.id}`
      await reply(env, Number(env.ADMIN_TELEGRAM_ID), `Опубликован пост #${post.id} в канал.`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const updated = await sql`
        UPDATE posts
        SET attempts = attempts + 1, last_error = ${message}, updated_at = NOW()
        WHERE id = ${post.id} RETURNING attempts`
      if (updated[0]?.attempts >= MAX_ATTEMPTS) {
        await reply(
          env,
          Number(env.ADMIN_TELEGRAM_ID),
          `Пост #${post.id} не опубликован после ${MAX_ATTEMPTS} попыток: ${truncate(message, 300)}`,
        )
      }
    }
  }
}

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext) {
    await publishDuePosts(env)
  },
}
