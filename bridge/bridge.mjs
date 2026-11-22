import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = dirname(fileURLToPath(import.meta.url))
const config = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))
const statePath = join(dir, 'state.json')
const logPath = join(dir, 'bridge.log')

const state = existsSync(statePath)
  ? JSON.parse(readFileSync(statePath, 'utf8'))
  : { sessionId: randomUUID(), sessionStarted: false }
writeFileSync(statePath, JSON.stringify(state, null, 2))

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
  const res = await fetch(config.workerUrl + path, {
    method: body ? 'POST' : 'GET',
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) throw new Error(`${path} HTTP ${res.status}`)
  return res.json()
}

function runQwen(text) {
  return new Promise((resolve, reject) => {
    const sessionArgs = state.sessionStarted
      ? ['-r', state.sessionId]
      : ['--session-id', state.sessionId]
    const args = ['-p', '--permission-mode', 'bypass_permissions', ...sessionArgs, text]
    const child = spawn(config.qwenPath, args, {
      cwd: config.cwd,
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`timeout after ${config.timeoutMs / 1000}s`))
    }, config.timeoutMs)
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        reject(new Error(`qwen exit ${code}: ${stderr.slice(-500) || stdout.slice(-500)}`))
        return
      }
      if (!state.sessionStarted) {
        state.sessionStarted = true
        writeFileSync(statePath, JSON.stringify(state, null, 2))
      }
      resolve(stdout.trim())
    })
  })
}

let busy = false

async function tick() {
  if (busy) return
  busy = true
  try {
    const { messages } = await api('/agent/pending')
    for (const m of messages) {
      log(`processing #${m.id}: ${m.text.slice(0, 80)}`)
      try {
        const answer = await runQwen(m.text)
        await api('/agent/reply', { id: m.id, text: answer || '(пустой ответ)' })
        log(`done #${m.id}`)
      } catch (err) {
        log(`failed #${m.id}: ${err.message}`)
        await api('/agent/fail', { id: m.id, error: err.message }).catch(() => {})
      }
    }
  } catch (err) {
    log(`poll error: ${err.message}`)
  } finally {
    busy = false
  }
}

log(`bridge started, session ${state.sessionId}`)
tick()
setInterval(tick, config.pollMs)
