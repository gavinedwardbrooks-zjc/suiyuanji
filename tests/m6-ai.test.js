// ============================================================
// tests/m6-ai.test.js · M6 AI 能力升级测试（PRD v0.8 / 指令 §13-14）
// A. 隐私 payload 白名单（mock Provider）
// B. 小结双版本（幂等/fallback/经期提醒）
// C. 周报双版本（幂等）
// D. 画像升级 / fail-closed
// 运行：node tests/m6-ai.test.js
// ============================================================
const Module = require('module')
const path = require('path')
const { MockDB } = require('./mock-db')

const ROOT = path.resolve(__dirname, '..')
let passed = 0, failed = 0, failures = []

function check(name, cond, detail) {
  if (cond) { passed++; console.log('  PASS  ' + name) }
  else { failed++; failures.push(name + (detail ? ' -> ' + detail : '')); console.log('  FAIL  ' + name + (detail ? ' -> ' + detail : '')) }
}
function testCase(name, fn) {
  return Promise.resolve().then(fn).then(() => { passed++; console.log('  PASS  ' + name) })
    .catch(e => { failed++; failures.push(name + ': ' + e.message); console.log('  FAIL  ' + name + '  -> ' + e.message) })
}
function assertEq(a, b, msg) { if (a !== b) throw new Error((msg || '') + ' 期望 ' + JSON.stringify(b) + ' 实际 ' + JSON.stringify(a)) }
function assertOk(v, msg) { if (!v) throw new Error(msg || '断言失败') }

// mock sdk + transport
let OPENID = 'A'
let aiCalls = [] // { messages } 记录每次 AI 调用
function loadAi(db) {
  const origLoad = Module._load
  Module._load = function (request, parent, isMain) {
    if (request === 'wx-server-sdk') {
      return { DYNAMIC_CURRENT_ENV: 'test', init() {}, database: () => db, getWXContext: () => ({ OPENID }) }
    }
    return origLoad.apply(this, arguments)
  }
  const fnPath = path.resolve(__dirname, '../cloudfunctions/aiSummary/index.js')
  delete require.cache[fnPath]
  const mod = require(fnPath)
  Module._load = origLoad
  aiCalls = []
  mod.__setTransport(async (messages) => {
    aiCalls.push({ messages })
    return 'AI 生成的内容：' + messages[0].content.slice(0, 12)
  })
  return mod
}

function seed(extra) {
  return new MockDB(Object.assign({
    users: [
      { _id: 'u_a', _openid: 'A', role: 'her', coupleId: 'CZ-1', schemaVersion: 2 },
      { _id: 'u_b', _openid: 'B', role: 'him', coupleId: 'CZ-1', schemaVersion: 2 },
      { _id: 'u_x', _openid: 'X', role: 'her', coupleId: null, schemaVersion: 2 }
    ],
    couples: [{ _id: 'c1', coupleId: 'CZ-1', herOpenid: 'A', himOpenid: 'B', status: 'active', anniversary: null }],
    daily_records: [], profiles: [], wishes: [], messages: [], menstrual: [], weekly_reports: []
  }, extra))
}
function herRec(over) {
  return Object.assign({
    _id: 'r1', _openid: 'A', coupleId: 'CZ-1', date: '2026-08-27',
    goals: [{ text: '读书', done: true }, { text: '运动', done: true }, { text: '早睡', done: false }],
    todos: [{ text: '买花', done: true }, { text: '扫地', done: false }],
    segments: { life: '和朋友吃了火锅，聊到很晚。', work: '改完了 bug。', growth: '读了几页书。' },
    mood: { type: 'happy', weather: 'sunny' },
    wishes: [{ type: 'eat', text: '螺蛳粉' }],
    score: 5, readProgress: 0, revision: 3
  }, over || {})
}

async function runAll() {
  console.log('\n=== M6-A · 隐私 payload 白名单 ===\n')

  await testCase('A1 partnerPayload 只含白名单键（无 diary/mood/weather/body/summary）', () => {
    const mod = loadAi(new MockDB({}))
    const p = mod.buildPartnerPayload(herRec(), { nextStart: '2026-09-10' })
    const s = JSON.stringify(p)
    for (const bad of ['life', 'work', 'growth', 'mood', 'weather', 'body', 'symptom', 'herSummary', 'diary', 'segments', 'goals']) {
      assertEq(s.includes(bad), false, 'partnerPayload 含禁止键: ' + bad)
    }
    assertOk(p.score === 5)
    assertOk(Array.isArray(p.doneGoals) && p.doneGoals.length === 2)
    assertOk(Array.isArray(p.doneTodos) && p.doneTodos.length === 1)
    assertOk(p.sharedWishes.length === 1)
    assertOk(p.nextLabel.includes('月'), '经期预计以 label 形式共享')
  })

  await testCase('A2 herPayload 可基于 diary（完整数据）', () => {
    const mod = loadAi(new MockDB({}))
    const p = mod.buildHerPayload(herRec(), null, null)
    assertOk(p.segments.life.includes('火锅'), 'her 可见日记')
    assertOk(p.mood.type === 'happy')
    assertOk(p.weather === 'sunny')
  })

  await testCase('A3 mock Provider 断言：partner 请求不含私有字段（计数=0）', async () => {
    const db = seed({ daily_records: [herRec()] })
    const mod = loadAi(db)
    OPENID = 'A'
    await mod.main({ action: 'daily', date: '2026-08-27' })
    assertOk(aiCalls.length >= 1, 'AI 被调用')
    let privateCount = 0
    for (const c of aiCalls) {
      const msg = JSON.stringify(c.messages)
      for (const bad of ['diary', 'life', 'work', 'growth', 'mood', 'weather', 'body', 'symptoms', 'herSummary']) {
        if (msg.includes(bad)) privateCount++
      }
    }
    assertEq(privateCount, 0, 'partner AI 请求私有字段泄露计数应 0（her 请求可含，需按角色判断）')
    // 精确断言：partner prompt 不含 diary/mood（用 partner 独有标记「愿意分享」定位）
    const partnerPrompt = aiCalls.find(c => c.messages[0].content.includes('愿意分享'))
    assertOk(partnerPrompt, '存在 partner prompt')
    const ps = JSON.stringify(partnerPrompt.messages)
    assertEq(ps.includes('生活'), false)
    assertEq(ps.includes('心情'), false)
    assertEq(ps.includes('天气'), false)
  })

  console.log('\n=== M6-B · 小结双版本（幂等/fallback/经期提醒） ===\n')

  await testCase('B1 AI 成功 → 保存 herSummary + partnerSummary', async () => {
    const db = seed({ daily_records: [herRec()] })
    const mod = loadAi(db)
    OPENID = 'A'
    const r = await mod.main({ action: 'daily', date: '2026-08-27' })
    assertOk(r.ok)
    const rec = db.dump().daily_records[0]
    assertOk(rec.herSummary && rec.herSummary.length > 0, 'herSummary 写入')
    assertOk(rec.partnerSummary && rec.partnerSummary.length > 0, 'partnerSummary 写入')
    assertOk(rec.herSummaryAt > 0 && rec.partnerSummaryAt > 0)
  })

  await testCase('B2 同日重复触发 → 幂等（不重复写、第二次不再调 AI）', async () => {
    const db = seed({ daily_records: [herRec()] })
    const mod = loadAi(db)
    OPENID = 'A'
    await mod.main({ action: 'daily', date: '2026-08-27' })
    const calls1 = aiCalls.length
    await mod.main({ action: 'daily', date: '2026-08-27' })
    assertEq(aiCalls.length, calls1, '第二次不再调 AI')
    const rec = db.dump().daily_records[0]
    assertOk(rec.herSummaryAt, '已有 herSummary')
  })

  await testCase('B3 AI 失败 → her fallback（不空白）', async () => {
    const db = seed({ daily_records: [herRec()] })
    const mod = loadAi(db)
    mod.__setTransport(() => Promise.reject(new Error('AI down')))
    OPENID = 'A'
    await mod.main({ action: 'daily', date: '2026-08-27' })
    const rec = db.dump().daily_records[0]
    assertOk(rec.herSummary && rec.herSummary.length > 0, 'her fallback 写入')
  })

  await testCase('B4 AI 失败 → partner fallback 且不泄露私有字段', async () => {
    const db = seed({ daily_records: [herRec()] })
    const mod = loadAi(db)
    mod.__setTransport(() => Promise.reject(new Error('AI down')))
    OPENID = 'A'
    await mod.main({ action: 'daily', date: '2026-08-27' })
    const rec = db.dump().daily_records[0]
    assertOk(rec.partnerSummary && rec.partnerSummary.length > 0, 'partner fallback 写入')
    assertEq(rec.partnerSummary.includes('火锅'), false, 'fallback 不含日记内容')
    assertEq(rec.partnerSummary.includes('心情'), false)
  })

  await testCase('B5 nextStart-2 → her 提示出现（这几天照顾好自己）', () => {
    const mod = loadAi(new MockDB({}))
    const r = mod.periodReminder('2026-08-29', '2026-08-27') // -2 天
    assertOk(r.her.includes('照顾好自己'))
    assertOk(r.partner.includes('多陪陪 TA'))
  })

  await testCase('B6 nextStart-1 → partner 提示出现', () => {
    const mod = loadAi(new MockDB({}))
    const r = mod.periodReminder('2026-08-28', '2026-08-27') // -1 天
    assertOk(r.partner.includes('多陪陪 TA'))
  })

  await testCase('B7 nextStart 当天不误判前 2 天', () => {
    const mod = loadAi(new MockDB({}))
    const r = mod.periodReminder('2026-08-27', '2026-08-27')
    assertEq(r.her, '')
    assertEq(r.partner, '')
  })

  await testCase('B8 其他日期无提示', () => {
    const mod = loadAi(new MockDB({}))
    const r = mod.periodReminder('2026-09-10', '2026-08-27')
    assertEq(r.her, '')
    assertEq(r.partner, '')
  })

  await testCase('B9 经期提醒实际写入小结（-2 天场景）', async () => {
    // lastStart 7/30 + cycle 30 → nextStart 8/29 = 今天(8/27)+2 → 触发 -2 天提示
    const db = seed({
      daily_records: [herRec()],
      menstrual: [{ _id: 'm1', _openid: 'A', lastStart: '2026-07-30', cycle: 30, periodLen: 5, revision: 1 }]
    })
    const mod = loadAi(db)
    OPENID = 'A'
    await mod.main({ action: 'daily', date: '2026-08-27' })
    const rec = db.dump().daily_records[0]
    assertOk(rec.herSummary && rec.herSummary.includes('照顾好自己'), 'her 提示写入: ' + rec.herSummary)
    assertOk(rec.partnerSummary && rec.partnerSummary.includes('多陪陪 TA'), 'partner 提示写入: ' + rec.partnerSummary)
  })

  console.log('\n=== M6-C · 周报双版本 ===\n')

  await testCase('C1 周报首次生成 1 条（herReport + partnerReport）', async () => {
    const db = seed({ daily_records: [herRec()] })
    const mod = loadAi(db)
    OPENID = 'A'
    const r = await mod.main({ action: 'weekly', startDate: '2026-08-21', endDate: '2026-08-27' })
    assertOk(r.ok)
    assertOk(r.report.herReport && r.report.herReport.length > 0)
    assertOk(r.report.partnerReport && r.report.partnerReport.length > 0)
    assertOk(r.report.partnerReport.includes('目标完成率'), 'partnerReport 白名单内容')
    assertEq(db.dump().weekly_reports.length, 1)
  })

  await testCase('C2 周报重复触发仍 1 条 + 不再调 AI', async () => {
    const db = seed({ daily_records: [herRec()] })
    const mod = loadAi(db)
    OPENID = 'A'
    await mod.main({ action: 'weekly', startDate: '2026-08-21', endDate: '2026-08-27' })
    const calls1 = aiCalls.length
    const r2 = await mod.main({ action: 'weekly', startDate: '2026-08-21', endDate: '2026-08-27' })
    assertEq(r2.idempotent, true)
    assertEq(aiCalls.length, calls1, '第二次不重调 AI')
    assertEq(db.dump().weekly_reports.length, 1, '不新增第二份')
  })

  await testCase('C3 partnerReport 不含日记/关键词/moodTrend/body', () => {
    const mod = loadAi(new MockDB({}))
    const r = mod.buildWeeklyReport([herRec()], null)
    for (const bad of ['火锅', '心情', 'moodTrend', 'body', '改完了']) {
      assertEq(r.partnerReport.includes(bad), false, 'partnerReport 含: ' + bad)
    }
  })

  console.log('\n=== M6-D · 画像升级 / fail-closed ===\n')

  await testCase('D1 profiles.moodTrend 按周聚合更新', async () => {
    const db = seed({ daily_records: [herRec()] })
    const mod = loadAi(db)
    OPENID = 'A'
    await mod.main({ action: 'daily', date: '2026-08-27' })
    const p = db.dump().profiles[0]
    assertOk(p.moodTrend && p.moodTrend['2026-W35'], 'moodTrend 有本周记录')
    assertOk(p.moodTrend['2026-W35'].happy === 1, 'happy 计数')
  })

  await testCase('D2 kwBySegment 分段关键词', async () => {
    const db = seed({ daily_records: [herRec()] })
    const mod = loadAi(db)
    OPENID = 'A'
    await mod.main({ action: 'daily', date: '2026-08-27' })
    const p = db.dump().profiles[0]
    assertOk(p.kwBySegment.life.some(k => k.includes('火锅')), 'life 关键词')
    assertOk(p.kwBySegment.work.some(k => k.includes('bug')), 'work 关键词')
    assertOk(p.kwBySegment.growth.length > 0, 'growth 关键词')
  })

  await testCase('D3 preferences 从 wishes 聚合', async () => {
    const db = seed({ daily_records: [herRec()] })
    const mod = loadAi(db)
    OPENID = 'A'
    await mod.main({ action: 'daily', date: '2026-08-27' })
    const p = db.dump().profiles[0]
    assertOk(p.preferences.eat['螺蛳粉'] === 1, 'eat 心愿词频')
  })

  await testCase('D4 milestones 不重复（目标全完成 → 记录 1 次）', async () => {
    const db = seed({
      daily_records: [herRec({
        goals: [{ text: '读书', done: true }, { text: '运动', done: true }, { text: '早睡', done: true }]
      })]
    })
    const mod = loadAi(db)
    OPENID = 'A'
    await mod.main({ action: 'daily', date: '2026-08-27' })
    await mod.main({ action: 'daily', date: '2026-08-27' }) // 幂等，但 updateProfile 仍会执行
    const p = db.dump().profiles[0]
    const full = p.milestones.filter(m => m.includes('三件大事'))
    assertEq(full.length, 1, 'milestone 不重复')
  })

  await testCase('D5 无数据 fail-closed（返回 ok count=0 不报错）', async () => {
    const db = seed({ daily_records: [] })
    const mod = loadAi(db)
    OPENID = 'A'
    const r = await mod.main({ action: 'daily', date: '2026-08-27' })
    assertOk(r.ok)
    assertEq(r.count, 0)
  })

  console.log('\n=== M6-E · 定时器入口 / 防伪造 / 失败上报（Task D） ===\n')

  await testCase('E1 Timer 触发（无 OPENID）→ 批量生成，不再 BAD_ACTION', async () => {
    const db = seed({ daily_records: [herRec()] })
    const mod = loadAi(db)
    OPENID = undefined // 定时器触发没有 OPENID
    const r = await mod.main({ Type: 'Timer', TriggerName: 'dailySummary', date: '2026-08-27' })
    OPENID = 'A'
    assertOk(r.ok, JSON.stringify(r))
    assertOk(r.count >= 1, '应至少生成 1 条')
    const rec = db.dump().daily_records[0]
    assertOk(rec.herSummary && rec.herSummary.length > 0)
    assertOk(rec.partnerSummary && rec.partnerSummary.length > 0)
  })

  await testCase('E2 客户端伪造 Timer（有 OPENID）→ FORBIDDEN', async () => {
    const db = seed({ daily_records: [herRec()] })
    const mod = loadAi(db)
    OPENID = 'A'
    const r = await mod.main({ Type: 'Timer', TriggerName: 'dailySummary', date: '2026-08-27' })
    assertEq(r.code, 'FORBIDDEN')
    assertEq(db.dump().daily_records[0].herSummaryAt, undefined, '不得生成任何内容')
  })

  await testCase('E3 daily 不接受伪造 event.openid 替他人生成', async () => {
    // X 当天有一条记录；A（本人）当天没有。A 伪造 openid='X' 也不能替 X 生成。
    const db = seed({ daily_records: [herRec({ _id: 'rx', _openid: 'X', coupleId: null })] })
    const mod = loadAi(db)
    OPENID = 'A'
    const r = await mod.main({ action: 'daily', date: '2026-08-27', openid: 'X' })
    assertOk(r.ok)
    assertEq(r.count, 0, '伪造 openid 不能替他人生成')
    assertEq(db.dump().daily_records[0].herSummaryAt, undefined, 'X 的记录不得被生成')
  })

  await testCase('E4 数据库写入失败 → 上报 failed，不假装成功', async () => {
    const db = seed({ daily_records: [herRec()] })
    db.injectFail('daily_records', 'update')
    const mod = loadAi(db)
    OPENID = 'A'
    const r = await mod.main({ action: 'daily', date: '2026-08-27' })
    assertOk(r.ok)
    assertEq(r.failed, 1, '写入失败必须记入 failed')
    assertEq(r.count, 0, '没写进去不能算成功')
  })

  console.log('\n=== 结果: ' + passed + ' PASS / ' + failed + ' FAIL ===')
  if (failed) {
    failures.forEach(f => console.log('  - ' + f))
    process.exit(1)
  }
  console.log('M6 AI: ALL GREEN')
}

runAll().catch(e => { console.error('测试执行异常:', e); process.exit(1) })
