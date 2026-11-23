import assert from 'node:assert/strict'
import { applyConfigUpdate } from '../index.js'

const base = {
  enabled: true,
  receive: 'auto',
  appId: 'cli_appone',
  appSecret: 'secret-one',
  target: { userId: 'ou_old', chatId: '', chatName: '', discover: true },
  allowOperators: ['ou_old'],
  bridge: { questions: true, approvals: true },
  maxPending: 8,
}

// Same app keeps the operator allowlist.
{
  const next = applyConfigUpdate(base, { enabled: true, target: { chatName: 'DSH 确认' } })
  assert.equal(next.appId, 'cli_appone')
  assert.deepEqual(next.allowOperators, ['ou_old'])
  assert.equal(next.target.chatName, 'DSH 确认')
  assert.equal(next.target.userId, 'ou_old', 'unspecified target keys are preserved')
}

// Switching apps clears the old app's open_ids.
{
  const next = applyConfigUpdate(base, { appId: 'cli_apptwo', appSecret: 'secret-two' })
  assert.equal(next.appId, 'cli_apptwo')
  assert.deepEqual(next.allowOperators, [], 'old app open_ids must not authorize the new app')
}

// App-scoped target ids are dropped on an app switch unless supplied now.
{
  const next = applyConfigUpdate(base, { appId: 'cli_apptwo', target: { chatName: 'DSH 确认' } })
  assert.equal(next.target.userId, '', 'old app open_id must not leak into the new app')
  assert.equal(next.target.chatId, '')
  assert.equal(next.target.chatName, 'DSH 确认')
  assert.equal(next.target.discover, true)
}
{
  const next = applyConfigUpdate(base, { appId: 'cli_apptwo', target: { userId: 'ou_new' } })
  assert.equal(next.target.userId, 'ou_new', 'a supplied new-app id is kept')
}

// Explicit allowlist wins over the reset.
{
  const next = applyConfigUpdate(base, { appId: 'cli_apptwo', allowOperators: ['ou_new', ''] })
  assert.deepEqual(next.allowOperators, ['ou_new'])
}

// Secret handling: empty keeps, null clears.
{
  assert.equal(applyConfigUpdate(base, { appSecret: '' }).appSecret, 'secret-one')
  assert.equal('appSecret' in applyConfigUpdate(base, { appSecret: null }), false)
  assert.equal(applyConfigUpdate(base, { appSecret: '  next  ' }).appSecret, 'next')
}

// Empty app id removes the key (fall back to the host lark-cli profile).
{
  const next = applyConfigUpdate(base, { appId: '' })
  assert.equal('appId' in next, false)
  assert.deepEqual(next.allowOperators, [])
}

// Validation.
assert.throws(() => applyConfigUpdate(base, { appId: 'not-an-app' }), /cli_/)
assert.throws(() => applyConfigUpdate(base, { receive: 'carrier-pigeon' }), /auto/)
{
  const next = applyConfigUpdate(base, { bridge: { questions: 'yes' } })
  assert.equal(next.bridge.questions, true, 'non-boolean bridge flags are ignored, not fatal')
}

// Boolean switches and bridge flags merge over the stored values.
{
  const next = applyConfigUpdate(base, { enabled: false, bridge: { approvals: false } })
  assert.equal(next.enabled, false)
  assert.equal(next.bridge.approvals, false)
  assert.equal(next.bridge.questions, true)
}

console.log('config api tests passed')
