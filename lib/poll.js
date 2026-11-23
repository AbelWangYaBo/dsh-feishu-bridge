/**
 * Plain-text reply parsing for the Feishu bridge.
 *
 * The card callback path is preferred, but it requires this lark-cli profile to
 * own the app's long connection. When another consumer owns it, a message in the
 * chat is the answer channel instead: these parsers turn that text into the same
 * answer batches / approval outcomes the callback path produces.
 */

/** Normalize one option label or user token for comparison. */
function normalize(value) {
  return String(value)
    .replaceAll('\u3000', ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
}

/** Explicit `1=value` / `2：value` line selector. */
const NUMBERED_LINE = /^\s*(?:q|Q|第)?\s*(\d+)\s*(?:题)?\s*[=:：]\s*(.+)$/

/** Split a multi-value token list. */
function splitTokens(value) {
  return String(value)
    .split(/[,，、;；/\s]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
}

/**
 * Parse one question's reply value.
 * @returns `{ ok: true, answer }` or `{ ok: false, error }`.
 */
export function parseQuestionValue(question, value) {
  const text = String(value ?? '').trim()
  const options = Array.isArray(question.options) ? question.options : []
  if (text.length === 0) return { ok: false, error: '回答内容为空' }
  if (options.length === 0) {
    return { ok: true, answer: { id: question.id, selected: [], custom: text } }
  }

  const multi = question.multiSelect === true
  const byLabel = options.find((option) => normalize(option.label) === normalize(text))
  if (byLabel !== undefined && !multi) {
    return { ok: true, answer: { id: question.id, selected: [byLabel.label] } }
  }

  const tokens = splitTokens(text)
  if (tokens.length === 0) return { ok: false, error: '回答内容为空' }
  const selected = []
  const unknown = []
  for (const token of tokens) {
    if (/^\d+$/.test(token)) {
      const index = Number(token) - 1
      if (index >= 0 && index < options.length) {
        selected.push(options[index].label)
        continue
      }
      unknown.push(token)
      continue
    }
    const match = options.find((option) => normalize(option.label) === normalize(token))
    if (match !== undefined) selected.push(match.label)
    else unknown.push(token)
  }

  if (selected.length === 0) {
    // Nothing matched an option: the whole reply is a free-form answer.
    return { ok: true, answer: { id: question.id, selected: [], custom: text } }
  }
  if (!multi) {
    if (selected.length > 1) return { ok: false, error: '该问题是单选，请只回复一个选项' }
    // A single-select question with extra text means the user edited the answer.
    if (unknown.length > 0) return { ok: true, answer: { id: question.id, selected: [], custom: text } }
    return { ok: true, answer: { id: question.id, selected } }
  }
  const answer = { id: question.id, selected }
  if (unknown.length > 0) answer.custom = unknown.join(' ')
  return { ok: true, answer }
}

/**
 * Merge one reply into the answers already collected for a prompt.
 * @param questions - the request's questions, in card order.
 * @param text - the user's message text (prompt code already stripped).
 * @param answered - Map of question index to the answer item collected so far.
 * @returns merged answers and whether every question has an answer.
 */
export function parseQuestionReply(questions, text, answered = new Map()) {
  const trimmed = String(text ?? '').trim()
  if (trimmed.length === 0) return { ok: false, error: '回复内容为空' }
  const updates = new Map()
  const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0)
  const explicit = []
  for (const line of lines) {
    const match = NUMBERED_LINE.exec(line)
    if (match !== null) explicit.push({ index: Number(match[1]) - 1, value: match[2].trim() })
  }
  if (explicit.length > 0) {
    for (const { index, value } of explicit) {
      if (!Number.isInteger(index) || index < 0 || index >= questions.length) {
        return { ok: false, error: `本次请求没有第 ${String(index + 1)} 个问题` }
      }
      const parsed = parseQuestionValue(questions[index], value)
      if (!parsed.ok) return parsed
      updates.set(index, parsed.answer)
    }
  } else {
    const target = questions.findIndex((_question, index) => !answered.has(index))
    if (target === -1) return { ok: false, error: '所有问题都已经回答过了' }
    const parsed = parseQuestionValue(questions[target], trimmed)
    if (!parsed.ok) return parsed
    updates.set(target, parsed.answer)
  }
  const merged = new Map(answered)
  for (const [index, answer] of updates) merged.set(index, answer)
  const missing = questions.map((_question, index) => index).filter((index) => !merged.has(index))
  return { ok: true, answers: merged, complete: missing.length === 0, missing }
}

/** Parse an approval reply: `1`/允许 grants once, `2`/拒绝 rejects. */
export function parseApprovalReply(text) {
  const normalized = normalize(text)
  if (['1', '允许', '同意', '批准', 'approve', 'ok', 'yes', 'y'].includes(normalized)) {
    return { ok: true, outcome: 'allowed-once' }
  }
  if (['2', '拒绝', '不同意', '驳回', 'reject', 'no', 'n'].includes(normalized)) {
    return { ok: true, outcome: 'rejected' }
  }
  return { ok: false, error: '请回复 1（允许一次）或 2（拒绝）' }
}

/** Remove a leading prompt code (`p1abc` or `p1abc:`) from a reply. */
export function stripPromptCode(text, promptId) {
  const escaped = String(promptId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return String(text ?? '').replace(new RegExp(`^\\s*${escaped}\\s*[:：,，]?\\s*`, 'i'), '').trim()
}

/** Find a leading prompt code among the given pending prompt ids. */
export function leadingPromptCode(text, promptIds) {
  const trimmed = String(text ?? '').trim()
  for (const id of promptIds) {
    if (new RegExp(`^\\s*${String(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$|[:：,，])`, 'i').test(trimmed)) {
      return id
    }
  }
  return undefined
}

/** Render a numbered option list for a text-reply card. */
export function optionLines(question) {
  const options = Array.isArray(question.options) ? question.options : []
  return options.map((option, index) => {
    const description = typeof option.description === 'string' && option.description.length > 0
      ? ` —— ${option.description}`
      : ''
    return `${String(index + 1)}) ${option.label}${description}`
  })
}
