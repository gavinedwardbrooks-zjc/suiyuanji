class CloudLoginSessionRepository {
  constructor(db) { this.db = db }
  collection() { return this.db.collection('login_sessions') }
  async create(record) { const r = await this.collection().add({ data: record }); return { ...record, _id: r._id } }
  async get(sessionId) { const r = await this.collection().where({ sessionId }).limit(1).get(); return r.data[0] || null }
  async transition(sessionId, expectedStatus, nextStatus, patch = {}) {
    const r = await this.collection().where({ sessionId, status: expectedStatus }).update({ data: { status: nextStatus, ...patch } })
    return !!(r.stats && r.stats.updated === 1)
  }
}
module.exports = { CloudLoginSessionRepository }
