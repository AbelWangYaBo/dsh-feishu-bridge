# 交付说明（HANDOFF）

## 目标

在 DSH Desktop 中把人工确认（`ask_user_question` 选项与权限审批）镜像到飞书，人不在电脑边也能作答；**电脑端与飞书先提交者生效**，另一方收到「已完成 / 已失效」。要求 appId / appSecret 可在插件内配置、可分享给他人使用。

## 已实现

| 能力 | 说明 |
|---|---|
| 问题桥接 | 单选 / 多选 / 自由文本；一次请求的多个问题渲染到同一张卡片，一次提交 |
| 审批桥接 | 「允许一次 / 拒绝」，与问题共用同一套仲裁 |
| 先提交者生效 | 两条通道同时挂起；任一通道先到 Host 即生效 |
| 电脑端让位 | 飞书先答时，插件中止转发给电脑端的请求信号，Gateway 向浏览器发 cancel 帧，电脑端待确认卡片自行关闭 |
| 迟到提示 | 电脑端先答后，飞书再提交会收到「已由电脑端处理，本次提交无效（已完成 / 已失效）」卡片/消息 |
| 两种接收方式 | `auto`：能收到卡片回调就用按钮（长连接），否则降级为「飞书回消息作答」；轮询在两种模式下兜底 |
| 多问题批量 | 消息作答支持 `1=2`、`2=自由文本`、多选 `1,3`，也可按顺序逐条回复 |
| 应用凭据隔离 | 配置 `appId`/`appSecret` 后，插件用 `LARKSUITE_CLI_CONFIG_DIR` 指向 `$DSH_HOME/feishu-bridge/lark-cli` 私有目录，不改动全局 `~/.lark-cli`，不影响其他服务 |
| 目标自动发现 | 只填应用凭据时，按 `target.chatName` 或机器人所在的唯一群自动发现目标群 |
| DSH 内配置页 | 设置 → 飞书桥接：App ID/Secret、目标群/chat_id/open_id、接收方式、开关、发送测试卡片；保存即热加载 |
| 诊断 | 状态区显示阻塞原因（凭据无效、机器人未入群、群名不唯一、发卡失败等） |
| 分享 | 插件目录或 `dsh-feishu-bridge-0.2.0.tgz` 可直接给他人安装，各自填自己的应用 |

## 关键实现

- `index.js` 以 `prepend: true` 注册 `user-questions/request` / `approval/request` waterfall 监听器，先于 Web 转发器执行；把请求交给 `next()`（电脑端照常显示）的同时保持飞书通道挂起。
- 飞书先答：把请求对象的 `signal` 替换为 `AbortSignal.any([原信号, 取消信号])` 并中止取消信号 → Gateway 取消转发事件 → 电脑端卡片关闭。
- 电脑端先答：`patch` 更新飞书卡片为「已在电脑端完成」，该 prompt 标记 settled；后续回调/消息走迟到分支。
- 消息作答：只在有未结算请求时快速轮询（3s），结算后 30 分钟保留窗口内以 30s 慢速轮询，用于发现“迟到的编号回复”并提示失效。
- 配置：`~/.dsh/feishu-bridge.json`（0600）+ 5 秒文件监视热加载；设置页通过 `GET/POST /api/feishu-bridge/config`、`POST /api/feishu-bridge/test-card` 读写。
- 换应用时自动清空旧应用作用域的 operator open_id 白名单。

## 真实应用联调结果（专用应用，回调模式）

- 飞书开发者后台回调配置为长连接；插件 lark-cli 消费者保持连接（`[source] feishu-websocket: connected`，`mode=callback`）。
- **飞书先答**：真实 `ask_user_question` 卡片点「继续」→ 日志 `answered from Feishu (card)` → `desktop answerer failed: answered-from-feishu`（电脑端待确认被取消）→ 卡片 `settled via token`。
- **电脑端先答**：电脑端点选后，飞书卡片被替换为「💻 已在电脑端完成」，按钮消失（消息 `updated: true`，内容含所选答案）。
- **多问题一次提交**：两问题卡片（下拉 + 自定义输入）在飞书一次提交 → 返回 `q1=方案 B`、`q2.custom=ok`，同样由飞书先提交生效。
- 单问题按钮卡片、测试卡片发送、私有 lark-cli 目录、配置热加载均已在真实应用中验证。
- 卡片上下文行同时显示**会话标题**（`ctx.sessionTitle.get(session)`，长标题截断）与 session 短 id；实测卡片内容为：`工作目录 demo-workspace · 会话「示例会话标题」 · session session-abcd1234 · …`。

## 验证证据

离线（全部通过）：`card` / `poll` / `bridge`（先答仲裁、双向迟到、批次）/ `isolation`（私有 lark-cli 目录 0600）/ `reload`（配置热加载）/ `injection` / `config-api`（校验、换应用清白名单、密钥保留/清除）。
真实飞书 API：
- `real-discovery`：列举机器人所在群并按群名解析目标群 → 通过；
- `real-poll`：历史用户消息驱动完整读取链路（列消息→过滤→请求编号→解析→抢占→答案）；夹具滚出窗口时明确 SKIP；
- `live-late`：电脑端先答 → 飞书迟到回复 → 发出「该请求已由电脑端处理，本次飞书提交无效」通知 → 通过；
- 真实 `ask_user_question` 拦截 + 飞书作答（注入）→ 工具返回飞书答案，日志出现 `desktop answerer failed: answered-from-feishu`（电脑端被主动取消）→ 通过。
- 设置页：React 静态渲染（模块 id、`settings.section` 注册、8 个输入、密码框、下拉、按钮）+ Host API 实测（非法 App ID 拒绝、保存后私有目录创建、未就绪时安全降级、恢复配置后 ready）。
- 隔离验证：独立配置目录下 lark-cli 正常工作，全局 `~/.lark-cli/config.json` 哈希前后不变。

## 免审批热重载与运行期换应用

- 设置页提供「热重载插件」，Host 暴露 `POST /api/feishu-bridge/reload`：通过 DSH 的 HMR 服务 `ctx.hmr.runExclusive(() => reconcileProfile())` 重载被替换的文件，**不经过 plugin_manager、不需要审批**；有未完成确认时拒绝。实测：改文件后调用接口出现 `stopped → starting → hot reload finished` 并重新进入 callback 模式。
- 运行中改 App ID 立即生效：重建私有 lark-cli 目录、清空应用级 `open_id`/`chat_id`/白名单、重新发现目标；新请求走新应用；旧应用未完成卡片标记失效。实测切到 dummy 应用再切回，状态从 `ready=false` 恢复到 `ready=true, mode=callback`。

## 飞书消息闭环

- 追加 `im.message.receive_v1` 消费者（应用已发布该事件时可用），与卡片回调共用同一个 lark-cli bus。
- 入站文本统一进 `handleIncomingText`：命令（状态/帮助/ping）→ 待确认请求作答 → 私聊确认回复；消息按 `message_id` 去重；群聊不刷屏。
- `watchMessages: false` 可关闭；未发布消息事件时退化为对已知会话的轮询（idle 约 30s）。

## 聊天通道（v0.3.0）

- 飞书普通消息通过 `ctx.sessionController.prompt({sessionId, content:[{type:'text',text}], mode:'queue'})` 进入会话；目标会话按「绑定 → 最近活跃根会话」解析。
- 镜像：`ctx.on('session/event')` 监听绑定会话的 `assistant/message`，提取文本块分条发回飞书；未绑定会话不镜像。
- 命令与确认作答优先于聊天转发；群聊默认关闭转发；设置页可开关、指定项目目录、绑定会话、允许群聊。
- 项目目录：`chat.cwd` 有值时按目录查找最近活跃会话，找不到则通过 `sessionController.create({cwd})` 新建；「项目」命令回显目录/会话/标题。
- 目标选择改进（v0.3.2）：优先最近发过飞书确认卡片的会话，其次最近空闲会话，最后才是忙会话；忙会话会回复「已排队」；新增「解绑」命令。
- 单测覆盖：转发目标选择、pinned 会话、群聊拦截、无会话提示、长文本分片、镜像开关、作答优先。

## 安装与配置

1. 安装插件（本地目录或 tarball），在插件管理中启用；
2. **重启一次 DSH**（首次需要，浏览器端才会加载设置页）；
3. 设置 → 飞书桥接 → 填 App ID / App Secret、目标群名（建议新建群「DSH 确认」把机器人拉进去）、接收方式 → 保存；
4. 点「发送测试卡片」确认飞书收到；之后也可以从左侧栏「飞书桥接」进入同一配置页。

应用侧最小配置：开启机器人能力；权限 `im:message`、`im:message:update`、`im:message:readonly`；如需按钮模式，在「事件与回调」中选长连接并订阅「卡片回传交互」。

## 已知限制

- 群聊自动发现只覆盖机器人已加入的群；私聊需要显式的 chat_id / open_id。
- 文本作答每个问题只接受一条答案；先答的问题会显示「已记录」，全部答完才一次性提交。
- 飞书卡片只在发送后 14 天内可更新；更晚的迟到提交只能收到文字提示。
- 子代理会话的请求不桥接（DSH 本身不允许子代理直接向人提问）。
- `testAcceptBotReplies` 仅供自动化验证，日常保持关闭。

## 后续（非本次范围）

核心逻辑已按宿主无关拆分：`lib/card.js`（卡片）、`lib/poll.js`（文本作答解析）、`lib/lark.js`（飞书适配）。接入 Claude 等其它 Agent 时复用这三个模块，只需新增一层宿主适配（把该宿主的确认事件映射到 `AskUserQuestionRequest` / `ApprovalRequestEvent` 形状）。
