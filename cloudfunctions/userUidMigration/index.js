// TEMP V2.1-3 migration gate. Deploy only for controlled admin execution.
// Default is read-only diagnose/dryRun. No frontend can provide authority.
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const identity = require('./core')

function adminGate(event) {
  return process.env.ALLOW_USER_UID_MIGRATION === 'true' &&
    typeof process.env.USER_UID_MIGRATION_NONCE === 'string' &&
    process.env.USER_UID_MIGRATION_NONCE.length >= 32 &&
    event.nonce === process.env.USER_UID_MIGRATION_NONCE
}

exports.main = async (event = {}) => {
  if (event.action === 'diagnose') return identity.diagnoseUserUid({ db })
  if (event.action === 'dryRun') return { USER_UID_MIGRATION_DRY_RUN: true, ...(await identity.dryRunUserUidMigration({ db })) }
  if (event.action === 'execute') {
    if (!adminGate(event)) return { ok: false, code: 'MIGRATION_NOT_AUTHORIZED' }
    return { USER_UID_MIGRATION_EXECUTED: true, ...(await identity.executeUserUidMigration({ db })) }
  }
  return { ok: false, code: 'BAD_ACTION' }
}
