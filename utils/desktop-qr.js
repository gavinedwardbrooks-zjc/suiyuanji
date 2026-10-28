// ============================================================
// utils/desktop-qr.js · Desktop 登录二维码解析（小程序侧）
// 契约：suiyuanji://desktop-login?v=1&sid=...&nonce=...
//
// 安全约束（DESKTOP_V2_1_PHASE_1_5 §三 QR 安全契约）：
//   - 只允许白名单 key：v / type / scheme / sid / sessionId / nonce
//   - 出现禁止字段（pollSecret / desktopToken / openid / user_uid /
//     coupleId / role / secret / token / uid）一律拒绝
//   - 未知 key 一律拒绝（fail-closed，防止新 secret 字段被悄悄携带）
//   - v 必须等于 '1'；sid 或 sessionId 至少一个；nonce 必选
//   - 长度上限：sessionId ≤ 256（对齐 loginSessionCore）、nonce ≤ 512
//
// 纯函数、无 wx/cloud 依赖，可被 node --test 直接测试。
// ============================================================

const PREFIX = 'suiyuanji://desktop-login'

// 允许出现在二维码 query 中的 key（小写匹配）
const ALLOWED_KEYS = ['v', 'type', 'scheme', 'sid', 'sessionid', 'nonce']
// 禁止字段：一旦出现立即拒绝（小写匹配；同时覆盖常见变体）
const FORBIDDEN_KEYS = [
  'pollsecret', 'poll_secret', 'desktoptoken', 'desktop_token', 'token',
  'openid', 'open_id', 'openid2', 'user_uid', 'useruid', 'uid',
  'coupleid', 'couple_id', 'role', 'secret', 'noncehash', 'pollsecrethash'
]

const MAX_SESSION_ID = 256
const MAX_NONCE = 512

/**
 * 解析扫码文本。
 * @param {*} text wx.scanCode 返回的 result
 * @returns {{ ok: true, sessionId: string, nonce: string }
 *          | { ok: false, code: string }}
 */
function parseDesktopLoginResult(text) {
  if (typeof text !== 'string' || text.length === 0 || text.length > 2048) {
    return { ok: false, code: 'NOT_DESKTOP_QR' }
  }
  if (!text.startsWith(PREFIX)) {
    return { ok: false, code: 'NOT_DESKTOP_QR' }
  }
  const rest = text.slice(PREFIX.length)
  if (rest === '') return { ok: false, code: 'QR_MISSING_FIELDS' }
  if (rest[0] !== '?') return { ok: false, code: 'NOT_DESKTOP_QR' }

  const params = {}
  const rawQuery = rest.slice(1)
  if (rawQuery) {
    for (const pair of rawQuery.split('&')) {
      if (!pair) continue
      const eq = pair.indexOf('=')
      let key = eq === -1 ? pair : pair.slice(0, eq)
      let value = eq === -1 ? '' : pair.slice(eq + 1)
      try {
        key = decodeURIComponent(key)
        value = decodeURIComponent(value)
      } catch (e) {
        return { ok: false, code: 'NOT_DESKTOP_QR' }
      }
      const lower = key.toLowerCase()
      if (FORBIDDEN_KEYS.includes(lower)) {
        return { ok: false, code: 'QR_FORBIDDEN_FIELD' }
      }
      if (!ALLOWED_KEYS.includes(lower)) {
        return { ok: false, code: 'QR_FORBIDDEN_FIELD' }
      }
      // 重复 key：fail-closed（歧义即拒绝）
      if (params[lower] !== undefined) {
        return { ok: false, code: 'QR_FORBIDDEN_FIELD' }
      }
      params[lower] = value
    }
  }

  if (params.v !== '1') return { ok: false, code: 'QR_MISSING_FIELDS' }
  if (typeof params.nonce !== 'string' || params.nonce.length === 0 || params.nonce.length > MAX_NONCE) {
    return { ok: false, code: 'QR_MISSING_FIELDS' }
  }
  const sessionId = params.sid !== undefined ? params.sid : params.sessionid
  if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > MAX_SESSION_ID) {
    return { ok: false, code: 'QR_MISSING_FIELDS' }
  }
  return { ok: true, sessionId, nonce: params.nonce }
}

module.exports = { parseDesktopLoginResult, PREFIX, ALLOWED_KEYS, FORBIDDEN_KEYS }
