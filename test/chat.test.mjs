import assert from 'node:assert/strict'
import { FeishuBridge } from '../index.js'

let seq = 0
class StubLark {
  constructor() {
    this.sent = []
    this.texts = []
    this.updates = []
    this.bin = '/stub/lark-cli'
    this.profile = undefined
  }

  async sendCard(card) {
    seq += 1
    const messageId = `om_chat${String(seq)}`
    this.sent.push({ card, messageId })
    return { messageId, chatId: 'oc_dm' }
  }

  async sendText(args) { this.texts.push(args) }
  async updateCard(args) { this.updates.push(args); return 'patch' }
  async getMessage() { return { position: 100, chatId: 'oc_dm' } }
  async listMessages() { return [] }
  async probeEvents() { return { ok: true } }
  startEventConsumer() { return { close: () => {} } }
  startCardConsumer() { return { close: () => {} } }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function makeAgent(id, time, title, cwd = '/workspace') {
  return {
    session: {
      id,
      header: { cwd, origin: 'main' },
      snapshotEvents: () => [{ time }],
      title,
    },
  }
}

function makeBridge({ agents = [], chat = {}, allowOperators = ['ou_me'] } = {}) {
  const lark = new StubLark()
  const requests = []
  const createRequests = []
  const sessionController = {
    prompt: async (request) => {
      requests.push(request)
      return { accepted: true }
    },
    create: async (request) => {
      createRequests.push(request)
      const agent = makeAgent('session-created', 999, undefined, request.cwd)
      agents.push(agent)
      return { sessionId: agent.session.id }
    },
  }
  const registry = {
    list: () => agents,
    get: (id) => agents.find((agent) => agent.session.id === id),
  }
  const ctx = {
    on: () => () => {},
    effect: (fn) => fn(),
    get: (name) => {
      if (name === 'agents') return registry
      if (name === 'sessionController') return sessionController
      if (name === 'sessionTitle') {
        return { get: (session) => (session?.title === undefined ? undefined : { title: session.title }) }
      }
      return undefined
    },
  }
  const bridge = new FeishuBridge({
    ctx,
    log: () => {},
    lark,
    config: {
      enabled: true,
      target: { userId: 'ou_me', chatId: '', chatName: '', discover: true },
      allowOperators,
      bridge: { questions: true, approvals: true },
      receive: 'callback',
      watchMessages: true,
      chat: { enabled: true, sessionId: '', mirror: true, allowGroups: false, ...chat },
      pollIntervalMs: 600_000,
      maxPending: 8,
      configFile: '/nonexistent',
    },
  })
  bridge.mode = 'callback'
  bridge.ready = true
  return { bridge, lark, requests, createRequests, registry }
}

const dm = (text, messageId = `om_${String(Date.now())}_${String(seq++)}`) => ({
  chatId: 'oc_dm',
  chatType: 'p2p',
  messageId,
  senderId: 'ou_me',
  senderType: 'user',
  text,
})

// A plain DM message is forwarded into the newest live session.
{
  const agent = makeAgent('session-1', 500, '示例会话标题')
  const { bridge, lark, requests } = makeBridge({ agents: [agent] })
  await bridge.handleIncomingText(dm('帮我看下日志'))
  assert.equal(requests.length, 1)
  assert.equal(requests[0].sessionId, 'session-1')
  assert.equal(requests[0].mode, 'queue')
  assert.deepEqual(requests[0].content, [{ type: 'text', text: '帮我看下日志' }])
  assert.ok(String(lark.texts.at(-1).text).includes('已连接 DSH 会话「示例会话标题」'))
  assert.equal(bridge.chatBindings.get('oc_dm'), 'session-1')

  // Assistant output from the bound session is mirrored back.
  await bridge.onSessionEvent(agent.session, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '日志没有问题' }] } },
  })
  assert.ok(lark.texts.some((item) => item.text === '日志没有问题'))

  // Output from an unrelated session is not mirrored.
  const before = lark.texts.length
  await bridge.onSessionEvent(makeAgent('session-2', 600).session, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '别的会话' }] } },
  })
  assert.equal(lark.texts.length, before)
}

// Mirroring can be disabled.
{
  const agent = makeAgent('session-1', 500)
  const { bridge, lark, requests } = makeBridge({ agents: [agent], chat: { mirror: false } })
  await bridge.handleIncomingText(dm('hi'))
  assert.equal(requests.length, 1)
  const before = lark.texts.length
  await bridge.onSessionEvent(agent.session, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '不会被镜像' }] } },
  })
  assert.equal(lark.texts.length, before)
}

// Group chats are blocked unless explicitly allowed.
{
  const agent = makeAgent('session-1', 500)
  const { bridge, lark, requests } = makeBridge({ agents: [agent] })
  await bridge.handleIncomingText({ ...dm('group hello'), chatType: 'group' })
  assert.equal(requests.length, 0)
  assert.equal(lark.texts.length, 0, 'group chatter stays silent')
}
{
  const agent = makeAgent('session-1', 500)
  const { bridge, requests } = makeBridge({ agents: [agent], chat: { allowGroups: true } })
  await bridge.handleIncomingText({ ...dm('group hello'), chatType: 'group' })
  assert.equal(requests.length, 1)
}

// Without a live session the user is told why nothing happened.
{
  const { bridge, lark, requests } = makeBridge({ agents: [] })
  await bridge.handleIncomingText(dm('有人吗'))
  assert.equal(requests.length, 0)
  assert.ok(String(lark.texts.at(-1).text).includes('没有可用的 DSH 会话'))
}

// A pinned session wins over the newest one.
{
  const older = makeAgent('session-old', 100)
  const newer = makeAgent('session-new', 900)
  const { bridge, requests } = makeBridge({ agents: [older, newer], chat: { sessionId: 'session-old' } })
  await bridge.handleIncomingText(dm('hello pinned'))
  assert.equal(requests[0].sessionId, 'session-old')
}

// Long assistant text is chunked into several Feishu messages.
{
  const agent = makeAgent('session-1', 500)
  const { bridge, lark } = makeBridge({ agents: [agent] })
  await bridge.handleIncomingText(dm('long'))
  const before = lark.texts.length
  await bridge.onSessionEvent(agent.session, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: `${'x'.repeat(2500)}\n${'y'.repeat(2500)}` }] } },
  })
  const sent = lark.texts.slice(before).map((item) => item.text)
  assert.ok(sent.length >= 2, 'long text must be split')
  assert.ok(sent.every((text) => text.length <= 3000))
  assert.equal(sent.join('').replaceAll('\n', ''), 'x'.repeat(2500) + 'y'.repeat(2500))
}

// Confirmation answering still wins over the chat channel while a prompt is open.
{
  const agent = makeAgent('session-1', 500)
  const { bridge, lark, requests } = makeBridge({ agents: [agent] })
  const desktop = new Promise(() => {})
  const request = {
    questions: [{ id: 'q1', question: '继续吗？', options: [{ label: '继续' }, { label: '停止' }] }],
    agent,
    signal: new AbortController().signal,
  }
  const promise = bridge.onQuestionRequest(request, () => desktop)
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const candidate = [...bridge.prompts.values()][0]
    if (lark.sent.length > 0 && candidate !== undefined && typeof candidate.chatId === 'string') break
    await sleep(10)
  }
  const entry = [...bridge.prompts.values()][0]
  await bridge.handleIncomingText({ ...dm(`${entry.id} 2`), messageId: 'om_answer' })
  const result = await promise
  assert.deepEqual(result, { answers: [{ id: 'q1', selected: ['停止'] }] })
  assert.equal(requests.length, 0, 'a prompt answer must not be forwarded as chat')
}

// A configured project directory without a live session creates one there.
{
  const { bridge, lark, requests, createRequests } = makeBridge({ agents: [], chat: { cwd: '/projects/foo' } })
  await bridge.handleIncomingText(dm('这个项目的构建脚本在哪？'))
  assert.deepEqual(createRequests, [{ cwd: '/projects/foo' }])
  assert.equal(requests.length, 1)
  assert.equal(requests[0].sessionId, 'session-created')
  assert.ok(String(lark.texts.at(-1).text).includes('已连接 DSH 会话'))
  assert.equal(bridge.chatBindings.get('oc_dm'), 'session-created')
}

// An existing live session in that directory is reused instead of creating one.
{
  const projectAgent = makeAgent('session-project', 700, '项目会话', '/projects/foo')
  const other = makeAgent('session-other', 900, '其他会话', '/elsewhere')
  const { bridge, requests, createRequests } = makeBridge({ agents: [projectAgent, other], chat: { cwd: '/projects/foo/' } })
  await bridge.handleIncomingText(dm('继续这个项目'))
  assert.equal(createRequests.length, 0, 'a live session in the directory is reused')
  assert.equal(requests[0].sessionId, 'session-project')
}

// The project command reports the bound session's directory.
{
  const projectAgent = makeAgent('session-project', 700, '项目会话', '/projects/foo')
  const { bridge, lark } = makeBridge({ agents: [projectAgent], chat: { cwd: '/projects/foo' } })
  await bridge.handleIncomingText(dm('hi'))
  await bridge.handleIncomingText(dm('项目'))
  const reply = String(lark.texts.at(-1).text)
  assert.ok(reply.includes('/projects/foo'), 'reply shows the project directory')
  assert.ok(reply.includes('session-project'), 'reply shows the bound session')
}

console.log('chat channel tests passed')
