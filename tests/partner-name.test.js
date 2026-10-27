// ============================================================
// tests/partner-name.test.js · 自定义情侣称呼（Task A）
//
// 验证：
//   1. 称呼是「查看者自己」设定的，存 users.partnerName，不跨情侣继承
//   2. 评分方向：记录方「给 X 打几分」、陪伴方「X 今天给你打了几分」，X 都是本人给 TA 的称呼
//   3. 解绑后称呼清空，重新绑定不把旧称呼用于新伴侣
//   4. 校验：长度、控制字符清洗、清空/恢复默认
//   5. displayName 缺省回退「TA」
//
// 运行：node tests/partner-name.test.js
// ============================================================
const Module = require('module')
const path = require('path')
const fs = require('fs')
const { MockDB } = require('./mock-db')

const ROOT = path.resolve(__dirname, '..')
let passed = 0, failed = 0, failures = []

function testCase(name, fn) {
  return Promise.resolve().then(fn).then(() => { passed++; console.log('  PASS  ' + name) })
    .catch(e => { failed++; failures.push(name + ': ' + e.message); console.log('  FAIL  ' + name + '  -> ' + e.message) })
}
function assertEq(a, b, msg) { if (a !== b) throw new Error((msg || '') + ' 期望 ' + JSON.stringify(b) + ' 实际 ' + JSON.stringify(a)) }
function assertOk(v, msg) { if (!v) throw new Error(msg || '断言失败') }

let OPENID = 'A'
function loadFn(name, db) {
  const origLoad = Module._load
  Module._load = function (request) {
    if (request === 'wx-server-sdk') {
      return {
        DYNAMIC_CURRENT_ENV: 'test', init() {}, database: () => db,
        getWXContext: () => ({ OPENID }),
        openapi: { subscribeMessage: { send: async () => ({ errCode: 0 }) } }
      }
    }
    return origLoad.apply(this, arguments)
  }
  const fnPath = path.resolve(__dirname, '../cloudfunctions/' + name + '/index.js')
  delete require.cache[fnPath]
  const mod = require(fnPath)
  Module._load = origLoad
  return mod
}

// 纯函数 helper（跨文件 require，无需 mock）
const { displayName } = require(path.join(ROOT, 'utils/partner-name.js'))

function seedBound() {
  return new MockDB({
    users: [
      { _id: 'u_a', _openid: 'A', role: 'her', coupleId: 'CZ-1', partnerName: '', schemaVersion: 2 },
      { _id: 'u_b', _openid: 'B', role: 'him', coupleId: 'CZ-1', partnerName: '', schemaVersion: 2 }
    ],
    couples: [{ _id: 'c1', coupleId: 'CZ-1', herOpenid: 'A', himOpenid: 'B', status: 'active', boundAt: 1000 }],
    daily_records: [], wishes: [], messages: [], menstrual: []
  })
}

async function runAll() {
  console.log('\n=== Partner Name · 自定义情侣称呼 ===\n')

  // ---- A. displayName 纯函数 ----
  await testCase('A1 displayName 空/空白回退「TA」', () => {
    assertEq(displayName(''), 'TA')
    assertEq(displayName(undefined), 'TA')
    assertEq(displayName(null), 'TA')
    assertEq(displayName('   '), 'TA')
  })
  await testCase('A2 displayName 保留自定义称呼并截断到 12 字', () => {
    assertEq(displayName('小胖'), '小胖')
    assertEq(displayName('宝宝'), '宝宝')
    assertEq(displayName('一二三四五六七八九十十一十二十三'), '一二三四五六七八九十十一')
  })

  // ---- B. 服务端 setPartnerName / view ----
  await testCase('B1 设置称呼后 view 返回 myPartnerName', async () => {
    const db = seedBound()
    const pv = loadFn('getPartnerView', db)
    OPENID = 'A'
    const s = await pv.main({ action: 'setPartnerName', name: '小胖' })
    assertEq(s.ok, true)
    assertEq(s.partnerName, '小胖')
    const v = await pv.main({})
    assertEq(v.myPartnerName, '小胖')
    // 只写自己的，不写对方
    assertEq(db.dump().users.find(u => u._openid === 'B').partnerName, '')
  })

  await testCase('B2 双方称呼独立：A 叫 B 小胖、B 叫 A 宝宝，互不覆盖', async () => {
    const db = seedBound()
    const pv = loadFn('getPartnerView', db)
    OPENID = 'A'
    await pv.main({ action: 'setPartnerName', name: '小胖' })
    OPENID = 'B'
    await pv.main({ action: 'setPartnerName', name: '宝宝' })
    const vB = await pv.main({})
    assertEq(vB.myPartnerName, '宝宝')
    OPENID = 'A'
    const vA = await pv.main({})
    assertEq(vA.myPartnerName, '小胖')
  })

  await testCase('B3 超长/控制字符被清洗，长度封顶 12', async () => {
    const db = seedBound()
    const pv = loadFn('getPartnerView', db)
    OPENID = 'A'
    const s = await pv.main({ action: 'setPartnerName', name: '宝宝\u0000\u0007\x01\u007f亲爱的' })
    assertEq(s.ok, true)
    assertOk(!s.partnerName.includes('\u0000'), '控制字符未清除')
    const long = '一'.repeat(40)
    const s2 = await pv.main({ action: 'setPartnerName', name: long })
    assertEq(s2.partnerName.length, 12)
  })

  await testCase('B4 清空/恢复默认：空串 → myPartnerName 回退 TA', async () => {
    const db = seedBound()
    const pv = loadFn('getPartnerView', db)
    OPENID = 'A'
    await pv.main({ action: 'setPartnerName', name: '小胖' })
    const c = await pv.main({ action: 'setPartnerName', name: '' })
    assertEq(c.ok, true)
    assertEq(c.partnerName, '')
    const v = await pv.main({})
    assertEq(v.myPartnerName, '')
  })

  await testCase('B5 未绑定 / 非 active 不能设置称呼', async () => {
    const db = seedBound()
    // 第三方 C 无关系
    db.collection('users').add({ data: { _id: 'u_c', _openid: 'C', role: 'her', coupleId: null, partnerName: '', schemaVersion: 2 } })
    const pv = loadFn('getPartnerView', db)
    OPENID = 'C'
    const s = await pv.main({ action: 'setPartnerName', name: '老公' })
    assertEq(s.ok, false)
    assertEq(s.code, 'NOT_ACTIVE')
  })

  // ---- C. 解绑清空称呼（不跨关系继承）----
  await testCase('C1 解绑后 partnerName 清空，重新绑定不继承旧称呼', async () => {
    const db = seedBound()
    const pv = loadFn('getPartnerView', db)
    OPENID = 'A'
    await pv.main({ action: 'setPartnerName', name: '小胖' })
    // 解绑（用 bindCouple core 真实状态机）
    const bcore = require(path.join(ROOT, 'cloudfunctions/bindCouple/core.js'))
    const ub = await bcore.unbind({ db, openid: 'A', now: Date.now() })
    assertEq(ub.ok, true)
    const a = db.dump().users.find(u => u._openid === 'A')
    assertEq(a.partnerName, '', '解绑应清空称呼')
    const b = db.dump().users.find(u => u._openid === 'B')
    assertEq(b.partnerName, '', '解绑应清空对方称呼')
  })

  // ---- D. 静态守护：评分方向与页面接线 ----
  await testCase('D1 score-picker 标签使用 name（可编辑「X 的得分」/ 只读「X 给你打的分」）', () => {
    const w = fs.readFileSync(path.join(ROOT, 'components/score-picker/score-picker.wxml'), 'utf8')
    assertOk(w.includes("name + '给你打的分'"), '只读标签未接 name')
    assertOk(w.includes("name + '的得分'"), '可编辑标签未接 name')
    const js = fs.readFileSync(path.join(ROOT, 'components/score-picker/score-picker.js'), 'utf8')
    assertOk(js.includes("name: { type: String, value: 'TA' }"), 'score-picker 未定义 name 属性')
  })
  await testCase('D2 记录页「给 X 打几分」+ 首页「X 的得分」接线', () => {
    const rw = fs.readFileSync(path.join(ROOT, 'pages/record/record.wxml'), 'utf8')
    assertOk(rw.includes('给{{partnerName}}打几分'), '记录页评分标题未用称呼')
    assertOk(rw.includes('name="{{partnerName}}"'), '记录页 score-picker 未传 name')
    const hw = fs.readFileSync(path.join(ROOT, 'pages/home/home.wxml'), 'utf8')
    assertOk(hw.includes('{{partnerName}}的得分'), '首页得分标签未用称呼')
  })
  await testCase('D3 我们页留言署名 + 称呼入口（评分展示已移至首页）', () => {
    const ow = fs.readFileSync(path.join(ROOT, 'pages/ours/ours.wxml'), 'utf8')
    assertOk(ow.includes("item.mine ? '我' : myPartnerName"), '留言署名未用称呼')
    assertOk(ow.includes('给 TA 的称呼'), '缺称呼入口')
    // 评分展示已从「我们」页移除（与首页重复），首页必须保留且用称呼
    assertOk(ow.indexOf('score-picker') === -1, '我们页不应再出现评分组件')
    const hw = fs.readFileSync(path.join(ROOT, 'pages/home/home.wxml'), 'utf8')
    assertOk(hw.includes('{{partnerName}}的得分'), '首页得分标签未用称呼')
    assertOk(hw.includes('TA 今天给你的评分'), '首页陪伴方评分标签缺失')
  })

  console.log('\n=== 结果: ' + passed + ' PASS / ' + failed + ' FAIL ===')
  if (failures.length) {
    failures.forEach(f => console.log('  - ' + f))
    process.exit(1)
  }
  console.log('Partner Name: ALL GREEN')
}

runAll().catch(e => { console.error(e); process.exit(1) })
