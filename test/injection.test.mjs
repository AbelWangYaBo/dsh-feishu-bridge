import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FeishuBridge } from '../index.js'

let seq = 0
class StubLark {
  constructor() {
    this.sent = []
    this.updates = []
    this.texts = []
    this.messages = []
  }

  async sendCard(card) {
    seq += 1
    const messageId = `om_inj${String(seq)}`
    this.sent.push({ card, messageId })
    return { messageId, chatId: 'oc_test' }
  }

  async sendText(args) { this.texts.push(args) }
  async updateCard(args) { this.updates.push(args); return 'patch' }
  async getMessage() { return { position: 100 } }
  async listMessages() { return [...this.messages] }
  startCardConsumer() { return { close: () => {} } }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function busyConfig(extra = {}) {
  return {
    enabled: true,
    target: { userId: 'ou_me', chatId: '', chatName: '', discover: true },
    allowOperators: ['ou_me'],
    bridge: { questions: true, approvals: true },
    receive: 'poll',
    pollIntervalMs: 600_000,
    maxPending: 8,
    configFile: '/nonexistent',
    ...extra,
  }
}

function makeBridge(config) {
  const lark = new StubLark()
  const bridge = new FeishuBridge({
    ctx: { on: () => () => {}, effect: (fn) => fn() },
    log: () => {},
    lark,
    config,
  })
  bridge.mode = 'poll'
  bridge.ready = true
  return { bridge, lark }
}

const agent = { session: { id: 'session-inj', header: { cwd: join(tmpdir(), 'w') } } }
const request = {
  questions: [{ id: 'q1', question: '继续吗？', options: [{ label: '继续' }, { label: '停止' }] }],
  agent,
  signal: new AbortController().signal,
}
const botMessage = (position, text) => ({
  messageId: `om_bot${String(position)}`,
  chatId: 'oc_test',
  position,
  senderType: 'app',
  senderId: 'cli_test_app',
  msgType: 'text',
  content: text,
  deleted: false,
})

// Flag off: a bot-authored message is ignored.
{
  const { bridge, lark } = makeBridge(busyConfig({ testAcceptBotReplies: false }))
  const promise = bridge.onQuestionRequest(request, () => new Promise(() => {}))
  await sleep(20)
  const entry = [...bridge.prompts.values()][0]
  lark.messages = [botMessage(105, `${entry.id} 1`)]
  await bridge.pollChat('oc_test')
  await sleep(20)
  assert.equal(bridge.prompts.size, 1, 'bot reply must not settle the prompt when the switch is off')
  assert.equal(lark.updates.length, 0)
  bridge.prompts.delete(entry.id)
}

// Flag on: the bot-authored message answers through the normal text path.
{
  const { bridge, lark } = makeBridge(busyConfig({ testAcceptBotReplies: true }))
  const promise = bridge.onQuestionRequest(request, () => new Promise(() => {}))
  await sleep(20)
  const entry = [...bridge.prompts.values()][0]
  lark.messages = [botMessage(106, `${entry.id} 2`)]
  await bridge.pollChat('oc_test')
  const result = await promise
  assert.deepEqual(result, { answers: [{ id: 'q1', selected: ['停止'] }] })
  await sleep(20)
  assert.ok(JSON.stringify(lark.updates.at(-1).card).includes('已在飞书提交'))
}

console.log('injection test passed')
