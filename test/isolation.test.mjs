import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { FeishuBridge } from '../index.js'
import { messageText, normalizeMessage } from '../lib/lark.js'

// --- messageText accepts both lark-cli's raw text and the API's JSON shape. ---
assert.equal(messageText({ msgType: 'text', content: '{"text":"hi"}' }), 'hi')
assert.equal(messageText({ msgType: 'text', content: 'p1ab 1' }), 'p1ab 1')
assert.equal(messageText({ msgType: 'post', content: '{"text":"hi"}' }), '')
assert.equal(messageText({ msgType: 'text', content: '{"text":"a","extra":1}' }), 'a')

// --- normalizeMessage maps the list payload the poller reads. ---
const normalized = normalizeMessage({
  message_id: 'om_x',
  chat_id: 'oc_x',
  message_position: '42',
  msg_type: 'text',
  content: 'hello',
  deleted: false,
  sender: { id: 'ou_me', id_type: 'open_id', sender_type: 'user' },
})
assert.deepEqual(normalized, {
  messageId: 'om_x',
  chatId: 'oc_x',
  position: 42,
  senderType: 'user',
  senderId: 'ou_me',
  msgType: 'text',
  content: 'hello',
  deleted: false,
  createTime: undefined,
})

// --- The isolated lark-cli home is written from configured app credentials. ---
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

  startCardConsumer() {
    return { close: () => {} }
  }
}

const dir = join(tmpdir(), `dsh-bridge-isolation-${String(Date.now())}`)
rmSync(dir, { recursive: true, force: true })
mkdirSync(dir, { recursive: true })
const logs = []
const bridge = new FeishuBridge({
  ctx: { on: () => () => {}, effect: (fn) => fn() },
  log: (...parts) => { logs.push(parts.join(' ')) },
  lark: new StubLark(),
  config: {
    enabled: true,
    appId: 'cli_isolationtest0001',
    appSecret: 'secret-value',
    larkConfigDir: dir,
    target: { userId: 'ou_me', chatId: '', chatName: '', discover: true },
    allowOperators: ['ou_me'],
    bridge: { questions: true, approvals: true },
    receive: 'poll',
    pollIntervalMs: 600_000,
    maxPending: 8,
    configFile: '/nonexistent',
    larkProfile: '',
  },
})
const dispose = bridge.start()
await new Promise((resolve) => setTimeout(resolve, 50))
const configPath = join(dir, 'config.json')
assert.equal(existsSync(configPath), true, 'isolated config.json must be created')
const written = JSON.parse(readFileSync(configPath, 'utf8'))
assert.equal(written.apps[0].appId, 'cli_isolationtest0001')
assert.equal(written.apps[0].appSecret, 'secret-value')
assert.equal(written.apps[0].defaultAs, 'bot')
const mode = statSync(configPath).mode & 0o777
assert.equal(mode, 0o600, `isolated config.json must be owner-only, got ${mode.toString(8)}`)
assert.ok(logs.some((line) => line.includes('wrote isolated lark-cli credentials')))
dispose()
rmSync(dir, { recursive: true, force: true })
console.log('isolation test passed')
