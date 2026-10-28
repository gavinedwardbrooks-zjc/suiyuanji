// ALL repository methods are async by contract.
class DesktopSessionRepository {
  async create() { throw new Error('NOT_IMPLEMENTED') }
  async findByTokenHash() { throw new Error('NOT_IMPLEMENTED') }
  async findByLoginSessionId() { throw new Error('NOT_IMPLEMENTED') }
  async transitionStatus() { throw new Error('NOT_IMPLEMENTED') }
  async updateLastSeen() { throw new Error('NOT_IMPLEMENTED') }
  async rotateToken() { throw new Error('NOT_IMPLEMENTED') }
}
class InMemoryDesktopSessionRepository extends DesktopSessionRepository {
  constructor({ delayMs = 0 } = {}) { super(); this.records = new Map(); this.byLoginSession = new Map(); this.failCreate = false; this.delayMs = delayMs }
  async wait() { if (this.delayMs) await new Promise(resolve => setTimeout(resolve, this.delayMs)) }
  async create(record) { await this.wait(); if (this.failCreate) { this.failCreate = false; throw new Error('DESKTOP_SESSION_CREATE_FAILED') }; if (!record || this.records.has(record.desktopSessionId) || (record.loginSessionId && this.byLoginSession.has(record.loginSessionId))) throw new Error('DUPLICATE_DESKTOP_SESSION'); this.records.set(record.desktopSessionId, JSON.parse(JSON.stringify(record))); if (record.loginSessionId) this.byLoginSession.set(record.loginSessionId, record.desktopSessionId); return this.get(record.desktopSessionId) }
  async get(id) { await this.wait(); const r = this.records.get(id); return r ? JSON.parse(JSON.stringify(r)) : null }
  async findByTokenHash(tokenHash) { await this.wait(); for (const r of this.records.values()) if (r.tokenHash === tokenHash) return JSON.parse(JSON.stringify(r)); return null }
  async findByLoginSessionId(id) { await this.wait(); const sid = this.byLoginSession.get(id); return sid ? this.get(sid) : null }
  async transitionStatus(id, expected, next, patch = {}) { await this.wait(); const r = this.records.get(id); if (!r || r.status !== expected) return false; r.status = next; Object.assign(r, JSON.parse(JSON.stringify(patch))); return true }
  async updateLastSeen(id, expected, value) { await this.wait(); const r = this.records.get(id); if (!r || r.status !== expected) return false; r.lastSeenAt = value; return true }
  async rotateToken(id, expected, expectedTokenHash, tokenHash, lastSeenAt) { await this.wait(); const r = this.records.get(id); if (!r || r.status !== expected || r.tokenHash !== expectedTokenHash) return false; r.tokenHash = tokenHash; r.lastSeenAt = lastSeenAt; return true }
}
module.exports = { DesktopSessionRepository, InMemoryDesktopSessionRepository }
