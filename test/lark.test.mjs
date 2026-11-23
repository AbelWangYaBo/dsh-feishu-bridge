import { LarkCli, createFileLogger, resolveLarkCli } from '../lib/lark.js'
import { buildNoticeCard } from '../lib/card.js'
import { configuredCliOptions, configuredTarget, sendsEnabled } from './helpers/app-config.mjs'

const options = configuredCliOptions()
const target = configuredTarget()
if (options === undefined || (target.userId === '' && target.chatId === '') || !sendsEnabled()) {
  console.log('SKIP lark adapter test: needs a configured app and BRIDGE_TEST_SEND=1 (it sends real messages)')
  process.exit(0)
}
const log = createFileLogger(join(tmpdir(), 'feishu-bridge-test.log'))
const lark = new LarkCli({
  bin: resolveLarkCli(undefined),
  log,
  profile: options.profile,
  env: options.env,
})
console.log('lark-cli:', lark.bin, '| profile:', lark.profile ?? '(host)')

const sentTo = target.chatId.length > 0 ? { chatId: target.chatId } : { userId: target.userId }
const card = buildNoticeCard({ title: 'DSH 飞书桥接 · 连通性测试', content: '这是一条测试卡片，几秒后会被自动更新。' })
const sent = await lark.sendCard(card, sentTo)
console.log('sent:', JSON.stringify(sent))
await new Promise((resolve) => setTimeout(resolve, 1500))
const patched = buildNoticeCard({ title: 'DSH 飞书桥接 · 测试完成', template: 'green', content: '发送与更新链路均正常。' })
try {
  await lark.patchCard(sent.messageId, patched)
  console.log('patch: ok')
} catch (error) {
  console.log('patch: failed ->', String(error.message).slice(0, 600))
}

await new Promise((resolve) => {
  let done = false
  const finish = () => { if (!done) { done = true; resolve() } }
  const consumer = lark.startCardConsumer({
    onEvent: (event) => console.log('event:', JSON.stringify(event).slice(0, 200)),
    onReady: () => { console.log('consumer: ready'); consumer.close(); finish() },
    onExit: () => { console.log('consumer: exited before ready'); consumer.close(); finish() },
  })
  setTimeout(() => { console.log('consumer: not ready within 12s'); consumer.close(); finish() }, 12_000)
})
process.exit(0)
