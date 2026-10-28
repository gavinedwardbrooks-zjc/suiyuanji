class CloudDesktopSessionRepository {
  constructor(db) { this.db = db }
  collection() { return this.db.collection('desktop_sessions') }
  async create(record) { const r = await this.collection().add({ data: record }); return { ...record, _id: r._id } }
  async findByTokenHash(tokenHash) { const r = await this.collection().where({ tokenHash }).limit(1).get(); return r.data[0] || null }
  async findByLoginSessionId(loginSessionId) { const r = await this.collection().where({ loginSessionId }).limit(1).get(); return r.data[0] || null }
  async transitionStatus(desktopSessionId, expectedStatus, nextStatus, patch = {}) {
    const r = await this.collection().where({ _id: desktopSessionId, status: expectedStatus }).update({ data: { status: nextStatus, ...patch } })
    return !!(r.stats && r.stats.updated === 1)
  }
  async updateLastSeen(desktopSessionId, expectedStatus, lastSeenAt) {
    const r = await this.collection().where({ _id: desktopSessionId, status: expectedStatus }).update({ data: { lastSeenAt } })
    return !!(r.stats && r.stats.updated === 1)
  }
}
module.exports = { CloudDesktopSessionRepository }
