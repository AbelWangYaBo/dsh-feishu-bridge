/**
 * lark-cli adapter for the DSH Feishu bridge.
 *
 * Responsibilities:
 *   - send interactive cards (bot identity, DM or group)
 *   - proactively patch a card we sent (desktop or cancellation won)
 *   - update a card through the callback token (late / invalid submissions)
 *   - keep one `card.action.trigger` consumer subprocess alive and parse NDJSON
 *   - read new chat messages so a plain-text reply also works when the app's
 *     long connection is already occupied by another consumer
 *
 * This module owns no arbitration state; see index.js for the first-wins logic.
 */
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, renameSync, statSync } from 'node:fs'

const LOG_MAX_BYTES = 1_000_000

/** Absolute locations where a Homebrew-installed lark-cli normally lives. */
const CLI_CANDIDATES = [
  process.env.DSH_FEISHU_LARK_CLI,
  '/opt/homebrew/bin/lark-cli',
  '/usr/local/bin/lark-cli',
]

/** Resolve the lark-cli executable, preferring an explicitly configured path. */
export function resolveLarkCli(configured) {
  const candidates = [configured, ...CLI_CANDIDATES].filter((value) => typeof value === 'string' && value.length > 0)
  for (const candidate of candidates) {
    if (candidate === 'lark-cli') return candidate
    if (existsSync(candidate)) return candidate
  }
  return 'lark-cli'
}

/** Minimal file logger; the Desktop host has no terminal attached. */
export function createFileLogger(path) {
  return (...parts) => {
    const line = `[${new Date().toISOString()}] ${parts.map(String).join(' ')}`
    try {
      if (existsSync(path) && statSync(path).size > LOG_MAX_BYTES) renameSync(path, `${path}.1`)
      appendFileSync(path, `${line}\n`)
    } catch {
      // Logging must never break the bridge.
    }
  }
}

/** Run one lark-cli invocation and resolve with its exit status and output. */
function run(bin, args, { input, timeoutMs = 30_000, env } = {}) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], env: env ?? process.env })
    } catch (error) {
      reject(error)
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn(value)
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM') } catch { /* ignore */ }
      finish(reject, new Error(`lark-cli timed out after ${String(timeoutMs)}ms: ${args.slice(0, 3).join(' ')}`))
    }, timeoutMs)
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', (error) => finish(reject, error))
    child.on('close', (code, signal) => {
      if (code === 0) {
        finish(resolve, { stdout, stderr })
        return
      }
      const detail = (stderr.trim() || stdout.trim() || `signal ${String(signal)}`).slice(-1200)
      finish(reject, new Error(`lark-cli ${args.slice(0, 3).join(' ')} exited ${String(code)}: ${detail}`))
    })
    try {
      child.stdin.end(input)
    } catch { /* the close handler reports the failure */ }
  })
}

/** Pull a message id out of an arbitrary lark-cli JSON payload. */
function extractMessageId(value) {
  if (value === null || typeof value !== 'object') return undefined
  if (typeof value.message_id === 'string') return value.message_id
  for (const nested of Object.values(value)) {
    const found = extractMessageId(nested)
    if (found !== undefined) return found
  }
  return undefined
}

/** Parse a lark-cli JSON response, tolerating the trailing `_notice` block. */
function parseJson(stdout) {
  const text = stdout.trim()
  if (text.length === 0) return undefined
  try {
    return JSON.parse(text)
  } catch {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try { return JSON.parse(text.slice(start, end + 1)) } catch { return undefined }
    }
    return undefined
  }
}

/** Normalize one message from the list/get APIs. */
export function normalizeMessage(raw) {
  if (raw === null || typeof raw !== 'object') return undefined
  const sender = raw.sender ?? {}
  const position = Number(raw.message_position ?? 0)
  const senderId = typeof sender.open_id === 'string'
    ? sender.open_id
    : typeof sender.id === 'string'
      ? sender.id
      : undefined
  return {
    messageId: raw.message_id,
    chatId: raw.chat_id,
    position: Number.isFinite(position) ? position : 0,
    senderType: typeof sender.sender_type === 'string' ? sender.sender_type : undefined,
    senderId,
    msgType: raw.msg_type,
    content: raw.content,
    deleted: raw.deleted === true,
    createTime: raw.create_time,
  }
}

/**
 * Plain text of a text message; other message types return ''.
 * lark-cli renders text content as the raw string, while the raw API wraps it as
 * `{"text":"..."}`; accept both shapes.
 */
export function messageText(message) {
  if (message?.msgType !== 'text' || typeof message.content !== 'string') return ''
  const content = message.content
  try {
    const parsed = JSON.parse(content)
    if (typeof parsed?.text === 'string') return parsed.text
  } catch { /* raw text, not JSON */ }
  return content
}

/** lark-cli facade used by the bridge. */
export class LarkCli {
  constructor({ bin, log, profile, env }) {
    this.bin = bin
    this.log = log
    this.profile = typeof profile === 'string' && profile.length > 0 ? profile : undefined
    this.env = env ?? {}
  }

  /** Prefix one argument list with the selected lark-cli profile. */
  withProfile(args) {
    return this.profile === undefined ? args : ['--profile', this.profile, ...args]
  }

  /** Run lark-cli with this adapter's isolated environment. */
  invoke(args, options = {}) {
    return run(this.bin, this.withProfile(args), { ...options, env: { ...process.env, ...this.env } })
  }

  /** Send one interactive card; returns `{ messageId, chatId }`. */
  async sendCard(card, target) {
    const args = ['im', '+messages-send']
    if (typeof target.chatId === 'string' && target.chatId.length > 0) args.push('--chat-id', target.chatId)
    else args.push('--user-id', target.userId)
    args.push('--msg-type', 'interactive', '--content', JSON.stringify(card), '--as', 'bot', '--format', 'json')
    const { stdout } = await this.invoke(args)
    const payload = parseJson(stdout)
    const messageId = extractMessageId(payload)
    if (messageId === undefined) throw new Error(`lark-cli send did not return a message_id: ${stdout.slice(0, 400)}`)
    const chatId = payload?.data?.chat_id
    return { messageId, chatId: typeof chatId === 'string' ? chatId : undefined }
  }

  /** Send a short plain-text notice to a chat (used for late submissions). */
  async sendText({ chatId, userId, text }) {
    const args = ['im', '+messages-send']
    if (typeof chatId === 'string' && chatId.length > 0) args.push('--chat-id', chatId)
    else args.push('--user-id', userId)
    args.push('--text', text, '--as', 'bot', '--format', 'json')
    await this.invoke(args)
  }

  /** Replace the content of a card we already sent. */
  async patchCard(messageId, card) {
    const data = JSON.stringify({ content: JSON.stringify(card) })
    await this.invoke(['im', 'messages', 'patch', '--message-id', messageId, '--data', data, '--as', 'bot'])
  }

  /** Update a card through the short-lived token carried by its callback. */
  async updateCardByToken(token, card) {
    const data = JSON.stringify({ token, card })
    await this.invoke(['api', 'POST', '/open-apis/interactive/v1/card/update', '--as', 'bot', '--data', data])
  }

  /** Best-effort card replacement: token first (fresh callback), then patch. */
  async updateCard({ token, messageId, card }) {
    const failures = []
    if (typeof token === 'string' && token.length > 0) {
      try {
        await this.updateCardByToken(token, card)
        return 'token'
      } catch (error) {
        failures.push(`token: ${String(error?.message ?? error)}`)
      }
    }
    if (typeof messageId === 'string' && messageId.length > 0) {
      try {
        await this.patchCard(messageId, card)
        return 'patch'
      } catch (error) {
        failures.push(`patch: ${String(error?.message ?? error)}`)
      }
    }
    throw new Error(`card update failed (${failures.join(' | ') || 'no token or message id'})`)
  }

  /** List the newest messages of one chat, newest first. */
  async listMessages(chatId, { limit = 30 } = {}) {
    const size = String(Math.min(Math.max(Math.trunc(limit), 1), 50))
    const { stdout } = await this.invoke([
      'im', '+chat-messages-list', '--chat-id', chatId, '--order', 'desc',
      '--page-size', size, '--no-reactions', '--as', 'bot', '--format', 'json',
    ])
    const payload = parseJson(stdout)
    const messages = payload?.data?.messages
    if (!Array.isArray(messages)) return []
    return messages.map(normalizeMessage).filter((message) => message !== undefined)
  }

  /** Fetch one message (used to learn the card's chat position). */
  async getMessage(messageId) {
    const { stdout } = await this.invoke([
      'im', '+messages-mget', '--message-ids', messageId, '--no-reactions', '--as', 'bot', '--format', 'json',
    ])
    const payload = parseJson(stdout)
    const messages = payload?.data?.messages
    if (!Array.isArray(messages) || messages.length === 0) return undefined
    return normalizeMessage(messages[0])
  }

  /** List the group chats this bot belongs to. */
  async listChats() {
    const { stdout } = await this.invoke(['im', '+chat-list', '--as', 'bot', '--format', 'json'])
    const payload = parseJson(stdout)
    const chats = payload?.data?.chats
    if (!Array.isArray(chats)) return []
    return chats
      .filter((chat) => chat !== null && typeof chat === 'object' && typeof chat.chat_id === 'string')
      .map((chat) => ({
        chatId: chat.chat_id,
        name: typeof chat.name === 'string' ? chat.name : '',
        mode: typeof chat.chat_mode === 'string' ? chat.chat_mode : undefined,
      }))
  }

  /** Ask lark-cli whether this app publishes one event key in the console. */
  async probeEvents(eventKey) {
    try {
      const { stdout } = await this.invoke(
        ['event', 'consume', eventKey, '--as', 'bot', '--dry-run'],
        { timeoutMs: 20_000 },
      )
      const payload = parseJson(stdout)
      const preconditions = payload?.data?.decision?.preconditions
      if (!Array.isArray(preconditions)) return { ok: false, reason: 'dry-run reported no preconditions' }
      const credentials = preconditions.find((item) => item?.name === 'credentials_available')
      if (credentials !== undefined && credentials.status !== 'ok') {
        return { ok: false, reason: `credentials ${String(credentials.status)}` }
      }
      const consoleEvent = preconditions.find((item) => item?.name === 'console_event_published')
      if (consoleEvent === undefined) return { ok: false, reason: 'console callback event not reported' }
      if (consoleEvent.status !== 'ok') return { ok: false, reason: `console callback event ${String(consoleEvent.status)}` }
      return { ok: true }
    } catch (error) {
      return { ok: false, reason: String(error?.message ?? error) }
    }
  }

  /** Backwards-compatible alias for the card callback consumer. */
  startCardConsumer(options) {
    return this.startEventConsumer({ eventKey: 'card.action.trigger', ...options })
  }

  /** Whether this app can receive card callbacks (console callback published). */
  async probeCardEvents() {
    return this.probeEvents('card.action.trigger')
  }

  /**
   * Start one lark-cli event consumer. The child restarts with backoff after an
   * unexpected exit; closing stdin stops it gracefully.
   *
   * `onExit` fires on every unexpected exit, so the caller can decide to fall
   * back to text-reply polling when the app's long connection is occupied.
   */
  startEventConsumer({ eventKey, onEvent, onReady, onExit }) {
    const bin = this.bin
    const log = this.log
    const larkEnv = this.env
    const command = this.withProfile(['event', 'consume', eventKey, '--as', 'bot'])
    let child = null
    let stopped = false
    let restartTimer = null
    let backoffMs = 1000

    const schedule = () => {
      if (stopped) return
      restartTimer = setTimeout(start, backoffMs)
      restartTimer.unref?.()
      backoffMs = Math.min(backoffMs * 2, 60_000)
    }

    const start = () => {
      if (stopped) return
      let stderrBuffer = ''
      child = spawn(bin, command, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...larkEnv } })
      let ready = false
      let stdoutBuffer = ''
      child.stderr.on('data', (chunk) => {
        stderrBuffer += String(chunk)
        const lines = stderrBuffer.split('\n')
        stderrBuffer = lines.pop() ?? ''
        for (const line of lines) {
          if (line.trim().length === 0) continue
          if (!ready && line.includes('[event] ready')) {
            ready = true
            backoffMs = 1000
            log(`${eventKey} consumer ready`)
            onReady?.()
            continue
          }
          log(`${eventKey} consumer stderr:`, line.trim().slice(0, 500))
        }
      })
      child.stdout.on('data', (chunk) => {
        stdoutBuffer += String(chunk)
        let index = stdoutBuffer.indexOf('\n')
        while (index >= 0) {
          const line = stdoutBuffer.slice(0, index).trim()
          stdoutBuffer = stdoutBuffer.slice(index + 1)
          index = stdoutBuffer.indexOf('\n')
          if (line.length === 0) continue
          let event
          try {
            event = JSON.parse(line)
          } catch {
            log(`${eventKey} consumer: unparsable event line`, line.slice(0, 300))
            continue
          }
          try {
            onEvent(event)
          } catch (error) {
            log(`${eventKey} consumer handler threw:`, String(error?.message ?? error))
          }
        }
      })
      child.on('error', (error) => log(`${eventKey} consumer spawn error:`, String(error?.message ?? error)))
      child.on('close', (code, signal) => {
        child = null
        const wasReady = ready
        ready = false
        if (stopped) return
        log(`${eventKey} consumer exited (code=${String(code)} signal=${String(signal)})`)
        onExit?.({ code, signal, wasReady })
        schedule()
      })
    }

    start()

    return {
      close() {
        stopped = true
        if (restartTimer !== null) clearTimeout(restartTimer)
        if (child !== null) {
          try { child.stdin.end() } catch { /* ignore */ }
          try { child.kill('SIGTERM') } catch { /* ignore */ }
          child = null
        }
      },
    }
  }
}
