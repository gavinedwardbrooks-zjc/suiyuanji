const crypto = require('crypto')
const { LOGIN_SESSION_TTL_MS } = require('./loginSessionCore')
const DESKTOP_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
const LAST_SEEN_THROTTLE_MS = 5 * 60 * 1000
function assertString(name, value, max) { if (typeof value !== 'string' || value.length === 0 || value.length > max) throw new Error('INVALID_' + name.toUpperCase()) }
function assertNow(now) { if (!Number.isSafeInteger(now) || now < 0) throw new Error('INVALID_NOW') }
function hashToken(token) { assertString('token', token, 512); return crypto.createHash('sha256').update(token, 'utf8').digest('hex') }
function random(bytes) { return crypto.randomBytes(bytes).toString('base64url') }
function createDesktopSession({ user_uid, deviceId, deviceName, now = Date.now(), loginSessionId = null }) {
  assertString('user_uid', user_uid, 256); assertString('deviceId', deviceId, 128); assertString('deviceName', deviceName, 80); assertNow(now)
  const token = random(32); const desktopSessionId = 'dss_' + random(32)
  const record = { desktopSessionId, tokenHash: hashToken(token), user_uid, deviceId, deviceName, status: 'active', createdAt: now, expiresAt: now + DESKTOP_SESSION_TTL_MS, lastSeenAt: now, revokedAt: null, loginSessionId }
  return { record, token, expiresAt: record.expiresAt }
}
async function validateDesktopSession({ repo, token, now = Date.now() }) {
  assertNow(now); let record
  try { record = await repo.findByTokenHash(hashToken(token)) } catch { throw new Error('INVALID_DESKTOP_SESSION') }
  if (!record || record.status !== 'active' || now >= record.expiresAt) { if (record && record.status === 'active' && now >= record.expiresAt) await repo.transitionStatus(record.desktopSessionId, 'active', 'expired', {}); throw new Error('INVALID_DESKTOP_SESSION') }
  if (now - record.lastSeenAt >= LAST_SEEN_THROTTLE_MS) await repo.updateLastSeen(record.desktopSessionId, 'active', now)
  return { valid: true, user_uid: record.user_uid, desktopSessionId: record.desktopSessionId, deviceId: record.deviceId }
}
async function revokeDesktopSession({ repo, token, now = Date.now() }) {
  assertNow(now); let record
  try { record = await repo.findByTokenHash(hashToken(token)) } catch { throw new Error('INVALID_DESKTOP_SESSION') }
  if (!record) throw new Error('INVALID_DESKTOP_SESSION')
  if (record.status === 'revoked') return { revoked: false, code: 'ALREADY_REVOKED' }
  if (record.status === 'expired' || now >= record.expiresAt) { await repo.transitionStatus(record.desktopSessionId, 'active', 'expired', {}); return { revoked: false, code: 'ALREADY_EXPIRED' } }
  if (!await repo.transitionStatus(record.desktopSessionId, 'active', 'revoked', { revokedAt: now })) throw new Error('INVALID_DESKTOP_SESSION')
  return { revoked: true }
}
async function consumeAndCreateDesktopSession({ loginCore, loginRepo, desktopRepo, loginSessionId, pollSecret, deviceId, deviceName, now = Date.now() }) {
  assertString('loginSessionId', loginSessionId, 256)
  const existing = desktopRepo.findByLoginSessionId && await desktopRepo.findByLoginSessionId(loginSessionId)
  if (existing) {
    // 上一次 consume 已经建好 desktop session，但响应在网络上丢了（客户端没收到 token）。
    // 此时 login session 已是 consumed，不能再走状态机；唯一能恢复的凭据是
    // loginSessionId + pollSecret，而 pollSecret 只存在于发起登录的那台桌面内存里
    // （二维码只有 sid + nonce）⇒ 先验 pollSecret，再换发新 token，旧 token 立即失效。
    if (!loginCore.assertPollSecret) throw new Error('DESKTOP_SESSION_ALREADY_USED')
    const loginRecord = await loginCore.assertPollSecret({ repo: loginRepo, sessionId: loginSessionId, pollSecret, now })
    // 换发窗口 = **登录会话自身的有效期**（5 分钟），不是 desktop session 的 30 天。
    // 响应丢失后的重试发生在秒级，5 分钟足够；一旦越过这个窗口就一律拒绝，
    // 否则 pollSecret 会变成 30 天内可无限换发 token 的长期凭据（无限续期）。
    if (!loginRecord || now >= loginRecord.expiresAt) throw new Error('DESKTOP_SESSION_ALREADY_USED')
    if (existing.status !== 'active' || now >= existing.expiresAt) throw new Error('DESKTOP_SESSION_ALREADY_USED')
    const rotatedToken = random(32)
    // CAS 同时比对旧 tokenHash：并发重放时只有一个请求能换发成功，
    // 不会出现「两个请求都收到新 token、其中一个立刻失效」的假成功。
    if (!desktopRepo.rotateToken ||
      !await desktopRepo.rotateToken(existing.desktopSessionId, 'active', existing.tokenHash, hashToken(rotatedToken), now)) {
      throw new Error('DESKTOP_SESSION_ALREADY_USED')
    }
    // expiresAt 原样带回：换发只是「同一张票换个号码」，**不续期**。
    return { token: rotatedToken, expiresAt: existing.expiresAt, desktopSessionId: existing.desktopSessionId, rotated: true }
  }
  const consumed = await loginCore.consumeLoginSession({ repo: loginRepo, sessionId: loginSessionId, pollSecret, now })
  try {
    const created = createDesktopSession({ user_uid: consumed.user_uid, deviceId, deviceName, now, loginSessionId })
    await desktopRepo.create(created.record)
    return { token: created.token, expiresAt: created.expiresAt, desktopSessionId: created.record.desktopSessionId }
  } catch (error) {
    // Without a cross-collection transaction, roll back the one-time consume
    // by CAS so the server can safely retry the handoff. Never leave consumed
    // without a desktop session.
    if (loginRepo.transition) await loginRepo.transition(loginSessionId, 'consumed', 'approved', {})
    throw new Error('DESKTOP_SESSION_CREATE_FAILED_RECOVERABLE')
  }
}
module.exports = { DESKTOP_SESSION_TTL_MS, LAST_SEEN_THROTTLE_MS, hashToken, createDesktopSession, validateDesktopSession, revokeDesktopSession, consumeAndCreateDesktopSession }
