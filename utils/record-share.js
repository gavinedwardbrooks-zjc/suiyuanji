// ============================================================
// utils/record-share.js · 日期级分享的客户端薄层（V1.1 · P3.1）
//
// 只做三件事：
//   1. 把云函数返回归一成**严格布尔**的前端状态（enabled/canShare 只认 true）；
//      服务端说没授权就是没授权 —— 缺失字段、'true'、1 一律按「未共享」处理。
//   2. 把「分享前预览」从**已保存的记录快照**算出来，而不是当前表单草稿；
//      草稿未保存时由页面额外提示，避免她以为草稿已经被分享。
//   3. 提供统一的用户可读文案，避免各页面各写一套。
//
// 本模块不判定授权、不做缓存、不发请求以外的事，可零依赖单测。
// ============================================================

// 服务端错误码（与 cloudfunctions/getPartnerView 保持一致）+ 客户端补充
const CODE = {
  NOT_ACTIVE: 'NOT_ACTIVE',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  BAD_ARGS: 'BAD_ARGS',
  NO_RECORD: 'NO_RECORD',
  RECORD_NOT_IN_COUPLE: 'RECORD_NOT_IN_COUPLE',
  NO_PARTNER: 'NO_PARTNER',
  NOT_SHARED: 'NOT_SHARED',
  // P3.3：并发与写入类错误（服务端新增）
  STALE_RELATION: 'STALE_RELATION',
  CONFLICT: 'CONFLICT',
  DB_ERROR: 'DB_ERROR',
  NETWORK: 'NETWORK',
  UNKNOWN: 'UNKNOWN'
}

const SEG_KEYS = ['life', 'work', 'growth']
const SEG_LABEL = { life: '生活', work: '工作', growth: '成长' }

const MOOD_LABEL = { happy: '开心', calm: '平静', low: '低落', angry: '生气', tired: '疲惫' }
const WEATHER_LABEL = { sunny: '晴', cloudy: '多云', rain: '雨', snow: '雪' }

// 开启分享前必须让她看到的原话（不许用模糊的「分享今天」）
const SHARE_NOTICE = '开启后，TA 可以看到这一天的心情、天气，以及生活、工作、成长三段日记。你可以随时关闭分享。'

const HINT = {
  NOT_ACTIVE: '当前绑定关系未生效，请去「我们」页确认',
  UNAUTHORIZED: '没有拿到登录身份，请退出小程序后重新进入',
  FORBIDDEN: '当前账号没有这个操作权限',
  BAD_ARGS: '内容不符合要求，请检查后再试',
  NO_RECORD: '这一天还没有记录，先保存再分享',
  RECORD_NOT_IN_COUPLE: '这一天的记录不属于当前绑定关系，无法分享',
  NO_PARTNER: '当前绑定关系缺少另一半',
  NOT_SHARED: 'TA 已经关闭了这一天的分享',
  STALE_RELATION: '绑定关系刚刚发生变化，请重新进入这一页再试',
  CONFLICT: '分享状态刚刚被改动过，已为你刷新，请重新操作',
  DB_ERROR: '没有保存成功，请稍后重试',
  NETWORK: '网络似乎不太稳定，请稍后重试',
  UNKNOWN: '服务返回异常，请稍后重试'
}

// 需要重新同步身份的错误码：关系层面的变化，页面上的角色/绑定快照已经过期
const RELATION_CODES = {
  NOT_ACTIVE: true,
  UNAUTHORIZED: true,
  STALE_RELATION: true
}

function needsIdentityRefresh(code) {
  return RELATION_CODES[code] === true
}

function hintOf(code) {
  return HINT[code] || HINT.UNKNOWN
}

function moodLabel(key) {
  return MOOD_LABEL[key] || ''
}

function weatherLabel(key) {
  return WEATHER_LABEL[key] || ''
}

function asText(v, max) {
  if (typeof v !== 'string') return ''
  return max && v.length > max ? v.slice(0, max) : v
}

function excerpt(text, max) {
  const t = String(text || '').replace(/\s+/g, ' ').trim()
  if (t.length <= max) return t
  return t.slice(0, max) + '…'
}

// ---- 响应归一 ----
function unwrap(res) {
  if (!res || typeof res !== 'object') return null
  const r = Object.prototype.hasOwnProperty.call(res, 'result') ? res.result : res
  return r && typeof r === 'object' ? r : null
}

// 分享状态：enabled 只认字面量 true；rev 只认非负整数（缺失 → 0 = 「没有分享文档」）
function normalizeShareStatus(res) {
  const r = unwrap(res)
  if (!r) return { ok: false, code: CODE.UNKNOWN, enabled: false, canShare: false, hasRecord: false, rev: 0, casSupported: false }
  if (r.ok !== true) {
    return {
      ok: false, code: r.code || CODE.UNKNOWN, enabled: false,
      canShare: false, hasRecord: false, rev: 0, casSupported: false
    }
  }
  const hasRev = typeof r.rev === 'number' && Number.isFinite(r.rev) && r.rev >= 0
  return {
    ok: true,
    code: '',
    date: typeof r.date === 'string' ? r.date : '',
    enabled: r.enabled === true,
    canShare: r.canShare === true,
    hasRecord: r.hasRecord === true,
    // 服务端权威版本号：下次写入必须原样回传，客户端不得自行猜测或递增
    rev: hasRev ? Math.floor(r.rev) : 0,
    // 「服务端是否支持 CAS」：只有真的回了数字 rev 才算。
    // 用于识别「新客户端 + 旧云函数」——旧服务端不认识 expectedRev，会退化成无条件覆盖，
    // 这种情况必须由客户端 fail-closed（禁用开关），而不是继续用。
    casSupported: hasRev
  }
}

function normalizeShareSet(res) {
  const r = unwrap(res)
  if (!r) return { ok: false, code: CODE.UNKNOWN, enabled: false, rev: 0 }
  if (r.ok !== true) {
    return {
      ok: false,
      code: r.code || CODE.UNKNOWN,
      enabled: false,
      rev: typeof r.rev === 'number' && r.rev >= 0 ? Math.floor(r.rev) : 0,
      needRefresh: r.needRefresh === true
    }
  }
  return {
    ok: true,
    code: '',
    enabled: r.enabled === true,
    rev: typeof r.rev === 'number' && r.rev >= 0 ? Math.floor(r.rev) : 0
  }
}

// ---- 请求 ----
// call 由调用方注入（页面传 wx.cloud.callFunction），因此本模块不依赖 wx，可单测。
function callFn(name, data, call) {
  if (typeof call !== 'function') return Promise.resolve(null)
  try {
    return Promise.resolve(call({ name, data })).catch(() => null)
  } catch (e) {
    return Promise.resolve(null)
  }
}

// 统一失败形状：任何失败都等价于「没有共享」，
// 调用方不必为失败单独分支，也就不会把 undefined 当成 true。
function failure(code) {
  return {
    ok: false,
    code: code || CODE.NETWORK,
    enabled: false,
    canShare: false,
    hasRecord: false,
    rev: 0
  }
}

function requestShareStatus(date, call) {
  return callFn('getPartnerView', { action: 'shareStatus', date }, call)
    .then(res => (res === null ? failure(CODE.NETWORK) : normalizeShareStatus(res)))
}

function requestShareSet(date, enabled, expectedRev, call) {
  // 严格布尔：调用方误传 'true' / 1 时不发请求，直接拒绝（服务端也会拒绝）
  if (enabled !== true && enabled !== false) return Promise.resolve(failure(CODE.BAD_ARGS))
  // 兼容旧的 3 参调用形式 (date, enabled, call)：不带版本号时仍然发请求，
  // 但服务端会以 CONFLICT 拒绝写入 —— 绝不退化成「无条件覆盖」。
  let expect = expectedRev
  let doCall = call
  if (typeof expect === 'function') { doCall = expect; expect = null }
  const payload = { action: 'shareSet', date, enabled }
  if (typeof expect === 'number' && Number.isFinite(expect) && expect >= 0) {
    payload.expectedRev = Math.floor(expect)
  }
  return callFn('getPartnerView', payload, doCall)
    .then(res => (res === null ? failure(CODE.NETWORK) : normalizeShareSet(res)))
}

// ---- 分享前预览（必须基于「已保存」的内容）----
// saved: { mood: { type, weather }, segments: { life, work, growth } }
// 返回 { lines, text, filledSegments, hasContent }
function buildSharePreview(saved) {
  const s = saved && typeof saved === 'object' ? saved : {}
  const mood = s.mood && typeof s.mood === 'object' ? s.mood : {}
  const segs = s.segments && typeof s.segments === 'object' ? s.segments : {}
  const lines = []
  const mLabel = moodLabel(mood.type) || '未选'
  const wLabel = weatherLabel(mood.weather) || '未选'
  lines.push('心情 ' + mLabel + ' · 天气 ' + wLabel)
  let filled = 0
  for (let i = 0; i < SEG_KEYS.length; i++) {
    const k = SEG_KEYS[i]
    const t = typeof segs[k] === 'string' ? segs[k].trim() : ''
    if (t) {
      filled++
      lines.push(SEG_LABEL[k] + ' ' + t.length + ' 字：' + excerpt(t, 24))
    } else {
      lines.push(SEG_LABEL[k] + ' 未填写')
    }
  }
  return {
    lines,
    text: lines.join('\n'),
    filledSegments: filled,
    hasContent: filled > 0 || mLabel !== '未选' || wLabel !== '未选'
  }
}

module.exports = {
  CODE,
  SEG_KEYS,
  SEG_LABEL,
  SHARE_NOTICE,
  moodLabel,
  weatherLabel,
  hintOf,
  needsIdentityRefresh,
  normalizeShareStatus,
  normalizeShareSet,
  requestShareStatus,
  requestShareSet,
  buildSharePreview
}
