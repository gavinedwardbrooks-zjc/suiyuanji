// ============================================================
// tests/p3-3-race.test.js · V1.1 P3.3 任务 D（分享开关并发一致性）
//
// 记录级互动已在 V1.1 收尾移除，原「任务 C：撤销与互动写入竞态」的用例一并删除。
// 本文件现在只覆盖分享开关（shareSet）的 CAS 并发语义。
//
// ⚠️ 语义边界（必须先读）
//   本文件用**单进程可控调度点**制造并发顺序（MockDB.injectHook），
//   断言的是「服务端业务逻辑在明确交错下的判定与补偿行为」。
//   它**不**证明生产数据库的事务隔离 / 行锁语义 —— 真实云环境未验证，
//   报告中该项列为待真机验证事项，不作「竞态已完全消除」的声明。
//
// 每个并发用例都显式记录「哪一次操作先提交」，不靠最终文档数量倒推正确性。
//
// 运行：node tests/p3-3-race.test.js
// ============================================================
const Module = require('module')
const path = require('path')
const { MockDB } = require('./mock-db')

const ROOT = path.resolve(__dirname, '..')
const D1 = '2026-10-20'
const HER_A = 'A_her_openid'
const HIM_B = 'B_him_openid'
const HIM_C = 'C_him_openid'

let OPENID = HER_A
let passed = 0, failed = 0, failures = []

function testCase(name, fn) {
  return Promise.resolve().then(fn).then(() => { passed++; console.log('  PASS  ' + name) })
    .catch(e => { failed++; failures.push(name + ': ' + e.message); console.log('  FAIL  ' + name + '  -> ' + e.message) })
}
function assertEq(a, b, msg) {
  if (a !== b) throw new Error((msg || '') + ' 期望 ' + JSON.stringify(b) + ' 实际 ' + JSON.stringify(a))
}
function assertOk(v, msg) { if (!v) throw new Error(msg || '断言失败') }

// 手写 deferred：用 setTimeout 实现的 Promise 无法精确表达「谁先提交」
function deferred() {
  let resolve, reject
  const p = new Promise((res, rej) => { resolve = res; reject = rej })
  return { p, resolve, reject }
}

function loadFn(db) {
  const origLoad = Module._load
  Module._load = function (request) {
    if (request === 'wx-server-sdk') {
      return {
        DYNAMIC_CURRENT_ENV: 'test',
        init() {},
        database: () => db,
        getWXContext: () => ({ OPENID }),
        openapi: { subscribeMessage: { send: async () => ({ errCode: 0 }) } }
      }
    }
    return origLoad.apply(this, arguments)
  }
  const fnPath = path.join(ROOT, 'cloudfunctions/getPartnerView/index.js')
  delete require.cache[fnPath]
  const mod = require(fnPath)
  Module._load = origLoad
  return mod
}

function seed(shareExtra) {
  return {
    users: [
      { _id: 'uA', _openid: HER_A, role: 'her', coupleId: 'CZ-1', partnerName: '' },
      { _id: 'uB', _openid: HIM_B, role: 'him', coupleId: 'CZ-1', partnerName: '' },
      { _id: 'uC', _openid: HIM_C, role: 'him', coupleId: null, partnerName: '' }
    ],
    couples: [
      { _id: 'c1', coupleId: 'CZ-1', status: 'active', herOpenid: HER_A, himOpenid: HIM_B, anniversary: null }
    ],
    daily_records: [{
      _openid: HER_A, date: D1, coupleId: 'CZ-1', revision: 2,
      goals: [], todos: [], segments: { life: '生活', work: '工作', growth: '成长' },
      mood: { type: 'calm', weather: 'sunny' }, score: 3, wishes: []
    }],
    record_shares: [Object.assign({
      _id: 'sh_' + HER_A + '_' + D1, _openid: HER_A, date: D1,
      coupleId: 'CZ-1', himOpenid: HIM_B, enabled: true, rev: 1, createdAt: 1, updatedAt: 1
    }, shareExtra || {})]
  }
}

const shareDocs = db => (db.dump().record_shares || [])
const shareOf = db => shareDocs(db)[0]

function switchOpenid(id) { OPENID = id }

// P3.3-R1（D2）：shareSet 需要客户端已确认的版本号 → 非并发用例按库内当前版本提交
function curRevOf(db) {
  const d = (db.dump().record_shares || [])[0]
  if (!d) return 0
  return typeof d.rev === 'number' && d.rev >= 0 ? d.rev : 0
}
function setShare(fn, db, date, enabled, expectedRev) {
  const rev = expectedRev === undefined ? curRevOf(db) : expectedRev
  return fn.main({ action: 'shareSet', date, enabled, expectedRev: rev })
}

async function main() {
  console.log('\n=== P3.3-R1 任务 D：分享开关 CAS（expectedRev）并发一致性 ===\n')

  await testCase('D1 两次并发开启（同一 expectedRev=0）→ 只有一个提交成功，另一个 CONFLICT', async () => {
    const db = new MockDB({ ...seed(), record_shares: [] })
    const fn = loadFn(db)
    const reached = deferred()
    const gate = deferred()
    db.injectHook('record_shares', 'add', async () => { reached.resolve(); await gate.p })

    switchOpenid(HER_A)
    const p1 = fn.main({ action: 'shareSet', date: D1, enabled: true, expectedRev: 0 })
    await reached.p
    const r2 = await fn.main({ action: 'shareSet', date: D1, enabled: true, expectedRev: 0 })  // 先提交
    gate.resolve()
    const r1 = await p1                                                                        // 后到

    assertEq(r2.ok, true, '先提交者成功')
    assertEq(r2.rev, 1, '首次创建 → rev=1')
    assertEq(r1.ok, false, '后到者基于「还不存在」的版本 → 必须冲突，不得覆盖')
    assertEq(r1.code, 'CONFLICT')
    assertEq(shareDocs(db).length, 1, '确定性 _id + 唯一约束 → 只能有一条')
    assertEq(shareOf(db).enabled, true)
    assertEq(shareOf(db).rev, 1, '冲突方不得推进版本号')
  })

  await testCase('D2 两次并发关闭（同一 expectedRev=1）→ 一个提交成功，另一个 CONFLICT，rev 只 +1', async () => {
    const db = new MockDB(seed({ enabled: true, rev: 1 }))
    const fn = loadFn(db)
    switchOpenid(HER_A)
    const reached = deferred()
    const gate = deferred()
    db.injectHook('record_shares', 'update', async () => { reached.resolve(); await gate.p })

    const p1 = fn.main({ action: 'shareSet', date: D1, enabled: false, expectedRev: 1 })
    await reached.p
    const r2 = await fn.main({ action: 'shareSet', date: D1, enabled: false, expectedRev: 1 })  // 先提交 rev 1→2
    gate.resolve()
    const r1 = await p1                                                                        // 后到：rev 已推进

    assertEq(r2.ok, true)
    assertEq(r2.rev, 2)
    assertEq(r1.ok, false, '基于已过期版本的关闭请求必须冲突，而不是再写一次')
    assertEq(r1.code, 'CONFLICT')
    assertEq(shareDocs(db).length, 1)
    assertEq(shareOf(db).enabled, false)
    assertEq(shareOf(db).rev, 2, '幂等语义由 CAS 保证：同版本只允许一次提交')
  })

  await testCase('D3 开启与关闭交错（同一版本）→ 先提交者胜，后到的开启不得覆盖已提交的关闭', async () => {
    const db = new MockDB(seed({ enabled: false, rev: 1 }))
    const fn = loadFn(db)
    switchOpenid(HER_A)
    const reached = deferred()
    const gate = deferred()
    db.injectHook('record_shares', 'update', async () => { reached.resolve(); await gate.p })

    const pOpen = fn.main({ action: 'shareSet', date: D1, enabled: true, expectedRev: 1 })   // 先发起，后提交
    await reached.p
    const close = await fn.main({ action: 'shareSet', date: D1, enabled: false, expectedRev: 1 })  // 后发起，先提交
    assertEq(close.ok, true, '先提交者成功')
    assertEq(close.rev, 2)
    gate.resolve()
    const open = await pOpen

    // 提交顺序：close(rev 1→2, enabled=false) → open 基于 rev1 已过期 → 拒
    assertEq(open.ok, false, '过期请求不得把刚提交的关闭覆盖成开启')
    assertEq(open.code, 'CONFLICT')
    assertEq(shareOf(db).rev, 2, '最终只有一次提交生效')
    assertEq(shareOf(db).enabled, false, '最终状态 = 先提交者（关闭）')
  })

  await testCase('D4 关闭与重新开启交错（同一版本）→ 后到的关闭不得覆盖已提交的开启', async () => {
    const db = new MockDB(seed())            // enabled=true rev=1
    const fn = loadFn(db)
    switchOpenid(HER_A)
    const reached = deferred()
    const gate = deferred()
    db.injectHook('record_shares', 'update', async () => { reached.resolve(); await gate.p })

    const pClose = fn.main({ action: 'shareSet', date: D1, enabled: false, expectedRev: 1 })
    await reached.p
    const reopen = await fn.main({ action: 'shareSet', date: D1, enabled: true, expectedRev: 1 })
    assertEq(reopen.ok, true)
    assertEq(reopen.rev, 2)
    gate.resolve()
    const closed = await pClose

    assertEq(closed.ok, false, '过期关闭必须被拒绝')
    assertEq(closed.code, 'CONFLICT')
    assertEq(shareOf(db).rev, 2)
    assertEq(shareOf(db).enabled, true, '最终状态 = 先提交者（开启）')
  })

  await testCase('D5 解绑与开启交错 → STALE_RELATION，补偿绑定本次版本并回滚为不共享', async () => {
    const db = new MockDB(seed({ enabled: false, rev: 1 }))
    const fn = loadFn(db)
    switchOpenid(HER_A)
    const reached = deferred()
    const gate = deferred()
    db.injectHook('record_shares', 'get', async () => { reached.resolve(); await gate.p })

    const pOpen = fn.main({ action: 'shareSet', date: D1, enabled: true, expectedRev: 1 })
    await reached.p
    db._data.couples[0].status = 'superseded'      // 解绑提交
    gate.resolve()
    const open = await pOpen

    assertEq(open.ok, false)
    assertEq(open.code, 'STALE_RELATION', '关系已失效 → 不能报告"分享成功"')
    assertEq(open.rollback, 'applied', '本次写入仍是自己那一版 → 补偿必须真的落下')
    assertEq(shareOf(db).enabled, false, '写后复检必须把这次写入回滚为不共享')
    assertEq(shareOf(db).invalidated, true)
    assertEq(shareOf(db).rev, 3, '写入 rev2 + 补偿 rev3')
  })

  await testCase('D6 换绑与开启交错 → 旧关系授权不得复活，新 him 读不到', async () => {
    const db = new MockDB(seed({ enabled: false, rev: 1 }))
    const fn = loadFn(db)
    switchOpenid(HER_A)
    const reached = deferred()
    const gate = deferred()
    db.injectHook('record_shares', 'get', async () => { reached.resolve(); await gate.p })

    const pOpen = fn.main({ action: 'shareSet', date: D1, enabled: true, expectedRev: 1 })
    await reached.p
    // 换绑到 C（新 coupleId）
    db._data.couples[0] = {
      _id: 'c1', coupleId: 'CZ-9', status: 'active',
      herOpenid: HER_A, himOpenid: HIM_C, anniversary: null
    }
    db._data.users[0].coupleId = 'CZ-9'
    db._data.users[2].coupleId = 'CZ-9'
    db._data.daily_records[0].coupleId = 'CZ-9'
    gate.resolve()
    const open = await pOpen

    assertEq(open.ok, false)
    assertEq(open.code, 'STALE_RELATION')
    assertEq(shareOf(db).enabled, false, '晚到的旧请求不得把上一段关系的授权写回有效')
    assertEq(shareOf(db).invalidated, true)

    switchOpenid(HIM_C)
    const v = await fn.main({ action: 'view', date: D1 })
    assertEq(v.shared, null, '新 him 不能因为这次竞态拿到任何内容')
  })

  await testCase('D7 数据库写入失败 → DB_ERROR，原状态不被破坏（不假装成功、不推进版本）', async () => {
    const db = new MockDB(seed({ enabled: true, rev: 7 }))
    const fn = loadFn(db)
    switchOpenid(HER_A)
    db.injectFail('record_shares', 'update')
    const r = await fn.main({ action: 'shareSet', date: D1, enabled: false, expectedRev: 7 })
    assertEq(r.ok, false)
    assertEq(r.code, 'DB_ERROR')
    assertEq(shareOf(db).enabled, true, '写入失败时原状态必须保持')
    assertEq(shareOf(db).rev, 7, '失败不得推进版本号')
  })

  await testCase('D8 旧请求晚到（版本已过期）→ CONFLICT，绝不自动升级到最新版本再提交', async () => {
    const db = new MockDB(seed())            // enabled=true rev=1
    const fn = loadFn(db)
    switchOpenid(HER_A)
    const reached = deferred()
    const gate = deferred()
    db.injectHook('record_shares', 'update', async () => { reached.resolve(); await gate.p })

    // p1 = 先发出、后提交（关闭）；r2 = 后发出、先提交（开启）。
    // 两者都基于 rev=1：这正是「过期请求」要防的场景。
    const p1 = fn.main({ action: 'shareSet', date: D1, enabled: false, expectedRev: 1 })
    await reached.p
    const r2 = await fn.main({ action: 'shareSet', date: D1, enabled: true, expectedRev: 1 })
    gate.resolve()
    const r1 = await p1

    assertEq(r2.ok, true)
    assertEq(r2.rev, 2)
    assertEq(r1.ok, false, '服务端不得替过期请求升级到 rev2 再写一遍')
    assertEq(r1.code, 'CONFLICT')
    assertEq(shareOf(db).rev, 2, '只有一次提交生效')
    assertEq(shareOf(db).enabled, true, '最终状态 = 先提交者，不被迟到请求覆盖')
  })

  await testCase('D9 缺少 expectedRev（旧客户端）→ CONFLICT + needRefresh，零写入', async () => {
    const db = new MockDB(seed())            // enabled=true rev=1
    const fn = loadFn(db)
    switchOpenid(HER_A)
    const r = await fn.main({ action: 'shareSet', date: D1, enabled: false })   // 不带版本号
    assertEq(r.ok, false, '无版本号不得被视为「无条件覆盖」')
    assertEq(r.code, 'CONFLICT')
    assertEq(r.needRefresh, true)
    assertEq(shareOf(db).enabled, true, '未发生任何写入')
    assertEq(shareOf(db).rev, 1)
  })

  await testCase('D10 expectedRev 非法（非整数 / 负数 / 字符串）→ BAD_ARGS，零写入', async () => {
    for (const bad of ['1', 1.5, -1, {}, [], NaN]) {
      const db = new MockDB(seed())
      const fn = loadFn(db)
      switchOpenid(HER_A)
      const r = await fn.main({ action: 'shareSet', date: D1, enabled: false, expectedRev: bad })
      assertEq(r.ok, false, 'expectedRev=' + JSON.stringify(bad) + ' 必须拒绝')
      assertEq(r.code, 'BAD_ARGS')
      assertEq(shareOf(db).rev, 1, '被拒绝的请求不得推进版本号')
      assertEq(shareOf(db).enabled, true)
    }
  })

  await testCase('D11 历史文档缺 rev：按版本 0 处理，expectedRev=0 可成功并补上 rev=1', async () => {
    const data = seed()
    delete data.record_shares[0].rev
    const db = new MockDB(data)
    const fn = loadFn(db)
    switchOpenid(HER_A)

    // 先确认读出来是 0
    const st = await fn.main({ action: 'shareStatus', date: D1 })
    assertEq(st.rev, 0, '缺 rev 的历史文档 → 版本 0')

    const r = await fn.main({ action: 'shareSet', date: D1, enabled: false, expectedRev: 0 })
    assertEq(r.ok, true, 'expectedRev=0 与「缺 rev」等价 → 允许一次 CAS')
    assertEq(r.rev, 1)
    assertEq(shareOf(db).enabled, false)
    assertEq(shareOf(db).rev, 1, 'CAS 成功后补上版本号')

    // 再用 0 提交必须冲突（版本已推进到 1）
    const again = await fn.main({ action: 'shareSet', date: D1, enabled: true, expectedRev: 0 })
    assertEq(again.ok, false)
    assertEq(again.code, 'CONFLICT')
    assertEq(again.rev, 1)
  })

  console.log('\n=== 结果: ' + passed + ' PASS / ' + failed + ' FAIL ===')
  if (failed) {
    console.log('\n失败用例:')
    for (const f of failures) console.log('  - ' + f)
    process.exit(1)
  }
  console.log('P3.3 Race (share CAS): ALL GREEN')
}

main()
