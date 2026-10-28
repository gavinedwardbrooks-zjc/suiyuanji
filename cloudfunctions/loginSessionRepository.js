// ALL repository methods are async by contract.
class LoginSessionRepository {
  async create() { throw new Error('NOT_IMPLEMENTED') }
  async get() { throw new Error('NOT_IMPLEMENTED') }
  async transition() { throw new Error('NOT_IMPLEMENTED') }
}
class InMemoryLoginSessionRepository extends LoginSessionRepository {
  constructor({ delayMs = 0 } = {}) { super(); this.records = new Map(); this.delayMs = delayMs }
  async wait() { if (this.delayMs) await new Promise(resolve => setTimeout(resolve, this.delayMs)) }
  async create(record) { await this.wait(); if (!record || typeof record.sessionId !== 'string' || this.records.has(record.sessionId)) throw new Error('DUPLICATE_SESSION'); this.records.set(record.sessionId, JSON.parse(JSON.stringify(record))); return this.get(record.sessionId) }
  async get(sessionId) { await this.wait(); const r = this.records.get(sessionId); return r ? JSON.parse(JSON.stringify(r)) : null }
  async transition(sessionId, expectedStatus, nextStatus, patch = {}) { await this.wait(); const r = this.records.get(sessionId); if (!r || r.status !== expectedStatus) return false; r.status = nextStatus; Object.assign(r, JSON.parse(JSON.stringify(patch))); return true }
}
module.exports = { LoginSessionRepository, InMemoryLoginSessionRepository }
