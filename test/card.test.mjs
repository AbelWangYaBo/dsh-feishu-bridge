import assert from 'node:assert/strict'
import {
  answerFromButton,
  contextLine,
  buildApprovalCard,
  buildNoticeCard,
  buildQuestionCard,
  buildSettledCard,
  collectAnswers,
  formatAnswers,
} from '../lib/card.js'

const questions = [
  {
    id: 'q1',
    header: '选择方案',
    question: '用哪个方案继续？',
    detail: '方案 A：直接改。\n方案 B：先备份。',
    options: [{ label: '方案 A', description: '直接改' }, { label: '方案 B', description: '先备份' }],
  },
  { id: 'q2', question: '还有什么要补充的？' },
  { id: 'q3', question: '需要哪些检查？', options: [{ label: '测试' }, { label: '构建' }, { label: '静态检查' }], multiSelect: true },
]

const context = { workspace: 'demo-workspace', session: 'session-abcd', time: '2026/11/23 12:00:00' }

const batch = buildQuestionCard({ promptId: 'pabc', context, questions })
assert.equal(batch.schema, '2.0')
assert.equal(batch.header.title.content, 'DSH 请你确认 3 个问题')
const batchJson = JSON.stringify(batch)
assert.ok(batchJson.length < 30_000, `batch card too large: ${String(batchJson.length)}`)
const form = batch.body.elements.find((element) => element.tag === 'form')
assert.ok(form !== undefined)
assert.equal(form.name, 'form_pabc')
const names = form.elements.map((element) => element.name ?? element.tag)
assert.ok(names.includes('s0'), 'single select for q1')
assert.ok(names.includes('c0'), 'custom input for q1')
assert.ok(names.includes('c1'), 'free text input for q2')
assert.ok(names.includes('m2'), 'multi select for q3')
assert.ok(names.includes('submit'), 'submit button')
// Each question's controls sit right below its own prompt, inside the form.
const tagOrder = form.elements.map((element) => element.tag === 'markdown'
  ? `md:${String(element.content).slice(0, 12)}`
  : (element.name ?? element.tag))
const orderIndex = (needle) => tagOrder.findIndex((item) => String(item).startsWith(needle))
assert.ok(orderIndex('md:') < orderIndex('s0'), 'first question prompt precedes its select')
assert.ok(orderIndex('s0') < orderIndex('c0'), 'first select precedes its custom input')
const secondPrompt = tagOrder.findIndex((item, index) => index > orderIndex('c0') && String(item).startsWith('md:'))
assert.ok(secondPrompt > orderIndex('c0'), 'second question prompt precedes its input')
assert.ok(orderIndex('c1') > secondPrompt, 'free-text input follows the second question prompt')

const single = buildQuestionCard({ promptId: 'pdef', context, questions: [questions[0]] })
const singleElements = single.body.elements
assert.equal(singleElements.filter((element) => element.tag === 'button').length, 2, 'one button per option')
assert.ok(singleElements.some((element) => element.tag === 'form'))

const collected = collectAnswers(questions, { s0: 'i1', c1: '补一句', m2: 'i0,i2' })
assert.equal(collected.ok, true)
assert.deepEqual(collected.answers, [
  { id: 'q1', selected: ['方案 B'] },
  { id: 'q2', selected: [], custom: '补一句' },
  { id: 'q3', selected: ['测试', '静态检查'] },
])

const missingFreeText = collectAnswers(questions, { s0: 'i0' })
assert.equal(missingFreeText.ok, false, 'free-text question needs content')

const emptyMulti = collectAnswers([questions[2]], {})
assert.equal(emptyMulti.ok, false)
assert.equal(emptyMulti.error, '请选择选项或填写自定义答案后再提交')

const fromButton = answerFromButton(questions, 'q1', '方案 A')
assert.deepEqual(fromButton, { ok: true, answers: [{ id: 'q1', selected: ['方案 A'] }] })
assert.equal(answerFromButton(questions, 'q1', '不存在').ok, false)

const approval = buildApprovalCard({
  promptId: 'pg',
  context,
  toolName: 'bash',
  reason: '运行 git 命令需要写入权限',
  displayReason: { en: 'Run git', zh_cn: '运行 git 命令' },
})
assert.equal(approval.header.template, 'orange')
const approvalButtons = approval.body.elements.filter((element) => element.tag === 'button')
assert.equal(approvalButtons.length, 2)
assert.equal(JSON.parse(approvalButtons[0].behaviors[0].value ? JSON.stringify(approvalButtons[0].behaviors[0].value) : '{}').v, 'allowed-once')

const settled = buildSettledCard({
  state: 'desktop',
  context,
  questions: [questions[0]],
  answers: [{ id: 'q1', selected: ['方案 A'] }],
})
assert.equal(settled.header.template, 'green')
assert.ok(JSON.stringify(settled).includes('已在电脑端完成'))

const late = buildSettledCard({ state: 'late', context, detail: '该请求已由**电脑端**处理，本次提交无效。' })
assert.equal(late.header.template, 'grey')

const notice = buildNoticeCard({ title: '⌛ 请求已结束', content: '已失效' })
assert.equal(notice.schema, '2.0')

const formatted = formatAnswers([questions[0]], [{ id: 'q1', selected: ['方案 A'] }, { id: 'q2', custom: '补充' }])
assert.ok(formatted.includes('方案 A'))
assert.ok(formatted.includes('自定义：补充'))

const titled = contextLine({ workspace: 'demo-workspace', title: '示例会话标题', session: 'session-abcd1234', time: 't' })
const titledLines = titled.split('\n')
assert.equal(titledLines.length, 2, 'title and metadata are separate lines')
assert.ok(titledLines[0].startsWith('**会话标题**：示例会话标题'), 'title line comes first')
assert.ok(titledLines[0].includes('示例会话标题'))
assert.ok(titledLines[1].includes('工作目录 demo-workspace'))
assert.ok(titledLines[1].includes('session session-abcd1234'), 'session id stays for agent-side disambiguation')
const untitled = contextLine({ workspace: 'demo-workspace', session: 'session-abcd1234' })
assert.equal(untitled.split('\n').length, 1)
assert.ok(untitled.includes('session session-abcd1234'))
const clipped = contextLine({ title: 'x'.repeat(80), session: 's1' })
assert.ok(clipped.includes('…（已截断）'), 'long titles are clipped')

console.log('card tests passed')
console.log('batch card bytes:', JSON.stringify(batch).length)
console.log('approval card bytes:', JSON.stringify(approval).length)
