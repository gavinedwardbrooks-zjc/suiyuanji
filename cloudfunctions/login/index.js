// ============================================================
// login · 云函数（PRD v0.6 §6.1）
// 职责：静默登录 + 注册建档（8 位绑定码）+ schemaVersion 惰性迁移
// 硬约束：本函数绝不重置失败限流计数（PRD §2.2-3 / Gate P0-01）
// ============================================================
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const core = require('./core')

const SCHEMA_VERSION = core.SCHEMA_VERSION

exports.main = async (event = {}, context) => {
  const { OPENID } = cloud.getWXContext()
  if (!OPENID) return { ok: false, msg: '未获取到用户身份' }

  const users = db.collection('users')
  const res = await users.where({ _openid: OPENID }).get()

  // ---- 首次注册：建档，生成 8 位绑定码，schemaVersion=2 ----
  if (res.data.length === 0) {
    const bindCode = core.genCode()
    const userUid = core.generateUserUid()
    await users.add({
      data: {
        _openid: OPENID,
        role: 'her',
        nickName: '她',
        partnerName: '', // 我给 TA 的称呼（自定义，默认空 = 通用「TA」）
        avatarUrl: '',
        coupleId: null,
        bindCode,
        schemaVersion: SCHEMA_VERSION,
        user_uid: userUid,
        createdAt: Date.now()
      }
    })
    return { openid: OPENID, user_uid: userUid, role: 'her', coupleId: null, nickName: '她', partnerName: '', avatarUrl: '', bindCode }
  }

  const u = res.data[0]
  let userUid = u.user_uid
  if (!userUid) {
    const candidate = core.generateUserUid()
    const result = await users.where({ _id: u._id, _openid: OPENID, user_uid: db.command.eq(null) }).update({ data: { user_uid: candidate } })
    userUid = result.stats && result.stats.updated === 1 ? candidate : ((await users.doc(u._id).get()).data.user_uid || candidate)
  }

  // ---- 惰性迁移：schemaVersion 缺失 = v1 → 迁移为 v2（幂等，仅补字段）----
  const migrated = core.migrateDocV1ToV2(u)
  if (migrated.changed) {
    await users.doc(u._id).update({ data: { schemaVersion: migrated.doc.schemaVersion } })
  }

  // ---- 兼容：老用户无绑定码时补一个（不覆盖已有码）----
  if (!u.bindCode) {
    await users.doc(u._id).update({ data: { bindCode: core.genCode() } })
  }

  return {
    openid: OPENID,
    role: u.role,
    coupleId: u.coupleId,
    nickName: u.nickName,
    partnerName: u.partnerName || '',
    avatarUrl: u.avatarUrl,
    bindCode: u.bindCode || null,
    user_uid: userUid
  }
}
