const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const { CloudWritingRepository } = require('./writingRepository')
const core = require('./writingCore')
const db = cloud.database()
const repo = new CloudWritingRepository(db)
function safeError(e) { const allowed = ['INVALID_TITLE', 'INVALID_CONTENT', 'INVALID_TYPE', 'INVALID_STATUS', 'INVALID_BOOK_ID', 'TITLE_TOO_LONG', 'CONTENT_TOO_LONG', 'FINISHED_CONTENT_REQUIRED', 'WRITING_NOT_FOUND']; return allowed.includes(e.code) ? e.code : 'INTERNAL_ERROR' }
exports.main = async (event = {}) => {
  try {
    const { OPENID } = cloud.getWXContext()
    if (!OPENID) return { ok: false, code: 'UNAUTHORIZED' }
    const action = event.action
    if (action === 'create') return { ok: true, writing: await core.create({ repo, ownerOpenid: OPENID, input: event, now: Date.now() }) }
    if (action === 'list') return { ok: true, writings: await core.list({ repo, ownerOpenid: OPENID, status: event.status }) }
    if (action === 'get') return { ok: true, writing: await core.get({ repo, ownerOpenid: OPENID, writingId: event.writingId }) }
    if (action === 'update') return { ok: true, writing: await core.update({ repo, ownerOpenid: OPENID, writingId: event.writingId, input: event, now: Date.now() }) }
    if (action === 'delete') return { ok: true, ...(await core.remove({ repo, ownerOpenid: OPENID, writingId: event.writingId })) }
    return { ok: false, code: 'INVALID_ACTION' }
  } catch (e) { return { ok: false, code: safeError(e) } }
}
