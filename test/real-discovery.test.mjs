/**
 * Real-API target-discovery check: list the bot's group chats and resolve one by
 * name, exactly as the plugin does when only app credentials are configured.
 */
import { FeishuBridge } from '../index.js'
import { LarkCli, createFileLogger, resolveLarkCli } from '../lib/lark.js'
import { configuredCliOptions } from './helpers/app-config.mjs'

const cliOptions = configuredCliOptions()
if (cliOptions === undefined) {
  console.log('SKIP real discovery test: the plugin has no configured app credentials')
  process.exit(0)
}

const fileLog = createFileLogger('/tmp/feishu-bridge-real-discovery.log')
const logs = []
const log = (...parts) => {
  const line = parts.join(' ')
  logs.push(line)
  fileLog(line)
}
const lark = new LarkCli({
  bin: resolveLarkCli(undefined),
  log,
  profile: cliOptions.profile,
  env: cliOptions.env,
})

const chats = await lark.listChats()
console.log('bot group chats:', chats.length)
for (const chat of chats.slice(0, 5)) console.log(' -', chat.chatId, chat.name)
if (chats.length === 0) {
  console.log('SKIP real discovery test: the configured bot is in no group chat')
  process.exit(0)
}

const wanted = chats[0]
const bridge = new FeishuBridge({
  ctx: { on: () => () => {}, effect: (fn) => fn() },
  log,
  lark,
  config: {
    enabled: true,
    appId: 'cli_dummy_discovery_test',
    appSecret: 'dummy',
    target: { userId: '', chatId: '', chatName: wanted.name, discover: true },
    allowOperators: [],
    bridge: { questions: true, approvals: true },
    receive: 'poll',
    pollIntervalMs: 600_000,
    maxPending: 8,
    configFile: '/nonexistent',
  },
})
bridge.mode = 'poll'
const resolved = await bridge.resolveTarget()
if (!resolved) throw new Error('discovery did not resolve the named chat')
if (bridge.config.target.chatId !== wanted.chatId) {
  throw new Error(`discovered ${String(bridge.config.target.chatId)}, expected ${wanted.chatId}`)
}
if (!bridge.hasTarget()) throw new Error('bridge still reports no target')
console.log('resolved chat:', bridge.config.target.chatId, '| name:', wanted.name)

// A missing name must not resolve.
const bridge2 = new FeishuBridge({
  ctx: { on: () => () => {}, effect: (fn) => fn() },
  log,
  lark,
  config: {
    enabled: true,
    appId: 'cli_dummy_discovery_test',
    appSecret: 'dummy',
    target: { userId: '', chatId: '', chatName: '一个不存在的群名', discover: true },
    allowOperators: [],
    bridge: { questions: true, approvals: true },
    receive: 'poll',
    pollIntervalMs: 600_000,
    maxPending: 8,
    configFile: '/nonexistent',
  },
})
bridge2.mode = 'poll'
const resolved2 = await bridge2.resolveTarget()
if (resolved2) throw new Error('discovery resolved an unknown chat name')
if (!logs.some((line) => line.includes('target discovery'))) throw new Error('discovery did not log its candidates')
console.log('real discovery test passed')
process.exit(0)
