/**
 * Browser half of `dsh-feishu-bridge`: the Feishu confirmation bridge's
 * settings page, registered into the Settings section list.
 *
 * The page is a thin form over the Host's `/api/feishu-bridge` JSON API: it
 * reads the effective configuration and bridge status, saves app credentials /
 * delivery target / switch changes, and can send one test card. App ID and
 * Secret live in the plugin's own config, so an installed copy is configured
 * here rather than by editing profile files or the shared lark-cli profile.
 */
window.__ModuleLoader__.load({
  id: 'dsh-feishu-bridge',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'feishu-bridge'
    const PANEL_ID = 'feishu-bridge'
    const API = '/api/feishu-bridge'

    const zh = {
      nav: '飞书桥接',
      title: '飞书确认桥接',
      intro: '把 DSH 需要人工确认的请求同步到飞书。电脑端与飞书任一渠道先提交者生效，另一方会收到“已完成 / 已失效”提示。',
      status: '当前状态',
      disabled: '已停用',
      unconfigured: '尚未配置',
      ready: '运行中',
      waiting: '等待可用目标',
      mode: '接收方式',
      modeAuto: '自动（能收到卡片回调就用按钮，否则回消息作答）',
      modePoll: '消息作答（飞书里回复编号）',
      modeCallback: '卡片按钮（需要长连接回调）',
      pending: '待确认请求',
      target: '投递目标',
      app: '飞书应用',
      appId: 'App ID',
      appIdHint: '例如 cli_xxxxxxxxxxxxxxxx',
      appSecret: 'App Secret',
      appSecretHint: '已保存；留空表示不修改',
      chatName: '目标群名',
      chatNameHint: '机器人已加入的群名；只有一个群时可留空',
      chatId: '目标群 chat_id（可选）',
      chatIdHint: 'oc_ 开头；填写后优先于群名',
      userId: '私聊用户 open_id（可选）',
      userIdHint: 'ou_ 开头；私聊时使用',
      enable: '启用飞书桥接',
      questions: '同步问题选项（ask_user_question）',
      approvals: '同步权限审批',
      watchMessages: '接收飞书消息（回复“状态/帮助”与作答确认）',
      save: '保存配置',
      saving: '保存中…',
      test: '发送测试卡片',
      testing: '发送中…',
      saved: '已保存，配置立即生效',
      tested: '测试卡片已发送，请到飞书查看',
      hotReload: '热重载插件',
      hotReloading: '重载中…',
      hotReloadRequested: '已请求热重载；插件会短暂重启，稍后刷新状态即可',
      loadFailed: '读取配置失败',
      reload: '重新读取',
      hint: '配置保存在本机插件配置文件中，保存后立即生效。推荐用群聊：新建一个群（如「DSH 确认」）把机器人拉进去，然后填目标群名。其他人安装本插件后填入自己的 App ID / Secret 即可使用。切换应用后请清空私聊 open_id（旧应用的 open_id 不再有效）。',
      isolated: '独立 lark-cli 配置',
      yes: '是',
      no: '否',
    }
    const en = {
      nav: 'Feishu bridge',
      title: 'Feishu confirmation bridge',
      intro: 'Mirror DSH human confirmations into Feishu. Whichever side submits first wins; the other side is told the request is complete or expired.',
      status: 'Status',
      disabled: 'Disabled',
      unconfigured: 'Not configured',
      ready: 'Running',
      waiting: 'Waiting for a target',
      mode: 'Receive mode',
      modeAuto: 'Auto (card buttons when callbacks work, text replies otherwise)',
      modePoll: 'Text replies',
      modeCallback: 'Card buttons (needs long-connection callbacks)',
      pending: 'Pending prompts',
      target: 'Delivery target',
      app: 'Feishu app',
      appId: 'App ID',
      appIdHint: 'e.g. cli_xxxxxxxxxxxxxxxx',
      appSecret: 'App Secret',
      appSecretHint: 'Saved; leave blank to keep it',
      chatName: 'Target group name',
      chatNameHint: 'A group the bot has joined; optional when it has exactly one',
      chatId: 'Target chat_id (optional)',
      chatIdHint: 'Starts with oc_; wins over the group name',
      userId: 'DM user open_id (optional)',
      userIdHint: 'Starts with ou_; used for direct messages',
      enable: 'Enable the Feishu bridge',
      questions: 'Mirror questions (ask_user_question)',
      approvals: 'Mirror permission approvals',
      watchMessages: 'Answer Feishu text messages (status/help, answers)',
      save: 'Save',
      saving: 'Saving…',
      test: 'Send test card',
      testing: 'Sending…',
      saved: 'Saved; the configuration applies immediately',
      tested: 'Test card sent; check Feishu',
      hotReload: 'Hot reload',
      hotReloading: 'Reloading…',
      hotReloadRequested: 'Reload requested; the plugin restarts briefly',
      loadFailed: 'Could not read the configuration',
      reload: 'Reload',
      hint: 'The configuration lives in this plugin’s own local file. Anyone who installs the plugin fills in their own App ID / Secret.',
      isolated: 'Isolated lark-cli home',
      yes: 'yes',
      no: 'no',
    }

    const styles = {
      section: { display: 'flex', flexDirection: 'column', gap: '18px', maxWidth: '720px', color: 'inherit' },
      heading: { margin: 0, fontSize: '18px', fontWeight: 600 },
      intro: { margin: 0, opacity: 0.75, lineHeight: 1.5 },
      card: { border: '1px solid rgba(128,128,128,0.35)', borderRadius: '10px', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '12px' },
      cardTitle: { margin: 0, fontSize: '14px', fontWeight: 600, opacity: 0.9 },
      row: { display: 'flex', flexDirection: 'column', gap: '4px' },
      label: { fontSize: '13px', fontWeight: 500 },
      hint: { fontSize: '12px', opacity: 0.6 },
      input: { padding: '7px 9px', borderRadius: '7px', border: '1px solid rgba(128,128,128,0.45)', background: 'transparent', color: 'inherit', font: 'inherit', width: '100%', boxSizing: 'border-box' },
      checkRow: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px' },
      actions: { display: 'flex', gap: '10px', flexWrap: 'wrap' },
      primary: { padding: '7px 16px', borderRadius: '7px', border: 'none', background: '#3370ff', color: '#fff', font: 'inherit', cursor: 'pointer' },
      secondary: { padding: '7px 16px', borderRadius: '7px', border: '1px solid rgba(128,128,128,0.45)', background: 'transparent', color: 'inherit', font: 'inherit', cursor: 'pointer' },
      badge: (tone) => ({ display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '2px 10px', borderRadius: '999px', fontSize: '12px', border: '1px solid rgba(128,128,128,0.4)', color: 'inherit', background: tone === 'ok' ? 'rgba(52,199,36,0.16)' : tone === 'warn' ? 'rgba(245,166,35,0.16)' : 'transparent' }),
      meta: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', fontSize: '12px', opacity: 0.8 },
      notice: { fontSize: '13px', color: '#34c724' },
      error: { fontSize: '13px', color: '#f54a45' },
    }

    async function request(path, options) {
      const response = await fetch(`${API}${path}`, {
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        ...options,
      })
      const value = await response.json().catch(() => undefined)
      if (value === undefined) throw new Error(`HTTP ${String(response.status)}`)
      if (!response.ok || value.ok !== true) throw new Error(value.error ?? `HTTP ${String(response.status)}`)
      return value
    }

    function Field({ label, hint, children }) {
      return h('div', { style: styles.row },
        h('label', { style: styles.label }, label),
        children,
        hint === undefined ? null : h('span', { style: styles.hint }, hint))
    }

    function Toggle({ checked, onChange, label }) {
      return h('label', { style: styles.checkRow },
        h('input', { type: 'checkbox', checked: checked === true, onChange: (event) => { onChange(event.target.checked) } }),
        h('span', null, label))
    }

    function SettingsSection({ t }) {
      const [status, setStatus] = React.useState(undefined)
      const [loading, setLoading] = React.useState(true)
      const [busy, setBusy] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const [error, setError] = React.useState('')
      const [form, setForm] = React.useState({
        appId: '', appSecret: '', chatName: '', chatId: '', userId: '',
        receive: 'auto', enabled: true, questions: true, approvals: true, watchMessages: true,
      })

      const applyStatus = (value) => {
        setStatus(value)
        setForm({
          appId: value.appId ?? '',
          appSecret: '',
          chatName: value.target?.chatName ?? '',
          chatId: value.target?.chatId ?? '',
          userId: value.target?.userId ?? '',
          receive: value.receive ?? 'auto',
          enabled: value.enabled === true,
          questions: value.bridge?.questions !== false,
          approvals: value.bridge?.approvals !== false,
          watchMessages: value.watchMessages !== false,
        })
      }

      const load = async () => {
        setLoading(true)
        setError('')
        try {
          const value = await request('/config')
          applyStatus(value.config)
        } catch (caught) {
          setError(String(caught.message ?? caught))
        } finally {
          setLoading(false)
        }
      }

      React.useEffect(() => { void load() }, [])

      const update = (key, value) => setForm((previous) => ({ ...previous, [key]: value }))

      const save = async () => {
        setBusy('save')
        setNotice('')
        setError('')
        try {
          const value = await request('/config', {
            method: 'POST',
            body: JSON.stringify({
              enabled: form.enabled,
              appId: form.appId,
              appSecret: form.appSecret,
              receive: form.receive,
              target: { chatName: form.chatName, chatId: form.chatId, userId: form.userId },
              bridge: { questions: form.questions, approvals: form.approvals },
              watchMessages: form.watchMessages,
            }),
          })
          applyStatus(value.config)
          setNotice(t('saved'))
        } catch (caught) {
          setError(String(caught.message ?? caught))
        } finally {
          setBusy('')
        }
      }

      const hotReload = async () => {
        setBusy('reload')
        setNotice('')
        setError('')
        try {
          await request('/reload', { method: 'POST' })
          setNotice(t('hotReloadRequested'))
        } catch (caught) {
          setError(String(caught.message ?? caught))
        } finally {
          setBusy('')
        }
      }

      const sendTest = async () => {
        setBusy('test')
        setNotice('')
        setError('')
        try {
          await request('/test-card', { method: 'POST' })
          setNotice(t('tested'))
        } catch (caught) {
          setError(String(caught.message ?? caught))
        } finally {
          setBusy('')
        }
      }

      const badge = (() => {
        if (loading) return h('span', { style: styles.badge() }, '…')
        if (status === undefined) return h('span', { style: styles.badge() }, t('unconfigured'))
        if (status.enabled !== true) return h('span', { style: styles.badge() }, t('disabled'))
        if (status.ready === true) return h('span', { style: styles.badge('ok') }, t('ready'))
        return h('span', { style: styles.badge('warn') }, t('waiting'))
      })()

      const modeText = status === undefined ? ''
        : status.mode === 'callback' ? t('modeCallback') : status.mode === 'poll' ? t('modePoll') : t('modeAuto')

      return h('div', { style: styles.section },
        h('h2', { style: styles.heading }, t('title')),
        h('p', { style: styles.intro }, t('intro')),

        h('div', { style: styles.card },
          h('h3', { style: styles.cardTitle }, t('status')),
          h('div', { style: styles.meta },
            badge,
            status === undefined ? null : h('span', null, `${t('mode')}: ${modeText}`),
            status === undefined ? null : h('span', null, `${t('pending')}: ${String(status.pending ?? 0)}`),
            status === undefined ? null : h('span', null, `${t('isolated')}: ${status.isolated === true ? t('yes') : t('no')}`)),
          status === undefined ? null : h('div', { style: styles.meta },
            h('span', null, `${t('target')}: ${status.target?.chatId || status.target?.chatName || status.target?.userId || '—'}`),
            status.appId ? h('span', null, `${t('appId')}: ${status.appId}`) : null),
          status !== undefined && typeof status.issue === 'string' && status.issue.length > 0
            ? h('div', { style: styles.error }, status.issue)
            : null,
          h('div', { style: styles.actions },
            h('button', { type: 'button', style: styles.secondary, onClick: () => { void load() }, disabled: loading }, t('reload')),
            h('button', { type: 'button', style: styles.secondary, onClick: () => { void sendTest() }, disabled: busy !== '' }, busy === 'test' ? t('testing') : t('test')),
            h('button', { type: 'button', style: styles.secondary, onClick: () => { void hotReload() }, disabled: busy !== '' }, busy === 'reload' ? t('hotReloading') : t('hotReload')))),

        h('div', { style: styles.card },
          h('h3', { style: styles.cardTitle }, t('app')),
          h(Field, { label: t('appId'), hint: t('appIdHint') },
            h('input', {
              style: styles.input,
              value: form.appId,
              placeholder: 'cli_...',
              spellCheck: false,
              onChange: (event) => {
                const value = event.target.value
                update('appId', value)
                // open_id is app-scoped: a changed app invalidates the old one.
                if (status !== undefined && value !== (status.appId ?? '') && form.userId.length > 0) update('userId', '')
              },
            })),
          h(Field, { label: t('appSecret'), hint: t('appSecretHint') },
            h('input', {
              style: styles.input,
              type: 'password',
              value: form.appSecret,
              placeholder: '••••••••',
              autoComplete: 'new-password',
              onChange: (event) => { update('appSecret', event.target.value) },
            }))),

        h('div', { style: styles.card },
          h('h3', { style: styles.cardTitle }, t('target')),
          h(Field, { label: t('chatName'), hint: t('chatNameHint') },
            h('input', { style: styles.input, value: form.chatName, onChange: (event) => { update('chatName', event.target.value) } })),
          h(Field, { label: t('chatId'), hint: t('chatIdHint') },
            h('input', { style: styles.input, value: form.chatId, spellCheck: false, onChange: (event) => { update('chatId', event.target.value) } })),
          h(Field, { label: t('userId'), hint: t('userIdHint') },
            h('input', { style: styles.input, value: form.userId, spellCheck: false, onChange: (event) => { update('userId', event.target.value) } }))),

        h('div', { style: styles.card },
          h('h3', { style: styles.cardTitle }, t('mode')),
          h('select', {
            style: styles.input,
            value: form.receive,
            onChange: (event) => { update('receive', event.target.value) },
          },
          h('option', { value: 'auto' }, t('modeAuto')),
          h('option', { value: 'poll' }, t('modePoll')),
          h('option', { value: 'callback' }, t('modeCallback'))),
          h(Toggle, { label: t('enable'), checked: form.enabled, onChange: (value) => { update('enabled', value) } }),
          h(Toggle, { label: t('questions'), checked: form.questions, onChange: (value) => { update('questions', value) } }),
          h(Toggle, { label: t('approvals'), checked: form.approvals, onChange: (value) => { update('approvals', value) } }),
          h(Toggle, { label: t('watchMessages'), checked: form.watchMessages, onChange: (value) => { update('watchMessages', value) } })),

        h('div', { style: styles.actions },
          h('button', { type: 'button', style: styles.primary, onClick: () => { void save() }, disabled: busy !== '' }, busy === 'save' ? t('saving') : t('save'))),

        notice.length > 0 ? h('div', { style: styles.notice }, notice) : null,
        error.length > 0 ? h('div', { style: styles.error }, `${t('loadFailed')}: ${error}`) : null,
        h('p', { style: styles.hint }, t('hint')))
    }

    /** Full-page shell for the sidebar entry; reuses the settings form. */
    function ConfigPage({ t }) {
      return h('div', {
        style: {
          height: '100%',
          overflowY: 'auto',
          boxSizing: 'border-box',
          padding: '26px 30px 40px 30px',
        },
      }, h(SettingsSection, { t }))
    }

    /** Left-sidebar icon: a card with a confirmation mark. */
    function BridgeIcon({ size }) {
      const edge = size || 16
      return h('svg', {
        width: edge,
        height: edge,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.4,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
      h('rect', { x: 1.8, y: 2.2, width: 12.4, height: 8.4, rx: 2.4 }),
      h('path', { d: 'M4.8 5.6h6.4M4.8 8.2h3.6' }),
      h('path', { d: 'M8 10.6v1.6' }),
      h('circle', { cx: 11.4, cy: 12.4, r: 2.2 }),
      h('path', { d: 'M10.5 12.4l.7.7 1.4-1.4' }))
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'feishu-bridge: dictionaries')
        const t = ctx.locale.bind(NS)
        // Tell the Host that the client half actually loaded (visible in the
        // plugin log even when the page is never opened).
        try {
          void fetch(`${API}/hello`, { method: 'POST', credentials: 'same-origin' }).catch(() => {})
        } catch { /* ignore */ }
        // The main page must exist before the sidebar row is clicked.
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
        }, (props) => h(ConfigPage, { ...props, t })))
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 1300,
          label: () => t('nav'),
        }, BridgeIcon))
        // Configuration is also reachable from Settings.
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'feishu-bridge',
          order: 40,
          label: () => t('nav'),
          locale: NS,
        }, SettingsSection))
      },
    }
  },
})
