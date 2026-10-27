const test = require('node:test')
const assert = require('node:assert/strict')
const core = require('../cloudfunctions/writing/writingCore')

class InMemoryWritingRepository {
  constructor() { this.rows = []; this.next = 1 }
  async create(r) { const row = { ...r, _id: `w${this.next++}` }; this.rows.push(row); return row }
  async listByOwner(owner, status) { return this.rows.filter(r => r.ownerOpenid === owner && (!status || r.status === status)).sort((a, b) => b.updatedAt - a.updatedAt) }
  async findByIdAndOwner(id, owner) { return this.rows.find(r => r._id === id && r.ownerOpenid === owner) || null }
  async updateByIdAndOwner(id, owner, patch) { const r = await this.findByIdAndOwner(id, owner); if (!r) return false; Object.assign(r, patch); return true }
  async deleteByIdAndOwner(id, owner) { const i = this.rows.findIndex(r => r._id === id && r.ownerOpenid === owner); if (i < 0) return false; this.rows.splice(i, 1); return true }
}
let now = 1000
function setup() { const repo = new InMemoryWritingRepository(); return { repo, A: 'USER_A', B: 'USER_B', coupleId: 'COUPLE_1' } }

test('CREATE_WRITING', async () => { const x = setup(); const r = await core.create({ repo: x.repo, ownerOpenid: x.A, input: { title: '日常', content: '今天看到一朵云', type: 'free', status: 'finished', ownerOpenid: x.B, wordCount: 999, bookId: 'victim-book' }, now: now++ }); assert.equal(r.ownerOpenid, x.A); assert.equal(r.wordCount, 7); assert.equal(r.bookId, null) })
test('CREATE_DRAFT_EMPTY_ALLOWED', async () => { const x = setup(); const r = await core.create({ repo: x.repo, ownerOpenid: x.A, input: { content: '', status: 'draft' }, now: now++ }); assert.equal(r.status, 'draft'); assert.equal(r.wordCount, 0) })
test('CREATE_FINISHED_EMPTY_DENIED', async () => { const x = setup(); await assert.rejects(() => core.create({ repo: x.repo, ownerOpenid: x.A, input: { status: 'finished' } }), { code: 'FINISHED_CONTENT_REQUIRED' }) })
test('LIST_OWN_ONLY', async () => { const x = setup(); await core.create({ repo: x.repo, ownerOpenid: x.A, input: { content: 'A' }, now: now++ }); await core.create({ repo: x.repo, ownerOpenid: x.B, input: { content: 'B' }, now: now++ }); assert.equal((await core.list({ repo: x.repo, ownerOpenid: x.A })).length, 1) })
test('GET_UPDATE_DELETE_OWN', async () => { const x = setup(); const r = await core.create({ repo: x.repo, ownerOpenid: x.A, input: { content: '原文' }, now: now++ }); assert.equal((await core.get({ repo: x.repo, ownerOpenid: x.A, writingId: r._id })).content, '原文'); const u = await core.update({ repo: x.repo, ownerOpenid: x.A, writingId: r._id, input: { content: '新内容', ownerOpenid: x.B, createdAt: 1 }, now: now++ }); assert.equal(u.content, '新内容'); assert.equal(u.ownerOpenid, x.A); assert.deepEqual(await core.remove({ repo: x.repo, ownerOpenid: x.A, writingId: r._id }), { deleted: true }) })
test('OTHER_USER_ACCESS_DENIED', async () => { const x = setup(); const r = await core.create({ repo: x.repo, ownerOpenid: x.A, input: { content: '私密' }, now: now++ }); for (const fn of [() => core.get({ repo: x.repo, ownerOpenid: x.B, writingId: r._id }), () => core.update({ repo: x.repo, ownerOpenid: x.B, writingId: r._id, input: { content: '攻击' } }), () => core.remove({ repo: x.repo, ownerOpenid: x.B, writingId: r._id })]) await assert.rejects(fn, { code: 'WRITING_NOT_FOUND' }); assert.equal((await core.list({ repo: x.repo, ownerOpenid: x.B })).length, 0) })
test('PARTNER_ACCESS_DENIED', async () => { const x = setup(); const r = await core.create({ repo: x.repo, ownerOpenid: x.A, input: { content: '私密' }, now: now++ }); assert.equal((await core.list({ repo: x.repo, ownerOpenid: x.B, coupleId: x.coupleId })).length, 0); await assert.rejects(() => core.get({ repo: x.repo, ownerOpenid: x.B, writingId: r._id, coupleId: x.coupleId }), { code: 'WRITING_NOT_FOUND' }) })
test('WORD_COUNT_SERVER_AUTHORITY', async () => { const x = setup(); const r = await core.create({ repo: x.repo, ownerOpenid: x.A, input: { content: '中文 abc\n测试', wordCount: 999 }, now: now++ }); assert.equal(r.wordCount, 9) })
test('INVALID_INPUT_DENIED', async () => { const x = setup(); await assert.rejects(() => core.create({ repo: x.repo, ownerOpenid: x.A, input: { type: 'bad' } }), { code: 'INVALID_TYPE' }); await assert.rejects(() => core.create({ repo: x.repo, ownerOpenid: x.A, input: { status: 'bad' } }), { code: 'INVALID_STATUS' }); await assert.rejects(() => core.create({ repo: x.repo, ownerOpenid: x.A, input: { content: 'x'.repeat(50001) } }), { code: 'CONTENT_TOO_LONG' }) })
test('ASYNC_REPOSITORY', async () => { const x = setup(); const r = await core.create({ repo: x.repo, ownerOpenid: x.A, input: { content: 'async' }, now: now++ }); assert.ok(r._id) })
