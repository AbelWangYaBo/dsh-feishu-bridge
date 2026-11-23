/**
 * Real-API polling check for the Feishu bridge.
 *
 * Uses the single historical user message already present in the bot DM
 * ("p1q6ts 1") to drive the whole read path: chat listing -> normalization ->
 * sender filter -> prompt-code match -> reply parse -> claim -> resolve.
 * No new chat message is sent by this script.
 */
import { FeishuBridge } from '../index.js'
import { LarkCli, createFileLogger, resolveLarkCli } from '../lib/lark.js'
import { configuredCliOptions, configuredTarget } from './helpers/app-config.mjs'

const cliOptions = configuredCliOptions()
const configured = configuredTarget()
const CHAT_ID = process.env.BRIDGE_TEST_CHAT || configured.chatId
if (cliOptions === undefined || CHAT_ID === '') {
  console.log('SKIP real polling test: needs the configured app and a DM/group chat id')
  process.exit(0)
}
const OPEN_ID = configured.userId
const KNOWN_PROMPT = process.env.BRIDGE_TEST_PROMPT || 'p1q6ts'
const KNOWN_POSITION = Number(process.env.BRIDGE_TEST_POSITION || '2813')

const logs = []
const log = (...parts) => {
  const line = parts.join(' ')
  logs.push(line)
  console.log('[bridge]', line)
}
const fileLog = createFileLogger('/tmp/feishu-bridge-real-poll.log')
const lark = new LarkCli({
  bin: resolveLarkCli(undefined),
  log: (line) => { fileLog(line); log(line) },
  profile: cliOptions.profile,
  env: cliOptions.env,
})

const messages = await lark.listMessages(CHAT_ID, { limit: 50 })
const userMessages = messages.filter((message) => message.senderType === 'user')
console.log('chat messages:', messages.length, '| user messages:', userMessages.length)
for (const message of userMessages.slice(0, 5)) {
  console.log('  user msg:', message.position, JSON.stringify(message.content).slice(0, 80))
}
const recentWindow = new Set(messages.slice(0, 30).map((message) => message.position))
const target = userMessages.find((message) => message.position === KNOWN_POSITION)
if (target === undefined || !recentWindow.has(KNOWN_POSITION)) {
  // The fixture is the only user-authored message in this bot DM; it ages out of
  // the 50-message window as test cards and notices accumulate. Re-run this
  // check while the fixture is still visible (or point BRIDGE_TEST_POSITION at
  // another user message) — skipping is not a failure of the bridge.
  console.log('SKIP real polling test: historical fixture message not in the recent window')
  process.exit(0)
}

const bridge = new FeishuBridge({
  ctx: { on: () => () => {}, effect: (fn) => fn() },
  log: (line) => log(line),
  lark,
  config: {
    enabled: true,
    target: { userId: OPEN_ID, chatId: CHAT_ID },
    allowOperators: [OPEN_ID],
    bridge: { questions: true, approvals: true },
    receive: 'poll',
    pollIntervalMs: 600_000,
    maxPending: 8,
    configFile: '/nonexistent',
  },
})
bridge.mode = 'poll'
bridge.ready = true
bridge.stopPolling()

const agent = { session: { id: 'session-e2e', header: { cwd: '/tmp/e2e-workspace' } } }
const request = {
  questions: [{
    id: 'q1',
    header: '真实轮询测试',
    question: '用哪个方案继续？',
    options: [{ label: '继续' }, { label: '停止' }],
  }],
  agent,
  signal: new AbortController().signal,
}
const entry = bridge.createEntry('question', request, agent)
bridge.stopPolling()
bridge.prompts.delete(entry.id)
entry.id = KNOWN_PROMPT
bridge.prompts.set(entry.id, entry)
entry.chatId = CHAT_ID
entry.baselinePosition = KNOWN_POSITION - 1
bridge.chatSince.set(CHAT_ID, KNOWN_POSITION - 1)

await bridge.pollChat(CHAT_ID)
const outcome = await Promise.race([
  entry.final.promise,
  new Promise((_resolve, reject) => setTimeout(() => reject(new Error('timed out waiting for the polled answer')), 10_000)),
])
console.log('outcome:', JSON.stringify(outcome))
if (outcome.channel !== 'feishu') throw new Error(`expected a Feishu answer, got ${String(outcome.channel)}`)
const answer = outcome.value.answers[0]
if (answer.id !== 'q1' || answer.selected.length !== 1 || answer.selected[0] !== '继续') {
  throw new Error(`unexpected answer payload: ${JSON.stringify(answer)}`)
}
if (!logs.some((line) => line.includes('answered from Feishu (text)'))) {
  throw new Error('bridge did not record a Feishu text answer')
}
console.log('real polling test passed')
process.exit(0)
