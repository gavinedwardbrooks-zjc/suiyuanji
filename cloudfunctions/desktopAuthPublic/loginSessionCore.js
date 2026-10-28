const crypto = require('crypto')

const LOGIN_SESSION_TTL_MS = 5 * 60 * 1000
const STATUS = Object.freeze({ PENDING: 'pending', APPROVED: 'approved', CONSUMED: 'consumed', CANCELLED: 'cancelled', EXPIRED: 'expired', SUPERSEDED: 'superseded' })
const TRANSITIONS = Object.freeze({ pending: ['approved', 'cancelled', 'expired', 'superseded'], approved: ['consumed'], consumed: [], cancelled: [], expired: [], superseded: [] })

function assertString(name, value, max) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) throw new Error('INVALID_' + name.toUpperCase())
}
function assertFiniteNow(now) {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('INVALID_NOW')
}
function hashSecret(value) {
  assertString('secret', value, 512)
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex')
}
function safeEqualHash(stored, provided) {
  if (typeof stored !== 'string' || !/^[0-9a-f]{64}$/.test(stored)) return false
  let actual
  try { actual = hashSecret(provided) } catch { return false }
  return crypto.timingSafeEqual(Buffer.from(stored, 'hex'), Buffer.from(actual, 'hex'))
}
function randomSecret(bytes) { return crypto.randomBytes(bytes).toString('base64url') }
async function createLoginSession({ desktopDeviceId, desktopDeviceName, now = Date.now() }) {
  assertString('desktopDeviceId', desktopDeviceId, 128)
  assertString('desktopDeviceName', desktopDeviceName, 80)
  assertFiniteNow(now)
  const sessionId = 'dls_' + randomSecret(32)
  const nonce = randomSecret(16)
  const pollSecret = randomSecret(32)
  const expiresAt = now + LOGIN_SESSION_TTL_MS
  const record = { sessionId, nonceHash: hashSecret(nonce), pollSecretHash: hashSecret(pollSecret), status: STATUS.PENDING, user_uid: null, desktopDeviceId, desktopDeviceName, createdAt: now, expiresAt, approvedAt: null, consumedAt: null, cancelledAt: null, supersededAt: null }
  return { record, sessionId, nonce, pollSecret, expiresAt, qrPayload: { v: 1, type: 'desktop-login', sessionId, nonce } }
}
function requireSessionId(sessionId) { assertString('sessionId', sessionId, 256) }
async function load(repo, sessionId, now) {
  requireSessionId(sessionId); assertFiniteNow(now)
  const record = await repo.get(sessionId)
  if (!record) throw new Error('INVALID_LOGIN_REQUEST')
  if (record.status === STATUS.PENDING && now >= record.expiresAt) {
    if (!await repo.transition(sessionId, STATUS.PENDING, STATUS.EXPIRED, { expiredAt: now })) throw new Error('SESSION_EXPIRED')
    return await repo.get(sessionId)
  }
  return record
}
function verifyNonce(record, nonce) { if (!safeEqualHash(record.nonceHash, nonce)) throw new Error('INVALID_LOGIN_REQUEST') }
function verifyPollSecret(record, pollSecret) { if (!safeEqualHash(record.pollSecretHash, pollSecret)) throw new Error('INVALID_LOGIN_REQUEST') }
async function inspectLoginSession({ repo, sessionId, nonce, now = Date.now() }) {
  const record = await load(repo, sessionId, now); verifyNonce(record, nonce)
  if (record.status !== STATUS.PENDING) throw new Error(record.status === STATUS.EXPIRED ? 'SESSION_EXPIRED' : 'SESSION_NOT_PENDING')
  return { valid: true, status: record.status, desktopDeviceName: record.desktopDeviceName, expiresAt: record.expiresAt }
}
async function confirmLoginSession({ repo, sessionId, nonce, authenticatedUserUid, now = Date.now() }) {
  assertString('authenticatedUserUid', authenticatedUserUid, 256)
  const record = await load(repo, sessionId, now); verifyNonce(record, nonce)
  if (record.status !== STATUS.PENDING) throw new Error(record.status === STATUS.EXPIRED ? 'SESSION_EXPIRED' : 'SESSION_NOT_PENDING')
  if (!await repo.transition(sessionId, STATUS.PENDING, STATUS.APPROVED, { user_uid: authenticatedUserUid, approvedAt: now })) throw new Error('SESSION_NOT_PENDING')
  return { approved: true, status: STATUS.APPROVED, expiresAt: record.expiresAt }
}
async function cancelLoginSession({ repo, sessionId, nonce, now = Date.now() }) {
  const record = await load(repo, sessionId, now); verifyNonce(record, nonce)
  if (record.status !== STATUS.PENDING) throw new Error(record.status === STATUS.EXPIRED ? 'SESSION_EXPIRED' : 'SESSION_NOT_PENDING')
  if (!await repo.transition(sessionId, STATUS.PENDING, STATUS.CANCELLED, { cancelledAt: now })) throw new Error('SESSION_NOT_PENDING')
  return { cancelled: true, status: STATUS.CANCELLED }
}
async function supersedeLoginSession({ repo, sessionId, now = Date.now() }) {
  const record = await load(repo, sessionId, now)
  if (record.status !== STATUS.PENDING) throw new Error(record.status === STATUS.EXPIRED ? 'SESSION_EXPIRED' : 'SESSION_NOT_PENDING')
  if (!await repo.transition(sessionId, STATUS.PENDING, STATUS.SUPERSEDED, { supersededAt: now })) throw new Error('SESSION_NOT_PENDING')
  return { superseded: true, status: STATUS.SUPERSEDED }
}
async function getLoginSessionStatus({ repo, sessionId, pollSecret, now = Date.now() }) {
  const record = await load(repo, sessionId, now); verifyPollSecret(record, pollSecret)
  const status = record.status === STATUS.APPROVED && now >= record.expiresAt ? STATUS.EXPIRED : record.status
  return { status, expiresAt: record.expiresAt }
}
// 只校验「这是这台桌面的会话」，不要求 status 仍为 approved。
// 用途：consume 的响应在网络层丢失后，同一台桌面凭 loginSessionId + pollSecret
// 恢复会话（login session 此时已是 consumed，不能再走 consume 的状态机）。
// 二维码里只有 sid + nonce、没有 pollSecret，因此拍照截图无法通过这一关。
async function assertPollSecret({ repo, sessionId, pollSecret, now = Date.now() }) {
  const record = await load(repo, sessionId, now)
  verifyPollSecret(record, pollSecret)
  return record
}
async function consumeLoginSession({ repo, sessionId, pollSecret, now = Date.now() }) {
  const record = await load(repo, sessionId, now); verifyPollSecret(record, pollSecret)
  if (now >= record.expiresAt) throw new Error('SESSION_EXPIRED')
  if (record.status !== STATUS.APPROVED) throw new Error(record.status === STATUS.EXPIRED ? 'SESSION_EXPIRED' : 'SESSION_NOT_APPROVED')
  if (!await repo.transition(sessionId, STATUS.APPROVED, STATUS.CONSUMED, { consumedAt: now })) throw new Error('SESSION_NOT_APPROVED')
  return { consumed: true, user_uid: record.user_uid }
}
module.exports = { LOGIN_SESSION_TTL_MS, STATUS, TRANSITIONS, hashSecret, safeEqualHash, createLoginSession, inspectLoginSession, confirmLoginSession, cancelLoginSession, supersedeLoginSession, getLoginSessionStatus, consumeLoginSession, assertPollSecret }
