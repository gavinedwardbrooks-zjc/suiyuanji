// ============================================================
// tests/dual-couple-isolation.test.js · Task F1 双情侣隔离（A-B 与 C-D 同时 active）
// 验证两对独立情侣**同时存在**时，心愿/留言/评分/经期/AI 小结严格隔离。
// 与 cross-couple-leak（换绑 A-B→A-C）互补：本文件聚焦「两对并存」。
// 运行：node tests/dual-couple-isolation.test.js
// ============================================================
const Module = require('module')
const path = require('path')
const { MockDB } = require('./mock-db')

const ROOT = path.resolve(__dirname, '..')
let passed = 0, failed = 0, failures = []

function testCase(name, fn) {
  return Promise.resolve().then(fn).then(() => {
    passed++; console.log('  PASS  ' + name)
  }).catch(e => {
    failed++; failures.push(name + ': ' + e.message); console.log('  FAIL  ' + name + '  -> ' + e.message)
  })
}
function assertEq(a, b, msg) { if (a !== b) throw new Error((msg || '') + ' 期望 ' + JSON.stringify(b) + ' 实际 ' + JSON.stringify(a)) }
function assertOk(v, msg) { if (!v) throw new Error(msg || '断言失败') }
function assertNo(text, needle, msg) { if (String(text).includes(needle)) throw new Error((msg || '') + ' 出现了不该出现的内容: ' + needle) }

let OPENID = 'A'
function loadFn(name, db) {
  const origLoad = Module._load
  Module._load = function (request) {
    if (request === 'wx-server-sdk') {
      return { DYNAMIC_CURRENT_ENV: 'test', init() {}, database: () => db, getWXContext: () => ({ OPENID }) }
    }
    return origLoad.apply(this, arguments)
  }
  const fnPath = path.resolve(__dirname, '../cloudfunctions/' + name + '/index.js')
  delete require.cache[fnPath]
  const mod = require(fnPath)
  Module._load = origLoad
  return mod
}

const D = '2026-10-18'

function seedDual() {
  return new MockDB({
    users: [
      { _id: 'u_a', _openid: 'A', role: 'her', coupleId: 'CZ-AB', schemaVersion: 2 },
      { _id: 'u_b', _openid: 'B', role: 'him', coupleId: 'CZ-AB', schemaVersion: 2 },
      { _id: 'u_c', _openid: 'C', role: 'her', coupleId: 'CZ-CD', schemaVersion: 2 },
      { _id: 'u_d', _openid: 'D', role: 'him', coupleId: 'CZ-CD', schemaVersion: 2 }
    ],
    couples: [
      { _id: 'cab', coupleId: 'CZ-AB', herOpenid: 'A', himOpenid: 'B', status: 'active', boundAt: 1000 },
      { _id: 'ccd', coupleId: 'CZ-CD', herOpenid: 'C', himOpenid: 'D', status: 'active', boundAt: 2000 }
    ],
    daily_records: [
      { _id: 'r_a', _openid: 'A', coupleId: 'CZ-AB', date: D, score: 5 },
      { _id: 'r_c', _openid: 'C', coupleId: 'CZ-CD', date: D, score: 3 }
    ],
    wishes: [
      { _id: 'w_a', _openid: 'A', coupleId: 'CZ-AB', type: 'eat', text: 'A想吃火锅', status: 'pending', createdAt: 100 },
      { _id: 'w_c', _openid: 'C', coupleId: 'CZ-CD', type: 'eat', text: 'C想吃寿司', status: 'pending', createdAt: 200 }
    ],
    messages: [
      { _id: 'm_ab', coupleId: 'CZ-AB', fromOpenid: 'B', fromRole: 'him', text: 'B给A的话', readAt: null, createdAt: 100 },
      { _id: 'm_cd', coupleId: 'CZ-CD', fromOpenid: 'D', fromRole: 'him', text: 'D给C的话', readAt: null, createdAt: 200 }
    ],
    menstrual: [
      { _id: 'mm_a', _openid: 'A', lastStart: '2026-10-01', cycle: 28, sharePeriod: true },
      { _id: 'mm_c', _openid: 'C', lastStart: '2026-10-02', cycle: 28, sharePeriod: true }
    ],
    profiles: [], weekly_reports: []
  })
}

async function runAll() {
  console.log('\n=== D · 两对独立情侣同时 active 的隔离 ===\n')

  await testCase('D1 B 只看 A 的心愿，看不到 C 的心愿', async () => {
    const db = seedDual()
    const pv = loadFn('getPartnerView', db)
    OPENID = 'B'
    const r = await pv.main({ date: D })
    assertOk(r.ok)
    assertEq(r.wishes.length, 1, JSON.stringify(r.wishes))
    assertEq(r.wishes[0].text, 'A想吃火锅')
    assertNo(JSON.stringify(r.wishes), '寿司', 'B 不得看到 C 的心愿')
    OPENID = 'A'
  })

  await testCase('D2 D 只看 C 的心愿，看不到 A 的心愿', async () => {
    const db = seedDual()
    const pv = loadFn('getPartnerView', db)
    OPENID = 'D'
    const r = await pv.main({ date: D })
    assertOk(r.ok)
    assertEq(r.wishes.length, 1)
    assertEq(r.wishes[0].text, 'C想吃寿司')
    assertNo(JSON.stringify(r.wishes), '火锅', 'D 不得看到 A 的心愿')
    OPENID = 'A'
  })

  await testCase('D3 B 只看 A 的评分，看不到 C 的评分', async () => {
    const db = seedDual()
    const pv = loadFn('getPartnerView', db)
    OPENID = 'B'
    const r = await pv.main({ date: D })
    assertEq(r.score, 5)
    OPENID = 'D'
    const r2 = await pv.main({ date: D })
    assertEq(r2.score, 3)
    OPENID = 'A'
  })

  await testCase('D4 留言按 coupleId 隔离：B/D 各看各的', async () => {
    const db = seedDual()
    const pv = loadFn('getPartnerView', db)
    OPENID = 'B'
    const rb = await pv.main({ date: D })
    assertEq(rb.messages.length, 1)
    assertEq(rb.messages[0].text, 'B给A的话')
    OPENID = 'D'
    const rd = await pv.main({ date: D })
    assertEq(rd.messages.length, 1)
    assertEq(rd.messages[0].text, 'D给C的话')
    assertNo(JSON.stringify(rd.messages), 'B给A', 'D 不得看到 A-B 的留言')
    OPENID = 'A'
  })

  await testCase('D5 经期各看各的（B 看 A，D 看 C，交叉不可见）', async () => {
    const db = seedDual()
    const pv = loadFn('getPartnerView', db)
    OPENID = 'B'
    const rb = await pv.main({ date: D })
    assertEq(rb.nextLabel, '10月29日左右', 'B 应看到 A 的经期（lastStart 10-01 + 28）')
    OPENID = 'D'
    const rd = await pv.main({ date: D })
    assertEq(rd.nextLabel, '10月30日左右', 'D 应看到 C 的经期（lastStart 10-02 + 28），交叉会看到错误日期')
    OPENID = 'A'
  })

  await testCase('D6 AI cron 批量生成：partnerSummaryCoupleId 各归各关系', async () => {
    const db = seedDual()
    const ai = loadFn('aiSummary', db)
    ai.__setTransport(async () => 'AI文本')
    OPENID = undefined // 后台批量
    const r = await ai.main({ Type: 'Timer', TriggerName: 'dailySummary', date: D })
    OPENID = 'A'
    assertOk(r.ok, JSON.stringify(r))
    const recs = db.dump().daily_records
    const ra = recs.find(x => x._id === 'r_a')
    const rc = recs.find(x => x._id === 'r_c')
    assertEq(ra.partnerSummaryCoupleId, 'CZ-AB')
    assertEq(rc.partnerSummaryCoupleId, 'CZ-CD')
    assertOk(ra.partnerSummary && ra.partnerSummary.length > 0)
    assertOk(rc.partnerSummary && rc.partnerSummary.length > 0)
  })

  await testCase('D7 越权：B 伪造 openid/coupleId 参数仍读不到 C 的数据', async () => {
    const db = seedDual()
    const pv = loadFn('getPartnerView', db)
    OPENID = 'B'
    // 伪造参数：身份只来自 WXContext，前端传 openid/coupleId 无效
    const r = await pv.main({ date: D, openid: 'C', coupleId: 'CZ-CD', role: 'her' })
    assertOk(r.ok)
    assertNo(JSON.stringify(r.wishes), '寿司', '伪造参数不得读到 C 的心愿')
    assertNo(JSON.stringify(r.messages), 'D给C', '伪造参数不得读到 C-D 留言')
    assertEq(r.score, 5, '伪造参数不影响身份（仍只读 A 的评分）')
    OPENID = 'A'
  })

  console.log('\n=== 结果: ' + passed + ' PASS / ' + failed + ' FAIL ===')
  if (failed) {
    failures.forEach(f => console.log('  - ' + f))
    process.exit(1)
  }
  console.log('Dual Couple Isolation: ALL GREEN')
}

runAll().catch(e => { console.error('测试执行异常:', e); process.exit(1) })
