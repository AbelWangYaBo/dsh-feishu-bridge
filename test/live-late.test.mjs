/**
 * Real-API check of the "desktop answered first, a later Feishu reply is
 * invalid" path.
 *
 * A standalone bridge instance answers the desktop channel immediately (as the
 * Web UI would), then a bot-authored chat message addresses the settled prompt.
 * The bridge must treat it as late, leave the settled card alone, and post a
 * chat notice that the submission is invalid.
 *
 * `testAcceptBotReplies` lets this script play the Feishu user without a human.
 */
import { FeishuBridge } from '../index.js'
import { LarkCli, createFileLogger, resolveLarkCli } from '../lib/lark.js'
import { configuredCliOptions, configuredTarget, sendsEnabled } from './helpers/app-config.mjs'

const options = configuredCliOptions()
const target = configuredTarget()
if (options === undefined || target.userId === '' || !sendsEnabled()) {
  console.log('SKIP live late-reply test: needs a configured app and BRIDGE_TEST_SEND=1 (it sends real messages)')
  process.exit(0)
}

const fileLog = createFileLogger(join(tmpdir(), 'feishu-bridge-live-late.log'))
const logs = []
const log = (...parts) => {
  const line = parts.join(' ')
  logs.push(line)
  fileLog(line)
  console.log('[bridge]', line)
}
const lark = new LarkCli({
  bin: resolveLarkCli(undefined),
  log: (line) => { fileLog(line) },
  profile: options.profile,
  env: options.env,
})

const bridge = new FeishuBridge({
  ctx: { on: () => () => {}, effect: (fn) => fn() },
  log,
  lark,
  config: {
    enabled: true,
    target: { userId: target.userId, chatId: target.chatId },
    allowOperators: [],
    bridge: { questions: true, approvals: true },
    receive: 'poll',
    pollIntervalMs: 600_000,
    idlePollIntervalMs: 600_000,
    maxPending: 8,
    testAcceptBotReplies: true,
    configFile: '/nonexistent',
  },
})
bridge.mode = 'poll'
bridge.ready = true

const agent = { session: { id: 'session-live-late', header: { cwd: join(tmpdir(), 'live-late') } } }
const request = {
  questions: [{
    id: 'q1',
    header: '迟到提交验证',
    question: '这个问题会先在电脑端回答，随后再由 Feishu 迟到提交。',
    options: [{ label: '继续' }, { label: '停止' }],
  }],
  agent,
  signal: new AbortController().signal,
}

// The desktop answerer resolves at once, so the desktop channel wins.
const desktopAnswer = { answers: [{ id: 'q1', selected: ['继续'] }] }
const result = await bridge.onQuestionRequest(request, () => Promise.resolve(desktopAnswer))
if (JSON.stringify(result) !== JSON.stringify(desktopAnswer)) {
  throw new Error(`desktop answer should pass through, got ${JSON.stringify(result)}`)
}
let settledEntry
for (let attempt = 0; attempt < 80 && settledEntry === undefined; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 250))
  settledEntry = [...bridge.byMessage.values()][0]
}
if (settledEntry === undefined) throw new Error('the prompt card was not recorded')
await new Promise((resolve) => setTimeout(resolve, 2500))
console.log('prompt settled by:', settledEntry.settledBy, '| id:', settledEntry.id)
if (settledEntry.settledBy !== 'desktop') throw new Error('expected the desktop channel to settle first')

// A Feishu reply arrives after the fact, addressed to the settled prompt.
const chatId = settledEntry.chatId
if (typeof chatId !== 'string' || chatId.length === 0) throw new Error('the prompt card chat was not resolved')
const before = await lark.listMessages(chatId, { limit: 20 })
const beforeMax = Math.max(...before.map((message) => message.position), 0)
await lark.sendText({ chatId, text: `${settledEntry.id} 2` })
await new Promise((resolve) => setTimeout(resolve, 1200))
// Poll just the new window instead of waiting for the idle cadence.
bridge.chatSince.set(chatId, beforeMax)
await bridge.pollChat(chatId)
await new Promise((resolve) => setTimeout(resolve, 2500))

if (!logs.some((line) => line.includes('late text reply'))) {
  throw new Error('bridge did not classify the reply as a late submission')
}
const after = await lark.listMessages(chatId, { limit: 10 })
const notice = after.find((message) => message.senderType === 'app'
  && message.position > beforeMax
  && typeof message.content === 'string'
  && message.content.includes('无效'))
if (notice === undefined) {
  console.log('recent messages:', after.map((message) => `${String(message.position)}:${message.msgType}:${String(message.content).slice(0, 40)}`))
  throw new Error('no invalidation notice was posted to the chat')
}
console.log('late-reply notice:', notice.content.slice(0, 120))
console.log('live late-reply test passed')
process.exit(0)
