import assert from 'node:assert/strict'
import { FeishuBridge } from '../index.js'

let seq = 0
class StubLark {
  constructor() {
    this.sent = []
    this.texts = []
    this.updates = []
    this.messages = []
    this.bin = '/stub/lark-cli'
    this.profile = undefined
  }

  async sendCard(card) {
    seq += 1
    const messageId = `om_msg${String(seq)}`
    this.sent.push({ card, messageId })
    return { messageId, chatId: 'oc_test' }
  }

  async sendText(args) { this.texts.push(args) }
  async updateCard(args) { this.updates.push(args); return 'patch' }
  async getMessage() { return { position: 100, chatId: 'oc_test' } }
  async listMessages() { return [...this.messages] }
  async probeEvents() { return { ok: true } }
  startEventConsumer() { return { close: () => {} } }
  startCardConsumer() { return { close: () => {} } }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function makeBridge(extraTarget = {}) {
  const lark = new StubLark()
  const logs = []
  const bridge = new FeishuBridge({
    ctx: { on: () => () => {}, effect: (fn) => fn(), get: () => undefined },
    log: (...parts) => { logs.push(parts.join(' ')) },
    lark,
    config: {
      enabled: true,
      target: { userId: 'ou_me', chatId: '', chatName: '', discover: true, ...extraTarget },
      allowOperators: ['ou_me'],
      bridge: { questions: true, approvals: true },
      receive: 'callback',
      watchMessages: true,
      pollIntervalMs: 600_000,
      maxPending: 8,
      configFile: '/nonexistent',
    },
  })
  bridge.mode = 'callback'
  bridge.ready = true
  return { bridge, lark, logs }
}

const userEvent = (text, messageId, overrides = {}) => ({
  chat_id: 'oc_test',
  chat_type: 'p2p',
  sender_id: 'ou_me',
  sender_type: 'user',
  message_id: messageId,
  message_type: 'text',
  content: text,
  ...overrides,
})

// Commands answer immediately.
{
  const { bridge, lark } = makeBridge()
  await bridge.onMessageEvent(userEvent('状态', 'om_s1'))
  assert.ok(String(lark.texts.at(-1).text).includes('DSH 飞书桥接状态'))
  assert.ok(String(lark.texts.at(-1).text).includes('待确认请求：0'))
  await bridge.onMessageEvent(userEvent('帮助', 'om_s2'))
  assert.ok(String(lark.texts.at(-1).text).includes('用法'))
  await bridge.onMessageEvent(userEvent('ping', 'om_s3'))
  assert.equal(lark.texts.at(-1).text, 'pong')
}

// Unknown DM text is acknowledged (closes the loop).
{
  const { bridge, lark } = makeBridge()
  await bridge.onMessageEvent(userEvent('随便说一句', 'om_a1'))
  assert.ok(String(lark.texts.at(-1).text).includes('已收到'))
}

// A group target does not spam acknowledgements for ordinary chatter.
{
  const { bridge, lark } = makeBridge({ userId: '', chatId: 'oc_group' })
  await bridge.onMessageEvent(userEvent('随便说一句', 'om_g1', { chat_id: 'oc_group', chat_type: 'group' }))
  assert.equal(lark.texts.length, 0)
  await bridge.onMessageEvent(userEvent('状态', 'om_g2', { chat_id: 'oc_group', chat_type: 'group' }))
  assert.ok(String(lark.texts.at(-1).text).includes('DSH 飞书桥接状态'))
}

// Duplicate deliveries of one message are handled once.
{
  const { bridge, lark } = makeBridge()
  await bridge.onMessageEvent(userEvent('ping', 'om_dup'))
  await bridge.onMessageEvent(userEvent('ping', 'om_dup'))
  assert.equal(lark.texts.length, 1)
}

// Messages from disallowed senders are ignored.
{
  const { bridge, lark } = makeBridge()
  await bridge.onMessageEvent(userEvent('ping', 'om_x1', { sender_id: 'ou_stranger' }))
  assert.equal(lark.texts.length, 0)
}

// A text answer over the message event resolves a pending question.
{
  const { bridge, lark, logs } = makeBridge()
  const desktop = new Promise(() => {})
  const request = {
    questions: [{ id: 'q1', header: '选择', question: '继续吗？', options: [{ label: '继续' }, { label: '停止' }] }],
    agent: { session: { id: 'session-msg', header: { cwd: '/tmp/w' } } },
    signal: new AbortController().signal,
  }
  const promise = bridge.onQuestionRequest(request, () => desktop)
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const candidate = [...bridge.prompts.values()][0]
    if (lark.sent.length > 0 && candidate !== undefined && typeof candidate.chatId === 'string') break
    await sleep(10)
  }
  const entry = [...bridge.prompts.values()][0]
  assert.ok(entry !== undefined, 'the prompt card should be pending')
  await bridge.onMessageEvent(userEvent(`${entry.id} 2`, 'om_ans'))
  const result = await promise
  assert.deepEqual(result, { answers: [{ id: 'q1', selected: ['停止'] }] })
  assert.ok(logs.some((line) => line.includes('answered from Feishu (text)')), 'the text answer is recorded')
}

console.log('message handling tests passed')
