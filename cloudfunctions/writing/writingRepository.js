class CloudWritingRepository {
  constructor(db) { this.db = db }
  collection() { return this.db.collection('writings') }
  async create(record) { const r = await this.collection().add({ data: record }); return { ...record, _id: r._id } }
  async listByOwner(ownerOpenid, status) {
    let q = this.collection().where({ ownerOpenid })
    if (status) q = q.where({ status })
    const r = await q.orderBy('updatedAt', 'desc').limit(100).get()
    return r.data || []
  }
  async findByIdAndOwner(id, ownerOpenid) {
    const r = await this.collection().where({ _id: id, ownerOpenid }).limit(1).get()
    return r.data[0] || null
  }
  async updateByIdAndOwner(id, ownerOpenid, data) {
    const r = await this.collection().where({ _id: id, ownerOpenid }).update({ data })
    return !!(r.stats && r.stats.updated === 1)
  }
  async deleteByIdAndOwner(id, ownerOpenid) {
    const r = await this.collection().where({ _id: id, ownerOpenid }).remove()
    return !!(r.stats && r.stats.removed === 1)
  }
}
module.exports = { CloudWritingRepository }
