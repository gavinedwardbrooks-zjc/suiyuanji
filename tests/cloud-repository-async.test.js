// ============================================================
// tests/cloud-repository-async.test.js · 云仓库适配层（异步契约 + 字段匹配）
// 关键教训：桌面会话的业务主键是 desktopSessionId（'dss_...'），
// 与云数据库文档 _id（随机串）**不是一个值**。旧用例把两者写成同一个字符串，
// 于是 where({_id: desktopSessionId}) 这种错误实现在测试里也能通过。
// 本文件现在强制让 _id ≠ desktopSessionId，防止同类错误再次被掩盖。
// ============================================================
const assert = require('assert')
const { CloudLoginSessionRepository } = require('../cloudfunctions/cloudLoginSessionRepository')
const { CloudDesktopSessionRepository } = require('../cloudfunctions/cloudDesktopSessionRepository')

function delayed(value, ms = 2) { return new Promise(resolve => setTimeout(() => resolve(value), ms)) }
function match(doc, q) { return Object.entries(q).every(([k, v]) => doc[k] === v) }
function fakeCollection(seed) {
  return {
    where(q) {
      const chain = {
        limit() { return chain },
        async get() { return delayed({ data: seed.filter(x => match(x, q)).map(x => ({ ...x })) }) },
        async update({ data }) {
          const hit = seed.filter(x => match(x, q))
          hit.forEach(x => Object.assign(x, data))
          return delayed({ stats: { updated: hit.length } })
        }
      }
      return chain
    },
    async add({ data }) {
      // 真实云数据库会分配自己的文档 _id；这里刻意与业务主键区分开
      const doc = { _id: 'docid_' + seed.length, ...data }
      seed.push(doc)
      return delayed({ _id: doc._id })
    }
  }
}

async function main() {
  // ---- 登录会话仓库 ----
  const l = []
  const lr = new CloudLoginSessionRepository({ collection: () => fakeCollection(l) })
  await lr.create({ sessionId: 'dls_1', status: 'pending' })
  assert.strictEqual((await lr.get('dls_1')).sessionId, 'dls_1')
  assert.strictEqual(await lr.transition('dls_1', 'pending', 'approved', { approvedAt: 1 }), true)
  assert.strictEqual((await lr.get('dls_1')).status, 'approved')
  // CAS：期望状态不匹配时不得改写
  assert.strictEqual(await lr.transition('dls_1', 'pending', 'cancelled', {}), false)

  // ---- 桌面会话仓库：_id 与 desktopSessionId 必须不同 ----
  const d = []
  const dr = new CloudDesktopSessionRepository({ collection: () => fakeCollection(d) })
  const ds = { desktopSessionId: 'dss_1', tokenHash: 'h1', status: 'active', loginSessionId: 'dls_1', expiresAt: 9999 }
  await dr.create(ds)
  assert.notStrictEqual(d[0]._id, d[0].desktopSessionId, '测试前置：_id 必须不同于业务主键')

  assert.strictEqual((await dr.findByTokenHash('h1')).desktopSessionId, 'dss_1')
  assert.strictEqual((await dr.findByLoginSessionId('dls_1')).desktopSessionId, 'dss_1')
  assert.strictEqual(await dr.findByTokenHash('nope'), null)

  // 这三条是桌面「退出登录 / 过期落库 / 心跳」的唯一通道，必须能命中
  assert.strictEqual(await dr.transitionStatus('dss_1', 'active', 'revoked', { revokedAt: 2 }), true)
  assert.strictEqual(d[0].status, 'revoked')
  assert.strictEqual(await dr.updateLastSeen('dss_1', 'revoked', 3), true)
  assert.strictEqual(d[0].lastSeenAt, 3)

  // 换发 token（consume 重放恢复）：只对 active 生效
  assert.strictEqual(await dr.rotateToken('dss_1', 'active', 'h1', 'h2', 4), false, '已撤销的会话不得换发 token')
  const d2 = []
  const dr2 = new CloudDesktopSessionRepository({ collection: () => fakeCollection(d2) })
  await dr2.create({ desktopSessionId: 'dss_2', tokenHash: 'h1', status: 'active', loginSessionId: 'dls_2', expiresAt: 9999 })
  assert.strictEqual(await dr2.rotateToken('dss_2', 'active', 'h1', 'h2', 5), true)
  assert.strictEqual((await dr2.findByTokenHash('h2')).desktopSessionId, 'dss_2')
  assert.strictEqual(await dr2.findByTokenHash('h1'), null, '旧 token 必须立即失效')
  // 并发重放的唯一赢家：期望的旧 tokenHash 已过时 ⇒ 必须失败（不得再换发一次）
  assert.strictEqual(await dr2.rotateToken('dss_2', 'active', 'h1', 'h3', 6), false, '旧 tokenHash 不匹配时不得换发')
  assert.strictEqual((await dr2.findByTokenHash('h2')).desktopSessionId, 'dss_2', '失败的重放不得覆盖当前 token')
  assert.strictEqual(await dr2.rotateToken('dss_2', 'active', 'h2', 'h3', 7), true, '按最新 hash 重试仍可换发')
  assert.strictEqual((await dr2.findByTokenHash('h3')).desktopSessionId, 'dss_2')

  console.log('cloud repository async tests PASS')
}
main().catch(e => { console.error(e); process.exit(1) })
