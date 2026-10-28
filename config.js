// ============================================================
// config.js · 客户端配置（公开版 · 只有安全占位符）
//
// 三层配置，职责严格分离：
//
//   ① 本文件（Git 跟踪）
//      只放**安全占位符**与合并逻辑，永远不含真实项目标识。
//
//   ② config.local.js（Git 忽略 · 本地私有）
//      真实云环境 ID、订阅消息模板 ID 写在这里。
//      首次使用：`node scripts/init-local-config.js`
//      （从 config.local.example.js 复制一份，之后按需填值）
//
//   ③ 云函数环境变量（仅服务端）
//      AI Key / AppSecret / 任何服务端密钥**只能**存在于此。
//      禁止写进 ①、②、桌面端或任何客户端可见文件。
//
// fail-closed 约定：
//   ② 缺失或仍为占位符时，isCloudEnvReady() 返回 false，app.js 会**拒绝**
//   调用 wx.cloud.init() 并在控制台给出配置指引 —— 绝不让微信回落到默认
//   环境（那可能静默连上不属于本项目的线上环境）。
//
// 硬约束：本文件只放「非敏感」配置。
// ============================================================

// 占位符常量：既是默认值，也是「未配置」的判定依据
const PLACEHOLDER_CLOUD_ENV = 'YOUR_CLOUD_ENV_ID'
const PLACEHOLDER_TEMPLATE = 'TEMPLATE_ID_HERE'

// ---- 公开默认值（占位符）----
// 订阅消息模板 ID（微信公众平台 → 订阅消息 → 我的模板）
//
// 两个通道（一个通道 = 一个模板 = 一份额度）：
//   SUB_TPL_CHAT   「聊天消息通知」模板 3377 —— 她新增心愿 / 她发悄悄话，共用这一个模板
//   SUB_TPL_PERIOD 「经期提醒」模板 472 —— 预计经期前 2 天提醒
//
// 模板 ID 不是密钥：客户端申请授权时必须用到它，所以可以放在本地配置里；
// 云函数侧同名环境变量 TPL_CHAT / TPL_PERIOD 可覆盖（缺省即用同样的 ID，
// 见 cloudfunctions/*/notify.js）。
// 一次性订阅：用户每同意一次 ≈ 可接收一条消息，没有「永久授权」。
//
// 下面两个占位符属于其他功能（目标提醒 / AI 小结）。
const DEFAULTS = {
  // 微信云开发环境 ID（在云开发控制台「设置 → 环境 ID」查看）
  CLOUD_ENV: 'YOUR_CLOUD_ENV_ID',

  SUB_TPL_REMIND: 'TEMPLATE_ID_HERE',   // 目标提醒
  SUB_TPL_SUMMARY: 'TEMPLATE_ID_HERE',  // AI 晚间小结

  SUB_TPL_CHAT: 'TEMPLATE_ID_HERE',
  SUB_TPL_PERIOD: 'TEMPLATE_ID_HERE'
}

// ---- 合并逻辑（白名单：只接受 DEFAULTS 里已有的键）----
// 空字符串 / 纯空白一律视为「没配」，保留默认占位符，
// 避免本地写了个空串就把默认值悄悄抹掉。
function mergeConfig(defaults, local) {
  const out = {}
  for (const k of Object.keys(defaults)) out[k] = defaults[k]
  if (!local || typeof local !== 'object') return out
  for (const k of Object.keys(defaults)) {
    const v = local[k]
    if (typeof v === 'string' && v.trim() !== '') out[k] = v.trim()
  }
  return out
}

// ---- 本地覆盖层加载 ----
// 缺失是**正常状态**（公开仓库里这个文件本来就不存在），不是错误。
// loader 可注入，便于测试「有无本地配置」两条分支，不必真的创建文件。
let LOCAL_STATE = { state: 'absent', value: null, error: '' }

function loadLocal(loader) {
  const fn = loader || function () { return require('./config.local') }
  let mod
  try {
    mod = fn()
  } catch (e) {
    const msg = (e && e.message) || String(e)
    // 区分「文件不存在」与「文件存在但内容写错」：前者是预期，后者要报警
    const missing = e && (e.code === 'MODULE_NOT_FOUND' || /Cannot find module|is not defined/.test(msg))
    return { state: missing ? 'absent' : 'invalid', value: null, error: msg }
  }
  if (!mod || typeof mod !== 'object' || Array.isArray(mod)) {
    return { state: 'invalid', value: null, error: 'config.local.js 必须导出对象' }
  }
  return { state: 'loaded', value: mod, error: '' }
}

LOCAL_STATE = loadLocal()
const CONFIG = mergeConfig(DEFAULTS, LOCAL_STATE.value)

// 内容写错时必须吵起来（能用但配置没生效，最容易被误判成「云环境有问题」）
if (LOCAL_STATE.state === 'invalid') {
  console.error('[config] config.local.js 存在但无法使用：' + LOCAL_STATE.error +
    '（该文件应形如 module.exports = { CLOUD_ENV: "..." }，已回落占位符）')
}

// ---- 判定与诊断 ----

// 模板 ID 是否已真正填写（'' 与历史占位符都算未配置）
function isTplReady(id) {
  return typeof id === 'string' && id !== '' && id !== PLACEHOLDER_TEMPLATE
}

// 云环境 ID 是否可用。宁可判死，也不要带着占位符去 init。
function isCloudEnvReady(env) {
  const v = typeof env === 'string' ? env.trim() : ''
  if (v === '') return false
  if (v === PLACEHOLDER_CLOUD_ENV) return false
  if (/^YOUR_/i.test(v)) return false       // 任何 YOUR_xxx 形态都是占位符
  if (/\s/.test(v)) return false            // 环境 ID 不含空白
  return true
}

// 已配置的订阅模板 ID 去重列表（未配置的不进列表，避免拿占位符去申请授权）
function subscribeTmplIds() {
  const all = [CONFIG.SUB_TPL_REMIND, CONFIG.SUB_TPL_SUMMARY, CONFIG.SUB_TPL_CHAT, CONFIG.SUB_TPL_PERIOD]
  const out = []
  for (const id of all) {
    if (isTplReady(id) && out.indexOf(id) === -1) out.push(id)
  }
  return out
}

// 配置体检快照（写日志 / 页面提示 / 测试断言共用，不含任何真实值）
function configStatus() {
  return {
    cloudEnvReady: isCloudEnvReady(CONFIG.CLOUD_ENV),
    localConfig: LOCAL_STATE.state,          // 'loaded' | 'absent' | 'invalid'
    localConfigError: LOCAL_STATE.error,
    templateIdsReady: subscribeTmplIds().length
  }
}

// 一行可直接抄的修复指引（只在未配置时使用）
function configHint() {
  if (LOCAL_STATE.state === 'absent') {
    return '未找到 config.local.js。请先执行 `node scripts/init-local-config.js`，' +
      '再在其中填入 CLOUD_ENV（云开发控制台 → 设置 → 环境 ID）。'
  }
  if (LOCAL_STATE.state === 'invalid') {
    return 'config.local.js 内容无效：' + LOCAL_STATE.error
  }
  return 'config.local.js 已加载，但 CLOUD_ENV 仍是占位符或为空，请填入真实环境 ID。'
}

module.exports = CONFIG
module.exports.isTplReady = isTplReady
module.exports.isCloudEnvReady = isCloudEnvReady
module.exports.mergeConfig = mergeConfig
module.exports.loadLocal = loadLocal
module.exports.subscribeTmplIds = subscribeTmplIds
module.exports.configStatus = configStatus
module.exports.configHint = configHint
module.exports.PLACEHOLDER_CLOUD_ENV = PLACEHOLDER_CLOUD_ENV
module.exports.PLACEHOLDER_TEMPLATE = PLACEHOLDER_TEMPLATE
