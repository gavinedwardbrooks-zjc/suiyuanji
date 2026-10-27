// ============================================================
// tests/m3-home.test.js · M3 首页仪表盘测试（PRD v0.6 §4.3 / 指令 §10）
// A. profileStats 云函数契约（mock sdk 驱动）
// B. H1-H4 静态检查（wxml/wxss/js）
// 运行：node tests/m3-home.test.js
// ============================================================
const Module = require('module')
const path = require('path')
const fs = require('fs')
const { MockDB } = require('./mock-db')

const ROOT = path.resolve(__dirname, '..')
let passed = 0, failed = 0, failures = []

function check(name, cond, detail) {
  if (cond) { passed++; console.log('  PASS  ' + name) }
  else { failed++; failures.push(name + (detail ? ' -> ' + detail : '')); console.log('  FAIL  ' + name + (detail ? ' -> ' + detail : '')) }
}
function assertEq(a, b, msg) { if (a !== b) throw new Error((msg || '') + ' 期望 ' + JSON.stringify(b) + ' 实际 ' + JSON.stringify(a)) }
function assertOk(v, msg) { if (!v) throw new Error(msg || '断言失败') }

// 可靠异步用例模式：抛错会显式 FAIL（不会静默吞掉）
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

// ---- A. profileStats 契约 ----
let OPENID = 'her_001'
function withMockSdk(db) {
  const origLoad = Module._load
  Module._load = function (request, parent, isMain) {
    if (request === 'wx-server-sdk') {
      return {
        DYNAMIC_CURRENT_ENV: 'test',
        init() {},
        database: () => db,
        getWXContext: () => ({ OPENID })
      }
    }
    return origLoad.apply(this, arguments)
  }
  const fnPath = path.resolve(__dirname, '../cloudfunctions/profileStats/index.js')
  delete require.cache[fnPath]
  const mod = require(fnPath)
  Module._load = origLoad
  return mod
}

// 动态构造最近 7 天日期（与云函数逻辑同源）
function last7Dates(today) {
  const p = n => String(n).padStart(2, '0')
  const out = []
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i)
    out.push(`${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`)
  }
  return out
}

async function runProfileStatsTests() {
  console.log('\n=== M3-A · profileStats 云函数契约 ===\n')

  const today = new Date()
  const days7 = last7Dates(today)

  await testCase('A1 契约：返回 7 天、含今天、逐日与 fixture 一致', async () => {
    const withRecord = days7[2]
    const db = new MockDB({
      daily_records: [{ _openid: OPENID, date: withRecord, score: 4 }]
    })
    const mod = withMockSdk(db)
    const res = await mod.main({ action: 'week' })
    assertOk(res.ok)
    assertEq(res.days.length, 7, '应返回 7 天')
    assertEq(res.days[6].date, days7[6], '第 7 天 = 今天')
    assertEq(res.days.map(d => d.hasRecord).filter(Boolean).length, 1, '仅 1 天有记录')
    assertEq(res.days[2].hasRecord, true, 'fixture 那天应为 true')
  })

  await testCase('A2 缺 3 天 → 只显示真实记录状态（不把 missing 当 zero/completed）', async () => {
    const db = new MockDB({
      daily_records: days7.map((d, i) => i % 2 === 0 ? { _openid: OPENID, date: d, score: 1 } : null).filter(Boolean)
    })
    const mod = withMockSdk(db)
    const res = await mod.main({ action: 'week' })
    for (let i = 0; i < 7; i++) {
      assertEq(res.days[i].hasRecord, i % 2 === 0, 'day ' + i + ' ' + days7[i])
    }
  })

  await testCase('A3 跨月日期计算正确（7/29~8/4）', async () => {
    const t = new Date(2026, 7, 4)
    const d7 = last7Dates(t)
    assertEq(d7[0], '2026-07-29', '跨月第 1 天应为 7/29')
    assertEq(d7[6], '2026-08-04', '最后一天应为 8/4')
    const db = new MockDB({
      daily_records: [{ _openid: OPENID, date: '2026-07-30', score: 3 }]
    })
    const mod = withMockSdk(db)
    const res = await mod.main({ action: 'week' })
    assertOk(res.ok)
    assertEq(res.days.length, 7)
  })

  await testCase('A4 隐私：只返回 date/hasRecord（无 diary/mood/body/summary）', async () => {
    const db = new MockDB({
      daily_records: [{
        _openid: OPENID, date: days7[0],
        segments: { life: '私密日记', work: 'x', growth: 'y' },
        mood: { type: 'low', weather: 'rain' },
        body: { amount: 'heavy', symptoms: ['pain'] },
        summary: '她版小结', score: 4
      }]
    })
    const mod = withMockSdk(db)
    const res = await mod.main({ action: 'week' })
    const hasRecordDay = res.days.find(d => d.hasRecord)
    const keys = Object.keys(hasRecordDay).sort()
    assertEq(JSON.stringify(keys), JSON.stringify(['date', 'hasRecord']), '只应返回 date/hasRecord')
  })

  await testCase('A5 身份隔离：him 请求只看到自己的数据（OPENID 来自 context）', async () => {
    const herDb = new MockDB({ daily_records: [{ _openid: 'her_001', date: days7[0], score: 5 }] })
    OPENID = 'him_001'
    const mod = withMockSdk(herDb)
    const res = await mod.main({ action: 'week' })
    assertOk(res.ok)
    assertEq(res.days.filter(d => d.hasRecord).length, 0, 'him 拿不到 her 的记录')
    OPENID = 'her_001'
  })

  await testCase('A6 未知 action → BAD_ACTION', async () => {
    const db = new MockDB({ daily_records: [] })
    const mod = withMockSdk(db)
    const res = await mod.main({ action: 'monthly' })
    assertEq(res.ok, false)
    assertEq(res.code, 'BAD_ACTION')
  })
}

// ---- B. H1-H4 静态检查 ----
function runStaticTests() {
  console.log('\n=== M3-B · 首页 H1-H4 静态检查 ===\n')

  const homeWxml = fs.readFileSync(path.join(ROOT, 'pages/home/home.wxml'), 'utf8')
  const homeWxss = fs.readFileSync(path.join(ROOT, 'pages/home/home.wxss'), 'utf8')
  const homeJs = fs.readFileSync(path.join(ROOT, 'pages/home/home.js'), 'utf8')

  // H1 顺序：greeting → today status → goals → todos → summary
  const orderIdx = ['greet', 'status-card', '今日目标', '今日小事', 'AI 小结'].map(s => homeWxml.indexOf(s))
  check('H1 首屏顺序固定：问候→今日状态→目标→小事→小结',
    orderIdx.every(i => i >= 0) && orderIdx.every((v, i) => i === 0 || v > orderIdx[i - 1]),
    'indexes=' + JSON.stringify(orderIdx))

  // H2 空状态
  check('H2 空状态存在（empty-state + 引导文案）',
    homeWxml.includes('empty-state') && homeWxml.includes('今天还没记录') && homeWxml.includes('第一件'))
  check('H2 空状态点击进入记录页', homeWxml.includes('bindtap="goRecord"'))
  check('H2 空状态为轻量便签（不再引用 300px 大插画）',
    !homeWxml.includes('empty-img') && !/\.empty-img\s*\{[\s\S]*?width:\s*300px/.test(homeWxss) && homeWxml.includes('empty-cta'),
    '大向日葵插画应移除、紧凑便签应保留 empty-cta')
  check('H2 空状态去记录按钮存在', homeWxml.includes('去记录'))
  check('H2 fail-closed：无假 score/goal/summary 文案', !homeWxml.includes('默认进度') && !homeWxml.includes('模板数据'))

  // H3 骨架
  check('H3 summary=null → card-skeleton 组件', homeWxml.includes('card-skeleton'))
  check('H3 骨架有手绘线稿线条（sk-line）', homeWxml.includes('sk-line') || fs.readFileSync(path.join(ROOT, 'components/card-skeleton/card-skeleton.wxss'), 'utf8').includes('sk-line'))
  check('H3 无假 summary 文案冒充真实', !homeWxml.includes('今晚我会为你写一段温柔的回顾'))

  // H4 最近 7 天
  check('H4 最近 7 天卡片存在', homeWxml.includes('最近 7 天') && homeWxml.includes('weekDays'))
  check('H4 有记录亮圆点逻辑（week-dot on）', homeWxml.includes('week-dot') && homeWxml.includes('item.hasRecord ? \'on\' : \'\''))
  check('H4 日期跨月格式（fmtShort 8/20 样式）', homeJs.includes('fmtShort') && /`\$\{Number\(m\)\}\/\$\{Number\(d\)\}`/.test(homeJs))

  // 权限：首页 mood 以图标（moodSrc）展示，不绑定 mood.type/weather 私有字段文本
  const exposesMoodPrivate = homeWxml.includes('mood.type') || /\{\{mood\./.test(homeWxml)
  check('首页 mood 展示为几何图标（moodSrc），不暴露 mood.type/weather 私有字段',
    !exposesMoodPrivate && homeWxml.includes('moodSrc'), 'mood 私有字段被绑定')

  // cache：身份隔离（key 含 openid）
  check('缓存 key 含 openid 身份隔离', homeJs.includes('`dr_${openid}_${date}`') || homeJs.includes("'dr_' + openid"))

  // 视觉红线
  // 允许 scrapbook 使用的装饰符号（如 ♡ U+2661）；仅拦截真正的 emoji code point 区间。
  check('M3 首页无 emoji（wxml）', !/[\u{1F000}-\u{1FAFF}]/u.test(homeWxml.replace(/✓/g, '')), 'wxml 含 emoji')
  check('M3 首页 js 无 emoji 心情映射', !homeJs.includes('😊') && !homeJs.includes('☀️'))
  check('M3 首页无高饱和渐变', !homeWxss.includes('linear-gradient'), 'wxss 含渐变')

  // SOURCES 登记
  const sources = fs.readFileSync(path.join(ROOT, 'assets/illustrations/SOURCES.md'), 'utf8')
  check('首页空状态资源已登记 SOURCES.md（PLACEHOLDER）',
    sources.includes('home_empty') && sources.includes('PLACEHOLDER'))
}

async function main() {
  await runProfileStatsTests()
  runStaticTests()
  console.log('\n=== 结果: ' + passed + ' PASS / ' + failed + ' FAIL ===')
  if (failed) {
    failures.forEach(f => console.log('  - ' + f))
    process.exit(1)
  }
  console.log('M3 Home: ALL GREEN')
}

main().catch(e => { console.error('测试执行异常:', e); process.exit(1) })
