// ============================================================
// tests/cross-couple-leak.test.js · P0 跨情侣隐私隔离（第二轮 · 端到端）
//
// 场景：A(her) + B(him) 绑定 → 解绑 → A + C(him) 重新绑定
// 目标：验证 C（以及任何人）都无法通过**任何一条数据通路**拿到 A-B 期间的私人内容：
//   ① 心愿（wishes）
//   ② 每日记录里的 partner 可见字段（score / partnerSummary）
//   ③ AI 小结（daily 伴侣版 / weekly 周报）
//   ④ 记录页的草稿与云端记录回填
//   ⑤ 通知（订阅消息）
//
// 同时验证：正常情侣的创建 / 读取 / 编辑 / 评分 / 通知 不受影响。
//
// 运行：node tests/cross-couple-leak.test.js
// ============================================================
const Module = require('module')
const path = require('path')
const fs = require('fs')
const { MockDB } = require('./mock-db')

const ROOT = path.resolve(__dirname, '..')
const RECORD_PAGE = path.join(ROOT, 'pages/record/record.js')

let passed = 0, failed = 0, failures = []

function testCase(name, fn) {
  return Promise.resolve().then(fn).then(() => { passed++; console.log('  PASS  ' + name) })
    .catch(e => { failed++; failures.push(name + ': ' + e.message); console.log('  FAIL  ' + name + '  -> ' + e.message) })
}
function assertEq(a, b, msg) { if (a !== b) throw new Error((msg || '') + ' 期望 ' + JSON.stringify(b) + ' 实际 ' + JSON.stringify(a)) }
function assertOk(v, msg) { if (!v) throw new Error(msg || '断言失败') }
function assertNo(text, needle, msg) {
  if (String(text).includes(needle)) throw new Error((msg || '') + ' 出现了不该出现的内容: ' + needle)
}

// ---------------- mock sdk ----------------
let OPENID = 'A'
let pushSpy = []
function loadFn(name, db) {
  const origLoad = Module._load
  Module._load = function (request) {
    if (request === 'wx-server-sdk') {
      return {
        DYNAMIC_CURRENT_ENV: 'test', init() {}, database: () => db,
        getWXContext: () => ({ OPENID }),
        openapi: {
          subscribeMessage: {
            send: async (args) => { pushSpy.push(args); return { errCode: 0 } }
          }
        }
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
function loadAi(db) {
  const mod = loadFn('aiSummary', db)
  mod.__setTransport(async (messages) => 'AI文本：' + messages[0].content.slice(0, 8))
  return mod
}

// ---------------- 场景夹具 ----------------
const D_AB = '2026-10-01'   // A-B 期间的记录日
const D_AC = '2026-10-18'   // A-C 期间的记录日

function seedAb() {
  return new MockDB({
    users: [
      { _id: 'u_a', _openid: 'A', role: 'her', coupleId: 'CZ-1', schemaVersion: 2 },
      { _id: 'u_b', _openid: 'B', role: 'him', coupleId: 'CZ-1', schemaVersion: 2 },
      { _id: 'u_c', _openid: 'C', role: 'him', coupleId: null, schemaVersion: 2 }
    ],
    couples: [{ _id: 'c1', coupleId: 'CZ-1', herOpenid: 'A', himOpenid: 'B', status: 'active', boundAt: 1000 }],
    daily_records: [
      // A-B 期间的一天：带关系标记
      {
        _id: 'r_ab', _openid: 'A', coupleId: 'CZ-1', date: D_AB, revision: 2, score: 5,
        goals: [{ text: '和B去看海', done: true }], todos: [{ text: '买B爱吃的', done: true }],
        segments: { life: '和 B 在一起的一天', work: '', growth: '' },
        wishes: [{ type: 'eat', text: '和B吃火锅' }, { type: 'do', text: '和B去看海' }],
        partnerSummary: 'TA 今天和你吃了火锅（旧关系文本）', partnerSummaryAt: 2000,
        herSummary: '你和 B 的一天（本人私有）', herSummaryAt: 2000
      },
      // A-B 期间的另一天：coupleId 字段还没上线的历史记录
      {
        _id: 'r_ab_legacy', _openid: 'A', date: '2026-10-02', revision: 1, score: 4,
        wishes: [{ type: 'eat', text: '历史心愿：烤肉' }],
        partnerSummary: '历史伙伴小结（旧关系文本）', partnerSummaryAt: 2000
      }
    ],
    wishes: [
      { _id: 'w_ab_eat', _openid: 'A', coupleId: 'CZ-1', type: 'eat', text: '和B吃火锅', status: 'pending', createdAt: 2000 },
      { _id: 'w_ab_done', _openid: 'A', coupleId: 'CZ-1', type: 'do', text: '和B去看海', status: 'done_by_partner', createdAt: 2100, arrangedAt: 2200 },
      // 历史文档（无 coupleId）：上一段关系期间写入，也可能是伪造时间
      { _id: 'w_legacy', _openid: 'A', type: 'eat', text: '历史心愿：烤肉', status: 'pending', createdAt: 900 },
      { _id: 'w_legacy_future', _openid: 'A', type: 'do', text: '时间被伪造的心愿', status: 'pending', createdAt: Number.MAX_SAFE_INTEGER }
    ],
    messages: [], menstrual: [], weekly_reports: []
  })
}

// 真实状态机完成换绑：A+B 解绑 → A 生成码 → C 认领 → A 同意
async function rebindToC(db) {
  const bcore = require(path.resolve(__dirname, '../cloudfunctions/bindCouple/core.js'))
  const now = Date.now()
  await bcore.unbind({ db, openid: 'A', now })
  const g = await bcore.generate({ db, herOpenid: 'A', now: now + 1 })
  await bcore.claim({ db, code: g.bindCode, himOpenid: 'C', now: now + 2 })
  const r = await bcore.confirm({ db, herOpenid: 'A', requestId: g.requestId, accept: true, now: now + 3 })
  assertOk(r.ok, '换绑应成功')
  const active = db.dump().couples.filter(c => c.status === 'active')
  assertEq(active.length, 1, '同一时刻只应有一段 active（A-C）')
  assertEq(active[0].coupleId, g.coupleId)
  return { coupleId: g.coupleId, boundAt: active[0].boundAt }
}

function wishes(db) { return db.dump().wishes || [] }
function rec(db, id) { return db.dump().daily_records.find(r => r._id === id) }

// ---------------- 页面级真实执行（记录页回填） ----------------
function loadRecordPage(opts) {
  const o = opts || {}
  const store = new Map()
  for (const k of Object.keys(o.storage || {})) store.set(k, o.storage[k])
  const calls = []
  const toasts = []
  const realRequire = Module.prototype.require
  global.wx = {
    cloud: {
      callFunction: (args) => {
        calls.push(args)
        const handler = (o.responses || {})[args.data.action]
        if (!handler) return Promise.reject(new Error('no handler'))
        return Promise.resolve({ result: handler(args.data) })
      }
    },
    getStorageSync: (k) => (store.has(k) ? store.get(k) : ''),
    setStorageSync: (k, v) => { store.set(k, v) },
    removeStorageSync: (k) => { store.delete(k) },
    showToast: (obj) => { toasts.push(obj && obj.title) },
    showModal: () => {},
    requestSubscribeMessage: () => {}
  }
  // P2.1 起页面按角色/绑定决定视图：身份未确认时是 pending（不渲染、不读个人记录）。
  // 这里模拟真实登录返回（login 会带 role + coupleId），否则页面停在 pending 是正确行为，
  // 而不是下面这些「同关系/异关系回填」用例要测的目标。
  global.getApp = () => ({
    whenReady: (cb) => cb({ openid: 'A', role: 'her', coupleId: 'CZ-1' }),
    globalData: { openid: 'A', role: 'her', coupleId: 'CZ-1', partnerName: '' }
  })
  let cfg = null
  global.Page = (c) => { cfg = c }
  delete require.cache[RECORD_PAGE]
  require(RECORD_PAGE)
  const page = Object.assign({}, cfg)
  page.data = JSON.parse(JSON.stringify(cfg.data))
  page.setData = function (patch, cb) {
    for (const key of Object.keys(patch || {})) {
      if (key.indexOf('.') === -1) { page.data[key] = patch[key]; continue }
      const parts = key.split('.')
      let cur = page.data
      for (let i = 0; i < parts.length - 1; i++) cur = cur[parts[i]] = cur[parts[i]] || {}
      cur[parts[parts.length - 1]] = patch[key]
    }
    if (cb) cb()
  }
  void realRequire
  const harness = {
    page, store, calls, toasts,
    // 真实执行顺序：onLoad（注入 openid 与关系缓存）→ 再切到指定日期
    async open(date) {
      page.onLoad()
      await flush()
      if (date) {
        page.loadDay(date)
        await flush()
      }
      return harness
    }
  }
  return harness
}
function flush() { return new Promise(r => setTimeout(r, 0)) }

// ==================== S · 正常情侣功能不受影响 ====================
async function runHealthy() {
  console.log('\n=== S · 正常情侣（A+B 绑定期间）功能基线 ===\n')

  await testCase('S1 新记录创建时写入服务端推导的 coupleId，心愿按同一关系写入', async () => {
    const db = seedAb()
    const daily = loadFn('dailyRecord', db)
    OPENID = 'A'
    const r = await daily.main({
      action: 'save', date: D_AC, requestId: 'req-ac-1', revision: 0,
      goals: [], todos: [], segments: { life: '', work: '', growth: '' },
      mood: { type: 'calm', weather: 'sunny' }, score: 5,
      wishes: [{ type: 'eat', text: '和B吃寿司' }], readProgress: 0
    })
    assertOk(r.ok, JSON.stringify(r))
    assertEq(r.wishSyncSkipped, null, '正常路径不应被闸门拦截')
    const newRec = db.dump().daily_records.find(r => r.date === D_AC)
    assertEq(newRec.coupleId, 'CZ-1', '记录必须带关系标记')
    const w = wishes(db).find(x => x.text === '和B吃寿司')
    assertOk(w, '心愿应创建')
    assertEq(w.coupleId, 'CZ-1')
  })

  await testCase('S2 B 能看到 A 的心愿 / 评分 / 伙伴小结（同关系正常读取）', async () => {
    const db = seedAb()
    const pv = loadFn('getPartnerView', db)
    OPENID = 'B'
    const r = await pv.main({ date: D_AB })
    assertOk(r.ok, JSON.stringify(r))
    assertEq(r.wishes.length, 2, '当前关系的两条心愿都应可见: ' + JSON.stringify(r.wishes))
    assertEq(r.score, 5, '同关系记录可共享评分')
    assertEq(r.partnerSummary, 'TA 今天和你吃了火锅（旧关系文本）')
    assertNo(JSON.stringify(r), '和 B 在一起的一天', '日记正文')
    assertNo(JSON.stringify(r), '买B爱吃的', 'todo 正文')
    OPENID = 'A'
  })

  await testCase('S3 B 可以 mark 当前关系的心愿，且通知只发一次', async () => {
    const db = seedAb()
    pushSpy = []
    const old = process.env.TPL_ARRANGE
    process.env.TPL_ARRANGE = 'TPL_TEST_ARRANGE'
    const pv = loadFn('getPartnerView', db)
    OPENID = 'B'
    const r1 = await pv.main({ action: 'mark', wishId: 'w_ab_eat' })
    const r2 = await pv.main({ action: 'mark', wishId: 'w_ab_eat' })
    if (old === undefined) delete process.env.TPL_ARRANGE; else process.env.TPL_ARRANGE = old
    assertOk(r1.ok, JSON.stringify(r1))
    assertEq(rec(db, 'r_ab') !== null, true)
    assertEq(wishes(db).find(w => w._id === 'w_ab_eat').status, 'done_by_partner')
    assertEq(r2.already, true, '第二次必须幂等')
    assertEq(pushSpy.length, 1, '只发一次通知')
    assertEq(pushSpy[0].touser, 'A', '通知必须发给心愿属主')
    OPENID = 'A'
  })

  await testCase('S4 A 自己也能看到自己的今日得分与心愿列表', async () => {
    const db = seedAb()
    const pv = loadFn('getPartnerView', db)
    OPENID = 'A'
    const r = await pv.main({ date: D_AB })
    assertOk(r.ok)
    assertEq(r.score, 5)
    assertEq(r.wishes.length, 2)
    OPENID = 'A'
  })
}

// ==================== L · 换绑之后的泄露路径 ====================
async function runLeak() {
  console.log('\n=== L · A-B 解绑 → A-C 重新绑定：所有泄露通路 ===\n')

  await testCase('L1 C 读不到 A-B 期间的心愿（含 done_by_partner）', async () => {
    const db = seedAb()
    await rebindToC(db)
    const pv = loadFn('getPartnerView', db)
    OPENID = 'C'
    const r = await pv.main({})
    assertOk(r.ok, JSON.stringify(r))
    assertEq(r.wishes.length, 0, '不得看到任何 A-B 心愿: ' + JSON.stringify(r.wishes))
    const s = JSON.stringify(r)
    assertNo(s, '和B吃火锅', 'A-B 心愿文本')
    assertNo(s, '和B去看海', 'A-B 已安排心愿文本')
    assertNo(s, '历史心愿：烤肉', '无 coupleId 的历史心愿')
    assertNo(s, '时间被伪造的心愿', '时间伪造的历史心愿')
    OPENID = 'A'
  })

  await testCase('L2 C 不能把 A-B 心愿标记为已安排（库内零改动）', async () => {
    const db = seedAb()
    await rebindToC(db)
    const before = JSON.stringify(wishes(db))
    const pv = loadFn('getPartnerView', db)
    OPENID = 'C'
    for (const id of ['w_ab_eat', 'w_ab_done', 'w_legacy', 'w_legacy_future']) {
      const r = await pv.main({ action: 'mark', wishId: id })
      assertEq(r.ok, false, id + ' 必须被拒绝')
      assertEq(r.code, 'FORBIDDEN')
    }
    assertEq(JSON.stringify(wishes(db)), before, '被拒绝的请求不得改动任何心愿文档')
    OPENID = 'A'
  })

  await testCase('L3 旧伴侣 B 已失权：读不到 C 与 A 的任何内容', async () => {
    const db = seedAb()
    await rebindToC(db)
    const pv = loadFn('getPartnerView', db)
    OPENID = 'B'
    const r = await pv.main({})
    assertEq(r.code, 'NOT_ACTIVE')
    assertNo(JSON.stringify(r), '火锅')
    assertNo(JSON.stringify(r), '心愿')
    OPENID = 'A'
  })

  await testCase('L4 本人 A 在新关系里也看不到 A-B 心愿（严格策略，数据仍在库里）', async () => {
    const db = seedAb()
    await rebindToC(db)
    const pv = loadFn('getPartnerView', db)
    OPENID = 'A'
    const r = await pv.main({})
    assertOk(r.ok)
    assertEq(r.wishes.length, 0, '本人同样不展示无法归属的心愿')
    assertEq(wishes(db).length, 4, '4 条心愿一条都不能少')
    OPENID = 'A'
  })

  await testCase('L5 C 读到 A-B 那天的记录时，score / partnerSummary 一律为空', async () => {
    const db = seedAb()
    await rebindToC(db)
    const pv = loadFn('getPartnerView', db)
    OPENID = 'C'
    for (const d of [D_AB, '2026-10-02']) {
      const r = await pv.main({ date: d })
      assertOk(r.ok, JSON.stringify(r))
      assertEq(r.score, null, d + ' 的评分不应透出')
      assertEq(r.partnerSummary, '', d + ' 的伙伴小结不应透出')
      assertNo(JSON.stringify(r), '旧关系文本', d + ' 的旧小结文本')
    }
    OPENID = 'A'
  })

  await testCase('L6 C 无法通过 AI 周报读到 A-B 内容（统计范围已按关系收窄）', async () => {
    const db = seedAb()
    const { boundAt } = await rebindToC(db)
    // A-C 期间写一天记录，确保周报不是空的
    const daily = loadFn('dailyRecord', db)
    OPENID = 'A'
    await daily.main({
      action: 'save', date: D_AC, requestId: 'req-l6', revision: 0,
      goals: [{ text: '新关系目标', done: true }], todos: [], segments: { life: '', work: '', growth: '' },
      mood: { type: 'calm', weather: 'sunny' }, score: 3,
      wishes: [{ type: 'eat', text: '和C吃面' }], readProgress: 0
    })
    const ai = loadAi(db)
    OPENID = 'C'
    const r = await ai.main({ action: 'weekly', startDate: '2026-09-25', endDate: '2026-10-18' })
    assertOk(r.ok, JSON.stringify(r))
    const s = JSON.stringify(r.report)
    assertNo(s, '火锅', 'A-B 心愿')
    assertNo(s, '看海', 'A-B 心愿')
    assertNo(s, '烤肉', '历史心愿')
    assertOk(s.includes('和C吃面') || !s.includes('许过心愿'), '当前关系的心愿可以出现: ' + s)
    const saved = db.dump().weekly_reports
    assertEq(saved.length, 1)
    assertNo(JSON.stringify(saved), '火锅')
    assertOk(boundAt > 0)
    OPENID = 'A'
  })

  await testCase('L7 关系缺 boundAt（旧数据）时，仍靠 coupleId 等值过滤挡住旧记录', async () => {
    const db = seedAb()
    // 手工构造：A 当前在 CZ-2，但该 couple 没有 boundAt（字段上线前建立）
    db._data.users.find(u => u._openid === 'A').coupleId = 'CZ-2'
    db._data.users.find(u => u._openid === 'C').coupleId = 'CZ-2'
    db._data.couples = [{ _id: 'c2', coupleId: 'CZ-2', herOpenid: 'A', himOpenid: 'C', status: 'active' }]
    const ai = loadAi(db)
    OPENID = 'C'
    const r = await ai.main({ action: 'weekly', startDate: '2026-09-25', endDate: '2026-10-18' })
    assertOk(r.ok)
    const s = JSON.stringify(r.report)
    assertNo(s, '火锅', '无 boundAt 时不得回落到时间推断')
    assertNo(s, '烤肉', '历史心愿不得进入周报')
    assertEq(r.report.herReport.includes('记录了 0 天'), true, '无归属记录 → 空周报: ' + r.report.herReport)
    OPENID = 'A'
  })

  await testCase('L8 AI 伴侣小结不会为「不属于当前关系」的记录生成', async () => {
    const db = seedAb()
    await rebindToC(db)
    // 抹掉 A-B 期间已经生成的 partnerSummary，验证「生成侧」也不会产出
    const target = db._data.daily_records.find(x => x._id === 'r_ab')
    delete target.partnerSummary
    delete target.partnerSummaryAt
    const ai = loadAi(db)
    OPENID = undefined // 模拟定时器/控制台后台批量触发（无 OPENID）
    const r = await ai.main({ action: 'cron', date: D_AB })
    OPENID = 'A'
    assertOk(r.ok, JSON.stringify(r))
    const after = rec(db, 'r_ab')
    assertEq(after.partnerSummaryAt, undefined, '不得为跨关系记录生成伴侣小结')
    assertEq(after.partnerSummary, undefined)
    assertOk(after.herSummaryAt, '本人私有的 herSummary 不受影响')
  })

  await testCase('L9 A 在 A-C 关系里重新许愿 → 新文档归 CZ-2，C 能看到；A-B 文档零改动', async () => {
    const db = seedAb()
    const { coupleId } = await rebindToC(db)
    const before = wishes(db).filter(w => w.coupleId === 'CZ-1')
    const daily = loadFn('dailyRecord', db)
    OPENID = 'A'
    const r = await daily.main({
      action: 'save', date: D_AC, requestId: 'req-l9', revision: 0,
      goals: [], todos: [], segments: { life: '', work: '', growth: '' },
      mood: { type: 'calm', weather: 'sunny' }, score: 4,
      // 故意重复 A-B 关系里出现过的文本：新关系里应视为全新心愿
      wishes: [{ type: 'eat', text: '和B吃火锅' }], readProgress: 0
    })
    assertOk(r.ok)
    const created = wishes(db).filter(w => w.coupleId === coupleId)
    assertEq(created.length, 1, '应在新关系下新建一条')
    assertEq(created[0].text, '和B吃火锅')
    assertEq(JSON.stringify(wishes(db).filter(w => w.coupleId === 'CZ-1')), JSON.stringify(before), 'A-B 文档不得被改动')
    const pv = loadFn('getPartnerView', db)
    OPENID = 'C'
    const view = await pv.main({})
    assertEq(view.wishes.length, 1, 'C 只看到新关系的心愿')
    assertEq(view.wishes[0]._id, created[0]._id)
    OPENID = 'A'
  })

  await testCase('L10 A 用 A-B 那天的记录保存心愿 → 服务端拒绝同步（wishSyncSkipped）', async () => {
    const db = seedAb()
    await rebindToC(db)
    const before = wishes(db).length
    const daily = loadFn('dailyRecord', db)
    OPENID = 'A'
    const r = await daily.main({
      action: 'save', date: D_AB, requestId: 'req-l10', revision: 2,
      goals: [], todos: [], segments: { life: '', work: '', growth: '' },
      mood: { type: 'calm', weather: 'sunny' }, score: 5,
      wishes: [{ type: 'eat', text: '回填进来的旧心愿' }], readProgress: 0
    })
    assertOk(r.ok, '记录本身可以保存（自己的日记）')
    assertEq(r.wishSyncSkipped, 'record-not-in-couple')
    assertEq(wishes(db).length, before, '不得向新关系产愿')
    assertEq(rec(db, 'r_ab').coupleId, 'CZ-1', '记录归属不得被改写')
  })

  await testCase('L11 A 保存 A-B 那天记录时不会通知 C（无新心愿 = 无推送）', async () => {
    const db = seedAb()
    await rebindToC(db)
    pushSpy = []
    const daily = loadFn('dailyRecord', db)
    OPENID = 'A'
    await daily.main({
      action: 'save', date: D_AB, requestId: 'req-l11', revision: 2,
      goals: [], todos: [], segments: { life: '', work: '', growth: '' },
      mood: { type: 'calm', weather: 'sunny' }, score: 5,
      wishes: [{ type: 'eat', text: '旧关系的心愿' }], readProgress: 0
    })
    assertEq(pushSpy.length, 0, '不得向 C 推送任何消息')
    OPENID = 'A'
  })

  await testCase('L12 关系记录整体缺失（旧 couple 文档被删）时，历史文档仍不展示', async () => {
    const db = seedAb()
    await rebindToC(db)
    // 模拟「历史关系记录缺失」：把 A-B 的 couple 文档删掉
    db._data.couples = db._data.couples.filter(c => c.coupleId !== 'CZ-1')
    const pv = loadFn('getPartnerView', db)
    OPENID = 'A'
    const rA = await pv.main({})
    assertEq(rA.wishes.length, 0, '缺历史也不能把无标记文档当成当前关系')
    OPENID = 'C'
    const rC = await pv.main({})
    assertEq(rC.wishes.length, 0)
    assertNo(JSON.stringify(rC), '烤肉')
    OPENID = 'A'
  })

  await testCase('L13 伪造参数无法越权（coupleId / role / openid / 任意 date）', async () => {
    const db = seedAb()
    await rebindToC(db)
    const before = JSON.stringify(wishes(db))
    const pv = loadFn('getPartnerView', db)
    OPENID = 'C'
    const forged = await pv.main({
      action: 'mark', wishId: 'w_ab_eat',
      coupleId: 'CZ-1', role: 'her', openid: 'A', _openid: 'A', fromOpenid: 'A'
    })
    assertEq(forged.ok, false)
    const view = await pv.main({ coupleId: 'CZ-1', role: 'her', date: D_AB, openid: 'A', _openid: 'A' })
    assertEq(view.wishes.length, 0, '伪造 coupleId 不得改变查询范围')
    assertEq(view.score, null, '伪造身份不得读到 A-B 记录的评分')
    assertNo(JSON.stringify(view), '旧关系文本')
    assertEq(JSON.stringify(wishes(db)), before)
    OPENID = 'A'
  })

  await testCase('L14 并发读取 + 重复 mark 不发生越权（B 失权、C 只看到本关系）', async () => {
    const db = seedAb()
    await rebindToC(db)
    const pv = loadFn('getPartnerView', db)
    const viewAs = (who) => { OPENID = who; return pv.main({ date: D_AB }) }
    const [rb1, rb2, rc1, rc2] = await Promise.all([viewAs('B'), viewAs('B'), viewAs('C'), viewAs('C')])
    for (const r of [rb1, rb2]) assertEq(r.code, 'NOT_ACTIVE')
    for (const r of [rc1, rc2]) {
      assertEq(r.wishes.length, 0)
      assertEq(r.score, null)
    }
    const before = JSON.stringify(wishes(db))
    OPENID = 'C'
    const [m1, m2] = await Promise.all([
      pv.main({ action: 'mark', wishId: 'w_ab_eat' }),
      pv.main({ action: 'mark', wishId: 'w_ab_eat' })
    ])
    assertEq(m1.ok || m2.ok, false, '并发也不得越权成功')
    assertEq(JSON.stringify(wishes(db)), before)
    OPENID = 'A'
  })

  await testCase('L16 users.coupleId 指向「与自己无关」的 active 关系 → 一律失权', async () => {
    // 脏数据场景：换绑中断 / 人工改库，users.coupleId 指向别人那段关系。
    const db = seedAb()
    db._data.users.find(u => u._openid === 'C').coupleId = 'CZ-1' // C 并不在这段关系里
    const pv = loadFn('getPartnerView', db)
    OPENID = 'C'
    const r = await pv.main({})
    assertEq(r.code, 'NOT_ACTIVE', '不得凭 coupleId 等值就越权')
    assertNo(JSON.stringify(r), '火锅')
    const daily = loadFn('dailyRecord', db)
    const get = await daily.main({ action: 'get', date: D_AB })
    assertEq(get.coupleId, null, '脏 coupleId 不得作为写入归属的依据')
    OPENID = 'A'
  })

  await testCase('L17 日历阅读标记不带出 A-B 期间的阅读痕迹（经期区间算法不变）', async () => {
    const db = seedAb()
    // A 的经期记录 + A-B 期间某天读过书（readProgress > 0）
    // sharePeriod: true —— A 授权新伴侣 C 查看经期（否则经期标记也会被授权闸门隐藏）
    db._data.menstrual = [{ _id: 'm_a', _openid: 'A', lastStart: '2026-10-03', cycle: 28, periodLen: 5, sharePeriod: true }]
    const { coupleId } = await rebindToC(db)
    const men = loadFn('menstrual', db)
    OPENID = 'C'
    // A-B 期间（2026-10-01，coupleId=CZ-1）：不得出现 read 标记
    const r1 = await men.main({ action: 'month', year: 2026, month: 10 })
    assertOk(r1.ok, JSON.stringify(r1))
    const day1 = r1.days.find(d => d.date === '2026-10-01')
    assertEq(day1.read, undefined, 'A-B 期间的阅读痕迹不得展示给 C')
    // 经期区间仍然要按原算法画出（未改动）
    assertEq(r1.days.find(d => d.date === '2026-10-03').type, 'period')
    assertEq(r1.days.find(d => d.date === '2026-10-07').type, 'period')
    // A-C 期间的记录（CZ-2）→ 正常显示
    db._data.daily_records.push({ _id: 'r_ac', _openid: 'A', coupleId, date: '2026-10-05', readProgress: 30 })
    const r2 = await men.main({ action: 'month', year: 2026, month: 10 })
    assertEq(r2.days.find(d => d.date === '2026-10-05').read, true, '当前关系的阅读标记应正常显示')
    assertEq(r2.days.find(d => d.date === '2026-10-01').read, undefined)
    OPENID = 'A'
  })
}

// ==================== R · 记录页回填（真实执行 pages/record） ====================
async function runRecordPage() {
  console.log('\n=== R · 记录页回填（跨关系不得带回旧心愿） ===\n')

  const recordWithWishes = (coupleId) => ({
    _id: 'r1', _openid: 'A', date: D_AC, revision: 1,
    goals: [{ text: '目标X', done: false }], todos: [], segments: { life: '日记', work: '', growth: '' },
    mood: { type: 'calm', weather: 'sunny' }, score: 3,
    wishes: [{ type: 'eat', text: '旧关系的火锅' }, { type: 'do', text: '旧关系的看海' }],
    coupleId
  })

  await testCase('R1 云端记录属于当前关系 → 心愿正常回填', async () => {
    const h = loadRecordPage({
      storage: { ['draft_A_' + D_AC]: '' },
      responses: { get: () => ({ ok: true, coupleId: 'CZ-2', record: recordWithWishes('CZ-2') }) }
    })
    await h.open(D_AC)
    assertEq(h.page.data.eats.length, 1, '同关系应回填: ' + JSON.stringify(h.page.data.eats))
    assertEq(h.page.data.dos.length, 1)
    assertEq(h.page.data.goals[0].text, '目标X')
    assertEq(h.page._coupleId, 'CZ-2', '页面必须记住服务端判定的当前关系')
  })

  await testCase('R2 云端记录属于上一段关系 → 心愿不回填，其余字段照常恢复', async () => {
    const h = loadRecordPage({
      storage: { ['draft_A_' + D_AC]: '' },
      responses: { get: () => ({ ok: true, coupleId: 'CZ-2', record: recordWithWishes('CZ-1') }) }
    })
    await h.open(D_AC)
    assertEq(h.page.data.eats.length, 0, '不得回填旧关系心愿')
    assertEq(h.page.data.dos.length, 0)
    assertEq(h.page.data.goals[0].text, '目标X', '其余字段不受影响')
    assertEq(h.page.data.score, 3)
  })

  await testCase('R3 历史记录（无 coupleId）→ 心愿不回填（无法证明归属）', async () => {
    const rec1 = recordWithWishes(undefined)
    delete rec1.coupleId
    const h = loadRecordPage({
      storage: { ['draft_A_' + D_AC]: '' },
      responses: { get: () => ({ ok: true, coupleId: 'CZ-2', record: rec1 }) }
    })
    await h.open(D_AC)
    assertEq(h.page.data.eats.length, 0)
    assertEq(h.page.data.goals[0].text, '目标X')
  })

  await testCase('R4 本地草稿属于当前关系 → 正常恢复（含心愿）', async () => {
    const h = loadRecordPage({
      storage: {
        ['draft_A_' + D_AC]: { t: 1, cid: 'CZ-2', eats: ['草稿火锅'], dos: [], goals: [], todos: [], segments: {}, mood: {}, score: 2 }
      },
      responses: { get: () => ({ ok: true, coupleId: 'CZ-2', record: null }) }
    })
    await h.open(D_AC)
    assertEq(h.page.data.eats[0], '草稿火锅', '同关系草稿必须能恢复')
    assertOk(h.toasts.includes('发现未保存的内容，已恢复'))
  })

  await testCase('R5 本地草稿属于上一段关系 → 心愿被丢弃，其余字段保留', async () => {
    const h = loadRecordPage({
      storage: {
        ['draft_A_' + D_AC]: {
          t: 1, cid: 'CZ-1', eats: ['旧火锅'], dos: ['旧看海'],
          goals: [{ text: '草稿目标', done: true }], todos: [{ text: '草稿小事', done: false }],
          segments: { life: '草稿日记', work: '', growth: '' }, mood: { type: 'low', weather: 'rain' }, score: 1
        }
      },
      responses: { get: () => ({ ok: true, coupleId: 'CZ-2', record: null }) }
    })
    await h.open(D_AC)
    assertEq(h.page.data.eats.length, 0, '旧关系草稿心愿不得回填')
    assertEq(h.page.data.dos.length, 0)
    assertEq(h.page.data.goals[0].text, '草稿目标')
    assertEq(h.page.data.todos[0].text, '草稿小事')
    assertEq(h.page.data.segments.life, '草稿日记')
  })

  await testCase('R6 草稿没有 cid（旧版草稿）→ 心愿不回填（fail-closed）', async () => {
    const h = loadRecordPage({
      storage: {
        ['draft_A_' + D_AC]: { t: 1, eats: ['无归属草稿'], dos: [], goals: [], todos: [], segments: {}, mood: {}, score: 0 }
      },
      responses: { get: () => ({ ok: true, coupleId: 'CZ-2', record: null }) }
    })
    await h.open(D_AC)
    assertEq(h.page.data.eats.length, 0)
  })

  await testCase('R7 断网：用缓存的关系 id 判定草稿（同关系可恢复 / 异关系丢弃）', async () => {
    const same = loadRecordPage({
      // 云端不可达 → get 分支抛错
      responses: {},
      storage: {
        ['couple_A']: 'CZ-2',
        ['draft_A_' + D_AC]: { t: 1, cid: 'CZ-2', eats: ['离线火锅'], dos: [], goals: [], todos: [], segments: {}, mood: {}, score: 0 }
      }
    })
    await same.open(D_AC)
    assertEq(same.page.data.eats[0], '离线火锅', '同关系离线草稿应恢复')

    const diff = loadRecordPage({
      responses: {},
      storage: {
        ['couple_A']: 'CZ-2',
        ['draft_A_' + D_AC]: { t: 1, cid: 'CZ-1', eats: ['旧关系火锅'], dos: [], goals: [], todos: [], segments: {}, mood: {}, score: 0 }
      }
    })
    await diff.open(D_AC)
    assertEq(diff.page.data.eats.length, 0, '异关系离线草稿不得回填心愿')
  })

  await testCase('R8 编辑后写草稿会带上当前关系 id（供下次判定）', async () => {
    const h = loadRecordPage({
      storage: { ['draft_A_' + D_AC]: '' },
      responses: { get: () => ({ ok: true, coupleId: 'CZ-2', record: null }) }
    })
    await h.open(D_AC)
    h.page.addEatByButton ? null : null
    h.page.setData({ eatInput: '新心愿' })
    h.page.addEatByButton()
    const draft = h.store.get('draft_A_' + D_AC)
    assertOk(draft && draft.cid === 'CZ-2', '草稿必须记录关系 id: ' + JSON.stringify(draft))
  })
}

async function main() {
  try {
    await runHealthy()
    await runLeak()
    await runRecordPage()
  } catch (e) {
    failed++
    failures.push('fatal: ' + (e && e.stack || e))
    console.log('  FATAL ' + (e && e.message))
  }
  console.log('\n=== 结果: ' + passed + ' PASS / ' + failed + ' FAIL ===')
  if (failed) {
    console.log('\n失败用例:')
    for (const f of failures) console.log('  - ' + f)
    process.exit(1)
  }
  console.log('Cross Couple Leak: ALL GREEN')
}

main()
