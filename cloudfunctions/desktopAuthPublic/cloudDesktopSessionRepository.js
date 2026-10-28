class CloudDesktopSessionRepository {
  constructor(db) { this.db = db }
  collection() { return this.db.collection('desktop_sessions') }
  async create(record) { const r = await this.collection().add({ data: record }); return { ...record, _id: r._id } }
  async findByTokenHash(tokenHash) { const r = await this.collection().where({ tokenHash }).limit(1).get(); return r.data[0] || null }
  async findByLoginSessionId(loginSessionId) { const r = await this.collection().where({ loginSessionId }).limit(1).get(); return r.data[0] || null }
  // 注意：desktopSessionId 是**业务主键字段**（'dss_...'），与云数据库的文档 _id
  // 是两个不同的值。此前的实现拿 desktopSessionId 去匹配 `_id`，在真云必然 0 命中，
  // 表现为「退出登录永远失败、过期状态永远不落库」。这里按业务字段匹配（CAS）。
  async transitionStatus(desktopSessionId, expectedStatus, nextStatus, patch = {}) {
    const r = await this.collection().where({ desktopSessionId, status: expectedStatus }).update({ data: { status: nextStatus, ...patch } })
    return !!(r.stats && r.stats.updated === 1)
  }
  async updateLastSeen(desktopSessionId, expectedStatus, lastSeenAt) {
    const r = await this.collection().where({ desktopSessionId, status: expectedStatus }).update({ data: { lastSeenAt } })
    return !!(r.stats && r.stats.updated === 1)
  }
  // 换发 token：仅当记录仍是 active **且 tokenHash 仍是期望值**才允许（真 CAS）。
  // 旧 tokenHash 作为条件，是为了让并发重放只有一个赢家；失败返回 false。
  async rotateToken(desktopSessionId, expectedStatus, expectedTokenHash, tokenHash, lastSeenAt) {
    const r = await this.collection()
      .where({ desktopSessionId, status: expectedStatus, tokenHash: expectedTokenHash })
      .update({ data: { tokenHash, lastSeenAt } })
    return !!(r.stats && r.stats.updated === 1)
  }
}
module.exports = { CloudDesktopSessionRepository }
