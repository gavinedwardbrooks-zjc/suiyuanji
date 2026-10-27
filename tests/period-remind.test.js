// ============================================================
// tests/period-remind.test.js · 经期提醒（模板 B · 472）
//
// 覆盖：
//   D · 日期与预测：唯一一套算法、倒计时、跨月跨年
//   F · 模板字段：date1 / number2 / time4 的真实格式（模板 B 没有「温馨提醒」字段）
//   T · 定时扫描：提醒窗口、幂等、日期变更、过期、无额度、失败降级
//   C · 伴侣通道：默认不发他；必须她显式开启 + 有效绑定 + 他自己有额度
//   S · 订阅记账 / 权限 / 隐私
//   W · 静态与客户端约束
//
// 平台事实：
//   · 一次性订阅：一次同意 ≈ 一条消息，绝不能承诺「每个月自动提醒」；
//   · date.DATA 要「年月日」；number.DATA 只能数字；time.DATA 要 24 小时制（支持+年月日）；
//   · 发送失败永不回滚经期记录，也不阻塞其他用户。
//
// 运行：node tests/period-remind.test.js
// ============================================================
const Module = require('module')
const path = require('path')
const fs = require('fs')
const { MockDB } = require('./mock-db')

const ROOT = path.resolve(__dirname, '..')
const MEN_DIR = path.join(ROOT, 'cloudfunctions/menstrual')
const NOTIFY = require(path.join(ROOT, 'cloudfunctions/getPartnerView/notify.js'))
const TPL_CHAT = NOTIFY.DEFAULT_TEMPLATES.chat
const TPL_PERIOD = NOTIFY.DEFAULT_TEMPLATES.period

let passed = 0, failed = 0
const failures = []

function testCase(name, fn) {
  return Promise.resolve().then(fn).then(() => {
    passed++
    console.log('  PASS  ' + name)
  }).catch(e => {
    failed++
    failures.push(name + ': ' + e.message)
    console.log('  FAIL  ' + name + '  -> ' + e.message)
  })
}
function assertEq(a, b, msg) {
  if (a !== b) throw new Error((msg || '') + ' 期望 ' + JSON.stringify(b) + ' 实际 ' + JSON.stringify(a))
}
function assertOk(v, msg) { if (!v) throw new Error(msg || '断言失败') }

// ------------------------------------------------------------
// 装配
// ------------------------------------------------------------
function quota(chat, period) {
  return { chat: chat || 0, period: period || 0, tpl: { chat: TPL_CHAT, period: TPL_PERIOD } }
}

// 默认：她（A）已记录经期，预计日期 = lastStart + cycle；他（B）已绑定、已订阅一次
function seed(extra) {
  return new MockDB(Object.assign({
    users: [
      { _id: 'u_a', _openid: 'A', role: 'her', coupleId: 'CZ-1', nickName: '安安', subQuota: quota(0, 1) },
      { _id: 'u_b', _openid: 'B', role: 'him', coupleId: 'CZ-1', subQuota: quota(0, 1) }
    ],
    couples: [{ _id: 'c1', coupleId: 'CZ-1', herOpenid: 'A', himOpenid: 'B', status: 'active' }],
    menstrual: [{
      _id: 'm_a', _openid: 'A', lastStart: '2026-10-03', cycle: 28, periodLen: 5, revision: 3
    }],
    daily_records: []
  }, extra))
}

function mockCloud(opts) {
  const o = opts || {}
  const calls = []
  return {
    calls,
    openapi: {
      subscribeMessage: {
        send: async (params) => {
          calls.push(params)
          // 模拟真实网络耗时：让两个并发实例真正重叠在「发送中」这个窗口里
          if (o.delayMs) await new Promise(r => setTimeout(r, o.delayMs))
          if (o.throwErr) {
            const e = new Error(o.throwErr.errMsg || 'send failed')
            e.errCode = o.throwErr.errCode
            throw e
          }
          return { errCode: 0 }
        }
      }
    }
  }
}

function loadMenstrual(db, state) {
  const origLoad = Module._load
  Module._load = function (request) {
    if (request === 'wx-server-sdk') {
      return {
        DYNAMIC_CURRENT_ENV: 'test',
        init() {},
        database: () => db,
        getWXContext: () => ({ OPENID: state.openid }),
        openapi: state.cloud.openapi
      }
    }
    return origLoad.apply(this, arguments)
  }
  const fnPath = path.join(MEN_DIR, 'index.js')
  delete require.cache[fnPath]
  delete require.cache[path.join(MEN_DIR, 'remind.js')]
  delete require.cache[path.join(MEN_DIR, 'dates.js')]
  delete require.cache[path.join(MEN_DIR, 'notify.js')]
  let mod
  try {
    mod = require(fnPath)
  } finally {
    Module._load = origLoad
  }
  return mod
}

// 「她」的预计日期 = 2026-10-03 + 28 = 2026-10-31
const NEXT = '2026-10-31'

// ==================== D. 日期与预测 ====================
async function runDateTests() {
  console.log('\n=== D · 日期与预测（唯一算法） ===\n')
  const dates = require(path.join(MEN_DIR, 'dates.js'))

  await testCase('D1 addDays：跨月 / 跨年 / 闰年都正确进位', async () => {
    assertEq(dates.addDays('2026-10-03', 28), '2026-10-31')
    assertEq(dates.addDays('2026-12-20', 20), '2027-01-09')
    assertEq(dates.addDays('2028-02-28', 1), '2028-02-29', '2028 是闰年')
    assertEq(dates.addDays('2026-02-28', 1), '2026-03-01', '2026 不是闰年')
    assertEq(dates.addDays('2026-13-01', 1), null, '非法日期必须拒绝')
  })

  await testCase('D2 daysBetween：正负与非法输入', async () => {
    assertEq(dates.daysBetween('2026-10-29', '2026-10-31'), 2)
    assertEq(dates.daysBetween('2026-10-31', '2026-10-29'), -2)
    assertEq(dates.daysBetween('2026-02-30', '2026-03-01'), null, '非法日期返回 null')
  })

  await testCase('D3 SINGLE_DATE_ALGORITHM：云函数目录里只有 dates.js 定义日期算法', async () => {
    const idx = fs.readFileSync(path.join(MEN_DIR, 'index.js'), 'utf8')
    const rem = fs.readFileSync(path.join(MEN_DIR, 'remind.js'), 'utf8')
    assertOk(/require\('\.\/dates'\)/.test(idx), 'index.js 应从 ./dates 取日期工具')
    assertOk(/require\('\.\/dates'\)/.test(rem), 'remind.js 应从 ./dates 取日期工具')
    assertOk(!/function\s+addDays\s*\(/.test(idx), 'index.js 不得再自己定义 addDays（会出现两套矛盾算法）')
    assertOk(!/function\s+addDays\s*\(/.test(rem), 'remind.js 不得自己定义 addDays')
    assertOk(/function\s+addDays\s*\(/.test(fs.readFileSync(path.join(MEN_DIR, 'dates.js'), 'utf8')), 'dates.js 应定义 addDays')
  })

  await testCase('D4 日历显示的下次日期与提醒用的日期完全一致（同一 lastStart/cycle）', async () => {
    const db = seed()
    const mod = loadMenstrual(db, { openid: 'A', cloud: mockCloud() })
    const g = await mod.main({ action: 'get' })
    assertEq(g.record.nextStart, NEXT)
    assertEq(dates.addDays('2026-10-03', 28), g.record.nextStart)
    // month 分支返回的 nextStart 也必须一致
    const mo = await mod.main({ action: 'month', year: 2026, month: 10 })
    assertEq(mo.nextStart, g.record.nextStart)
  })

  await testCase('D5 倒计时天数：2026-10-29 → 还有 2 天', async () => {
    assertEq(dates.daysBetween('2026-10-29', NEXT), 2)
    assertEq(dates.daysBetween('2026-10-31', NEXT), 0)
    assertEq(dates.daysBetween('2026-11-01', NEXT), -1)
  })
}

// ==================== F. 模板 B 字段 ====================
async function runFieldTests() {
  console.log('\n=== F · 模板 B 字段（date1 / number2 / time4） ===\n')
  const notify = require(path.join(ROOT, 'cloudfunctions/getPartnerView/notify.js'))

  await testCase('F1 字段集合必须精确：date1 / number2 / time4（模板没有「温馨提醒」字段）', async () => {
    const data = notify.FIELD_MAP.period({ nextStart: NEXT, countdown: 2, lastStart: '2026-10-03' })
    assertEq(Object.keys(data).sort().join(','), 'date1,number2,time4')
    assertOk(!('thing1' in data) && !('thing5' in data), '不得发送模板里不存在的关键词')
  })

  await testCase('F2 date1 = 年月日；number2 = 纯数字；time4 = 24 小时制（含年月日）', async () => {
    const d = notify.FIELD_MAP.period({ nextStart: NEXT, countdown: 2, lastStart: '2026-10-03' })
    assertEq(d.date1.value, '2026年10月31日')
    assertOk(/^\d+$/.test(d.number2.value), 'number2 只能是数字: ' + d.number2.value)
    assertEq(d.number2.value, '2')
    // time.DATA：24 小时制（支持 + 年月日）。纯日期在 time 字段有被判格式不合法的风险，
    // 所以补一个中性的 00:00 —— 数据本身没有时刻。
    assertOk(/^\d{4}年\d{1,2}月\d{1,2}日 \d{2}:\d{2}$/.test(d.time4.value), 'time4 格式: ' + d.time4.value)
    assertEq(d.time4.value, '2026年10月3日 00:00')
  })

  await testCase('F3 不使用 date1/time4 之外的日期字符串拼接（fmtCnDate 对非法输入返回空）', async () => {
    assertEq(notify.fmtCnDate('2026-02-30'), '2026年2月30日', '格式化只管格式，合法性由调用方把关')
    assertEq(notify.fmtCnDate(''), '')
    assertEq(notify.fmtCnDate('abc'), '')
  })

  await testCase('F4 非法预计日期 → bad_date，绝不把脏字符串塞进模板', async () => {
    const db = seed()
    const cloud = mockCloud()
    const notifyMod = require(path.join(ROOT, 'cloudfunctions/getPartnerView/notify.js'))
    const r = await notifyMod.sendPeriodReminder({
      db, cloud, env: process.env, openid: 'A', nextStart: 'not-a-date', countdown: 2, lastStart: '2026-10-03'
    })
    assertEq(r.sent, false)
    assertEq(r.reason, 'bad_date')
    assertEq(cloud.calls.length, 0)
  })
}

// ==================== T. 定时扫描 ====================
async function runTickTests() {
  console.log('\n=== T · 定时扫描：窗口 / 幂等 / 过期 / 降级 ===\n')

  async function tick(db, cloud, opts) {
    const mod = loadMenstrual(db, { openid: '', cloud })
    return mod.main(Object.assign({ action: 'remindTick', dryRun: false }, opts || {}))
  }

  await testCase('T1 预计日期前 2 天 → 给她发一条，并写下已提醒的日期', async () => {
    const db = seed()
    const cloud = mockCloud()
    const r = await tick(db, cloud, { today: '2026-10-29' })
    assertEq(r.ok, true)
    assertEq(r.sent, 1, '应发一条: ' + JSON.stringify(r))
    assertEq(cloud.calls.length, 1)
    assertEq(cloud.calls[0].touser, 'A', '默认只提醒她本人')
    assertEq(cloud.calls[0].templateId, TPL_PERIOD)
    assertEq(cloud.calls[0].page, 'pages/calendar/calendar', '点击后进日历')
    assertEq(cloud.calls[0].data.date1.value, '2026年10月31日')
    assertEq(cloud.calls[0].data.number2.value, '2')
    assertEq(db.dump().menstrual[0].remindSentFor, NEXT, '应记录已提醒的预计日期')
  })

  await testCase('T2 同一天重复扫描 → 不再重复发送（幂等键 = 预计日期）', async () => {
    const db = seed()
    const cloud = mockCloud()
    await tick(db, cloud, { today: '2026-10-29' })
    const r2 = await tick(db, cloud, { today: '2026-10-29' })
    assertEq(cloud.calls.length, 1, '同一预计日期只能发一次')
    assertEq(r2.sent, 0)
  })

  await testCase('T3 第二天再扫（倒计时变 1）→ 仍然不重复', async () => {
    const db = seed()
    const cloud = mockCloud()
    await tick(db, cloud, { today: '2026-10-29' })
    await tick(db, cloud, { today: '2026-10-30' })
    assertEq(cloud.calls.length, 1, '一次性订阅也不该为同一次经期连发两条')
    assertEq(db.dump().menstrual[0].remindSentFor, NEXT)
  })

  await testCase('T4 预计日期变了 → 按新日期重新提醒（旧标记自动失效）', async () => {
    const db = seed()
    const cloud = mockCloud()
    await tick(db, cloud, { today: '2026-10-29' })
    // 她再订阅一次（一次性订阅：每一条提醒都要一次授权）
    await db.collection('users').doc('u_a').update({
      data: { subQuota: quota(0, 1) }
    })
    // 她把 lastStart 改成 10-08 → 预计 11-05；11-03 时进入窗口
    await db.collection('menstrual').doc('m_a').update({ data: { lastStart: '2026-10-08' } })
    const r = await tick(db, cloud, { today: '2026-11-03' })
    assertEq(r.sent, 1, JSON.stringify(r))
    assertEq(cloud.calls.length, 2)
    assertEq(cloud.calls[1].data.date1.value, '2026年11月5日')
    assertEq(db.dump().menstrual[0].remindSentFor, '2026-11-05')
  })

  await testCase('T5 还早（倒计时 3 天）→ not_due，不发', async () => {
    const db = seed()
    const cloud = mockCloud()
    const r = await tick(db, cloud, { today: '2026-10-28' })
    assertEq(r.sent, 0)
    assertEq(r.skipped.not_due, 1)
    assertEq(cloud.calls.length, 0)
  })

  await testCase('T6 预计日期已经过去 → 不补发过期提醒', async () => {
    const db = seed()
    const cloud = mockCloud()
    const r = await tick(db, cloud, { today: '2026-11-10' })
    assertEq(r.sent, 0)
    assertEq(r.skipped.prediction_passed, 1)
    assertEq(cloud.calls.length, 0)
    assertEq(db.dump().menstrual[0].remindSentFor, undefined, '不得把过期日期写进标记')
  })

  await testCase('T7 没记录过经期 → not_configured，不发', async () => {
    const db = seed({ menstrual: [] })
    const cloud = mockCloud()
    const r = await tick(db, cloud, { today: '2026-10-29' })
    assertEq(r.sent, 0)
    assertEq(cloud.calls.length, 0)
  })

  await testCase('T8 她没有订阅额度 → no_quota，不发，也不写标记（补订阅后还能收到）', async () => {
    const db = seed({ users: [
      { _id: 'u_a', _openid: 'A', role: 'her', coupleId: 'CZ-1', subQuota: quota(0, 0) },
      { _id: 'u_b', _openid: 'B', role: 'him', coupleId: 'CZ-1', subQuota: quota(0, 1) }
    ] })
    const cloud = mockCloud()
    const r = await tick(db, cloud, { today: '2026-10-29' })
    assertEq(r.skipped.no_quota, 1)
    assertEq(cloud.calls.length, 0)
    assertEq(db.dump().menstrual[0].remindSentFor, undefined, '无额度不等于已提醒')
  })

  await testCase('T9 微信返回 43101 → 不抛错、额度归零、业务数据完好', async () => {
    const db = seed()
    const cloud = mockCloud({ throwErr: { errCode: 43101, errMsg: 'user refuse' } })
    const r = await tick(db, cloud, { today: '2026-10-29' })
    assertEq(r.ok, true, '扫描本身不能失败')
    assertEq(r.sent, 0)
    assertEq(r.skipped.no_permission, 1)
    assertEq(db.dump().users.find(u => u._openid === 'A').subQuota.period, 0, '明确无授权 → 归零')
    assertEq(db.dump().menstrual[0].lastStart, '2026-10-03', '经期记录不受影响')
  })

  await taskLooseCase('T10 系统繁忙（-1）→ 不写标记，下一轮可以重试', async () => {
    const db = seed()
    const cloud = mockCloud({ throwErr: { errCode: -1, errMsg: 'system busy' } })
    const r = await tick(db, cloud, { today: '2026-10-29' })
    assertEq(r.sent, 0)
    assertEq(r.skipped.system_busy, 1)
    assertEq(db.dump().menstrual[0].remindSentFor, undefined, '失败不能标记为已提醒')
  })

  await testCase('T11 多个用户互不影响：一条失败不阻塞另一条成功', async () => {
    const db = seed({
      users: [
        { _id: 'u_a', _openid: 'A', role: 'her', coupleId: 'CZ-1', subQuota: quota(0, 1) },
        { _id: 'u_c', _openid: 'C', role: 'her', subQuota: quota(0, 1) }
      ],
      couples: [{ _id: 'c1', coupleId: 'CZ-1', herOpenid: 'A', himOpenid: 'B', status: 'active' }],
      menstrual: [
        { _id: 'm_a', _openid: 'A', lastStart: '2026-10-03', cycle: 28, periodLen: 5 },
        { _id: 'm_c', _openid: 'C', lastStart: '2026-10-03', cycle: 28, periodLen: 5 }
      ]
    })
    const cloud = mockCloud()
    const r = await tick(db, cloud, { today: '2026-10-29' })
    assertEq(r.scanned, 2)
    assertEq(r.sent, 2, '两个独立用户都应收到')
    assertEq(cloud.calls.length, 2)
  })

  await testCase('T12 扫描统计不含 openid、不含任何日期（隐私）', async () => {
    const db = seed()
    const cloud = mockCloud()
    const r = await tick(db, cloud, { today: '2026-10-29' })
    const wire = JSON.stringify(r)
    assertOk(!/"A"|"B"/.test(wire), '响应里出现了 openid: ' + wire)
    assertOk(wire.indexOf('2026-10-03') === -1 && wire.indexOf('2026-10-31') === -1, '响应里出现了经期日期')
    assertEq(r.day, '2026-10-29', '只回传「今天」，这是扫描基准而非她的健康数据')
  })

  await testCase('T13 日志不含 openid、不含日期', async () => {
    const db = seed()
    const cloud = mockCloud({ throwErr: { errCode: -1, errMsg: 'system busy' } })
    const logs = []
    const origWarn = console.warn
    console.warn = (...args) => logs.push(args.map(x => String(x)).join(' '))
    try { await tick(db, cloud, { today: '2026-10-29' }) } finally { console.warn = origWarn }
    assertOk(logs.length >= 1, '失败应留痕')
    const all = logs.join('\n')
    assertOk(all.indexOf('"A"') === -1 && all.indexOf('"B"') === -1, '日志泄露 openid: ' + all)
    assertOk(all.indexOf('2026-10-03') === -1 && all.indexOf('2026-10-31') === -1, '日志泄露经期日期: ' + all)
  })

  await testCase('T14 经期提醒模板被关掉 → no_template，不发也不报错', async () => {
    process.env.TPL_PERIOD = ''
    try {
      const db = seed()
      const cloud = mockCloud()
      const r = await tick(db, cloud, { today: '2026-10-29' })
      assertEq(r.sent, 0)
      assertEq(r.skipped.no_template, 1)
      assertEq(cloud.calls.length, 0)
    } finally {
      // 必须用 finally：断言失败时若残留 TPL_PERIOD='' 会污染后面所有用例
      delete process.env.TPL_PERIOD
    }
  })
}

// 与 testCase 相同，只是名字里带「系统繁忙」字样时仍按普通用例处理
async function taskLooseCase(name, fn) { return testCase(name, fn) }

// ==================== C. 伴侣通道 ====================
async function runPartnerGatingTests() {
  console.log('\n=== C · 伴侣通道：默认不发，必须双方各自同意 ===\n')

  async function tick(db, cloud, today) {
    const mod = loadMenstrual(db, { openid: '', cloud })
    return mod.main({ action: 'remindTick', today, dryRun: false })
  }

  await testCase('C1 默认（未开启共享）→ 只发她，绝不发给他', async () => {
    const db = seed()
    const cloud = mockCloud()
    const r = await tick(db, cloud, '2026-10-29')
    assertEq(r.sent, 1)
    const tousers = cloud.calls.map(c => c.touser).join(',')
    assertEq(tousers, 'A', '默认不得把他的微信号卷进经期提醒')
  })

  await testCase('C2 她开启共享 + 有效绑定 + 他也有额度 → 两人各一条，各扣一次', async () => {
    const db = seed()
    await db.collection('menstrual').doc('m_a').update({ data: { remindPartner: true } })
    const cloud = mockCloud()
    const r = await tick(db, cloud, '2026-10-29')
    assertEq(r.sent, 2, JSON.stringify(r))
    assertEq(cloud.calls.map(c => c.touser).sort().join(','), 'A,B')
    const users = db.dump().users
    assertEq(users.find(u => u._openid === 'A').subQuota.period, 0)
    assertEq(users.find(u => u._openid === 'B').subQuota.period, 0, '他的额度必须由他自己那次授权提供')
    assertEq(db.dump().menstrual[0].remindPartnerSentFor, NEXT)
  })

  await testCase('C3 她开了共享但没绑定 → 只发她，原因 partner_not_bound', async () => {
    const db = seed({
      users: [{ _id: 'u_a', _openid: 'A', role: 'her', subQuota: quota(0, 1) }],
      couples: [],
      menstrual: [{ _id: 'm_a', _openid: 'A', lastStart: '2026-10-03', cycle: 28, periodLen: 5, remindPartner: true }]
    })
    const cloud = mockCloud()
    const r = await tick(db, cloud, '2026-10-29')
    assertEq(r.sent, 1)
    assertEq(r.skipped.partner_not_bound, 1)
    assertEq(cloud.calls.map(c => c.touser).join(','), 'A')
  })

  await testCase('C4 已解绑（superseded）→ 只发她，绝不发给旧伴侣', async () => {
    const db = seed({
      couples: [{ _id: 'c1', coupleId: 'CZ-1', herOpenid: 'A', himOpenid: 'B', status: 'superseded' }],
      menstrual: [{ _id: 'm_a', _openid: 'A', lastStart: '2026-10-03', cycle: 28, periodLen: 5, remindPartner: true }]
    })
    const cloud = mockCloud()
    const r = await tick(db, cloud, '2026-10-29')
    assertEq(r.sent, 1)
    assertEq(r.skipped.partner_not_active, 1)
    assertEq(cloud.calls.map(c => c.touser).join(','), 'A')
  })

  await testCase('C5 他没有订阅额度 → 只发她', async () => {
    const db = seed({ users: [
      { _id: 'u_a', _openid: 'A', role: 'her', coupleId: 'CZ-1', subQuota: quota(0, 1) },
      { _id: 'u_b', _openid: 'B', role: 'him', coupleId: 'CZ-1', subQuota: quota(0, 0) }
    ] })
    await db.collection('menstrual').doc('m_a').update({ data: { remindPartner: true } })
    const cloud = mockCloud()
    const r = await tick(db, cloud, '2026-10-29')
    assertEq(r.sent, 1)
    assertEq(r.skipped.partner_no_quota, 1)
    assertEq(cloud.calls.map(c => c.touser).join(','), 'A')
  })

  await testCase('C6 第二次扫描：两人都不重复收', async () => {
    const db = seed()
    await db.collection('menstrual').doc('m_a').update({ data: { remindPartner: true } })
    const cloud = mockCloud()
    await tick(db, cloud, '2026-10-29')
    const r2 = await tick(db, cloud, '2026-10-29')
    assertEq(r2.sent, 0)
    assertEq(cloud.calls.length, 2, '第一轮两人各一条，第二轮零条')
  })
}

// ==================== S. 订阅记账 / 权限 ====================
async function runSubAndAuthTests() {
  console.log('\n=== S · 订阅记账 / 权限 ===\n')

  await testCase('S1 subPeriod → period 通道 +1（一次同意 = 一条消息）', async () => {
    const db = seed()
    const mod = loadMenstrual(db, { openid: 'A', cloud: mockCloud() })
    const r = await mod.main({ action: 'subPeriod' })
    assertEq(r.ok, true)
    assertEq(r.quota.period, 2, '原本 1 → 现在 2')
    assertEq(r.quota.chat, 0, '不得顺手给 chat 通道加额度')
  })

  await testCase('S2 subPeriod 由谁调用就记给谁（前端传不了别人的 openid）', async () => {
    const db = seed()
    const mod = loadMenstrual(db, { openid: 'B', cloud: mockCloud() })
    await mod.main({ action: 'subPeriod', openid: 'A' })
    const users = db.dump().users
    assertEq(users.find(u => u._openid === 'B').subQuota.period, 2, 'B 自己 +1')
    assertEq(users.find(u => u._openid === 'A').subQuota.period, 1, 'A 不受影响')
  })

  await testCase('S3 客户端调用 remindTick → FORBIDDEN（不能被人肉刷提醒）', async () => {
    const db = seed()
    const cloud = mockCloud()
    const mod = loadMenstrual(db, { openid: 'A', cloud })
    const r = await mod.main({ action: 'remindTick' })
    assertEq(r.ok, false)
    assertEq(r.code, 'FORBIDDEN')
    assertEq(cloud.calls.length, 0)
  })

  await testCase('S4 定时触发器事件（无 OPENID）→ 正常执行扫描', async () => {
    const db = seed()
    const cloud = mockCloud()
    const mod = loadMenstrual(db, { openid: '', cloud })
    const r = await mod.main({ Type: 'Timer', TriggerName: 'periodRemind', Time: '2026-10-29T09:00:00Z' })
    assertEq(r.ok, true)
    assertOk(typeof r.scanned === 'number', '定时执行应返回扫描统计')
  })

  await testCase('S5 remindPrefs：他调用 → FORBIDDEN，改不了她的共享开关', async () => {
    const db = seed()
    const mod = loadMenstrual(db, { openid: 'B', cloud: mockCloud() })
    const r = await mod.main({ action: 'remindPrefs', partner: true })
    assertEq(r.ok, false)
    assertEq(r.code, 'FORBIDDEN')
    assertEq(db.dump().menstrual[0].remindPartner, undefined)
  })

  await testCase('S6 remindPrefs：她还没记录经期 → NOT_CONFIGURED', async () => {
    const db = seed({ menstrual: [] })
    const mod = loadMenstrual(db, { openid: 'A', cloud: mockCloud() })
    const r = await mod.main({ action: 'remindPrefs', partner: true })
    assertEq(r.ok, false)
    assertEq(r.code, 'NOT_CONFIGURED')
  })

  await testCase('S7 remindPrefs：她能开也能关，状态如实落库', async () => {
    const db = seed()
    const mod = loadMenstrual(db, { openid: 'A', cloud: mockCloud() })
    const on = await mod.main({ action: 'remindPrefs', partner: true })
    assertEq(on.ok, true)
    assertEq(on.partnerRemind, true)
    assertEq(db.dump().menstrual[0].remindPartner, true)
    const off = await mod.main({ action: 'remindPrefs', partner: false })
    assertEq(off.partnerRemind, false)
    assertEq(db.dump().menstrual[0].remindPartner, false)
  })

  await testCase('S8 get 返回提醒状态（额度 / 是否共享 / 已提醒日期），且不泄露他的信息', async () => {
    const db = seed()
    const mod = loadMenstrual(db, { openid: 'A', cloud: mockCloud() })
    const r = await mod.main({ action: 'get' })
    assertEq(r.ok, true)
    assertEq(r.remind.quota, 1)
    assertEq(r.remind.leadDays, 2)
    assertEq(r.remind.partnerRemind, false)
    assertEq(typeof r.remind.sentFor, 'string')
    assertOk(JSON.stringify(r).indexOf('"B"') === -1, '响应不得出现伴侣 openid')
  })

  await testCase('S9 get 在「未记录经期」时也要返回提醒状态（否则新用户看不到订阅入口）', async () => {
    const db = seed({ menstrual: [] })
    const mod = loadMenstrual(db, { openid: 'A', cloud: mockCloud() })
    const r = await mod.main({ action: 'get' })
    assertEq(r.configured, false)
    assertOk(r.remind && typeof r.remind.quota === 'number', '未配置也要能展示额度')
    assertEq(r.remind.quota, 1)
  })
}

// ==================== W. 静态与客户端 ====================
async function runStaticTests() {
  console.log('\n=== W · 静态与客户端约束 ===\n')
  const wxml = fs.readFileSync(path.join(ROOT, 'pages/calendar/calendar.wxml'), 'utf8')
  const js = fs.readFileSync(path.join(ROOT, 'pages/calendar/calendar.js'), 'utf8')
  const conf = JSON.parse(fs.readFileSync(path.join(MEN_DIR, 'config.json'), 'utf8'))

  await testCase('W1 日历页有「订阅经期提醒」入口，并说明每次只提醒一次', async () => {
    assertOk(/订阅经期提醒/.test(wxml), '缺少订阅入口')
    assertOk(/经期提醒/.test(wxml), '缺少模块标题')
    // V1.1 UI 精简：不再常驻「微信只支持一次性订阅：每同意一次只能收到一条」这类长解释，
    // 一次性语义由底部一行「开启后，预计经期前 2 天提醒一次」表达。
    assertOk(/提醒一次|一次性订阅/.test(wxml), '必须如实说明每次只提醒一次')
    assertOk(/前 2 天/.test(wxml), '应说明默认提前 2 天')
  })

  await testCase('W2 「也提醒 TA」只在她的界面出现（他不能自己打开别人的健康数据分享）', async () => {
    const idx = wxml.indexOf('也提醒 TA')
    assertOk(idx > 0, '缺少「也提醒 TA」开关')
    const prev = wxml.lastIndexOf('wx:if', idx)
    assertOk(prev > 0, '开关应带 wx:if 条件')
    assertOk(wxml.slice(prev, idx).indexOf('isHer') !== -1, '开关必须被 isHer 包裹')
  })

  await testCase('W3 订阅只能在用户点击时申请：onLoad / onShow 里没有 requestSubscribeMessage', async () => {
    const onLoad = js.slice(js.indexOf('onLoad()'), js.indexOf('loadMarks()'))
    assertOk(onLoad.indexOf('requestSubscribeMessage') === -1, 'onLoad 里不得申请订阅')
    const onShow = js.slice(js.indexOf('onShow()'), js.indexOf('// 日历标记'))
    assertOk(onShow.indexOf('requestSubscribeMessage') === -1, 'onShow 里不得申请订阅')
    assertOk(/subscribeRemind\(\)/.test(js), '应有独立的 subscribeRemind 入口')
  })

  await testCase('W4 界面文案不承诺「每月自动」或「永久」（一次性订阅做不到）', async () => {
    const visible = wxml.replace(/<!--[\s\S]*?-->/g, '')
    assertOk(!/永久/.test(visible), '不得出现「永久」')
    assertOk(!/每月自动|每个月都/.test(visible), '不得承诺每月自动提醒')
    const noComment = js.replace(/\/\/[^\n]*/g, '')
    assertOk(!/永久/.test(noComment), 'js 用户可见文案不得出现「永久」')
  })

  await testCase('W5 config.json：定时触发器每天 09:00 + 声明订阅消息 openapi 权限', async () => {
    assertOk(Array.isArray(conf.triggers) && conf.triggers.length === 1, '应恰好一个定时触发器')
    assertEq(conf.triggers[0].type, 'timer')
    assertEq(conf.triggers[0].config, '0 0 9 * * * *', '每天 09:00:00')
    assertEq(conf.triggers[0].name, 'periodRemind')
    assertOk(conf.permissions.openapi.indexOf('subscribeMessage.send') !== -1, '云调用需声明 openapi 权限')
  })

  await testCase('W6 点击经期提醒落到日历页（提醒里给了正确 page）', async () => {
    assertEq(NOTIFY.PAGE_OF.period, 'pages/calendar/calendar')
  })

  await testCase('W7 前端不出现 touser / 不硬编码 openid', async () => {
    assertOk(!/touser/.test(js), '前端不得决定接收者')
    assertOk(!/openid\s*:\s*['"]/.test(js), '前端不得硬编码 openid')
  })
}

// ==================== K. 并发安全（先领取再发送） ====================
async function runConcurrencyTests() {
  console.log('\n=== K · 并发安全：原子领取 / 失败释放 / 悬挂接管 ===\n')

  async function tick(db, cloud, opts) {
    const mod = loadMenstrual(db, { openid: '', cloud })
    return mod.main(Object.assign({ action: 'remindTick', dryRun: false }, opts || {}))
  }

  await testCase('K1 两个实例并发扫描 → 只发一条（另一个拿不到领取权）', async () => {
    const db = seed()
    // 发送耗时 20ms：让第二个实例在第一个「正在发送」时到达领取点
    const cloud = mockCloud({ delayMs: 20 })
    const mod = loadMenstrual(db, { openid: '', cloud })
    const run = () => mod.main({ action: 'remindTick', today: '2026-10-29', dryRun: false })
    const rs = await Promise.all([run(), run()])
    assertEq(cloud.calls.length, 1, '并发只能发一条，实际 ' + cloud.calls.length)
    assertEq(rs.reduce((n, r) => n + r.sent, 0), 1)
    assertEq(db.dump().users.find(u => u._openid === 'A').subQuota.period, 0, '额度只能扣一次')
    assertOk(rs.some(r => r.skipped.concurrent === 1), '另一个实例应记 concurrent: ' + JSON.stringify(rs.map(r => r.skipped)))
  })

  await testCase('K2 阴性对照：去掉 claimFor 守卫就会两次都领取成功（证明守卫是必要的）', async () => {
    const dates = null
    // 正确守卫：第二次 updated === 0
    const good = seed()
    const _g = good.command
    const g1 = await good.collection('menstrual')
      .where({ _id: 'm_a', remindSentFor: _g.neq(NEXT), remindClaimFor: _g.neq(NEXT) })
      .update({ data: { remindClaimFor: NEXT } })
    const g2 = await good.collection('menstrual')
      .where({ _id: 'm_a', remindSentFor: _g.neq(NEXT), remindClaimFor: _g.neq(NEXT) })
      .update({ data: { remindClaimFor: NEXT } })
    assertEq(g1.stats.updated, 1)
    assertEq(g2.stats.updated, 0, '第二次必须拿不到')

    // 旧写法（只判 sentFor，不判 claim）→ 两次都成功 = 会双发
    const bad = seed()
    const _b = bad.command
    const b1 = await bad.collection('menstrual')
      .where({ _id: 'm_a', remindSentFor: _b.neq(NEXT) }).update({ data: { x: 1 } })
    const b2 = await bad.collection('menstrual')
      .where({ _id: 'm_a', remindSentFor: _b.neq(NEXT) }).update({ data: { x: 1 } })
    assertEq(b1.stats.updated, 1)
    assertEq(b2.stats.updated, 1, '这就是「先发后写」在并发下会双发的原因')
    assertOk(dates === null)
  })

  await testCase('K3 发送失败 → 领取立刻释放，下一轮仍能补发（不丢提醒）', async () => {
    const db = seed()
    const bad = mockCloud({ throwErr: { errCode: -1, errMsg: 'system busy' } })
    const r1 = await tick(db, bad, { today: '2026-10-29' })
    assertEq(r1.sent, 0)
    const doc = db.dump().menstrual[0]
    assertEq(doc.remindSentFor, undefined, '失败不得写成已提醒')
    assertOk(doc.remindClaimFor === null || doc.remindClaimFor === undefined, '教领取必须释放: ' + JSON.stringify(doc.remindClaimFor))
    assertOk(doc.remindClaimId === null || doc.remindClaimId === undefined, 'claim id 必须清空')

    const good = mockCloud()
    const r2 = await tick(db, good, { today: '2026-10-29' })
    assertEq(r2.sent, 1, '释放后下一轮应该能发出去')
    assertEq(good.calls.length, 1)
  })

  await testCase('K4 发送成功 → 标记落库且 claim 清空（不留悬挂）', async () => {
    const db = seed()
    const cloud = mockCloud()
    const r = await tick(db, cloud, { today: '2026-10-29' })
    assertEq(r.sent, 1)
    const doc = db.dump().menstrual[0]
    assertEq(doc.remindSentFor, NEXT)
    assertEq(doc.remindClaimFor, null)
    assertEq(doc.remindClaimId, null)
    assertOk(typeof doc.remindUpdatedAt === 'number', '应记录本次处理时间')
  })

  await testCase('K5 悬挂的领取（超过 TTL）可被安全接管；新鲜的领取不会被抢', async () => {
    // 新鲜 claim（刚刚）→ 抢不到，不发
    const fresh = seed()
    await fresh.collection('menstrual').doc('m_a').update({
      data: { remindClaimFor: NEXT, remindClaimAt: Date.now(), remindClaimId: 'other' }
    })
    const c1 = mockCloud()
    const r1 = await tick(fresh, c1, { today: '2026-10-29' })
    assertEq(r1.sent, 0)
    assertEq(c1.calls.length, 0, '新鲜 claim 期间不得发送')
    assertEq(r1.skipped.concurrent, 1)

    // 过期 claim（7 小时前 > 6 小时 TTL）→ 可接管并发送
    const stale = seed()
    await stale.collection('menstrual').doc('m_a').update({
      data: { remindClaimFor: NEXT, remindClaimAt: Date.now() - 7 * 3600 * 1000, remindClaimId: 'dead' }
    })
    const c2 = mockCloud()
    const r2 = await tick(stale, c2, { today: '2026-10-29' })
    assertEq(r2.sent, 1, '过期 claim 应被接管（否则一次崩溃就永久漏提醒）: ' + JSON.stringify(r2))
    assertEq(c2.calls.length, 1)
    assertEq(stale.dump().menstrual[0].remindSentFor, NEXT)
  })

  await testCase('K6 静态约束：remind.js 必须「先领取、后发送」，且用 updated===1 判定', async () => {
    const src = fs.readFileSync(path.join(MEN_DIR, 'remind.js'), 'utf8')
    const claimAt = src.indexOf('tryClaim({')
    const sendAt = src.indexOf('notify.sendPeriodReminder(')
    assertOk(claimAt > 0, '缺少领取步骤')
    assertOk(sendAt > 0, '缺少发送步骤')
    assertOk(claimAt < sendAt, '领取必须发生在发送之前（否则并发会双发）')
    assertOk(/stats\.updated === 1/.test(src), '领取必须依赖单文档原子更新的 updated 计数')
    assertOk(/CLAIM_TTL_MS/.test(src), '必须有悬挂 claim 的自愈窗口')
  })
}

// ==================== R. 只读演练（dryRun） ====================
async function runDryRunTests() {
  console.log('\n=== R · 只读演练：不发送 / 不扣额度 / 不写库 ===\n')

  async function tick(db, cloud, event) {
    const mod = loadMenstrual(db, { openid: '', cloud })
    return mod.main(Object.assign({ action: 'remindTick' }, event || {}))
  }

  await testCase('R1 手动执行默认就是只读演练（不传 dryRun 也不发送）', async () => {
    const db = seed()
    const before = JSON.stringify(db.dump())
    const cloud = mockCloud()
    const r = await tick(db, cloud, { today: '2026-10-29' })
    assertEq(r.dryRun, true, '默认必须是演练')
    assertEq(r.sent, 0)
    assertEq(r.wouldSend, 1, '应报告「本会发给谁」')
    assertEq(cloud.calls.length, 0, '演练绝不能调用微信接口')
    assertEq(JSON.stringify(db.dump()), before, '演练绝不能写数据库（含额度与标记）')
  })

  await testCase('R2 dryRun:true 显式 → 零发送、零写入，即便在提醒窗口内', async () => {
    const db = seed()
    const before = JSON.stringify(db.dump())
    const cloud = mockCloud()
    const r = await tick(db, cloud, { today: '2026-10-29', dryRun: true })
    assertEq(r.due, 1)
    assertEq(r.sent, 0)
    assertEq(cloud.calls.length, 0)
    assertEq(JSON.stringify(db.dump()), before)
  })

  await testCase('R3 dryRun 下的额度判定也是只读的（无额度 → no_quota，不归零、不发送）', async () => {
    const db = seed({ users: [
      { _id: 'u_a', _openid: 'A', role: 'her', coupleId: 'CZ-1', subQuota: quota(0, 0) },
      { _id: 'u_b', _openid: 'B', role: 'him', coupleId: 'CZ-1', subQuota: quota(0, 1) }
    ] })
    const before = JSON.stringify(db.dump())
    const cloud = mockCloud()
    const r = await tick(db, cloud, { today: '2026-10-29', dryRun: true })
    assertEq(r.wouldSend, 0)
    assertEq(r.skipped.no_quota, 1)
    assertEq(cloud.calls.length, 0)
    assertEq(JSON.stringify(db.dump()), before)
  })

  await testCase('R4 dryRun:false 是唯一真正发送的路径（显式声明）', async () => {
    const db = seed()
    const cloud = mockCloud()
    const r = await tick(db, cloud, { today: '2026-10-29', dryRun: false })
    assertEq(r.dryRun, false)
    assertEq(r.sent, 1)
    assertEq(cloud.calls.length, 1)
  })

  await testCase('R5 定时触发器不受 dryRun 默认值影响（真实执行）', async () => {
    const db = seed()
    const cloud = mockCloud()
    const mod = loadMenstrual(db, { openid: '', cloud })
    const r = await mod.main({ Type: 'Timer', TriggerName: 'periodRemind' })
    assertEq(r.dryRun, false, '定时任务必须真跑')
    assertOk(typeof r.scanned === 'number')
  })

  await testCase('R6 客户端伪造 { Type:"Timer" } 会被挡掉（有 OPENID 就不算定时器）', async () => {
    const db = seed()
    const before = JSON.stringify(db.dump())
    const cloud = mockCloud()
    const mod = loadMenstrual(db, { openid: 'A', cloud })
    const r = await mod.main({ Type: 'Timer' })
    assertEq(r.ok, false)
    assertEq(r.code, 'FORBIDDEN')
    assertEq(cloud.calls.length, 0)
    assertEq(JSON.stringify(db.dump()), before)
  })
}

// ==================== M. 版本状态（miniprogramState） ====================
async function runMpStateTests() {
  console.log('\n=== M · 版本状态：formal / trial / developer ===\n')
  const notify = require(path.join(MEN_DIR, 'notify.js'))

  await testCase('M1 默认 formal；trial / developer 需显式配置；非法值退回 formal', async () => {
    assertEq(notify.resolveMiniprogramState({}), 'formal')
    assertEq(notify.resolveMiniprogramState({ MP_STATE: 'trial' }), 'trial')
    assertEq(notify.resolveMiniprogramState({ MP_STATE: ' DEVELOPER ' }), 'developer')
    assertEq(notify.resolveMiniprogramState({ MP_STATE: 'preview' }), 'formal', '未知值不得透传')
  })

  await testCase('M2 经期提醒的发送参数会带上 MP_STATE（体验版验收必须能改）', async () => {
    const db = seed()
    const cloud = mockCloud()
    const env = Object.assign({}, process.env, { MP_STATE: 'trial' })
    const r = await notify.sendPeriodReminder({
      db, cloud, env, openid: 'A', nextStart: NEXT, countdown: 2, lastStart: '2026-10-03'
    })
    assertEq(r.sent, true, JSON.stringify(r))
    assertEq(cloud.calls[0].miniprogramState, 'trial')
  })

  await testCase('M3 情侣消息同样跟随 MP_STATE，未配置时仍是 formal', async () => {
    const db = seed()
    const cloud = mockCloud()
    const env = Object.assign({}, process.env, { MP_STATE: 'trial', TPL_CHAT: TPL_CHAT })
    await db.collection('users').doc('u_b').update({ data: { subQuota: quota(1, 0) } })
    const r = await notify.sendCoupleNotice({ db, cloud, env, openid: 'A', kind: 'msg' })
    assertEq(r.sent, true, JSON.stringify(r))
    assertEq(cloud.calls[0].miniprogramState, 'trial')

    const cloud2 = mockCloud()
    await db.collection('users').doc('u_b').update({ data: { subQuota: quota(1, 0) } })
    await notify.sendCoupleNotice({ db, cloud: cloud2, env: process.env, openid: 'A', kind: 'msg' })
    assertEq(cloud2.calls[0].miniprogramState, 'formal')
  })
}

// ==================== C2. 新旧版本兼容 ====================
async function runCompatTests() {
  console.log('\n=== P · 新旧版本客户端 / 云函数兼容 ===\n')

  await testCase('P1 旧客户端（不传 action）仍走 month，行为不变', async () => {
    const db = seed()
    const mod = loadMenstrual(db, { openid: 'A', cloud: mockCloud() })
    const r = await mod.main({ year: 2026, month: 10 })
    assertEq(r.ok, true)
    assertOk(Array.isArray(r.days))
  })

  await testCase('P2 get 是纯增量：旧字段一个不少，新字段只是追加 remind', async () => {
    const db = seed()
    const mod = loadMenstrual(db, { openid: 'A', cloud: mockCloud() })
    const r = await mod.main({ action: 'get' })
    for (const k of ['lastStart', 'cycle', 'periodLen', 'nextStart', 'revision']) {
      assertOk(k in r.record, '旧字段丢失: ' + k)
    }
    assertOk(r.remind && typeof r.remind.quota === 'number', '新增 remind 状态')
    assertEq(r.record.cycle, 28)
    assertEq(r.record.periodLen, 5)
  })

  await testCase('P3 旧客户端 save（不传 periodLen）仍按默认 5 落库，不被新逻辑打断', async () => {
    const db = seed({ menstrual: [] })
    const mod = loadMenstrual(db, { openid: 'A', cloud: mockCloud() })
    const r = await mod.main({ action: 'save', lastStart: '2026-10-03', cycle: 30, requestId: 'r-old' })
    assertEq(r.ok, true, JSON.stringify(r))
    assertEq(r.periodLen, 5)
    assertEq(db.dump().menstrual[0].cycle, 30)
  })

  await testCase('P4 新客户端 + 旧云函数：服务端没记账时不得谎报「已开启」', async () => {
    const cal = fs.readFileSync(path.join(ROOT, 'pages/calendar/calendar.js'), 'utf8')
    const ours = fs.readFileSync(path.join(ROOT, 'pages/ours/ours.js'), 'utf8')
    // 旧云函数不认识 subPeriod / sub → 返回 ok:false → 必须走「未成功」分支
    for (const [name, src] of [['calendar.js', cal], ['ours.js', ours]]) {
      assertOk(/if \(!rr\.ok\)/.test(src), name + ' 缺少服务端记账失败的判断')
      const failBranch = src.slice(src.indexOf('if (!rr.ok)'), src.indexOf('if (!rr.ok)') + 200)
      assertOk(/已同意，但记录未成功/.test(failBranch), name + ' 失败分支必须如实提示')
    }
  })

  await testCase('P5 旧客户端不会调用新 action，新 action 也不改旧数据', async () => {
    const db = seed()
    const before = JSON.stringify(db.dump().menstrual)
    const mod = loadMenstrual(db, { openid: 'A', cloud: mockCloud() })
    await mod.main({ action: 'subPeriod' })
    await mod.main({ action: 'remindPrefs', partner: true })
    const after = JSON.parse(JSON.stringify(db.dump().menstrual))
    const beforeArr = JSON.parse(before)
    for (const k of ['lastStart', 'cycle', 'periodLen', 'revision', 'lastRequestId']) {
      assertEq(after[0][k], beforeArr[0][k], '旧业务字段被改动: ' + k)
    }
  })

  await testCase('P6 三个云函数都声明了 timeout，避免通知拖长导致超时', async () => {
    for (const dir of ['menstrual', 'getPartnerView', 'dailyRecord']) {
      const c = JSON.parse(fs.readFileSync(path.join(ROOT, 'cloudfunctions', dir, 'config.json'), 'utf8'))
      assertEq(c.timeout, 20, dir + ' 缺少 timeout 声明')
      assertOk(c.permissions.openapi.indexOf('subscribeMessage.send') !== -1, dir + ' 缺 openapi 权限')
    }
  })
}

// ==================== 主流程 ====================
;(async () => {
  console.log('========================================')
  console.log(' 经期提醒（模板 B · 472）· 测试')
  console.log('========================================')
  await runDateTests()
  await runFieldTests()
  await runTickTests()
  await runPartnerGatingTests()
  await runSubAndAuthTests()
  await runConcurrencyTests()
  await runDryRunTests()
  await runMpStateTests()
  await runCompatTests()
  await runStaticTests()

  console.log('\n========================================')
  console.log(' 结果: ' + passed + ' PASS / ' + failed + ' FAIL')
  if (failures.length) {
    console.log(' 失败项:')
    failures.forEach(f => console.log('   · ' + f))
  }
  console.log('========================================')
  process.exit(failed === 0 ? 0 : 1)
})()
