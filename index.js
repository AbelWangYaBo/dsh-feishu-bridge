/**
 * dsh-feishu-bridge — Host plugin.
 *
 * When DSH needs a human decision (ask_user_question option sets, or a permission
 * approval), this plugin mirrors the request into a Feishu card and races two
 * answer channels:
 *
 *   - the desktop/Web answerer (the ordinary forwarded Remote Event waterfall)
 *   - Feishu: card-button callbacks, or a plain-text reply in the chat
 *
 * Whichever submission reaches the Host first wins. The loser is told the request
 * is already complete: the desktop card is cancelled through the request signal
 * the Gateway already watches, and a late Feishu submission gets a "已失效" card
 * plus a chat notice.
 *
 * The plugin is a prepended waterfall listener, so it runs before the Web
 * forwarder and can hand the request to it with `next()` while keeping its own
 * Feishu path pending. It only intercepts when a usable delivery target is
 * configured; otherwise it behaves like an absent listener.
 *
 * Receive modes:
 *   - `callback`: interactive cards; clicks arrive through `lark-cli event consume`.
 *     Requires this lark-cli profile to own the app's long connection.
 *   - `poll`: cards carry numbered options and the user answers with a chat
 *     message; the bridge polls the chat. Used automatically when another
 *     consumer already owns the app's long connection.
 *   - `auto` (default): try `callback`, fall back to `poll`.
 * Text replies are accepted in both modes; polling only runs while a prompt is open.
 *
 * @module dsh-feishu-bridge
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { LarkCli, createFileLogger, messageText, resolveLarkCli } from './lib/lark.js'
import {
  answerFromButton,
  buildApprovalCard,
  buildNoticeCard,
  buildQuestionCard,
  buildSettledCard,
  buildTextApprovalCard,
  buildTextQuestionCard,
  collectAnswers,
} from './lib/card.js'
import {
  leadingPromptCode,
  parseApprovalReply,
  parseQuestionReply,
  stripPromptCode,
} from './lib/poll.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'feishu-bridge'

const DEFAULTS = {
  /** Master switch. */
  enabled: true,
  /** lark-cli executable; resolved from PATH/Homebrew when omitted. */
  larkCliPath: undefined,
  /** lark-cli profile to use (a profile may bind a different Feishu app). */
  larkProfile: '',
  /** Feishu app credentials; when both are set the bridge keeps its own isolated lark-cli home. */
  appId: '',
  appSecret: '',
  /** Isolated lark-cli config directory (default: $DSH_HOME/feishu-bridge/lark-cli). */
  larkConfigDir: '',
  /**
   * Where cards are sent. `userId` is a bot-visible open_id, `chatId` a group id;
   * with only appId/appSecret configured, a group chat can be discovered by name.
   */
  target: { userId: '', chatId: '', chatName: '', discover: true },
  /** open_ids allowed to answer. Defaults to `target.userId`; empty means anyone. */
  allowOperators: [],
  /** Which interaction kinds are mirrored to Feishu. */
  bridge: { questions: true, approvals: true },
  /** Receive path: 'auto' (preferred), 'callback', or 'poll'. */
  receive: 'auto',
  /** Answer Feishu text messages (prompt answers, status/help commands, acknowledgements). */
  watchMessages: true,
  /** Chat poll interval for text replies while a prompt is open, in milliseconds. */
  pollIntervalMs: 3000,
  /** Slower poll interval that watches for late replies to settled prompts. */
  idlePollIntervalMs: 30000,
  /**
   * Feishu ⇄ DSH chat channel: forward Feishu text messages into a live DSH
   * session and mirror that session's assistant replies back to Feishu.
   */
  chat: { enabled: true, sessionId: '', mirror: true, allowGroups: false, cwd: '' },
  /** Refuse to mirror more than this many open prompts at once. */
  maxPending: 8,
  /**
   * Testing only: accept a text reply authored by the bot itself, so the
   * Feishu reply path can be exercised without a human. Leave false in use.
   */
  testAcceptBotReplies: false,
  /** Optional JSON file merged over the bundle config (default: $DSH_HOME/feishu-bridge.json). */
  configFile: '',
}

const LATE_RETENTION_MS = 30 * 60 * 1000
const SEEN_EVENT_LIMIT = 500
const CALLBACK_PROBE_MS = 7000

/** A promise plus its resolvers, independent of the runtime Node version. */
function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

/** The DSH home directory for profile-scoped files. */
function dshHome() {
  return typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
}

/**
 * Materialize this plugin's own lark-cli home so configured app credentials never
 * touch the shared `~/.lark-cli` profile that other services use. lark-cli reads
 * `LARKSUITE_CLI_CONFIG_DIR`, and its config accepts a plaintext app secret.
 */
function prepareIsolatedLarkHome({ config, log }) {
  if (typeof config.appId !== 'string' || config.appId.length === 0) return undefined
  if (typeof config.appSecret !== 'string' || config.appSecret.length === 0) {
    log('appId is set without appSecret; keeping the host lark-cli profile')
    return undefined
  }
  const dir = typeof config.larkConfigDir === 'string' && config.larkConfigDir.length > 0
    ? config.larkConfigDir
    : join(dshHome(), 'feishu-bridge', 'lark-cli')
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const configPath = join(dir, 'config.json')
    let existing
    try { existing = JSON.parse(readFileSync(configPath, 'utf8')) } catch { existing = undefined }
    const current = Array.isArray(existing?.apps)
      ? existing.apps.find((app) => app?.appId === config.appId)
      : undefined
    if (current?.appSecret !== config.appSecret) {
      writeFileSync(configPath, `${JSON.stringify({
        apps: [{ appId: config.appId, appSecret: config.appSecret, brand: 'feishu', lang: 'zh', defaultAs: 'bot' }],
      }, null, 2)}\n`, { mode: 0o600 })
      log(`wrote isolated lark-cli credentials for app ${config.appId}`)
    }
    return {
      env: {
        LARKSUITE_CLI_CONFIG_DIR: dir,
        LARKSUITE_CLI_LOG_DIR: join(dir, 'logs'),
      },
      profile: config.appId,
    }
  } catch (error) {
    log('could not prepare the isolated lark-cli home:', String(error?.message ?? error))
    return undefined
  }
}

/** Deep-merge the small config surface the bridge understands. */
function mergeConfig(rowConfig) {
  const merged = {
    ...DEFAULTS,
    ...rowConfig,
    target: { ...DEFAULTS.target, ...(rowConfig?.target ?? {}) },
    bridge: { ...DEFAULTS.bridge, ...(rowConfig?.bridge ?? {}) },
    allowOperators: Array.isArray(rowConfig?.allowOperators) ? [...rowConfig.allowOperators] : [...DEFAULTS.allowOperators],
  }
  const home = dshHome()
  const file = typeof merged.configFile === 'string' && merged.configFile.length > 0
    ? merged.configFile
    : join(home, 'feishu-bridge.json')
  let fileConfig
  try {
    if (existsSync(file)) fileConfig = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    fileConfig = undefined
  }
  if (fileConfig !== null && typeof fileConfig === 'object') {
    if (typeof fileConfig.enabled === 'boolean') merged.enabled = fileConfig.enabled
    if (typeof fileConfig.larkCliPath === 'string') merged.larkCliPath = fileConfig.larkCliPath
    if (typeof fileConfig.larkProfile === 'string') merged.larkProfile = fileConfig.larkProfile
    if (typeof fileConfig.appId === 'string') merged.appId = fileConfig.appId
    if (typeof fileConfig.appSecret === 'string') merged.appSecret = fileConfig.appSecret
    if (typeof fileConfig.larkConfigDir === 'string') merged.larkConfigDir = fileConfig.larkConfigDir
    if (typeof fileConfig.receive === 'string') merged.receive = fileConfig.receive
    if (typeof fileConfig.watchMessages === 'boolean') merged.watchMessages = fileConfig.watchMessages
    merged.chat = { ...merged.chat, ...(fileConfig.chat ?? {}) }
    if (Number.isSafeInteger(fileConfig.pollIntervalMs) && fileConfig.pollIntervalMs >= 500) {
      merged.pollIntervalMs = fileConfig.pollIntervalMs
    }
    if (Number.isSafeInteger(fileConfig.maxPending) && fileConfig.maxPending > 0) merged.maxPending = fileConfig.maxPending
    merged.target = { ...merged.target, ...(fileConfig.target ?? {}) }
    merged.bridge = { ...merged.bridge, ...(fileConfig.bridge ?? {}) }
    if (Array.isArray(fileConfig.allowOperators)) merged.allowOperators = [...fileConfig.allowOperators]
  }
  merged.file = file
  return merged
}

/** Human-readable label for the channel that settled a request. */
function channelLabel(channel) {
  switch (channel) {
    case 'feishu': return '飞书'
    case 'desktop': return '电脑端'
    default: return '超时或取消'
  }
}

/** Build the context block shown on every card. */
function cardContext(agent, ctx) {
  const cwd = agent?.session?.header?.cwd
  const sessionId = agent?.session?.id
  let sessionTitle
  try {
    const titles = typeof ctx?.get === 'function' ? ctx.get('sessionTitle') : undefined
    const snapshot = titles?.get?.(agent.session)
    if (typeof snapshot?.title === 'string' && snapshot.title.length > 0) sessionTitle = snapshot.title
  } catch { /* the title service is optional */ }
  return {
    workspace: typeof cwd === 'string' && cwd.length > 0 ? basename(cwd) : undefined,
    title: sessionTitle,
    session: typeof sessionId === 'string' && sessionId.length > 0 ? sessionId.slice(0, 12) : undefined,
    time: new Date().toLocaleString('zh-CN', { hour12: false }),
  }
}

/** Plain text of one assistant message, ignoring non-text content blocks. */
function extractAssistantText(message) {
  const content = message?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part) => part !== null && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text.trim())
    .filter((text) => text.length > 0)
    .join('\n')
    .trim()
}

/** Recognize the small command vocabulary a Feishu message may carry. */
function classifyCommand(text) {
  const normalized = String(text ?? '').trim().toLowerCase()
  if (['状态', 'status', '查看状态'].includes(normalized)) return 'status'
  if (['帮助', 'help', '?', '？', '使用说明'].includes(normalized)) return 'help'
  if (['ping', 'pong'].includes(normalized)) return 'ping'
  if (['项目', '当前项目', 'pwd', 'project'].includes(normalized)) return 'project'
  if (['取消绑定', '解绑', 'unbind'].includes(normalized)) return 'unbind'
  return undefined
}

/** Parse the JSON payloads a card callback carries. */
function parseAction(event) {
  const action = { value: undefined, form: undefined, tag: event?.action_tag }
  const rawValue = event?.action_value
  if (typeof rawValue === 'string' && rawValue.trim().length > 0) {
    try { action.value = JSON.parse(rawValue) } catch { /* keep undefined */ }
  } else if (rawValue !== null && typeof rawValue === 'object') {
    action.value = rawValue
  }
  const rawForm = event?.form_value
  if (typeof rawForm === 'string' && rawForm.trim().length > 0) {
    try { action.form = JSON.parse(rawForm) } catch { /* keep undefined */ }
  } else if (rawForm !== null && typeof rawForm === 'object') {
    action.form = rawForm
  }
  return action
}

/** Owns one profile-scoped bridge instance. Exported for offline tests. */
export class FeishuBridge {
  constructor({ ctx, config, log, lark, rowConfig }) {
    this.ctx = ctx
    this.config = config
    this.log = log
    this.prompts = new Map()
    this.byMessage = new Map()
    this.seenEvents = new Set()
    this.seenMessageIds = new Set()
    this.chatBindings = new Map()
    this.lastPromptSessionId = undefined
    this.chatSince = new Map()
    this.seq = 0
    this.injectedLark = lark
    this.rowConfig = rowConfig ?? {}
    this.configStamp = undefined
    this.configTimer = undefined
    this.reloading = false
    this.larkHome = undefined
    this.ready = false
    this.lastIssue = ''
    this.mode = 'detecting'
    this.consumer = undefined
    this.retryTimer = undefined
    this.pollTimer = undefined
    this.polling = false
    this.idleTicks = 0
    this.modeTimer = undefined
    this.disposed = false
    this.lark = lark ?? new LarkCli({
      bin: resolveLarkCli(config.larkCliPath),
      log,
      profile: config.larkProfile,
    })
    this.allow = new Set(
      [...(config.allowOperators ?? []), config.target?.userId ?? '']
        .filter((value) => typeof value === 'string' && value.length > 0),
    )
  }

  /** Register listeners and start receive-mode detection; returns the disposer. */
  start() {
    this.larkHome = prepareIsolatedLarkHome({ config: this.config, log: this.log })
    if (this.injectedLark === undefined && this.larkHome !== undefined) {
      this.lark = new LarkCli({
        bin: resolveLarkCli(this.config.larkCliPath),
        log: this.log,
        profile: this.larkHome.profile,
        env: this.larkHome.env,
      })
    }
    this.log(`starting (target=${this.targetLabel()}, cli=${this.lark.bin}, profile=${this.lark.profile ?? 'current'}, isolated=${String(this.larkHome !== undefined)})`)
    if (this.config.testAcceptBotReplies === true) {
      this.log('test injection enabled: bot-authored reply messages are accepted as answers')
    }
    const offQuestions = this.ctx.on(
      'user-questions/request',
      (request, next) => this.onQuestionRequest(request, next),
      { prepend: true },
    )
    const offApprovals = this.ctx.on(
      'approval/request',
      (request, next) => this.onApprovalRequest(request, next),
      { prepend: true },
    )
    const offSession = this.ctx.on('session/event', (session, event) => { void this.onSessionEvent(session, event) }, { global: true })
    this.configStamp = this.fileStamp()
    this.configTimer = setInterval(() => { void this.checkConfigFile() }, 5000)
    this.configTimer.unref?.()
    void this.initialize()
    return () => {
      this.disposed = true
      offQuestions()
      offApprovals()
      offSession()
      this.stopConsumer()
      this.stopPolling()
      if (this.retryTimer !== undefined) clearInterval(this.retryTimer)
      if (this.configTimer !== undefined) clearInterval(this.configTimer)
      if (this.modeTimer !== undefined) clearTimeout(this.modeTimer)
      for (const entry of [...this.prompts.values()]) {
        this.settleEntry(entry, 'expired')
        entry.final.reject(new Error('feishu-bridge: plugin is shutting down'))
        this.cleanup(entry)
      }
      this.log('stopped')
    }
  }

  /** Timestamp/size fingerprint of the config file, used to notice edits. */
  fileStamp() {
    try {
      const stat = statSync(this.config.file)
      return `${String(stat.mtimeMs)}:${String(stat.size)}`
    } catch {
      return 'missing'
    }
  }

  /** Reload the delivery settings when the config file changed on disk. */
  async checkConfigFile() {
    if (this.disposed || this.reloading) return
    const stamp = this.fileStamp()
    if (stamp === this.configStamp) return
    this.configStamp = stamp
    this.reloading = true
    try {
      await this.reloadConfig()
    } catch (error) {
      this.log('configuration reload failed:', String(error?.message ?? error))
    } finally {
      this.reloading = false
    }
  }

  /** Apply a changed config file without restarting DSH. */
  async reloadConfig() {
    const previous = this.config
    const next = mergeConfig(this.rowConfig)
    this.config = next
    this.allow = new Set(
      [...(next.allowOperators ?? []), next.target?.userId ?? '']
        .filter((value) => typeof value === 'string' && value.length > 0),
    )
    if (next.enabled !== true) {
      this.ready = false
      this.stopConsumer()
      this.stopPolling()
      this.log('configuration reloaded: bridge disabled')
      return
    }
    const deliveryKey = (config) => [
      config.appId, config.appSecret, config.larkProfile, config.larkCliPath, config.larkConfigDir,
    ].join('|')
    const deliveryChanged = deliveryKey(next) !== deliveryKey(previous)
    const targetChanged = [next.target?.chatId, next.target?.userId, next.target?.chatName]
      .join('|') !== [previous.target?.chatId, previous.target?.userId, previous.target?.chatName].join('|')
    this.log(`configuration reloaded (deliveryChanged=${String(deliveryChanged)}, targetChanged=${String(targetChanged)})`)
    if (deliveryChanged) {
      this.invalidatePendingForAppSwitch()
      this.stopConsumer()
      this.stopPolling()
      this.chatSince.clear()
      this.seenMessageIds.clear()
      this.mode = 'detecting'
      this.ready = false
      this.larkHome = prepareIsolatedLarkHome({ config: next, log: this.log })
      if (this.injectedLark === undefined) {
        this.lark = new LarkCli({
          bin: resolveLarkCli(next.larkCliPath),
          log: this.log,
          profile: this.larkHome?.profile ?? (next.larkProfile || undefined),
          env: this.larkHome?.env,
        })
      }
      await this.initialize()
      return
    }
    if (targetChanged) {
      this.ready = false
      const resolved = await this.resolveTarget()
      if (resolved) {
        this.ready = true
        this.lastIssue = ''
        this.log(`bridge ready after target change (target=${this.targetLabel()}, mode=${this.mode})`)
      } else {
        this.startTargetRetry()
      }
      return
    }
  }

  /** Resolve the delivery target and the receive path before serving prompts. */
  async initialize() {
    if (this.config.enabled !== true) {
      this.ready = false
      this.stopConsumer()
      this.stopPolling()
      this.log('bridge disabled by configuration')
      return
    }
    await Promise.allSettled([this.detectMode(), this.resolveTarget()])
    if (this.hasTarget()) {
      this.ready = true
      this.lastIssue = ''
      this.log(`bridge ready (target=${this.targetLabel()}, mode=${this.mode})`)
      return
    }
    this.lastIssue = '尚未发现目标群：请确认机器人已加入目标群，并在设置里填写群名或 chat_id。'
    this.log('no Feishu target resolved yet; prompts stay on the desktop until a target is configured')
    this.startTargetRetry()
  }

  /** Start the retry loop that waits for a usable delivery target. */
  startTargetRetry() {
    if (this.retryTimer !== undefined || this.disposed) return
    this.retryTimer = setInterval(() => { void this.retryTarget() }, 60_000)
    this.retryTimer.unref?.()
  }

  /** Keep trying to discover the target chat while the bridge is idle. */
  async retryTarget() {
    if (this.disposed || this.ready) return
    const resolved = await this.resolveTarget()
    if (!resolved) return
    this.ready = true
    this.lastIssue = ''
    this.log(`bridge ready after target discovery (target=${this.targetLabel()}, mode=${this.mode})`)
    if (this.retryTimer !== undefined) {
      clearInterval(this.retryTimer)
      this.retryTimer = undefined
    }
  }

  /**
   * Resolve a group chat automatically when app credentials are configured:
   * an explicit `target.chatName` wins, otherwise exactly one bot group is used.
   */
  async resolveTarget() {
    if (this.hasTarget()) {
      this.ready = true
      return true
    }
    const target = this.config.target ?? {}
    if (target.discover === false) return false
    if (typeof this.config.appId !== 'string' || this.config.appId.length === 0) return false
    try {
      const chats = await this.lark.listChats()
      const wanted = typeof target.chatName === 'string' ? target.chatName : ''
      const match = wanted.length > 0
        ? chats.find((chat) => chat.name === wanted)
        : chats.length === 1
          ? chats[0]
          : undefined
      if (match !== undefined) {
        target.chatId = match.chatId
        this.log(`discovered target chat ${match.chatId} (${match.name.length > 0 ? match.name : 'unnamed'})`)
        this.ready = true
        return true
      }
      const candidates = chats.slice(0, 5).map((chat) => chat.name.length > 0 ? chat.name : chat.chatId).join(', ')
      this.lastIssue = chats.length === 0
        ? '机器人还没有加入任何群：请先建群并把它拉进去，再填写群名。'
        : `机器人所在的群有多个，请在设置里填写目标群名（候选：${candidates}）。`
      this.log(`target discovery: bot is in ${String(chats.length)} group chat(s); set target.chatName or target.chatId`
        + (candidates.length > 0 ? ` (candidates: ${candidates})` : ''))
    } catch (error) {
      this.lastIssue = `列举群失败：${String(error?.message ?? error)}`
      this.log('target discovery failed:', String(error?.message ?? error))
    }
    return false
  }

  /** Decide how Feishu answers reach the bridge. */
  async detectMode() {
    if (this.mode !== 'detecting' && this.consumer !== undefined) {
      this.log(`receive mode already active: ${this.mode}`)
      return
    }
    const configured = this.config.receive
    if (configured === 'poll') {
      this.mode = 'poll'
      this.log('receive mode: poll (configured)')
      return
    }
    if (configured === 'callback') {
      this.mode = 'callback'
      this.startConsumer()
      void this.ensureMessageConsumer()
      this.log('receive mode: callback (configured)')
      return
    }
    const published = await this.lark.probeCardEvents()
    if (!published.ok) {
      this.mode = 'poll'
      this.log(`receive mode: poll (card callback unavailable: ${published.reason}); text replies will be used`)
      return
    }
    const mode = await this.probeCallback()
    if (this.disposed) return
    this.mode = mode
    if (mode === 'callback') {
      this.log('receive mode: callback (long connection available)')
      void this.ensureMessageConsumer()
    } else {
      this.log('receive mode: poll (long connection is owned by another consumer); text replies will be used')
    }
  }

  /** Try to own a card callback consumer; resolve 'callback' only after ready. */
  probeCallback() {
    return new Promise((resolve) => {
      let settled = false
      const finish = (mode) => {
        if (settled) return
        settled = true
        if (this.modeTimer !== undefined) clearTimeout(this.modeTimer)
        resolve(mode)
      }
      this.modeTimer = setTimeout(() => {
        this.log('card callback consumer was not ready in time; falling back to poll')
        this.stopConsumer()
        finish('poll')
      }, CALLBACK_PROBE_MS)
      this.modeTimer.unref?.()
      this.startConsumer((mode) => {
        if (mode === 'callback') finish('callback')
        else finish('poll')
      })
    })
  }

  /** Start the card callback consumer; `onProbe` receives the first decision. */
  startConsumer(onProbe) {
    if (this.consumer !== undefined) return
    let probeDone = false
    this.consumer = this.lark.startCardConsumer({
      onEvent: (event) => { void this.onCardAction(event) },
      onReady: () => {
        if (!probeDone) {
          probeDone = true
          onProbe?.('callback')
        }
      },
      onExit: (info) => {
        if (!probeDone) {
          probeDone = true
          onProbe?.('poll')
          // A failed probe means another consumer owns the long connection;
          // stop retrying so we do not spray auth checks every few seconds.
          this.stopConsumer()
          return
        }
        if (this.mode === 'callback' && !info.wasReady) {
          this.log('callback consumer unavailable; switching to text-reply polling')
          this.mode = 'poll'
          this.stopConsumer()
        }
      },
    })
  }

  /** Stop and forget the event consumers (callbacks and text messages). */
  stopConsumer() {
    for (const key of ['consumer', 'messageConsumer']) {
      const consumer = this[key]
      if (consumer === undefined) continue
      this[key] = undefined
      try { consumer.close() } catch { /* ignore */ }
    }
  }

  /** Human label for logs, keeping raw ids out of routine lines. */
  targetLabel() {
    if (typeof this.config.target?.chatId === 'string' && this.config.target.chatId.length > 0) return 'group'
    if (typeof this.config.target?.userId === 'string' && this.config.target.userId.length > 0) return 'dm'
    return 'none'
  }

  /** Delivery target for lark-cli. */
  target() {
    return this.config.target
  }

  /** Snapshot reported to the settings page. */
  status() {
    return {
      enabled: this.config.enabled === true,
      ready: this.ready === true,
      issue: this.lastIssue ?? '',
      mode: this.mode,
      pending: this.prompts.size,
      isolated: this.larkHome !== undefined,
      cli: this.lark.bin,
      profile: this.lark.profile ?? '',
      target: {
        chatId: this.config.target?.chatId ?? '',
        userId: this.config.target?.userId ?? '',
        chatName: this.config.target?.chatName ?? '',
        discover: this.config.target?.discover !== false,
      },
      bridge: { ...this.config.bridge },
      receive: this.config.receive,
      watchMessages: this.config.watchMessages !== false,
      chat: {
        ...(this.config.chat ?? {}),
        bindings: [...this.chatBindings.entries()].map(([chatId, sessionId]) => ({ chatId, sessionId })),
      },
      appId: this.config.appId ?? '',
      larkCliPath: this.config.larkCliPath ?? '',
      maxPending: this.config.maxPending,
      pollIntervalMs: this.config.pollIntervalMs,
      secretConfigured: typeof this.config.appSecret === 'string' && this.config.appSecret.length > 0,
      configFile: this.config.file,
    }
  }

  /** Whether a usable delivery target exists. */
  hasTarget() {
    return (typeof this.config.target?.chatId === 'string' && this.config.target.chatId.length > 0)
      || (typeof this.config.target?.userId === 'string' && this.config.target.userId.length > 0)
  }

  /** Whether one Feishu operator may answer. */
  isAllowed(operatorId) {
    if (typeof operatorId !== 'string' || operatorId.length === 0) return false
    if (this.allow.size === 0) return true
    return this.allow.has(operatorId)
  }

  /** Create the in-memory record for one pending prompt. */
  createEntry(kind, request, agent, extra = {}) {
    this.seq += 1
    const id = `p${this.seq.toString(36)}${Date.now().toString(36).slice(-4)}`
    const entry = {
      id,
      kind,
      request,
      agent,
      context: cardContext(agent, this.ctx),
      questions: request.questions,
      toolName: request.toolName,
      reason: request.reason,
      displayReason: request.displayReason,
      final: deferred(),
      settled: false,
      settledBy: undefined,
      settledState: undefined,
      settledValue: undefined,
      cancel: new AbortController(),
      messageId: undefined,
      chatId: undefined,
      baselinePosition: 0,
      pollAnswers: new Map(),
      token: undefined,
      sendError: undefined,
      desktopError: undefined,
      createdAt: Date.now(),
      pruneTimer: undefined,
      ...extra,
    }
    this.prompts.set(id, entry)
    this.startPolling()
    return entry
  }

  /** Replace the request signal with one that also aborts when Feishu wins. */
  wrapSignal(request, entry) {
    const original = request.signal
    try {
      const wrapped = original === undefined
        ? entry.cancel.signal
        : AbortSignal.any([original, entry.cancel.signal])
      request.signal = wrapped
      return original
    } catch (error) {
      this.log('could not wrap request signal:', String(error?.message ?? error))
      return original
    }
  }

  /** Watch the caller's own cancellation lifetime outside the wrapped signal. */
  watchAbort(entry, original) {
    if (original === undefined) return
    const abort = () => {
      if (entry.settled) return
      this.log(`prompt ${entry.id} aborted by caller`)
      this.settleEntry(entry, 'expired')
      entry.final.reject(original.reason ?? new Error('feishu-bridge: request was cancelled'))
    }
    if (original.aborted) abort()
    else original.addEventListener('abort', abort, { once: true })
  }

  /** Mark an entry settled; returns false when another channel already claimed it. */
  claim(entry, channel) {
    if (entry.settled) return false
    entry.settled = true
    entry.settledBy = channel
    if (channel === 'feishu') {
      // Cancelling this signal makes the Gateway cancel the forwarded desktop
      // waterfall, whose card closes itself on the cancel frame.
      try {
        entry.cancel.abort(new Error('answered-from-feishu'))
      } catch { /* ignore */ }
    }
    return true
  }

  /** Record the final card state and apply it (or defer until the card exists). */
  settleEntry(entry, channel, value) {
    entry.settledState = channel
    entry.settledValue = value
    this.applySettledCard(entry, channel, value)
  }

  /** Render and push the settled card through the best available channel. */
  applySettledCard(entry, channel, value, token) {
    if (entry.messageId === undefined) return
    const state = channel === 'aborted' ? 'expired' : channel
    const card = buildSettledCard({
      state,
      context: entry.context,
      questions: entry.kind === 'question' ? entry.questions : undefined,
      answers: entry.kind === 'question' ? value : undefined,
      toolName: entry.kind === 'approval' ? entry.toolName : undefined,
      detail: entry.kind === 'approval'
        ? `**结果**：${value === 'allowed-once' ? '已允许一次' : value === 'rejected' ? '已拒绝' : '已取消'}`
        : undefined,
    })
    const useToken = token ?? entry.token
    void this.lark.updateCard({ token: useToken, messageId: entry.messageId, card })
      .then((via) => { this.log(`prompt ${entry.id} card settled via ${via}`) })
      .catch((error) => { this.log(`prompt ${entry.id} card settle failed:`, String(error?.message ?? error)) })
  }

  /**
   * A new app cannot update cards the old bot sent, and the old app's answers can
   * no longer reach this Host: mark those cards invalid and drop the Feishu side
   * of their prompts, while the desktop answerer stays free to answer.
   */
  invalidatePendingForAppSwitch() {
    if (this.prompts.size === 0) return
    const oldLark = this.lark
    for (const entry of [...this.prompts.values()]) {
      const messageId = entry.messageId
      this.prompts.delete(entry.id)
      if (typeof messageId === 'string') this.byMessage.delete(messageId)
      entry.messageId = undefined
      if (typeof messageId === 'string') {
        const card = buildSettledCard({
          state: 'expired',
          context: entry.context,
          questions: entry.kind === 'question' ? entry.questions : undefined,
          detail: '飞书应用配置已切换；本请求的飞书通道已失效，请在电脑端继续作答。',
        })
        void oldLark.updateCard({ messageId, card })
          .catch((error) => { this.log('app-switch card notice failed:', String(error?.message ?? error)) })
      }
      this.log(`prompt ${entry.id} Feishu side invalidated by app switch; desktop can still answer`)
    }
  }

  /** Remove a settled entry from the live map but keep it for late clicks. */
  cleanup(entry) {
    this.prompts.delete(entry.id)
    if (entry.messageId !== undefined) {
      if (entry.pruneTimer !== undefined) clearTimeout(entry.pruneTimer)
      entry.pruneTimer = setTimeout(() => {
        this.byMessage.delete(entry.messageId)
        this.updatePolling()
      }, LATE_RETENTION_MS)
      entry.pruneTimer.unref?.()
    }
    this.updatePolling()
  }

  /** Fail an entry before any channel answered. */
  failEntry(entry, error) {
    if (entry.settled) return
    entry.settled = true
    entry.settledBy = 'error'
    entry.final.reject(error)
  }

  /** Build the card appropriate for the current receive mode. */
  questionCard(entry) {
    if (this.mode === 'callback') {
      return buildQuestionCard({ promptId: entry.id, context: entry.context, questions: entry.questions })
    }
    return buildTextQuestionCard({
      promptId: entry.id,
      context: entry.context,
      questions: entry.questions,
      answered: entry.pollAnswers.size > 0 ? entry.pollAnswers : undefined,
    })
  }

  /** Send the card for one question request. */
  async sendQuestionCard(entry) {
    try {
      const { messageId, chatId } = await this.lark.sendCard(this.questionCard(entry), this.target())
      entry.messageId = messageId
      entry.chatId = chatId ?? entry.chatId
      this.byMessage.set(messageId, entry)
      this.log(`prompt ${entry.id} question card sent (${messageId}, mode=${this.mode})`)
      if (entry.agent?.session?.header?.origin !== 'subagent') this.lastPromptSessionId = entry.agent.session.id
      await this.ensureChatBaseline(entry)
      if (entry.settledState !== undefined) this.applySettledCard(entry, entry.settledState, entry.settledValue)
    } catch (error) {
      entry.sendError = error
      this.lastIssue = `发送飞书卡片失败：${String(error?.message ?? error)}`
      this.log(`prompt ${entry.id} question card failed:`, String(error?.message ?? error))
      if (entry.desktopError !== undefined) this.failEntry(entry, entry.desktopError)
    }
  }

  /** Send the card for one approval request. */
  async sendApprovalCard(entry) {
    const card = this.mode === 'callback'
      ? buildApprovalCard({
        promptId: entry.id,
        context: entry.context,
        toolName: entry.toolName,
        reason: entry.reason,
        displayReason: entry.displayReason,
      })
      : buildTextApprovalCard({
        promptId: entry.id,
        context: entry.context,
        toolName: entry.toolName,
        reason: entry.reason,
        displayReason: entry.displayReason,
      })
    try {
      const { messageId, chatId } = await this.lark.sendCard(card, this.target())
      entry.messageId = messageId
      entry.chatId = chatId ?? entry.chatId
      this.byMessage.set(messageId, entry)
      this.log(`prompt ${entry.id} approval card sent (${messageId}, mode=${this.mode})`)
      if (entry.agent?.session?.header?.origin !== 'subagent') this.lastPromptSessionId = entry.agent.session.id
      await this.ensureChatBaseline(entry)
      if (entry.settledState !== undefined) this.applySettledCard(entry, entry.settledState, entry.settledValue)
    } catch (error) {
      entry.sendError = error
      this.lastIssue = `发送飞书卡片失败：${String(error?.message ?? error)}`
      this.log(`prompt ${entry.id} approval card failed:`, String(error?.message ?? error))
      if (entry.desktopError !== undefined) this.failEntry(entry, entry.desktopError)
    }
  }

  /**
   * Seed the polling baseline from the sent card's message position, so only
   * replies that come after the card count as answers.
   */
  async ensureChatBaseline(entry) {
    if (entry.messageId === undefined) return
    let position = 0
    try {
      const message = await this.lark.getMessage(entry.messageId)
      position = message?.position ?? 0
      // The send API does not return the chat id for a DM; the message lookup does.
      if (typeof message?.chatId === 'string' && message.chatId.length > 0) entry.chatId = message.chatId
    } catch (error) {
      this.log('could not read card position:', String(error?.message ?? error))
    }
    if (typeof entry.chatId !== 'string' || entry.chatId.length === 0) {
      const configuredChat = this.config.target?.chatId
      if (typeof configuredChat === 'string' && configuredChat.length > 0) entry.chatId = configuredChat
    }
    if (typeof entry.chatId !== 'string' || entry.chatId.length === 0) {
      this.log(`prompt ${entry.id}: no chat id available; text replies cannot be polled for this prompt`)
      return
    }
    if (position === 0) {
      try {
        const messages = await this.lark.listMessages(entry.chatId, { limit: 1 })
        position = messages[0]?.position ?? 0
      } catch { /* polling will start from 0 */ }
    }
    entry.baselinePosition = position
    if (!this.chatSince.has(entry.chatId)) this.chatSince.set(entry.chatId, position)
    this.log(`prompt ${entry.id}: polling chat from position ${String(position)}`)
  }

  /** Track a desktop answerer failure without giving up the Feishu path yet. */
  desktopFailed(entry, error) {
    entry.desktopError = error
    this.log(`prompt ${entry.id} desktop answerer failed:`, String(error?.message ?? error))
    if (entry.sendError !== undefined) this.failEntry(entry, error)
  }

  /** user-questions/request waterfall listener. */
  onQuestionRequest(request, next) {
    if (!this.config.bridge.questions) return next()
    if (this.config.enabled !== true || this.mode === 'detecting' || this.ready !== true) return next()
    const agent = request.agent
    if (agent === undefined || !Array.isArray(request.questions) || request.questions.length === 0) return next()
    if (agent.session?.header?.origin === 'subagent') return next()
    if (this.prompts.size >= this.config.maxPending) {
      this.log('too many open prompts; leaving this one to the desktop')
      return next()
    }
    const entry = this.createEntry('question', request, agent)
    const original = this.wrapSignal(request, entry)
    this.watchAbort(entry, original)
    void this.sendQuestionCard(entry)
    const desktop = Promise.resolve().then(() => next())
    void desktop.then(
      (value) => {
        if (this.claim(entry, 'desktop')) {
          this.settleEntry(entry, 'desktop', value?.answers)
          entry.final.resolve({ channel: 'desktop', value })
        }
      },
      (error) => { this.desktopFailed(entry, error) },
    )
    return entry.final.promise.then(
      (outcome) => {
        this.cleanup(entry)
        return outcome.value
      },
      (error) => {
        this.cleanup(entry)
        throw error
      },
    )
  }

  /** approval/request waterfall listener. */
  onApprovalRequest(request, next) {
    if (!this.config.bridge.approvals) return next()
    if (this.config.enabled !== true || this.mode === 'detecting' || this.ready !== true) return next()
    const agent = request.agent
    if (agent === undefined) return next()
    if (agent.session?.header?.origin === 'subagent') return next()
    if (this.prompts.size >= this.config.maxPending) return next()
    const entry = this.createEntry('approval', request, agent)
    const original = this.wrapSignal(request, entry)
    this.watchAbort(entry, original)
    void this.sendApprovalCard(entry)
    const desktop = Promise.resolve().then(() => next())
    void desktop.then(
      (outcome) => {
        if (this.claim(entry, 'desktop')) {
          this.settleEntry(entry, 'desktop', outcome)
          entry.final.resolve({ channel: 'desktop', value: outcome })
        }
      },
      (error) => { this.desktopFailed(entry, error) },
    )
    return entry.final.promise.then(
      (outcome) => {
        this.cleanup(entry)
        return outcome.value
      },
      (error) => {
        this.cleanup(entry)
        throw error
      },
    )
  }

  /** Handle one card callback event. */
  async onCardAction(event) {
    const eventId = event?.event_id
    if (typeof eventId === 'string') {
      if (this.seenEvents.has(eventId)) return
      this.seenEvents.add(eventId)
      if (this.seenEvents.size > SEEN_EVENT_LIMIT) {
        const first = this.seenEvents.values().next().value
        this.seenEvents.delete(first)
      }
    }
    const operatorId = event?.operator_id
    const token = typeof event?.token === 'string' ? event.token : undefined
    const messageId = typeof event?.message_id === 'string' ? event.message_id : undefined
    const chatId = typeof event?.chat_id === 'string' ? event.chat_id : undefined
    const action = parseAction(event)
    const promptId = action.value?.p
    const entry = (messageId !== undefined ? this.byMessage.get(messageId) : undefined)
      ?? (typeof promptId === 'string' ? this.prompts.get(promptId) : undefined)
    if (!this.isAllowed(operatorId)) {
      this.log(`card action from disallowed operator (${String(operatorId ?? 'unknown')})`)
      if (messageId !== undefined) {
        await this.lark.updateCard({
          token,
          messageId,
          card: buildNoticeCard({
            title: '⛔ 无权操作',
            template: 'red',
            content: '你的账号不在该 DSH 桥接的授权名单内，本次操作无效。',
          }),
        }).catch((error) => { this.log('denied notice failed:', String(error?.message ?? error)) })
      }
      return
    }
    if (entry === undefined) {
      this.log('card action for an unknown or expired prompt')
      await this.lark.updateCard({
        token,
        messageId,
        card: buildNoticeCard({
          title: '⌛ 请求已结束',
          content: '该请求已完成、已取消或已超时，本次操作无效。',
        }),
      }).catch((error) => { this.log('stale notice failed:', String(error?.message ?? error)) })
      return
    }
    if (chatId !== undefined) entry.chatId = chatId
    if (token !== undefined) entry.token = token
    if (entry.settled) {
      await this.notifyLate(entry, token, messageId)
      return
    }
    if (entry.kind === 'question') {
      await this.onQuestionAction(entry, action, token)
      return
    }
    await this.onApprovalAction(entry, action, token)
  }

  /** Apply a question answer submitted from Feishu card controls. */
  async onQuestionAction(entry, action, token) {
    let result
    if (action.form !== undefined) {
      result = collectAnswers(entry.questions, action.form)
    } else if (action.value?.t === 'q') {
      result = answerFromButton(entry.questions, action.value.q, action.value.v)
    } else {
      result = { ok: false, error: '无法识别的卡片操作' }
    }
    if (!result.ok) {
      this.log(`prompt ${entry.id} rejected incomplete submission:`, result.error)
      await this.noticeInChat(entry, `⚠️ ${result.error}（请求仍未完成，可继续选择或填写）`)
      return
    }
    if (!this.claim(entry, 'feishu')) {
      await this.notifyLate(entry, token, entry.messageId)
      return
    }
    this.log(`prompt ${entry.id} answered from Feishu (card)`)
    this.settleEntry(entry, 'feishu', result.answers, token)
    entry.final.resolve({ channel: 'feishu', value: { answers: result.answers } })
  }

  /** Apply an approval decision submitted from Feishu card controls. */
  async onApprovalAction(entry, action, token) {
    const outcome = action.value?.t === 'a' ? action.value.v : undefined
    if (outcome !== 'allowed-once' && outcome !== 'rejected') {
      this.log(`prompt ${entry.id} received an unrecognised approval action`)
      await this.noticeInChat(entry, '⚠️ 无法识别的审批操作，请重新点击按钮。')
      return
    }
    if (!this.claim(entry, 'feishu')) {
      await this.notifyLate(entry, token, entry.messageId)
      return
    }
    this.log(`prompt ${entry.id} approval decided from Feishu (card): ${outcome}`)
    this.settleEntry(entry, 'feishu', outcome, token)
    entry.final.resolve({ channel: 'feishu', value: outcome })
  }

  /** Poll the chat for text replies while at least one prompt is open. */
  startPolling() {
    if (this.pollTimer !== undefined) return
    this.idleTicks = 0
    const interval = Math.max(Math.trunc(this.config.pollIntervalMs), 500)
    this.pollTimer = setInterval(() => { void this.pollOnce() }, interval)
    this.pollTimer.unref?.()
  }

  /** Stop polling when nothing is open. */
  stopPolling() {
    if (this.pollTimer === undefined) return
    clearInterval(this.pollTimer)
    this.pollTimer = undefined
  }

  /** Poll fast while prompts are open, slowly for late replies and watched messages. */
  updatePolling() {
    const active = this.prompts.size > 0
    const watching = [...this.byMessage.values()]
      .some((entry) => entry.settled === true && typeof entry.chatId === 'string' && this.chatSince.has(entry.chatId))
    const messaging = this.config.watchMessages !== false && this.chatSince.size > 0
    if (active || watching || messaging) this.startPolling()
    else this.stopPolling()
  }

  /** One polling pass across every chat with an open or recently settled prompt. */
  async pollOnce() {
    if (this.polling) return
    if (this.prompts.size === 0) {
      // Late replies are only worth a slow watch; skip most ticks while idle.
      const idleEvery = Math.max(1, Math.floor(
        Math.max(this.config.idlePollIntervalMs ?? 30_000, this.config.pollIntervalMs) / Math.max(this.config.pollIntervalMs, 500),
      ))
      this.idleTicks += 1
      if (this.idleTicks % idleEvery !== 0) return
    } else {
      this.idleTicks = 0
    }
    this.polling = true
    try {
      const chats = new Set()
      for (const entry of this.prompts.values()) {
        if (typeof entry.chatId === 'string' && this.chatSince.has(entry.chatId)) chats.add(entry.chatId)
      }
      for (const entry of this.byMessage.values()) {
        if (entry.settled === true && typeof entry.chatId === 'string' && this.chatSince.has(entry.chatId)) {
          chats.add(entry.chatId)
        }
      }
      if (this.config.watchMessages !== false) {
        for (const chatId of this.chatSince.keys()) chats.add(chatId)
      }
      if (chats.size === 0) {
        this.stopPolling()
        return
      }
      for (const chatId of chats) await this.pollChat(chatId)
    } catch (error) {
      this.log('poll pass failed:', String(error?.message ?? error))
    } finally {
      this.polling = false
    this.idleTicks = 0
    }
  }

  /** Read one chat's new user messages and route them to pending prompts. */
  async pollChat(chatId) {
    const since = this.chatSince.get(chatId) ?? 0
    const messages = await this.lark.listMessages(chatId, { limit: 30 })
    let max = since
    for (const message of messages) if (message.position > max) max = message.position
    const acceptBot = this.config.testAcceptBotReplies === true
    const fresh = messages
      .filter((message) => message.position > since
        && message.deleted !== true
        && message.msgType === 'text'
        && (message.senderType === 'user' || (acceptBot && message.senderType === 'app')))
      .sort((a, b) => a.position - b.position)
    this.chatSince.set(chatId, max)
    if (fresh.length > 0) this.log(`poll ${chatId}: ${String(fresh.length)} new user message(s)`)
    for (const message of fresh) {
      try {
        await this.onPollMessage(chatId, message)
      } catch (error) {
        this.log('text reply handling failed:', String(error?.message ?? error))
      }
    }
  }

  /**
   * Receive Feishu text messages over the same app connection when the console
   * publishes `im.message.receive_v1`; this is what makes a plain chat message
   * get an answer instead of being silently ignored.
   */
  async ensureMessageConsumer() {
    if (this.disposed || this.config.watchMessages === false || this.messageConsumer !== undefined) return
    const probe = await this.lark.probeEvents('im.message.receive_v1')
    if (!probe.ok) {
      this.log(`Feishu message events unavailable (${probe.reason}); only chats with prompts are polled`)
      return
    }
    if (this.disposed || this.messageConsumer !== undefined || this.config.watchMessages === false) return
    this.messageConsumer = this.lark.startEventConsumer({
      eventKey: 'im.message.receive_v1',
      onEvent: (event) => { void this.onMessageEvent(event) },
      onReady: () => { this.log('message consumer ready: Feishu text messages will be answered') },
      onExit: (info) => { this.log(`message consumer exited (code=${String(info?.code)})`) },
    })
  }

  /** Handle one inbound Feishu text message from the event consumer. */
  async onMessageEvent(event) {
    if (this.config.watchMessages === false) return
    const chatId = event?.chat_id
    const text = typeof event?.content === 'string' ? event.content : ''
    if (typeof chatId !== 'string' || chatId.length === 0 || text.trim().length === 0) return
    const messageId = typeof event?.message_id === 'string' && event.message_id.length > 0
      ? event.message_id
      : (typeof event?.id === 'string' ? event.id : undefined)
    const senderType = typeof event?.sender_type === 'string' ? event.sender_type : undefined
    const senderId = typeof event?.sender_id === 'string' ? event.sender_id : undefined
    const chatType = typeof event?.chat_type === 'string' ? event.chat_type : undefined
    if (senderType === 'bot') {
      if (this.config.testAcceptBotReplies !== true) return
      this.log('test injection: accepting a bot-authored message event')
    }
    try {
      await this.handleIncomingText({ chatId, chatType, messageId, senderId, senderType, text })
    } catch (error) {
      this.log('inbound message handling failed:', String(error?.message ?? error))
    }
  }

  /** Poll-path adapter: one chat message from the list API. */
  async onPollMessage(chatId, message) {
    const text = messageText(message)
    if (text.trim().length === 0) return
    await this.handleIncomingText({
      chatId,
      messageId: message.messageId,
      senderId: message.senderId,
      senderType: message.senderType,
      text,
      position: message.position,
      requirePosition: true,
    })
  }

  /**
   * One inbound text message: commands first, then prompt answering, then an
   * acknowledgement so a human never wonders whether the bot received anything.
   */
  async handleIncomingText({ chatId, chatType, messageId, senderId, senderType, text, position, requirePosition = false }) {
    if (typeof messageId === 'string' && messageId.length > 0) {
      if (this.seenMessageIds.has(messageId)) return
      this.seenMessageIds.add(messageId)
      if (this.seenMessageIds.size > 500) {
        const first = this.seenMessageIds.values().next().value
        this.seenMessageIds.delete(first)
      }
    }
    if (senderType === 'app') {
      if (this.config.testAcceptBotReplies !== true) return
    } else if (this.allow.size > 0 && !this.isAllowed(senderId)) {
      this.log(`ignoring message from disallowed sender (${String(senderId ?? 'unknown')})`)
      return
    }
    const trimmed = text.trim()
    const command = classifyCommand(trimmed)
    if (command !== undefined) {
      await this.replyText(chatId, this.commandReply(command, chatId))
      return
    }
    const pending = [...this.prompts.values()]
      .filter((entry) => entry.chatId === chatId && entry.settled !== true)
    const code = leadingPromptCode(trimmed, [
      ...pending.map((entry) => entry.id),
      ...[...this.byMessage.values()].filter((entry) => entry.settled === true).map((entry) => entry.id),
    ])
    if (pending.length === 0) {
      if (code !== undefined) {
        const settled = [...this.byMessage.values()].find((entry) => entry.id === code)
        if (settled !== undefined) {
          this.log(`prompt ${settled.id} received a late text reply (already settled by ${String(settled.settledBy)})`)
          await this.noticeInChat(settled, `⚠️ 该请求已由${channelLabel(settled.settledBy)}处理，本次飞书提交无效（已完成 / 已失效）。`)
          return
        }
      }
      if (this.config.chat?.enabled !== false && await this.forwardChatMessage(chatId, chatType, trimmed)) return
      await this.acknowledge(chatId, chatType)
      return
    }
    let target
    if (code !== undefined) {
      // The prompt's chat id may still be resolving when a very fast reply lands;
      // an explicit prompt code is enough to route it.
      target = pending.find((entry) => entry.id === code)
        ?? [...this.prompts.values()].find((entry) => entry.id === code && entry.settled !== true)
      if (target !== undefined && typeof target.chatId !== 'string') target.chatId = chatId
    } else {
      const eligible = requirePosition
        ? pending.filter((entry) => position > entry.baselinePosition)
        : pending
      target = eligible.sort((a, b) => a.createdAt - b.createdAt)[0]
    }
    if (target === undefined) {
      if (this.config.chat?.enabled !== false && await this.forwardChatMessage(chatId, chatType, trimmed)) return
      await this.acknowledge(chatId, chatType)
      return
    }
    if (target.settled === true) {
      this.log(`prompt ${target.id} received a late text reply (already settled by ${String(target.settledBy)})`)
      await this.noticeInChat(target, `⚠️ 该请求已由${channelLabel(target.settledBy)}处理，本次飞书提交无效（已完成 / 已失效）。`)
      return
    }
    const body = code === undefined ? trimmed : stripPromptCode(trimmed, code)
    if (target.kind === 'approval') {
      await this.applyApprovalText(target, body)
      return
    }
    await this.applyQuestionText(target, body)
  }

  /** Session title for user-facing text, when the title service is composed. */
  sessionTitleOf(session) {
    try {
      const titles = this.ctx.get('sessionTitle')
      const snapshot = titles?.get?.(session)
      return typeof snapshot?.title === 'string' && snapshot.title.length > 0 ? snapshot.title : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Feishu chat -> DSH: forward one plain message into a live session.
   * Returns false when the channel is disabled or no session can take it, so the
   * caller can fall back to a plain acknowledgement.
   */
  async forwardChatMessage(chatId, chatType, text) {
    const chat = { enabled: true, sessionId: '', mirror: true, allowGroups: false, ...(this.config.chat ?? {}) }
    if (chat.enabled === false) return false
    if (chatType === 'group' && chat.allowGroups !== true) {
      // Stay silent for ordinary group chatter: only commands and answers reply there.
      this.log('chat: group message ignored (chat channel disabled for groups)')
      return true
    }
    const sessionController = this.ctx.get('sessionController')
    if (sessionController === undefined || typeof sessionController.prompt !== 'function') {
      this.log('chat channel unavailable: no sessionController service')
      return false
    }
    let target
    try {
      target = await this.resolveChatTarget(chat, chatId)
    } catch (error) {
      this.log('chat target resolution failed:', String(error?.message ?? error))
      await this.replyText(chatId, `无法选择 DSH 会话：${String(error?.message ?? error)}`)
      return true
    }
    if (target === undefined) {
      await this.replyText(chatId, '当前没有可用的 DSH 会话；请先在 DSH 里打开一个会话，或在设置里填写「聊天项目目录」。')
      return true
    }
    const sessionId = target.sessionId
    const agent = target.agent
    const busy = agent === undefined ? false : this.sessionBusy(agent)
    const first = this.chatBindings.get(chatId) !== sessionId
    try {
      await sessionController.prompt({
        requestId: randomUUID(),
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
      }, new AbortController().signal)
    } catch (error) {
      this.log('chat forward failed:', String(error?.message ?? error))
      await this.replyText(chatId, `转交 DSH 失败：${String(error?.message ?? error)}`)
      return true
    }
    this.chatBindings.set(chatId, sessionId)
    this.log(`chat: forwarded a Feishu message to session ${sessionId}`)
    if (first) {
      const title = (agent === undefined ? undefined : this.sessionTitleOf(agent.session)) ?? sessionId.slice(0, 12)
      const suffix = busy ? '（该会话正在处理其他任务，消息会排队等待）' : ''
      await this.replyText(chatId, `已连接 DSH 会话「${title}」${suffix}。之后这里的消息会转交给它，agent 的回复会同步发到这里。`)
    } else if (busy) {
      await this.replyText(chatId, '目标会话正在处理其他任务，消息已排队，处理完会回复到这里。')
    }
    return true
  }

  /** Resolve the session a Feishu chat should talk to: pinned, bound, or newest live root. */
  resolveChatBinding(chat, chatId) {
    const agents = this.ctx.get('agents')
    if (agents === undefined || typeof agents.list !== 'function') return undefined
    const live = (sessionId) => {
      const agent = agents.get(sessionId)
      if (agent === undefined) return undefined
      return agent.session.header.origin === 'subagent' ? undefined : agent
    }
    if (typeof chat.sessionId === 'string' && chat.sessionId.length > 0) {
      const pinned = live(chat.sessionId)
      if (pinned !== undefined) return pinned
      this.log(`chat channel: pinned session ${chat.sessionId} is not live; falling back to the newest live session`)
    }
    const boundId = this.chatBindings.get(chatId)
    if (boundId !== undefined) {
      const bound = live(boundId)
      if (bound !== undefined) return bound
      this.chatBindings.delete(chatId)
    }
    // Prefer the session that last asked the human through Feishu.
    if (this.lastPromptSessionId !== undefined) {
      const prompting = live(this.lastPromptSessionId)
      if (prompting !== undefined) return prompting
    }
    // Then the newest idle session; a busy session would only queue the message.
    let idleBest
    let idleTime = -1
    let busyBest
    let busyTime = -1
    for (const agent of agents.list()) {
      if (agent.session.header.origin === 'subagent') continue
      const time = this.sessionRecency(agent)
      if (this.sessionBusy(agent)) {
        if (time >= busyTime) {
          busyTime = time
          busyBest = agent
        }
      } else if (time >= idleTime) {
        idleTime = time
        idleBest = agent
      }
    }
    return idleBest ?? busyBest
  }

  /** Whether the session has an open turn (a queued prompt would only wait). */
  sessionBusy(agent) {
    try {
      const events = typeof agent.session.snapshotEvents === 'function' ? agent.session.snapshotEvents() : []
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const type = events[index]?.type
        if (type === 'turn/end') return false
        if (type === 'turn/start') return true
      }
    } catch { /* unknown -> treat as idle */ }
    return false
  }

  /**
   * Resolve the session for one chat message. A configured project directory
   * wins: use a live session there, otherwise create one; without it fall back
   * to pinned/bound/newest live session.
   */
  async resolveChatTarget(chat, chatId) {
    const agents = this.ctx.get('agents')
    if (agents === undefined || typeof agents.list !== 'function') return undefined
    const wantedCwd = typeof chat.cwd === 'string' ? chat.cwd.trim() : ''
    if (wantedCwd.length > 0) {
      const found = this.findLiveSessionForCwd(agents, wantedCwd)
      if (found !== undefined) return { agent: found, sessionId: found.session.id }
      const sessionController = this.ctx.get('sessionController')
      if (sessionController === undefined || typeof sessionController.create !== 'function') {
        throw new Error('当前 DSH 无法创建会话')
      }
      const created = await sessionController.create({ cwd: wantedCwd })
      this.log(`chat: created a DSH session in ${wantedCwd} (${created.sessionId})`)
      return { agent: agents.get(created.sessionId), sessionId: created.sessionId }
    }
    const agent = this.resolveChatBinding(chat, chatId)
    return agent === undefined ? undefined : { agent, sessionId: agent.session.id }
  }

  /** Newest live root session whose working directory equals one path. */
  findLiveSessionForCwd(agents, cwd) {
    const normalized = cwd.replace(/[\\/]+$/, '')
    let best
    let bestTime = -1
    for (const agent of agents.list()) {
      if (agent.session.header.origin === 'subagent') continue
      const sessionCwd = typeof agent.session.header.cwd === 'string'
        ? agent.session.header.cwd.replace(/[\\/]+$/, '')
        : ''
      if (sessionCwd !== normalized) continue
      const time = this.sessionRecency(agent)
      if (time >= bestTime) {
        bestTime = time
        best = agent
      }
    }
    return best
  }

  /** Last-event timestamp of a live session, used to choose the most recent one. */
  sessionRecency(agent) {
    try {
      const events = typeof agent.session.snapshotEvents === 'function' ? agent.session.snapshotEvents() : []
      return events.length > 0 ? Number(events[events.length - 1]?.time ?? 0) : 0
    } catch {
      return 0
    }
  }

  /** Mirror one assistant message from a bound session back to Feishu. */
  async onSessionEvent(session, event) {
    if (event?.type !== 'assistant/message') return
    const chat = { enabled: true, mirror: true, ...(this.config.chat ?? {}) }
    if (chat.enabled === false || chat.mirror === false) return
    const chatIds = [...this.chatBindings.entries()]
      .filter(([, sessionId]) => sessionId === session.id)
      .map(([chatId]) => chatId)
    if (chatIds.length === 0) return
    const text = extractAssistantText(event.data?.message)
    if (text.length === 0) return
    this.log(`chat: mirroring an assistant message to ${String(chatIds.length)} Feishu chat(s)`)
    for (const chatId of chatIds) await this.sendChunked(chatId, text)
  }

  /** Send long assistant text as several Feishu messages without breaking lines. */
  async sendChunked(chatId, text, limit = 3000) {
    const parts = []
    let rest = text
    while (rest.length > limit) {
      let cut = rest.lastIndexOf('\n', limit)
      if (cut < limit / 2) cut = limit
      parts.push(rest.slice(0, cut))
      rest = rest.slice(cut).replace(/^\n/, '')
    }
    if (rest.length > 0) parts.push(rest)
    for (const part of parts) await this.replyText(chatId, part)
  }

  /** Tell a human their message arrived but matches nothing (DM only, or when asked). */
  async acknowledge(chatId, chatType) {
    if (chatType === 'group' || (chatType === undefined && !this.isDmTarget())) return
    await this.replyText(chatId, '已收到你的消息。当前没有待确认的请求；这个机器人用于 DSH 的确认/审批作答，发送「状态」查看桥接状态，发送「帮助」查看用法。')
  }

  /** Reply text for one recognized command. */
  commandReply(command, chatId) {
    if (command === 'ping') return 'pong'
    if (command === 'unbind') {
      this.chatBindings.delete(chatId)
      return '已解除本飞书会话的 DSH 会话绑定；下一条消息会重新选择会话（可在设置页固定项目目录或绑定会话 ID）。'
    }
    if (command === 'project') {
      const chat = { ...(this.config.chat ?? {}) }
      const sessionId = this.chatBindings.get(chatId) ?? (chat.sessionId || '')
      const agents = this.ctx.get('agents')
      const agent = sessionId.length > 0 && agents !== undefined ? agents.get(sessionId) : undefined
      const cwd = agent?.session?.header?.cwd
      const title = agent === undefined ? undefined : this.sessionTitleOf(agent.session)
      return [
        'DSH 飞书聊天项目',
        `· 项目目录：${typeof cwd === 'string' && cwd.length > 0 ? cwd : (chat.cwd || '跟随最近活跃会话')}`,
        `· 会话：${sessionId.length > 0 ? sessionId : '尚未绑定（发一条普通消息即可绑定）'}`,
        `· 会话标题：${title ?? '（未生成）'}`,
      ].join('\n')
    }
    if (command === 'help') {
      return [
        'DSH 飞书桥接用法：',
        '· 有确认请求时：回「1」选第 1 个选项，或直接回文字作为自定义答案；多问题每行一条如 `1=2`、`2=补充说明`；多选 `1,3`。',
        '· 「状态」：查看桥接是否运行、当前待确认数量、目标与应用。',
        '· 「帮助」：显示本说明。',
        '· 这个机器人只负责 DSH 的确认/审批作答，不是通用聊天入口。',
      ].join('\n')
    }
    const target = this.config.target ?? {}
    const targetText = target.chatId || target.chatName || target.userId || '未配置'
    return [
      'DSH 飞书桥接状态',
      `· 运行：${this.config.enabled !== true ? '已停用' : this.ready === true ? '运行中' : '等待目标'}`,
      `· 接收方式：${this.mode === 'callback' ? '卡片按钮（长连接）' : this.mode === 'poll' ? '消息作答（轮询）' : '检测中'}`,
      `· 待确认请求：${String(this.prompts.size)}`,
      `· 目标：${targetText}`,
      `· 应用：${this.config.appId || '宿主 lark-cli'}`,
      `· 监听飞书消息：${this.config.watchMessages !== false ? '开' : '关'}`,
    ].join('\n')
  }

  /** Whether the configured delivery target is a direct message. */
  isDmTarget() {
    const target = this.config.target ?? {}
    if (typeof target.userId === 'string' && target.userId.length > 0) return true
    if (typeof target.chatId === 'string' && target.chatId.length > 0) return false
    return true
  }

  /** Send one plain-text reply to a chat. */
  async replyText(chatId, text) {
    if (typeof chatId !== 'string' || chatId.length === 0) return
    try {
      await this.lark.sendText({ chatId, text })
    } catch (error) {
      this.log('reply failed:', String(error?.message ?? error))
    }
  }

  /** Apply one text answer to a question prompt (may be a partial batch). */
  async applyQuestionText(entry, text) {
    const parsed = parseQuestionReply(entry.questions, text, entry.pollAnswers)
    if (!parsed.ok) {
      this.log(`prompt ${entry.id} text reply rejected: ${parsed.error}`)
      await this.noticeInChat(entry, `⚠️ ${parsed.error}`)
      return
    }
    entry.pollAnswers = parsed.answers
    if (!parsed.complete) {
      const remaining = parsed.missing.length
      this.log(`prompt ${entry.id} partial text answer (${String(remaining)} left)`)
      await this.showProgress(entry, `已记录，还剩 ${String(remaining)} 个问题待回答。`)
      return
    }
    const answers = entry.questions.map((_question, index) => parsed.answers.get(index))
    if (!this.claim(entry, 'feishu')) return
    this.log(`prompt ${entry.id} answered from Feishu (text)`)
    this.settleEntry(entry, 'feishu', answers)
    entry.final.resolve({ channel: 'feishu', value: { answers } })
  }

  /** Apply one text answer to an approval prompt. */
  async applyApprovalText(entry, text) {
    const parsed = parseApprovalReply(text)
    if (!parsed.ok) {
      await this.noticeInChat(entry, `⚠️ ${parsed.error}`)
      return
    }
    if (!this.claim(entry, 'feishu')) return
    this.log(`prompt ${entry.id} approval decided from Feishu (text): ${parsed.outcome}`)
    this.settleEntry(entry, 'feishu', parsed.outcome)
    entry.final.resolve({ channel: 'feishu', value: parsed.outcome })
  }

  /** Show partial progress: patch the card in poll mode, else tell the chat. */
  async showProgress(entry, note) {
    if (this.mode === 'poll' && entry.messageId !== undefined) {
      const card = buildTextQuestionCard({
        promptId: entry.id,
        context: entry.context,
        questions: entry.questions,
        answered: entry.pollAnswers,
        note,
      })
      await this.lark.updateCard({ token: entry.token, messageId: entry.messageId, card })
        .catch((error) => { this.log('progress card failed:', String(error?.message ?? error)) })
      return
    }
    await this.noticeInChat(entry, `ℹ️ ${note}`)
  }

  /** Tell a late submitter that the other channel already settled the request. */
  async notifyLate(entry, token, messageId) {
    const label = channelLabel(entry.settledBy)
    this.log(`prompt ${entry.id} received a late submission (already settled by ${String(entry.settledBy)})`)
    const card = buildSettledCard({
      state: entry.settledBy === 'feishu' ? 'feishu' : entry.settledBy === 'desktop' ? 'late' : 'expired',
      context: entry.context,
      questions: entry.kind === 'question' ? entry.questions : undefined,
      answers: entry.kind === 'question' ? entry.settledValue : undefined,
      detail: `该请求已由**${label}**处理，本次提交无效。`,
    })
    await this.lark.updateCard({ token, messageId: messageId ?? entry.messageId, card })
      .catch((error) => { this.log('late notice card failed:', String(error?.message ?? error)) })
    await this.noticeInChat(entry, `⚠️ 该请求已由${label}处理，本次飞书提交无效（已完成 / 已失效）。`)
  }

  /** Send a short plain-text note to the prompt's chat. */
  async noticeInChat(entry, text) {
    const chatId = entry.chatId
    if (typeof chatId !== 'string' || chatId.length === 0) return
    try {
      await this.lark.sendText({ chatId, text })
    } catch (error) {
      this.log('chat notice failed:', String(error?.message ?? error))
    }
  }
}

/** Read the raw persisted config file (no defaults applied). */
function readConfigFile(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}

/** Write the config file with owner-only permissions. */
function writeConfigFile(file, value, log) {
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    return true
  } catch (error) {
    log('could not write config file:', String(error?.message ?? error))
    return false
  }
}

/** Send one JSON response. */
function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/** Read a bounded JSON request body. */
async function readJsonBody(req, limit = 64 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('body must be a JSON object')
  return value
}

const RECEIVE_MODES = new Set(['auto', 'poll', 'callback'])

/** Validate and merge one settings-page update onto the raw config. */
export function applyConfigUpdate(raw, body) {
  const next = { ...raw }
  if (typeof body.enabled === 'boolean') next.enabled = body.enabled
  const previousAppId = typeof raw.appId === 'string' ? raw.appId.trim() : ''
  if (typeof body.larkCliPath === 'string') {
    const cliPath = body.larkCliPath.trim()
    if (cliPath.length > 0) next.larkCliPath = cliPath
    else delete next.larkCliPath
  }
  if (typeof body.appId === 'string') {
    const appId = body.appId.trim()
    if (appId.length > 0) next.appId = appId
    else delete next.appId
  }
  const nextAppId = typeof next.appId === 'string' ? next.appId.trim() : ''
  if (Array.isArray(body.allowOperators)) {
    next.allowOperators = body.allowOperators.filter((value) => typeof value === 'string' && value.length > 0)
  } else if (nextAppId !== previousAppId) {
    // open_ids are app-scoped: the old app's allowlist cannot authorize the new one.
    next.allowOperators = []
  }
  if (nextAppId !== previousAppId) {
    // chat ids and open ids belong to one app; keep only values the caller supplied now.
    const target = { ...(next.target ?? {}) }
    for (const key of ['chatId', 'userId']) {
      if (typeof body.target?.[key] === 'string' && body.target[key].trim().length > 0) {
        target[key] = body.target[key].trim()
      } else {
        target[key] = ''
      }
    }
    next.target = target
  }
  if (body.appSecret === null) delete next.appSecret
  else if (typeof body.appSecret === 'string' && body.appSecret.trim().length > 0) next.appSecret = body.appSecret.trim()
  for (const [key, min, max] of [['maxPending', 1, 64], ['pollIntervalMs', 500, 600_000]]) {
    if (body[key] === undefined) continue
    const value = Number(body[key])
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new Error(`${key} 必须是 ${String(min)}-${String(max)} 之间的整数`)
    }
    next[key] = value
  }
  if (typeof body.receive === 'string') {
    if (!RECEIVE_MODES.has(body.receive)) throw new Error('receive 必须是 auto / poll / callback')
    next.receive = body.receive
  }
  if (typeof body.watchMessages === 'boolean') next.watchMessages = body.watchMessages
  if (body.chat !== null && typeof body.chat === 'object') {
    const chat = { ...(next.chat ?? {}) }
    for (const key of ['enabled', 'mirror', 'allowGroups']) {
      if (typeof body.chat[key] === 'boolean') chat[key] = body.chat[key]
    }
    if (typeof body.chat.sessionId === 'string') chat.sessionId = body.chat.sessionId.trim()
    if (typeof body.chat.cwd === 'string') chat.cwd = body.chat.cwd.trim()
    next.chat = chat
  }
  if (body.bridge !== null && typeof body.bridge === 'object') {
    const bridge = { questions: true, approvals: true, ...(raw.bridge ?? {}) }
    if (typeof body.bridge.questions === 'boolean') bridge.questions = body.bridge.questions
    if (typeof body.bridge.approvals === 'boolean') bridge.approvals = body.bridge.approvals
    next.bridge = bridge
  }
  if (body.target !== null && typeof body.target === 'object') {
    // Start from the already-normalized target so an app switch's cleared
    // app-scoped ids are not reintroduced from the raw config.
    const target = { ...(next.target ?? raw.target ?? {}) }
    for (const key of ['chatId', 'userId', 'chatName']) {
      if (typeof body.target[key] === 'string') target[key] = body.target[key].trim()
    }
    if (typeof body.target.discover === 'boolean') target.discover = body.target.discover
    next.target = target
  }
  if (typeof next.appId === 'string' && next.appId.length > 0 && next.appId !== '' && !/^cli_[A-Za-z0-9]+$/.test(next.appId)) {
    throw new Error('App ID 应以 cli_ 开头')
  }
  return next
}

/** Serve the settings-page JSON API through the Web server. */
function registerSettingsRoutes(ctx, bridge, log) {
  const webServer = ctx.get('webServer')
  if (webServer === undefined) {
    log('webServer is unavailable; the settings page API is not served')
    return () => {}
  }
  const snapshot = () => ({ ok: true, config: bridge.status() })
  const configHandler = async (req, res) => {
    try {
      if (req.method === 'GET') {
        sendJson(res, 200, snapshot())
        return
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      const body = await readJsonBody(req)
      const raw = readConfigFile(bridge.config.file)
      const next = applyConfigUpdate(raw, body)
      if (!writeConfigFile(bridge.config.file, next, log)) throw new Error('配置写入失败')
      await bridge.reloadConfig()
      bridge.configStamp = bridge.fileStamp()
      log('settings page saved the configuration')
      sendJson(res, 200, snapshot())
    } catch (error) {
      sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
    }
  }
  const testHandler = async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    try {
      if (!bridge.hasTarget()) throw new Error('还没有可用的飞书目标：请先填写目标群名或 chat_id 并保存')
      const card = buildNoticeCard({
        title: 'DSH 飞书桥接 · 连通性测试',
        template: 'green',
        content: '如果你在飞书看到这张卡片，说明插件配置已经生效。',
      })
      const sent = await bridge.lark.sendCard(card, bridge.target())
      sendJson(res, 200, { ok: true, messageId: sent.messageId, chatId: sent.chatId ?? '' })
    } catch (error) {
      sendJson(res, 200, { ok: false, error: String(error?.message ?? error) })
    }
  }
  const reloadHandler = async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    if (bridge.prompts.size > 0) {
      sendJson(res, 200, {
        ok: false,
        error: `当前还有 ${String(bridge.prompts.size)} 个未完成的确认请求，请处理完再热重载；重载会中断它们`,
      })
      return
    }
    const hmr = ctx.get('hmr')
    const canReload = hmr !== undefined
      && typeof hmr.runExclusive === 'function'
      && typeof hmr.reconcileProfile === 'function'
    if (!canReload) {
      sendJson(res, 200, {
        ok: false,
        error: '当前 DSH 未启用 HMR 热重载；请在插件管理里重新启用插件，或重启 DSH',
      })
      return
    }
    sendJson(res, 200, { ok: true, reloading: true })
    log('manual hot reload requested (settings page)')
    setTimeout(() => {
      void hmr.runExclusive(() => hmr.reconcileProfile()).then(
        (result) => { log('hot reload finished', JSON.stringify(result ?? {}).slice(0, 240)) },
        (error) => { log('hot reload failed:', String(error?.message ?? error)) },
      )
    }, 150)
  }
  const chatTestHandler = async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    try {
      if ((bridge.config.chat ?? {}).enabled === false) throw new Error('聊天通道未启用')
      const known = [...bridge.chatSince.keys()]
      let chatId = bridge.config.target?.chatId || known[known.length - 1]
      if (typeof chatId !== 'string' || chatId.length === 0) {
        // Learn the DM chat id by sending one short card to the configured target.
        const probe = await bridge.lark.sendCard(
          buildNoticeCard({ title: 'DSH 飞书桥接', content: '正在准备聊天通道自检…' }),
          bridge.target(),
        )
        chatId = probe.chatId
        if (typeof chatId !== 'string' || chatId.length === 0) {
          const message = await bridge.lark.getMessage(probe.messageId)
          chatId = message?.chatId
        }
        if (typeof chatId === 'string' && chatId.length > 0) bridge.chatSince.set(chatId, 0)
      }
      if (typeof chatId !== 'string' || chatId.length === 0) {
        throw new Error('找不到飞书会话；请先点「发送测试卡片」确认目标可用')
      }
      const text = '【DSH 飞书桥接自检】这是一条聊天通道自检消息，请简短回复一句即可。'
      const forwarded = await bridge.forwardChatMessage(chatId, 'p2p', text)
      if (!forwarded) throw new Error('转发失败：没有可用的 DSH 会话或聊天通道未启用')
      sendJson(res, 200, { ok: true, chatId, sessionId: bridge.chatBindings.get(chatId) ?? '' })
    } catch (error) {
      sendJson(res, 200, { ok: false, error: String(error?.message ?? error) })
    }
  }
  const helloHandler = async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    log('client module loaded (settings page / sidebar panel reached the Host)')
    sendJson(res, 200, { ok: true })
  }
  const disposers = [
    ['/api/feishu-bridge/config', configHandler],
    ['/api/feishu-bridge/test-card', testHandler],
    ['/api/feishu-bridge/hello', helloHandler],
    ['/api/feishu-bridge/reload', reloadHandler],
    ['/api/feishu-bridge/chat-selftest', chatTestHandler],
  ].map(([path, handler]) => webServer.register({ kind: 'exact', path, handler }))
  return () => {
    for (const dispose of disposers) {
      try { dispose() } catch { /* ignore */ }
    }
  }
}

/** Host plugin entry: create the bridge and always serve its settings API. */
export function apply(ctx, config = {}) {
  const merged = mergeConfig(config)
  const log = createFileLogger(join(dshHome(), 'feishu-bridge.log'))
  const bridge = new FeishuBridge({ ctx, config: merged, log, rowConfig: config })
  ctx.effect(() => registerSettingsRoutes(ctx, bridge, log), 'feishu-bridge: settings API')
  ctx.effect(() => bridge.start(), 'feishu-bridge: card bridge')
  log(`loaded from ${merged.file} (enabled=${String(merged.enabled)}, target=${bridge.targetLabel()}, receive=${String(merged.receive)})`)
}
