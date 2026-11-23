import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FeishuBridge } from '../index.js'

class StubLark {
  constructor() {
    this.bin = '/stub/lark-cli'
    this.profile = undefined
  }

  async probeCardEvents() {
    return { ok: false, reason: 'stub' }
  }

  async listChats() {
    return []
  }

  async sendCard() {
    return { messageId: 'om_stub', chatId: 'oc_stub' }
  }

  async updateCard() {
    return 'patch'
  }

  async sendText() {}
}

const dir = join('/tmp', `dsh-bridge-reload-${String(Date.now())}`)
rmSync(dir, { recursive: true, force: true })
mkdirSync(dir, { recursive: true })
const configPath = join(dir, 'feishu-bridge.json')

const writeConfig = (value) => {
  writeFileSync(configPath, `${JSON.stringify(value, null, 2)}\n`)
}

writeConfig({
  enabled: true,
  receive: 'poll',
  target: { userId: 'ou_first' },
  allowOperators: ['ou_first'],
  bridge: { questions: true, approvals: true },
  maxPending: 8,
})

const logs = []
const bridge = new FeishuBridge({
  ctx: { on: () => () => {}, effect: (fn) => fn() },
  log: (...parts) => { logs.push(parts.join(' ')) },
  lark: new StubLark(),
  rowConfig: { configFile: configPath },
  config: {
    enabled: true,
    appId: '',
    appSecret: '',
    larkProfile: '',
    larkConfigDir: '',
    larkCliPath: undefined,
    target: { userId: 'ou_first', chatId: '', chatName: '', discover: true },
    allowOperators: ['ou_first'],
    bridge: { questions: true, approvals: true },
    receive: 'poll',
    pollIntervalMs: 600_000,
    maxPending: 8,
    configFile: configPath,
    file: configPath,
  },
})
const dispose = bridge.start()
await new Promise((resolve) => setTimeout(resolve, 60))
assert.equal(bridge.ready, true, 'bridge should be ready with a configured target')
assert.equal(bridge.mode, 'poll')

// Change the delivery target; the bridge must pick it up without a restart.
writeConfig({
  enabled: true,
  receive: 'poll',
  target: { userId: 'ou_second' },
  allowOperators: ['ou_second'],
  bridge: { questions: true, approvals: true },
  maxPending: 8,
})
await bridge.checkConfigFile()
await new Promise((resolve) => setTimeout(resolve, 60))
assert.equal(bridge.config.target.userId, 'ou_second')
assert.equal(bridge.allow.has('ou_second'), true, 'allowlist should follow the new config')
assert.equal(bridge.ready, true)
assert.ok(logs.some((line) => line.includes('configuration reloaded')))

// Disabling through the config file makes the bridge inert.
writeConfig({
  enabled: false,
  receive: 'poll',
  target: { userId: 'ou_second' },
  allowOperators: ['ou_second'],
  bridge: { questions: true, approvals: true },
  maxPending: 8,
})
await bridge.checkConfigFile()
assert.equal(bridge.ready, false)
assert.ok(logs.some((line) => line.includes('bridge disabled')))

dispose()
rmSync(dir, { recursive: true, force: true })
console.log('config reload test passed')
