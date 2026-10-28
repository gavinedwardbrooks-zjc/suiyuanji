const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const loginCore = require('./loginSessionCore')
const desktopCore = require('./desktopSessionCore')
const { CloudLoginSessionRepository } = require('./cloudLoginSessionRepository')
const { CloudDesktopSessionRepository } = require('./cloudDesktopSessionRepository')
const loginRepo = new CloudLoginSessionRepository(db)
const desktopRepo = new CloudDesktopSessionRepository(db)
const MAX_BODY = 8192
function response(statusCode, body) { return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } }
function safeError(error) { const allowed = ['INVALID_LOGIN_REQUEST', 'INVALID_DESKTOP_SESSION', 'SESSION_NOT_PENDING', 'SESSION_EXPIRED', 'SESSION_NOT_APPROVED', 'DESKTOP_SESSION_ALREADY_USED', 'RATE_LIMITED', 'METHOD_NOT_POST', 'BODY_TOO_LARGE', 'INVALID_JSON']; return allowed.includes(error.message) ? error.message : 'INTERNAL_ERROR' }
function parse(event) {
  if (event.httpMethod !== 'POST') throw new Error('METHOD_NOT_POST')
  const type = String((event.headers && (event.headers['content-type'] || event.headers['Content-Type'])) || '').toLowerCase()
  if (!type.startsWith('application/json')) throw new Error('INVALID_JSON')
  if (typeof event.body !== 'string' || Buffer.byteLength(event.body, 'utf8') > MAX_BODY) throw new Error('BODY_TOO_LARGE')
  try { return JSON.parse(event.body) } catch { throw new Error('INVALID_JSON') }
}
exports.main = async (event = {}) => {
  try {
    const body = parse(event); const action = body.action; const now = Date.now()
    // TODO（部署前必办 · 2026-10-28 M2 冻结决策，本轮**不实现**）：
    //   action=create 目前没有任何速率限制。任何人都能无限创建 login_sessions 文档
    //   （每条 5 分钟自然过期，但写入次数本身不受限），属存储/成本放大型风险，
    //   不构成越权（拿不到 pollSecret 就换不到 token）。正式对外部署前需补
    //   「来源 IP + 时间窗」限流；safeError 白名单里已预留 RATE_LIMITED 码，尚无实现。
    if (action === 'create') { const made = await loginCore.createLoginSession({ desktopDeviceId: body.deviceId, desktopDeviceName: body.deviceName, now }); await loginRepo.create(made.record); return response(200, { ok: true, sessionId: made.sessionId, nonce: made.nonce, pollSecret: made.pollSecret, expiresAt: made.expiresAt }) }
    if (action === 'status') return response(200, { ok: true, ...(await loginCore.getLoginSessionStatus({ repo: loginRepo, sessionId: body.sessionId, pollSecret: body.pollSecret, now })) })
    if (action === 'consume') { const result = await desktopCore.consumeAndCreateDesktopSession({ loginCore, loginRepo, desktopRepo, loginSessionId: body.sessionId, pollSecret: body.pollSecret, deviceId: body.deviceId, deviceName: body.deviceName, now }); return response(200, { ok: true, desktopToken: result.token, expiresAt: result.expiresAt }) }
    if (action === 'validate') { const auth = String((event.headers && (event.headers.authorization || event.headers.Authorization)) || ''); if (!/^Bearer [^\s]+$/.test(auth) || auth.length > 700) throw new Error('INVALID_DESKTOP_SESSION'); await desktopCore.validateDesktopSession({ repo: desktopRepo, token: auth.slice(7), now }); return response(200, { ok: true, authenticated: true }) }
    if (action === 'logout') { const auth = String((event.headers && (event.headers.authorization || event.headers.Authorization)) || ''); if (!/^Bearer [^\s]+$/.test(auth) || auth.length > 700) throw new Error('INVALID_DESKTOP_SESSION'); await desktopCore.revokeDesktopSession({ repo: desktopRepo, token: auth.slice(7), now }); return response(200, { ok: true, revoked: true }) }
    return response(400, { ok: false, code: 'INVALID_LOGIN_REQUEST' })
  } catch (error) { const code = safeError(error); return response(code === 'INTERNAL_ERROR' ? 500 : 400, { ok: false, code }) }
}
