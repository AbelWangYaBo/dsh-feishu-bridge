import assert from 'node:assert/strict'
import { FeishuBridge } from '../index.js'

let messageSeq = 0

/** Minimal lark-cli stub capturing every side effect. */
class StubLark {
  constructor() {
    this.sent = []
    this.updates = []
    this.texts = []
    this.messages = []
    this.consumerCloseCount = 0
  }

  async sendCard(card, target) {
    messageSeq += 1
    const messageId = `om_stub${String(messageSeq)}`
    this.sent.push({ card, target, messageId })
    return { messageId, chatId: 'oc_test' }
  }

  async sendText(args) {
    this.texts.push(args)
  }

  async updateCard(args) {
    this.updates.push(args)
    return 'token'
  }

  async getMessage() {
    return { position: 100 }
  }

  async listMessages() {
    return [...this.messages]
  }

  startCardConsumer() {
    return { close: () => { this.consumerCloseCount += 1 } }
  }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function makeCtx() {
  const handlers = new Map()
  return {
    handlers,
    on(name, listener) {
      handlers.set(name, listener)
      return () => { handlers.delete(name) }
    },
    effect(fn) {
      return fn()
    },
    get(name) {
      return name === 'sessionTitle'
        ? { get: () => ({ title: '测试会话标题' }) }
        : undefined
    },
  }
}

function makeBridge(mode) {
  const logs = []
  const lark = new StubLark()
  const bridge = new FeishuBridge({
    ctx: makeCtx(),
    log: (...parts) => { logs.push(parts.join(' ')) },
    lark,
    config: {
      enabled: true,
      target: { userId: 'ou_me', chatId: '' },
      allowOperators: ['ou_me'],
      bridge: { questions: true, approvals: true },
      receive: 'poll',
      pollIntervalMs: 600_000,
      maxPending: 8,
      configFile: '/nonexistent',
    },
  })
  bridge.mode = mode
  bridge.ready = true
  return { bridge, lark, logs }
}

function makeAgent() {
  return { session: { id: 'session-test', header: { cwd: '/tmp/workspace' } } }
}

function questionRequest(agent, signal) {
  return {
    questions: [{
      id: 'q1',
      header: '选择方案',
      question: '用哪个方案继续？',
      options: [{ label: '方案 A' }, { label: '方案 B' }],
    }],
    agent,
    signal,
  }
}

function userMessage(position, text) {
  return {
    messageId: `om_user${String(position)}`,
    chatId: 'oc_test',
    position,
    senderType: 'user',
    senderId: 'ou_me',
    msgType: 'text',
    content: JSON.stringify({ text }),
    deleted: false,
  }
}

// --- Feishu text reply wins; desktop waterfall is cancelled. ---
{
  const { bridge, lark } = makeBridge('poll')
  const desktop = deferred()
  const ac = new AbortController()
  const request = questionRequest(makeAgent(), ac.signal)
  const promise = bridge.onQuestionRequest(request, () => desktop.promise)
  await sleep(20)
  assert.equal(lark.sent.length, 1)
  assert.equal(lark.sent[0].card.body.elements.some((element) => element.tag === 'button'), false,
    'poll-mode card must not carry buttons')
  assert.ok(JSON.stringify(lark.sent[0].card).includes('测试会话标题'), 'card context must carry the session title')
  const entryId = [...bridge.prompts.values()][0].id

  lark.messages = [userMessage(105, '2')]
  await bridge.pollChat('oc_test')
  const result = await promise
  assert.deepEqual(result, { answers: [{ id: 'q1', selected: ['方案 B'] }] })
  assert.equal(request.signal.aborted, true, 'wrapped signal must cancel the desktop waterfall')
  await sleep(20)
  assert.ok(lark.updates.length >= 1)
  assert.ok(JSON.stringify(lark.updates.at(-1).card).includes('已在飞书提交'))
  assert.equal(bridge.prompts.size, 0)
  desktop.resolve({ answers: [{ id: 'q1', selected: ['方案 A'] }] })
  await sleep(10)
  // A late, code-addressed text reply gets a notice, not a second answer.
  lark.messages = [userMessage(110, `${entryId} 1`)]
  await bridge.pollChat('oc_test')
  await sleep(20)
  assert.ok(lark.texts.some((text) => String(text.text).includes('无效')), 'late reply should be told it is invalid')
}

// --- Desktop wins; a later Feishu reply is rejected. ---
{
  const { bridge, lark } = makeBridge('poll')
  const desktop = deferred()
  const ac = new AbortController()
  const request = questionRequest(makeAgent(), ac.signal)
  const promise = bridge.onQuestionRequest(request, () => desktop.promise)
  await sleep(20)
  const entryId = [...bridge.prompts.values()][0].id
  desktop.resolve({ answers: [{ id: 'q1', selected: ['方案 A'] }] })
  const result = await promise
  assert.deepEqual(result, { answers: [{ id: 'q1', selected: ['方案 A'] }] })
  assert.equal(request.signal.aborted, false, 'desktop answer must not cancel the request')
  await sleep(20)
  assert.ok(JSON.stringify(lark.updates.at(-1).card).includes('已在电脑端完成'))
  assert.equal(lark.texts.length, 0)

  lark.messages = [userMessage(115, `${entryId} 2`)]
  await bridge.pollChat('oc_test')
  await sleep(20)
  assert.ok(lark.texts.length >= 1)
  assert.ok(String(lark.texts.at(-1).text).includes('无效'))
}

// --- Approval by text reply. ---
{
  const { bridge, lark } = makeBridge('poll')
  const desktop = deferred()
  const ac = new AbortController()
  const request = { agent: makeAgent(), toolName: 'bash', reason: '写入工作区外文件', signal: ac.signal }
  const promise = bridge.onApprovalRequest(request, () => desktop.promise)
  await sleep(20)
  assert.equal(lark.sent.length, 1)
  assert.ok(JSON.stringify(lark.sent[0].card).includes('回复 `1` 允许一次'))
  lark.messages = [userMessage(120, '允许')]
  await bridge.pollChat('oc_test')
  const outcome = await promise
  assert.equal(outcome, 'allowed-once')
  assert.equal(request.signal.aborted, true)
  await sleep(20)
  assert.ok(JSON.stringify(lark.updates.at(-1).card).includes('已允许一次'))
}

// --- Card button callback path (callback mode). ---
{
  const { bridge, lark } = makeBridge('callback')
  const desktop = deferred()
  const ac = new AbortController()
  const request = questionRequest(makeAgent(), ac.signal)
  const promise = bridge.onQuestionRequest(request, () => desktop.promise)
  await sleep(20)
  assert.equal(lark.sent.length, 1)
  const buttons = lark.sent[0].card.body.elements.filter((element) => element.tag === 'button')
  assert.equal(buttons.length, 2)
  const value = buttons[1].behaviors[0].value
  assert.equal(value.v, '方案 B')

  // A disallowed operator is rejected without settling the prompt.
  await bridge.onCardAction({
    event_id: 'ev-denied',
    operator_id: 'ou_stranger',
    message_id: lark.sent[0].messageId,
    chat_id: 'oc_test',
    token: 'tk0',
    action_tag: 'button',
    action_value: JSON.stringify(value),
  })
  assert.equal(bridge.prompts.size, 1)
  assert.ok(JSON.stringify(lark.updates.at(-1).card).includes('无权操作'))

  await bridge.onCardAction({
    event_id: 'ev-1',
    operator_id: 'ou_me',
    message_id: lark.sent[0].messageId,
    chat_id: 'oc_test',
    token: 'tk1',
    action_tag: 'button',
    action_value: JSON.stringify(value),
  })
  const result = await promise
  assert.deepEqual(result, { answers: [{ id: 'q1', selected: ['方案 B'] }] })
  assert.equal(request.signal.aborted, true)
  await sleep(20)
  const settled = lark.updates.at(-1)
  assert.equal(settled.token, 'tk1')
  assert.ok(JSON.stringify(settled.card).includes('已在飞书提交'))

  // A second click on the already-settled card is invalid.
  await bridge.onCardAction({
    event_id: 'ev-2',
    operator_id: 'ou_me',
    message_id: lark.sent[0].messageId,
    chat_id: 'oc_test',
    token: 'tk2',
    action_tag: 'button',
    action_value: JSON.stringify(value),
  })
  await sleep(20)
  assert.ok(lark.texts.some((text) => String(text.text).includes('无效')))
}

// --- Multi-question batch by explicit numbered text reply. ---
{
  const { bridge, lark } = makeBridge('poll')
  const desktop = deferred()
  const ac = new AbortController()
  const request = {
    questions: [
      { id: 'q1', question: '用哪个方案？', options: [{ label: '方案 A' }, { label: '方案 B' }] },
      { id: 'q2', question: '还有什么要补充的？' },
      { id: 'q3', question: '需要哪些检查？', options: [{ label: '测试' }, { label: '构建' }, { label: '静态检查' }], multiSelect: true },
    ],
    agent: makeAgent(),
    signal: ac.signal,
  }
  const promise = bridge.onQuestionRequest(request, () => desktop.promise)
  await sleep(20)
  lark.messages = [userMessage(130, '1=2\n2=先备份再改\n3=1,2')]
  await bridge.pollChat('oc_test')
  const result = await promise
  assert.deepEqual(result, {
    answers: [
      { id: 'q1', selected: ['方案 B'] },
      { id: 'q2', selected: [], custom: '先备份再改' },
      { id: 'q3', selected: ['测试', '构建'] },
    ],
  })
}

// --- Switching the app invalidates open prompts' Feishu side only. ---
{
  const { bridge, lark } = makeBridge('poll')
  const agent = makeAgent()
  const entry = bridge.createEntry('question', questionRequest(agent, new AbortController().signal), agent)
  entry.messageId = 'om_old_app'
  bridge.byMessage.set('om_old_app', entry)
  assert.equal(bridge.prompts.size, 1)
  bridge.invalidatePendingForAppSwitch()
  assert.equal(bridge.prompts.size, 0, 'open prompts leave the live map')
  assert.equal(bridge.byMessage.has('om_old_app'), false)
  assert.equal(entry.messageId, undefined)
  assert.equal(entry.settled, false, 'the desktop path must stay answerable')
  bridge.stopPolling()
  await sleep(30)
  assert.ok(lark.updates.length >= 1)
  assert.ok(JSON.stringify(lark.updates.at(-1).card).includes('应用配置已切换'))
}

console.log('bridge tests passed')
