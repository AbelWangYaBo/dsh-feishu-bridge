/**
 * Shared test configuration: every real-API test must use the Feishu app the
 * plugin is configured with, never the host lark-cli default profile. Routine
 * runs also skip anything that would send messages unless BRIDGE_TEST_SEND=1.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Read the plugin's persisted configuration. */
export function configuredApp() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const file = join(home, 'feishu-bridge.json')
  let config = {}
  try {
    config = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    config = {}
  }
  const appId = typeof config.appId === 'string' ? config.appId : ''
  const appSecret = typeof config.appSecret === 'string' ? config.appSecret : ''
  const configDir = typeof config.larkConfigDir === 'string' && config.larkConfigDir.length > 0
    ? config.larkConfigDir
    : join(home, 'feishu-bridge', 'lark-cli')
  return { config, appId, appSecret, configDir, target: config.target ?? {} }
}

/** lark-cli options pinned to the plugin's isolated app, or undefined. */
export function configuredCliOptions() {
  const { appId, appSecret, configDir } = configuredApp()
  if (appId.length === 0 || appSecret.length === 0) return undefined
  return {
    profile: appId,
    env: {
      LARKSUITE_CLI_CONFIG_DIR: configDir,
      LARKSUITE_CLI_LOG_DIR: join(configDir, 'logs'),
    },
  }
}

/** Whether this run may send test messages into a real chat. */
export function sendsEnabled() {
  return process.env.BRIDGE_TEST_SEND === '1'
}

/** Configured DM user id (or chat id) a test may target. */
export function configuredTarget() {
  const { target } = configuredApp()
  return {
    userId: typeof target.userId === 'string' ? target.userId : '',
    chatId: typeof target.chatId === 'string' ? target.chatId : '',
  }
}
