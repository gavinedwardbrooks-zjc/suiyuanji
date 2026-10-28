// userIdentity · internal-only cloud function
// Only ensure is exposed to the authenticated current user.
// OPENID always comes from cloud context; event.openid is ignored.
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const identity = require('./core')

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext()
  if (!OPENID) return { ok: false, code: 'NO_OPENID' }
  if (event.action === 'ensure') return identity.ensureUserUid({ db, openid: OPENID })
  return { ok: false, code: 'BAD_ACTION' }
}
