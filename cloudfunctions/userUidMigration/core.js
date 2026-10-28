// Temporary migration copy: kept self-contained for WeChat per-function packaging.
const crypto = require('crypto')
function generateUserUid() { return 'uid_' + crypto.randomUUID() }
function find(db, q) { return db.collection('users').where(q).get() }
async function diagnoseUserUid({ db }) {
  const users = (await find(db, {})).data
  const openids = {}, uids = {}, roles = {}
  let withCouple = 0, missingOpenid = 0
  for (const u of users) {
    if (!u._openid) missingOpenid++; else openids[u._openid] = (openids[u._openid] || 0) + 1
    if (u.user_uid) uids[u.user_uid] = (uids[u.user_uid] || 0) + 1
    if (u.coupleId) withCouple++
    roles[u.role || '(missing)'] = (roles[u.role || '(missing)'] || 0) + 1
  }
  const dup = x => Object.values(x).filter(n => n > 1).length
  return { TOTAL_USERS: users.length, USERS_WITH_USER_UID: users.filter(u => !!u.user_uid).length, USERS_WITHOUT_USER_UID: users.filter(u => !u.user_uid).length, DUPLICATE_OPENID: dup(openids), DUPLICATE_USER_UID: dup(uids), USERS_WITHOUT_OPENID: missingOpenid, USERS_WITH_COUPLE: withCouple, ROLE_DISTRIBUTION: roles }
}
async function dryRunUserUidMigration({ db }) {
  return migrateUserUid({ db, execute: false })
}

async function executeUserUidMigration({ db }) {
  return migrateUserUid({ db, execute: true })
}

async function migrateUserUid({ db, execute }) {
  const users = (await find(db, {})).data
  const out = { TOTAL_USERS: users.length, NEEDS_MIGRATION: users.filter(u => !u.user_uid).length, ALREADY_MIGRATED: users.filter(u => !!u.user_uid).length, WOULD_CREATE: users.filter(u => !u.user_uid).length, WOULD_CHANGE_EXISTING: 0, WOULD_DELETE: 0, COUPLE_RELATIONS_TOUCHED: 0, migrated: 0 }
  if (!execute) return out
  for (const u of users) if (!u.user_uid) {
    const candidate = generateUserUid()
    const r = await db.collection('users').where({ _id: u._id, _openid: u._openid, user_uid: db.command.eq(null) }).update({ data: { user_uid: candidate } })
    if (r.stats && r.stats.updated === 1) out.migrated++
  }
  return out
}
module.exports = { diagnoseUserUid, dryRunUserUidMigration, executeUserUidMigration }
