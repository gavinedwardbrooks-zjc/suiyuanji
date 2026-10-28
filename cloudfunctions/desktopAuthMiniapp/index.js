const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const core = require('./loginSessionCore')
const { CloudLoginSessionRepository } = require('./cloudLoginSessionRepository')
const repo = new CloudLoginSessionRepository(db)
function safeError(error) { return ['INVALID_LOGIN_REQUEST', 'SESSION_NOT_PENDING', 'SESSION_EXPIRED'].includes(error.message) ? error.message : 'INTERNAL_ERROR' }
exports.main = async (event = {}) => {
  try {
    const { OPENID } = cloud.getWXContext(); if (!OPENID) throw new Error('INVALID_LOGIN_REQUEST')
    const user = (await db.collection('users').where({ _openid: OPENID }).limit(1).get()).data[0]
    if (!user || !user.user_uid) throw new Error('INVALID_LOGIN_REQUEST')
    const input = { repo, sessionId: event.sessionId, nonce: event.nonce, now: Date.now() }
    if (event.action === 'inspect') return { ok: true, ...(await core.inspectLoginSession(input)) }
    if (event.action === 'confirm') return { ok: true, ...(await core.confirmLoginSession({ ...input, authenticatedUserUid: user.user_uid })) }
    if (event.action === 'cancel') return { ok: true, ...(await core.cancelLoginSession(input)) }
    return { ok: false, code: 'INVALID_LOGIN_REQUEST' }
  } catch (error) { return { ok: false, code: safeError(error) } }
}
