/**
 * Feishu Card 2.0 builders for the DSH bridge.
 *
 * Every card the bridge sends goes through one of these builders so the payload
 * shape stays consistent: a blue question card, an orange approval card, and a
 * grey/green settled card that replaces the interactive one when the request is
 * over. All interactive elements carry a JSON `action_value` that names the
 * prompt, so a late callback can still be attributed.
 */

import { optionLines } from './poll.js'

const MAX_QUESTION_CHARS = 700
const MAX_DETAIL_CHARS = 1500
const MAX_REASON_CHARS = 700

/** Escape the two characters that would otherwise open card HTML tags. */
function escapeText(value) {
  return String(value).replaceAll('<', '&#60;').replaceAll('>', '&#62;')
}

/** Truncate long model-authored text and mark the cut. */
function clip(value, max) {
  const text = String(value ?? '')
  return text.length <= max ? text : `${text.slice(0, max)}…（已截断）`
}

/** One plain-text run. */
function plainText(content) {
  return { tag: 'plain_text', content }
}

/** Build a caption-sized grey markdown line. */
function caption(content) {
  return { tag: 'markdown', content, text_size: 'notation' }
}

/** Render the session context shown under every card title. */
export function contextLine(context) {
  const meta = []
  if (typeof context?.workspace === 'string' && context.workspace.length > 0) meta.push(`工作目录 ${context.workspace}`)
  if (typeof context?.session === 'string' && context.session.length > 0) meta.push(`session ${context.session}`)
  if (typeof context?.agent === 'string' && context.agent.length > 0) meta.push(`Agent ${context.agent}`)
  if (typeof context?.time === 'string' && context.time.length > 0) meta.push(context.time)
  const lines = []
  // The title gets its own line so it reads as a heading for humans; the
  // session id stays on the meta line for agent-side disambiguation.
  if (typeof context?.title === 'string' && context.title.length > 0) {
    lines.push(`**会话标题**：${escapeText(clip(context.title, 60))}`)
  }
  if (meta.length > 0) lines.push(`<font color='grey'>${escapeText(meta.join(' · '))}</font>`)
  return lines.join('\n')
}

/** The one-line footer that explains the arbitration rule. */
function arbitrationFooter() {
  return caption(
    '电脑端与飞书任一渠道**先提交者生效**。另一渠道之后的提交会被判定为已完成 / 已失效。'
    + '\n也可以直接在本会话回复消息：回 `1` 选第 1 个选项，回其他文字作为自定义答案。',
  )
}

/** Footer naming the prompt so concurrent prompts can be disambiguated. */
function promptCodeFooter(promptId) {
  return caption(`请求编号 \`${promptId}\`：同时有多个请求时，回复开头带上编号，例如 \`${promptId} 1\`。`)
}

/** Map one question's selected labels / custom text onto its answer item. */
function answerItem(question, selected, custom) {
  const item = { id: question.id, selected: [...selected] }
  const text = typeof custom === 'string' ? custom.trim() : ''
  if (text.length > 0) {
    item.custom = text
    if (question.multiSelect !== true) item.selected = []
  }
  return item
}

/** Convert form values into a complete answer batch. */
export function collectAnswers(questions, formValues) {
  const answers = []
  for (let index = 0; index < questions.length; index += 1) {
    const question = questions[index]
    const rawSelect = formValues?.[`s${String(index)}`]
    const rawMulti = formValues?.[`m${String(index)}`]
    const rawCustom = formValues?.[`c${String(index)}`]
    let selected = []
    if (Array.isArray(rawMulti)) selected = rawMulti.map(String)
    else if (typeof rawMulti === 'string' && rawMulti.length > 0) selected = rawMulti.split(',').map((value) => value.trim()).filter(Boolean)
    else if (typeof rawSelect === 'string' && rawSelect.length > 0) selected = [rawSelect]
    const labels = selected
      .map((token) => {
        const match = /^i(\d+)$/.exec(token)
        return match === null ? token : question.options?.[Number(match[1])]?.label
      })
      .filter((label) => typeof label === 'string' && label.length > 0)
    const custom = typeof rawCustom === 'string' ? rawCustom : undefined
    if (labels.length === 0 && (custom === undefined || custom.trim().length === 0)) {
      if (question.options === undefined || question.options.length === 0) {
        return { ok: false, error: `「${question.header ?? question.question.slice(0, 20)}」需要填写内容` }
      }
      continue
    }
    answers.push(answerItem(question, labels, custom))
  }
  if (answers.length === 0) return { ok: false, error: '请选择选项或填写自定义答案后再提交' }
  return { ok: true, answers }
}

/** Validate a batch submitted through quick action buttons against the request. */
export function answerFromButton(questions, questionId, label) {
  const question = questions.find((item) => item.id === questionId)
  if (question === undefined) return { ok: false, error: '按钮对应的子问题已不存在' }
  if (question.options?.some((option) => option.label === label) !== true) {
    return { ok: false, error: '该选项不在本次请求中' }
  }
  return { ok: true, answers: [{ id: question.id, selected: [label] }] }
}

/** Option buttons for one single-select question (labels carry reply numbers). */
function optionButtons(promptId, question) {
  const options = question.options ?? []
  return options.map((option, index) => ({
    tag: 'button',
    text: plainText(clip(`${String(index + 1)}) ${option.label}`, 90)),
    type: index === 0 ? 'primary_filled' : 'default',
    width: 'fill',
    behaviors: [{
      type: 'callback',
      value: { t: 'q', p: promptId, q: question.id, v: option.label },
    }],
  }))
}

/** Render one question's prompt block (heading, body, detail, mode hint). */
function questionBlock(question, index, total, { inlineMode = false } = {}) {
  const lines = []
  const heading = question.header !== undefined && String(question.header).length > 0
    ? String(question.header)
    : `问题 ${String(index + 1)}`
  const hasOptions = (question.options?.length ?? 0) > 0
  const mode = question.multiSelect === true ? '可多选' : '单选'
  if (total > 1 && inlineMode) {
    const hint = hasOptions ? mode : '直接填写'
    lines.push(`**${String(index + 1)}. ${escapeText(clip(heading, 80))}**<font color='grey'> · ${hint}</font>`)
  } else {
    lines.push(`**${String(index + 1)}. ${escapeText(clip(heading, 80))}**`)
  }
  lines.push(escapeText(clip(question.question, MAX_QUESTION_CHARS)))
  if (typeof question.detail === 'string' && question.detail.length > 0) {
    lines.push('')
    lines.push(`> ${escapeText(clip(question.detail, MAX_DETAIL_CHARS)).replaceAll('\n', '\n> ')}`)
  }
  if (total > 1 && !inlineMode) {
    lines.push('')
    lines.push(`<font color='grey'>${mode}${hasOptions ? '' : ' · 直接填写'}</font>`)
  }
  return { tag: 'markdown', content: lines.join('\n'), margin: '0px' }
}

/** One question's free-text input; required when the question offers no options. */
function customInput(question, index) {
  const hasOptions = (question.options?.length ?? 0) > 0
  return {
    tag: 'input',
    name: `c${String(index)}`,
    placeholder: plainText(hasOptions ? '其他 / 修改意见（可选）' : '输入你的回答'),
    label: plainText(hasOptions ? '自定义答案' : '回答'),
    label_position: 'top',
    input_type: hasOptions ? 'text' : 'multiline_text',
    max_length: 1000,
    required: !hasOptions,
    margin: '2px 0px 4px 0px',
  }
}

/** Build one question card. */
export function buildQuestionCard({ promptId, context, questions }) {
  const single = questions.length === 1 && questions[0].multiSelect !== true && (questions[0].options?.length ?? 0) > 0
  const elements = []
  const contextText = contextLine(context)
  if (contextText.length > 0) elements.push(caption(contextText))
  const formElements = []
  if (single) {
    const question = questions[0]
    elements.push(questionBlock(question, 0, 1))
    elements.push(...optionButtons(promptId, question))
    formElements.push(customInput(question, 0))
  } else {
    // One form holds every question so the batch is submitted once. Each
    // question's prompt sits right above its own controls, inside the form.
    for (let index = 0; index < questions.length; index += 1) {
      const question = questions[index]
      formElements.push(questionBlock(question, index, questions.length, { inlineMode: true }))
      const options = question.options ?? []
      if (options.length > 0) {
        const multi = question.multiSelect === true
        formElements.push({
          tag: multi ? 'multi_select_static' : 'select_static',
          name: `${multi ? 'm' : 's'}${String(index)}`,
          placeholder: plainText(multi ? '选择一个或多个选项' : '选择一个选项'),
          options: options.map((option, optionIndex) => ({
            text: plainText(clip(option.label, 90)),
            value: `i${String(optionIndex)}`,
          })),
          width: 'fill',
          margin: '6px 0px 2px 0px',
        })
      }
      formElements.push(customInput(question, index))
    }
  }
  formElements.push({
    tag: 'button',
    name: 'submit',
    text: plainText(single ? '提交自定义答案' : questions.length > 1 ? '提交全部答案' : '提交答案'),
    type: single ? 'default' : 'primary_filled',
    form_action_type: 'submit',
    width: 'fill',
    margin: '10px 0px 0px 0px',
  })
  elements.push({ tag: 'form', name: `form_${promptId}`, elements: formElements })
  elements.push(arbitrationFooter())

  return {
    schema: '2.0',
    config: {
      update_multi: true,
      width_mode: 'default',
      summary: { content: questions.length > 1 ? `DSH 请你确认 ${String(questions.length)} 个问题` : 'DSH 请你确认' },
    },
    header: {
      title: plainText(questions.length > 1 ? `DSH 请你确认 ${String(questions.length)} 个问题` : 'DSH 请你确认'),
      subtitle: plainText('在飞书直接回答，或回到电脑端作答，先提交者生效'),
      template: 'blue',
    },
    body: { direction: 'vertical', padding: '12px 12px 20px 12px', elements },
  }
}

/** Build one permission approval card. */
export function buildApprovalCard({ promptId, context, toolName, reason, displayReason }) {
  const elements = []
  const contextText = contextLine(context)
  if (contextText.length > 0) elements.push(caption(contextText))
  const lines = [`**工具** \`${escapeText(clip(toolName, 120))}\``]
  const localized = displayReason?.zh_cn ?? displayReason?.en
  const reasonText = typeof localized === 'string' && localized.length > 0 ? localized : reason
  if (typeof reasonText === 'string' && reasonText.length > 0) {
    lines.push('')
    lines.push(`**原因** ${escapeText(clip(reasonText, MAX_REASON_CHARS))}`)
  }
  elements.push({ tag: 'markdown', content: lines.join('\n') })
  elements.push({
    tag: 'button',
    text: plainText('允许一次'),
    type: 'primary_filled',
    width: 'fill',
    behaviors: [{ type: 'callback', value: { t: 'a', p: promptId, v: 'allowed-once' } }],
  })
  elements.push({
    tag: 'button',
    text: plainText('拒绝'),
    type: 'danger',
    width: 'fill',
    behaviors: [{ type: 'callback', value: { t: 'a', p: promptId, v: 'rejected' } }],
  })
  elements.push(caption('电脑端与飞书任一渠道**先提交者生效**。本次授权只对当前这一次操作有效。'))
  return {
    schema: '2.0',
    config: { update_multi: true, width_mode: 'default', summary: { content: 'DSH 操作审批' } },
    header: {
      title: plainText('DSH 操作审批'),
      subtitle: plainText('同意或拒绝这次操作，先提交者生效'),
      template: 'orange',
    },
    body: { direction: 'vertical', padding: '12px 12px 20px 12px', elements },
  }
}

/** Format one answer batch for display in a settled card. */
export function formatAnswers(questions, answers) {
  if (!Array.isArray(answers) || answers.length === 0) return '_（未记录具体答案）_'
  const lines = []
  for (const answer of answers) {
    const question = questions?.find((item) => item.id === answer.id)
    const heading = question?.header ?? question?.question?.slice(0, 40) ?? answer.id
    const selected = Array.isArray(answer.selected) && answer.selected.length > 0
      ? answer.selected.map((label) => `「${escapeText(label)}」`).join('、')
      : ''
    const custom = typeof answer.custom === 'string' && answer.custom.trim().length > 0
      ? `自定义：${escapeText(clip(answer.custom.trim(), 400))}`
      : ''
    const body = [selected, custom].filter(Boolean).join(' · ')
    lines.push(`**${escapeText(clip(heading, 60))}**：${body.length > 0 ? body : '_（跳过）_'}`)
  }
  return lines.join('\n')
}

/** Card that replaces an interactive card once its request is over. */
export function buildSettledCard({ state, context, questions, answers, detail, toolName }) {
  const states = {
    feishu: { title: '✅ 已在飞书提交', template: 'green' },
    desktop: { title: '💻 已在电脑端完成', template: 'green' },
    expired: { title: '⌛ 已失效 / 已取消', template: 'grey' },
    late: { title: '⌛ 已处理，本次操作无效', template: 'grey' },
    stale: { title: '⌛ 该请求已结束', template: 'grey' },
    denied: { title: '⛔ 当前账号无权操作', template: 'red' },
  }
  const meta = states[state] ?? states.stale
  const elements = []
  const contextText = contextLine(context)
  if (contextText.length > 0) elements.push(caption(contextText))
  if (typeof toolName === 'string' && toolName.length > 0) {
    elements.push({ tag: 'markdown', content: `**工具** \`${escapeText(toolName)}\`` })
  }
  if (typeof detail === 'string' && detail.length > 0) {
    elements.push({ tag: 'markdown', content: detail })
  }
  if (Array.isArray(questions) && questions.length > 0) {
    elements.push({ tag: 'markdown', content: formatAnswers(questions, answers) })
  }
  return {
    schema: '2.0',
    config: { update_multi: true, width_mode: 'default', summary: { content: meta.title } },
    header: { title: plainText(meta.title), template: meta.template },
    body: { direction: 'vertical', padding: '12px 12px 20px 12px', elements },
  }
}

/** Small card used when the operator is not allowed or the prompt is unknown. */
export function buildNoticeCard({ title, template = 'grey', content }) {
  return {
    schema: '2.0',
    config: { update_multi: true, width_mode: 'default' },
    header: { title: plainText(title), template },
    body: { direction: 'vertical', padding: '12px 12px 16px 12px', elements: [{ tag: 'markdown', content }] },
  }
}

/** One question block for a text-reply card: numbered options and status. */
function textQuestionBlock(question, index, answered) {
  const lines = []
  const heading = question.header !== undefined && String(question.header).length > 0
    ? String(question.header)
    : `问题 ${String(index + 1)}`
  const mode = question.multiSelect === true ? '多选' : '单选'
  const hasOptions = (question.options?.length ?? 0) > 0
  lines.push(`**${String(index + 1)}. ${escapeText(clip(heading, 80))}**<font color='grey'> · ${hasOptions ? mode : '直接回复文字'}</font>`)
  lines.push(escapeText(clip(question.question, MAX_QUESTION_CHARS)))
  if (typeof question.detail === 'string' && question.detail.length > 0) {
    lines.push('')
    lines.push(`> ${escapeText(clip(question.detail, MAX_DETAIL_CHARS)).replaceAll('\n', '\n> ')}`)
  }
  const options = optionLines(question)
  if (options.length > 0) {
    lines.push('')
    lines.push(options.map((option) => escapeText(option)).join('\n'))
  }
  const collected = answered?.get(index)
  if (collected !== undefined) {
    const chosen = Array.isArray(collected.selected) && collected.selected.length > 0
      ? collected.selected.join('、')
      : collected.custom ?? ''
    lines.push('')
    lines.push(`<font color='green'>✅ 已记录：${escapeText(clip(chosen, 120))}</font>`)
  }
  return { tag: 'markdown', content: lines.join('\n') }
}

/** Instruction block explaining the reply grammar. */
function replyInstructions(questions) {
  const lines = ['**直接在飞书回复消息即可作答**']
  if (questions.length === 1) {
    lines.push('· 回 `1` 选第 1 个选项，回 `2` 选第 2 个，以此类推；直接回其他文字即作为自定义答案。')
    if (questions[0].multiSelect === true) lines.push('· 多选：用逗号分隔，例如 `1,3`。')
  } else {
    lines.push('· 每行回答一个问题：`1=1`、`2=自定义文字`（左侧数字是问题序号，右侧是选项序号或文字）。')
    lines.push('· 也可以按顺序逐条回复，每条消息回答下一个未答的问题。')
    lines.push('· 多选：`1=1,3`。')
  }
  return { tag: 'markdown', content: lines.join('\n'), text_size: 'notation' }
}

/** Text-reply (non-interactive) question card, also used to show progress. */
export function buildTextQuestionCard({ promptId, context, questions, answered, note }) {
  const elements = []
  const contextText = contextLine(context)
  if (contextText.length > 0) elements.push(caption(contextText))
  for (let index = 0; index < questions.length; index += 1) {
    elements.push(textQuestionBlock(questions[index], index, answered))
  }
  if (typeof note === 'string' && note.length > 0) {
    elements.push({ tag: 'markdown', content: `<font color='orange'>${escapeText(note)}</font>` })
  }
  elements.push(replyInstructions(questions))
  elements.push(arbitrationFooter())
  elements.push(promptCodeFooter(promptId))
  const remaining = answered === undefined ? questions.length : questions.length - answered.size
  return {
    schema: '2.0',
    config: {
      update_multi: true,
      width_mode: 'default',
      summary: { content: questions.length > 1 ? `DSH 请你确认 ${String(questions.length)} 个问题` : 'DSH 请你确认' },
    },
    header: {
      title: plainText(questions.length > 1 ? `DSH 请你确认 ${String(questions.length)} 个问题` : 'DSH 请你确认'),
      subtitle: plainText(remaining > 0 && answered !== undefined
        ? `还剩 ${String(remaining)} 个问题待回答`
        : '在飞书回消息作答，或回到电脑端作答，先提交者生效'),
      template: 'blue',
    },
    body: { direction: 'vertical', padding: '12px 12px 20px 12px', elements },
  }
}

/** Text-reply (non-interactive) approval card. */
export function buildTextApprovalCard({ promptId, context, toolName, reason, displayReason }) {
  const elements = []
  const contextText = contextLine(context)
  if (contextText.length > 0) elements.push(caption(contextText))
  const lines = [`**工具** \`${escapeText(clip(toolName, 120))}\``]
  const localized = displayReason?.zh_cn ?? displayReason?.en
  const reasonText = typeof localized === 'string' && localized.length > 0 ? localized : reason
  if (typeof reasonText === 'string' && reasonText.length > 0) {
    lines.push('')
    lines.push(`**原因** ${escapeText(clip(reasonText, MAX_REASON_CHARS))}`)
  }
  elements.push({ tag: 'markdown', content: lines.join('\n') })
  elements.push({ tag: 'markdown', content: '**回复 `1` 允许一次，回复 `2` 拒绝。**' })
  elements.push(arbitrationFooter())
  elements.push(promptCodeFooter(promptId))
  return {
    schema: '2.0',
    config: { update_multi: true, width_mode: 'default', summary: { content: 'DSH 操作审批' } },
    header: {
      title: plainText('DSH 操作审批'),
      subtitle: plainText('回复消息作答，先提交者生效'),
      template: 'orange',
    },
    body: { direction: 'vertical', padding: '12px 12px 20px 12px', elements },
  }
}
