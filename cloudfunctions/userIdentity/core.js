// userIdentity · V2.1-3 server-side identity foundation
// Only accepts trusted server-derived openid. Never expose this module to clients.

const crypto = require('crypto')

function generateUserUid() {
  return 'uid_' + crypto.randomUUID()
}

function normalizeUid(value) {
  return typeof value === 'string' && /^uid_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
    ? value
    : null
}

function projectIdentity(user) {
  if (!user) return null
  return {
    user_uid: user.user_uid,
    openid: user._openid,
    role: user.role,
    coupleId: user.coupleId
  }
}

async function findByOpenid(db, openid) {
  if (!openid || typeof openid !== 'string') throw new Error('trusted openid required')
  const result = await db.collection('users').where({ _openid: openid }).get()
  return result.data[0] || null
}

async function findByUid(db, userUid) {
  const uid = normalizeUid(userUid)
  if (!uid) return null
  const result = await db.collection('users').where({ user_uid: uid }).get()
  return result.data[0] || null
}

async function ensureUserUid({ db, openid, generate = generateUserUid }) {
  const user = await findByOpenid(db, openid)
  if (!user) return { ok: false, code: 'USER_NOT_FOUND' }
  if (user.user_uid) return { ok: true, user_uid: user.user_uid, created: false }

  for (let attempt = 1; attempt <= 3; attempt++) {
    const candidate = generate()
    if (await findByUid(db, candidate)) continue
    const query = { _id: user._id, _openid: openid, user_uid: db.command.eq(null) }
    const result = db.collection('users').updateWhere
      ? await db.collection('users').updateWhere({ where: query, data: { user_uid: candidate } })
      : await db.collection('users').where(query).update({ data: { user_uid: candidate } }).then(r => ({ updated: (r.stats && r.stats.updated) || 0 }))
    if (result.updated === 1) return { ok: true, user_uid: candidate, created: true }
    const winner = await findByOpenid(db, openid)
    if (winner && winner.user_uid) return { ok: true, user_uid: winner.user_uid, created: false, raced: true }
  }
  throw new Error('user_uid allocation conflict')
}

async function resolveUserIdentityByUid({ db, userUid }) {
  return projectIdentity(await findByUid(db, userUid))
}

async function resolveUserIdentityByOpenid({ db, openid }) {
  return projectIdentity(await findByOpenid(db, openid))
}

async function diagnoseUserUid({ db }) {
  const users = (await db.collection('users').where({}).get()).data
  const byOpenid = new Map()
  const byUid = new Map()
  let missingOpenid = 0
  let withCouple = 0
  const roles = {}
  for (const u of users) {
    if (!u._openid) missingOpenid++
    else byOpenid.set(u._openid, (byOpenid.get(u._openid) || 0) + 1)
    if (u.user_uid) byUid.set(u.user_uid, (byUid.get(u.user_uid) || 0) + 1)
    if (u.coupleId) withCouple++
    roles[u.role || '(missing)'] = (roles[u.role || '(missing)'] || 0) + 1
  }
  const duplicateCount = map => [...map.values()].filter(n => n > 1).length
  return {
    TOTAL_USERS: users.length,
    USERS_WITH_USER_UID: users.filter(u => !!u.user_uid).length,
    USERS_WITHOUT_USER_UID: users.filter(u => !u.user_uid).length,
    DUPLICATE_OPENID: duplicateCount(byOpenid),
    DUPLICATE_USER_UID: duplicateCount(byUid),
    USERS_WITH_COUPLE: withCouple,
    ROLE_DISTRIBUTION: roles,
    USERS_WITHOUT_OPENID: missingOpenid
  }
}

async function migrateUserUid({ db, execute = false }) {
  const users = (await db.collection('users').where({}).get()).data
  const result = {
    TOTAL_USERS: users.length,
    NEEDS_MIGRATION: users.filter(u => !u.user_uid).length,
    ALREADY_MIGRATED: users.filter(u => !!u.user_uid).length,
    WOULD_CREATE: users.filter(u => !u.user_uid).length,
    WOULD_CHANGE_EXISTING: 0,
    WOULD_DELETE: 0,
    COUPLE_RELATIONS_TOUCHED: 0,
    migrated: 0
  }
  if (!execute) return result
  for (const user of users) {
    if (user.user_uid) continue
    const ensured = await ensureUserUid({ db, openid: user._openid })
    if (ensured.created) result.migrated++
  }
  return { ...result, executed: true }
}

module.exports = { generateUserUid, normalizeUid, projectIdentity, ensureUserUid, resolveUserIdentityByUid, resolveUserIdentityByOpenid, diagnoseUserUid, migrateUserUid }
