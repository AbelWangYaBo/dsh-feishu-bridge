/**
 * Send one real multi-question card with the configured dedicated app, dump how
 * Feishu stored it, then replace it with an expired notice so no prompt dangles.
 */
import { FeishuBridge } from '../index.js'
import { LarkCli, createFileLogger, resolveLarkCli } from '../lib/lark.js'
import { buildSettledCard } from '../lib/card.js'
import { configuredCliOptions, configuredTarget, sendsEnabled } from './helpers/app-config.mjs'

const options = configuredCliOptions()
const target = configuredTarget()
if (options === undefined || target.userId === '' || !sendsEnabled()) {
  console.log('SKIP multi-question card inspection: needs a configured app and BRIDGE_TEST_SEND=1')
  process.exit(0)
}

const fileLog = createFileLogger(join(tmpdir(), 'feishu-bridge-inspect-multiq.log'))
const log = (...parts) => { fileLog(parts.join(' ')) }
const lark = new LarkCli({
  bin: resolveLarkCli(undefined),
  log,
  profile: options.profile,
  env: options.env,
})

const bridge = new FeishuBridge({
  ctx: {
    on: () => () => {},
    effect: (fn) => fn(),
    // Stand-in for the Host's sessionTitle service so the rendered context can
    // be inspected without a live Agent session.
    get: (name) => name === 'sessionTitle' ? { get: () => ({ title: '会话标题布局验证' }) } : undefined,
  },
  log,
  lark,
  config: {
    enabled: true,
    target: { userId: target.userId, chatId: target.chatId },
    allowOperators: [],
    bridge: { questions: true, approvals: true },
    receive: 'callback',
    pollIntervalMs: 600_000,
    maxPending: 8,
    configFile: '/nonexistent',
  },
})
bridge.mode = 'callback'
bridge.ready = true

const agent = { session: { id: 'session-inspect', header: { cwd: join(tmpdir(), 'inspect') } } }
const questions = [
  { id: 'q1', header: '选择方案', question: '多问题批量验证：请选择「方案 B」。', options: [{ label: '方案 A' }, { label: '方案 B' }] },
  { id: 'q2', question: '请在这里输入任意文字（例如 ok），用于验证自定义输入框。' },
]
const never = new Promise(() => {})
void bridge.onQuestionRequest({ questions, agent, signal: new AbortController().signal }, () => never)
await new Promise((resolve) => setTimeout(resolve, 4000))
const entry = [...bridge.prompts.values()][0]
if (entry === undefined || entry.messageId === undefined) throw new Error('card was not sent')
const message = await lark.getMessage(entry.messageId)
console.log('MESSAGE_ID', entry.messageId)
console.log('CONTENT', String(message?.content ?? '').slice(0, 4000))
const settled = buildSettledCard({
  state: 'expired',
  context: entry.context,
  questions,
  detail: '这是自动化检查用的多问题卡片，已失效。',
})
await lark.updateCard({ messageId: entry.messageId, card: settled }).catch(() => undefined)
process.exit(0)
