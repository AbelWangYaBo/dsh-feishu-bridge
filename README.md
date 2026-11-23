# dsh-feishu-bridge

DeepSeek Harness（DSH）插件：把 `ask_user_question` 的选项与权限审批同步成飞书卡片/消息，电脑端与飞书两条作答通道竞争，**先提交者生效**，另一方收到「已完成 / 已失效」。飞书里也可以直接回消息作答，或发送「状态 / 帮助」查询桥接状态。**聊天通道**开启后，飞书里的普通消息会转交给一个 DSH 会话，agent 的回复会同步发回飞书。

- Host 插件 + 浏览器设置页（设置/左侧栏 → 飞书桥接），appId/appSecret/目标/开关都在 DSH 内配置；
- 使用插件私有的 lark-cli 配置目录，不影响本机其他使用 lark-cli 的服务；
- 无需重启即可切换应用或热重载插件；
- 确认交互默认可用；**聊天通道默认关闭**（插件只做确认/审批）。需要时在设置页打开：飞书 → DSH 会话转发 + agent 回复回传，可指定项目目录（自动复用/新建会话）、绑定会话、控制是否允许群聊；发送「项目」查看绑定，发送「解绑」重新选择；目标会话忙时会提示消息已排队。

## 依赖

- DSH Desktop（或在同一安装上运行的 DSH Web profile）；
- 本机安装并已配置 `lark-cli`（插件通过它调用飞书 OpenAPI）。
  - 支持 macOS / Linux / Windows；插件不含任何硬编码的机器路径，默认从 `PATH` 查找 `lark-cli`，找不到时可在设置页填写完整路径（Windows 建议填 `lark-cli.exe`，也兼容 `.cmd` shim）；
  - 配置目录、日志都基于 `$DSH_HOME`（缺省为当前用户的 `~/.dsh`），不写死任何绝对路径；
- 一个飞书自建应用（机器人能力 + `im:message`、`im:message:update`、`im:message:readonly` 权限；建议发布 `card.action.trigger` 回调与 `im.message.receive_v1` 事件，均用长连接）。
- 首次安装后重启一次 DSH 让设置页加载；之后改配置不需要重启。

## 安装

1. 把本目录（或 `dsh-feishu-bridge-*.tgz`）通过 DSH「插件 → 添加插件」安装并启用；
2. 重启一次 DSH；
3. 打开 **设置 → 飞书桥接**（或左侧栏入口），填 App ID / App Secret、目标群名或私聊 open_id（高级项与 lark-cli 路径也在同一页），保存；
4. 点「发送测试卡片」确认飞书收到；详细配置与限制见 [docs/DETAIL.md](docs/DETAIL.md)、[docs/HANDOFF.md](docs/HANDOFF.md)。

## 文件

- `index.js` — 插件入口：拦截 `user-questions/request` 与 `approval/request`，维护先提交者仲裁、轮询与卡片结算。
- `lib/lark.js` — lark-cli 适配：发卡、patch 卡片、卡片回调事件消费、聊天消息读取、目标群发现；支持私有配置目录与独立 app 凭据。
- `lib/card.js` — 飞书 Card 2.0 构建：交互卡片、文本作答卡片、审批卡片、结算卡片。
- `lib/poll.js` — 文本作答解析（编号选项、多问题、多选、审批、请求编号）。
- `client.js` — 浏览器设置页（设置 → 飞书桥接；首次安装后需重启一次 DSH 才出现）：读写 `/api/feishu-bridge/config` 与测试卡片。
- `docs/HANDOFF.md` — 交付说明：实现、验证证据、安装配置、限制与后续。
- `test/*.test.mjs` — 离线与真实 API 测试：
  - 离线：`card` / `poll` / `bridge` / `isolation` / `reload` / `injection` / `config-api`
  - 真实 API：一律使用插件自己配置的应用（读 `~/.dsh/feishu-bridge.json` 的 appId + 私有 lark-cli 目录），**绝不使用宿主默认 profile**；会发消息的用例默认跳过，需显式 `BRIDGE_TEST_SEND=1` 才执行（`lark` / `live-late` / `inspect-multiq-card` / `real-poll`）。

## 关键实现点

- 以 `prepend: true` 注册 waterfall 监听器，先于 Web 转发器执行；把请求交给 `next()` 的同时保持飞书通道挂起。
- 飞书先答时，把请求对象的 `signal` 换成 `AbortSignal.any([原信号, 取消信号])`，并中止取消信号；Gateway 因此向客户端发送 cancel 帧，电脑端卡片自行关闭。
- 电脑端先答时，用 patch 更新飞书卡片并标记该 prompt 已结算；之后的回调/消息命中 `settled` 分支，只提示不生效。
- 无长连接可用时（`auto` 降级）改用轮询：只在有未结算请求时轮询，按发送卡片后的 `message_position` 基线过滤，只认允许名单用户的文本回复。
- 专用应用：配置 `appId`/`appSecret` 后，插件通过 `LARKSUITE_CLI_CONFIG_DIR` 指向 `$DSH_HOME/feishu-bridge/lark-cli` 的私有配置目录，不触碰全局 lark-cli 配置。
- 目标发现：只填应用凭据时，按 `target.chatName` 或机器人已加入的唯一群自动发现目标群。
- 配置热加载：设置页保存后立即重建（另有 5 秒文件监视兜底），无需重启 DSH。
- 入站消息：`im.message.receive_v1` 长连接消费者（与卡片回调共用 lark-cli bus），支持作答、「状态」「帮助」「ping」命令和私聊确认回复；`watchMessages: false` 关闭。
- 设置页：Host 暴露 `GET/POST /api/feishu-bridge/config`、`POST /api/feishu-bridge/test-card`、`POST /api/feishu-bridge/reload`（HMR 免审批热重载，有未完成确认时拒绝）；浏览器端注册 `settings.section` 页面。切换 App ID 时会自动清空旧应用的 operator open_id 白名单，状态区显示阻塞原因。

## License

MIT
