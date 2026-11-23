import assert from 'node:assert/strict'
import {
  leadingPromptCode,
  optionLines,
  parseApprovalReply,
  parseQuestionReply,
  parseQuestionValue,
  stripPromptCode,
} from '../lib/poll.js'
import { buildTextApprovalCard, buildTextQuestionCard } from '../lib/card.js'

const single = [{
  id: 'q1',
  header: '选择方案',
  question: '用哪个方案继续？',
  options: [{ label: '方案 A', description: '直接改' }, { label: '方案 B', description: '先备份' }],
}]
const multi = [
  { id: 'q1', question: '用哪个方案继续？', options: [{ label: '方案 A' }, { label: '方案 B' }] },
  { id: 'q2', question: '补充说明' },
  { id: 'q3', question: '需要哪些检查？', options: [{ label: '测试' }, { label: '构建' }, { label: '静态检查' }], multiSelect: true },
]

// Single-question replies.
assert.deepEqual(parseQuestionValue(single[0], '2'), { ok: true, answer: { id: 'q1', selected: ['方案 B'] } })
assert.deepEqual(parseQuestionValue(single[0], '方案 A'), { ok: true, answer: { id: 'q1', selected: ['方案 A'] } })
assert.deepEqual(parseQuestionValue(single[0], '改成方案 C'), { ok: true, answer: { id: 'q1', selected: [], custom: '改成方案 C' } })
assert.equal(parseQuestionValue(single[0], '1 2').ok, false, 'single select rejects two options')
assert.deepEqual(parseQuestionValue(multi[2], '1,3'), { ok: true, answer: { id: 'q3', selected: ['测试', '静态检查'] } })
assert.deepEqual(parseQuestionValue(multi[1], '随便写点'), { ok: true, answer: { id: 'q2', selected: [], custom: '随便写点' } })

// Sequential replies answer the next unanswered question.
let state = parseQuestionReply(multi, '1')
assert.equal(state.ok, true)
assert.equal(state.complete, false)
assert.deepEqual(state.missing, [1, 2])
assert.deepEqual(state.answers.get(0), { id: 'q1', selected: ['方案 A'] })

let second = parseQuestionReply(multi, '补充一句', state.answers)
assert.equal(second.complete, false)
assert.deepEqual(second.answers.get(1), { id: 'q2', selected: [], custom: '补充一句' })

const third = parseQuestionReply(multi, '1,3', second.answers)
assert.equal(third.complete, true)
assert.deepEqual(third.answers.get(2), { id: 'q3', selected: ['测试', '静态检查'] })

// Explicit numbered answers in one message.
const explicit = parseQuestionReply(multi, '1=2\n2=补充说明\n3=1,2')
assert.equal(explicit.complete, true)
assert.deepEqual(explicit.answers.get(0), { id: 'q1', selected: ['方案 B'] })
assert.deepEqual(explicit.answers.get(1), { id: 'q2', selected: [], custom: '补充说明' })
assert.deepEqual(explicit.answers.get(2), { id: 'q3', selected: ['测试', '构建'] })
assert.equal(parseQuestionReply(multi, '9=1').ok, false)

// Approval replies.
assert.deepEqual(parseApprovalReply('1'), { ok: true, outcome: 'allowed-once' })
assert.deepEqual(parseApprovalReply('允许'), { ok: true, outcome: 'allowed-once' })
assert.deepEqual(parseApprovalReply('2'), { ok: true, outcome: 'rejected' })
assert.deepEqual(parseApprovalReply('拒绝'), { ok: true, outcome: 'rejected' })
assert.equal(parseApprovalReply('随便').ok, false)

// Prompt codes.
assert.equal(leadingPromptCode('p1ab 2', ['p1ab', 'p2cd']), 'p1ab')
assert.equal(leadingPromptCode('p2cd: 1', ['p1ab', 'p2cd']), 'p2cd')
assert.equal(leadingPromptCode('2', ['p1ab']), undefined)
assert.equal(stripPromptCode('p1ab 2', 'p1ab'), '2')
assert.equal(stripPromptCode('p1ab：允许', 'p1ab'), '允许')

assert.deepEqual(optionLines(multi[2]), ['1) 测试', '2) 构建', '3) 静态检查'])

// Text cards are valid Card 2.0 without interactive elements.
const context = { workspace: 'demo-workspace', session: 'session-abcd', time: '2026/11/23 12:00:00' }
const textCard = buildTextQuestionCard({ promptId: 'p1ab', context, questions: multi })
assert.equal(textCard.schema, '2.0')
const interactiveTags = ['button', 'form', 'input', 'select_static', 'multi_select_static']
for (const element of textCard.body.elements) {
  assert.equal(interactiveTags.includes(element.tag), false, `unexpected interactive element ${element.tag}`)
}
assert.ok(JSON.stringify(textCard).length < 30_000)
assert.ok(JSON.stringify(textCard).includes('请求编号'))

const progress = buildTextQuestionCard({
  promptId: 'p1ab',
  context,
  questions: multi,
  answered: new Map([[0, { id: 'q1', selected: ['方案 A'] }]]),
  note: '已记录，还剩 2 个问题待回答。',
})
assert.ok(JSON.stringify(progress).includes('已记录'))

const approval = buildTextApprovalCard({
  promptId: 'p2cd',
  context,
  toolName: 'bash',
  reason: '需要写入工作区外文件',
})
assert.equal(approval.header.template, 'orange')
assert.ok(JSON.stringify(approval).includes('回复 `1` 允许一次'))

console.log('poll tests passed')
