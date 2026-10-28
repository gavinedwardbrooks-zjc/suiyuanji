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
  assertString('loginSessionId', loginSessionId, 256); const existing = desktopRepo.findByLoginSessionId && await desktopRepo.findByLoginSessionId(loginSessionId)
  if (existing) return { token: null, expiresAt: existing.expiresAt, alreadyCreated: true, desktopSessionId: existing.desktopSessionId }
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
