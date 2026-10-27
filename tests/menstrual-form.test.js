// ============================================================
// tests/menstrual-form.test.js · 经期设置「输入不显示 / 无法保存」回归
//
// 覆盖的真实 Bug（用户实测）：
//   · 周期输入 30、持续天数输入 7，输入框不显示数字
//   · 因为值留不住，保存也随之失败
//
// 根因（两处，缺一不可）：
//   1) 竞态：onLoad / onShow / 切月都会发 menstrual get，慢网络下响应在用户
//      开始输入之后才到达 → setData 把刚输入的 cycle/periodLen 覆盖回旧值。
//   2) 表现：data 里 cycle/periodLen 初始是 number，用户输入后变成 string，
//      类型混杂 + 输入框没有 placeholder/maxlength/显式高度，值为空时看着就是个空框。
//
// 修复：raw 输入态（字符串）+ `_formDirty` 脏标记（脏了就不回填表单字段）+
//       纯数字过滤 + 严格整数校验 + 保存后以服务端回读值为准。
//
// 运行：node tests/menstrual-form.test.js
// ============================================================
const path = require('path')
const fs = require('fs')

const ROOT = path.resolve(__dirname, '..')

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
// 日历页 harness：加载**真实的** pages/calendar/calendar.js
// ------------------------------------------------------------
function loadPage() {
  let pageDef = null
  const calls = []
  const toasts = []
  const modals = []

  global.getApp = () => ({ globalData: { role: 'her' } })
  global.Page = (def) => { pageDef = def }
  global.wx = {
    cloud: {
      callFunction({ name, data }) {
        return new Promise((resolve, reject) => calls.push({ name, data, resolve, reject }))
      }
    },
    showToast: (o) => toasts.push(o.title),
    showModal: (o) => modals.push(o)
  }

  const pagePath = path.join(ROOT, 'pages/calendar/calendar.js')
  delete require.cache[pagePath]
  require(pagePath)

  return {
    pageDef,
    calls,
    toasts,
    modals,
    // 新建一个页面实例（模拟「重新进入页面」）
    open() {
      const p = Object.create(pageDef)
      p.data = JSON.parse(JSON.stringify(pageDef.data))
      p.setData = function (patch) { Object.assign(this.data, patch) }
      p.onLoad()
      p.onShow()
      return p
    },
    // 取最近一个未响应的调用
    take(action) {
      for (let i = calls.length - 1; i >= 0; i--) {
        if (calls[i].data && calls[i].data.action === action && !calls[i].settled) {
          return calls[i]
        }
      }
      return null
    },
    takeAll(action) {
      return calls.filter(c => c.data && c.data.action === action && !c.settled)
    },
    find(action) {
      return calls.filter(c => c.data && c.data.action === action)
    }
  }
}

function resolveCall(call, result) {
  call.settled = true
  call.resolve({ result })
}

function tick(n) {
  return new Promise(r => setTimeout(r, n || 5))
}

const CLOUD_RECORD = {
  lastStart: '2026-10-01',
  cycle: 28,
  periodLen: 5,
  nextStart: '2026-10-29',
  revision: 3
}

// ==================== A. 输入即时可见 ====================
async function runInputTests() {
  console.log('\n=== A · 输入数字必须实时可见 ===\n')

  await testCase('A1 输入周期 30、持续 7 → data 立即可见且为字符串', async () => {
    const h = loadPage()
    const p = h.open()
    p.toggleSetting()
    p.onCycle({ detail: { value: '3' } })
    p.onCycle({ detail: { value: '30' } })
    p.onPeriodLen({ detail: { value: '7' } })
    assertEq(p.data.cycle, '30', '周期')
    assertEq(p.data.periodLen, '7', '持续天数')
    assertOk(typeof p.data.cycle === 'string', 'cycle 必须是字符串（避免类型混杂）')
    assertOk(typeof p.data.periodLen === 'string', 'periodLen 必须是字符串')
  })

  await testCase('A2 逐位输入 3 → 30 不丢字', async () => {
    const h = loadPage()
    const p = h.open()
    p.toggleSetting()
    const seq = ['3', '30']
    for (const v of seq) p.onCycle({ detail: { value: v } })
    assertEq(p.data.cycle, '30')
  })

  await testCase('A3 删除后重新输入：空串 → 正常保留', async () => {
    const h = loadPage()
    const p = h.open()
    p.toggleSetting()
    p.onCycle({ detail: { value: '' } })
    assertEq(p.data.cycle, '', '全删后应为空串（不回退成旧值）')
    p.onCycle({ detail: { value: '7' } })
    assertEq(p.data.cycle, '7')
  })

  await testCase('A4 非数字字符被过滤，不会留在输入框里', async () => {
    const h = loadPage()
    const p = h.open()
    p.toggleSetting()
    p.onCycle({ detail: { value: 'a3b0' } })
    assertEq(p.data.cycle, '30', '只保留数字')
    p.onPeriodLen({ detail: { value: '7 天' } })
    assertEq(p.data.periodLen, '7')
  })

  await testCase('A5 超长输入被截断（周期 3 位 / 持续 2 位）', async () => {
    const h = loadPage()
    const p = h.open()
    p.toggleSetting()
    p.onCycle({ detail: { value: '1234' } })
    assertEq(p.data.cycle, '123')
    p.onPeriodLen({ detail: { value: '789' } })
    assertEq(p.data.periodLen, '78')
  })

  await testCase('A6 失焦时空值整理为默认值，不静默存 0', async () => {
    const h = loadPage()
    const p = h.open()
    p.toggleSetting()
    p.onCycle({ detail: { value: '' } })
    p.onCycleBlur()
    assertEq(p.data.cycle, '28')
    p.onPeriodLen({ detail: { value: '' } })
    p.onPeriodLenBlur()
    assertEq(p.data.periodLen, '5')
  })

  await testCase('A7 周期与持续天数各走各的字段，不串用', async () => {
    const h = loadPage()
    const p = h.open()
    p.toggleSetting()
    p.onCycle({ detail: { value: '30' } })
    assertEq(p.data.periodLen, '5', '改周期不得影响持续天数')
    p.onPeriodLen({ detail: { value: '7' } })
    assertEq(p.data.cycle, '30', '改持续天数不得影响周期')
  })
}

// ==================== B. 核心回归：异步 get 不得覆盖输入 ====================
async function runRaceTests() {
  console.log('\n=== B · 慢网络下云端 get 后到达，不得覆盖用户输入（核心 Bug） ===\n')

  await testCase('B1 get 在用户输入之后才返回 → 输入的值必须保留', async () => {
    const h = loadPage()
    const p = h.open()
    // 用户先展开面板并输入（此时 get 还在飞）
    p.toggleSetting()
    p.onCycle({ detail: { value: '3' } })
    p.onCycle({ detail: { value: '30' } })
    p.onPeriodLen({ detail: { value: '7' } })
    // 慢响应现在才到，带着旧值 28 / 5
    h.takeAll('get').forEach(c => resolveCall(c, { ok: true, configured: true, record: CLOUD_RECORD }))
    h.takeAll('month').forEach(c => resolveCall(c, { ok: true, configured: true, days: [] }))
    await tick(10)
    assertEq(p.data.cycle, '30', '旧实现会把这里覆盖回 28')
    assertEq(p.data.periodLen, '7', '旧实现会把这里覆盖回 5')
  })

  await testCase('B2 慢 get 仍然更新派生字段（nextStart / revision）', async () => {
    const h = loadPage()
    const p = h.open()
    p.toggleSetting()
    p.onCycle({ detail: { value: '30' } })
    h.takeAll('get').forEach(c => resolveCall(c, { ok: true, configured: true, record: CLOUD_RECORD }))
    h.takeAll('month').forEach(c => resolveCall(c, { ok: true, configured: true, days: [] }))
    await tick(10)
    assertEq(p.data.revision, 3, '乐观锁 revision 必须同步（否则保存必然冲突）')
    assertEq(p.data.nextStart, '2026-10-29')
  })

  await testCase('B3 用户未输入时，get 正常回填云端值', async () => {
    const h = loadPage()
    const p = h.open()
    h.takeAll('get').forEach(c => resolveCall(c, { ok: true, configured: true, record: CLOUD_RECORD }))
    h.takeAll('month').forEach(c => resolveCall(c, { ok: true, configured: true, days: [] }))
    await tick(10)
    assertEq(p.data.cycle, '28')
    assertEq(p.data.periodLen, '5')
    assertEq(p.data.lastStart, '2026-10-01')
  })

  await testCase('B4 重新展开设置面板 → 脏标记归零，展示最新云端值', async () => {
    const h = loadPage()
    const p = h.open()
    p.toggleSetting()
    p.onCycle({ detail: { value: '99' } })
    assertOk(p._formDirty === true, '输入后应为脏')
    p.toggleSetting() // 收起
    p.toggleSetting() // 再展开
    assertOk(p._formDirty === false, '展开面板应重置脏标记')
  })

  await testCase('B5 首屏只发一次 get（onLoad 不再重复请求）', async () => {
    const h = loadPage()
    h.open()
    const gets = h.find('get')
    assertEq(gets.length, 1, 'onLoad + onShow 应只产生 1 次 get')
  })
}

// ==================== C. 保存链路 ====================
async function runSaveTests() {
  console.log('\n=== C · 保存：payload 正确、失败不谎报、重进仍显示 ===\n')

  await testCase('C1 输入 30 / 7 → 保存 payload 为数字 30 / 7，且不含 _openid', async () => {
    const h = loadPage()
    const p = h.open()
    h.takeAll('get').forEach(c => resolveCall(c, { ok: true, configured: true, record: CLOUD_RECORD }))
    h.takeAll('month').forEach(c => resolveCall(c, { ok: true, configured: true, days: [] }))
    await tick(10)
    p.toggleSetting()
    p.onCycle({ detail: { value: '30' } })
    p.onPeriodLen({ detail: { value: '7' } })
    p.saveMenstrual()
    const save = h.take('save')
    assertOk(save, '未发出 save 请求')
    assertEq(save.data.cycle, 30, 'cycle 必须是数字')
    assertEq(save.data.periodLen, 7, 'periodLen 必须是数字')
    assertEq(save.data.lastStart, '2026-10-01')
    assertEq(save.data.revision, 3, '必须带乐观锁 revision')
    assertOk(save.data._openid === undefined, 'payload 不得包含 _openid（身份由 WXContext 决定）')
  })

  await testCase('C2 保存成功 → 表单回填服务端回读值、面板收起、脏标记清除', async () => {
    const h = loadPage()
    const p = h.open()
    h.takeAll('get').forEach(c => resolveCall(c, { ok: true, configured: true, record: CLOUD_RECORD }))
    h.takeAll('month').forEach(c => resolveCall(c, { ok: true, configured: true, days: [] }))
    await tick(10)
    p.toggleSetting()
    p.onCycle({ detail: { value: '30' } })
    p.onPeriodLen({ detail: { value: '7' } })
    p.saveMenstrual()
    resolveCall(h.take('save'), { ok: true, revision: 4, nextStart: '2026-10-31', periodLen: 7 })
    await tick(10)
    assertEq(p.data.cycle, '30')
    assertEq(p.data.periodLen, '7')
    assertEq(p.data.revision, 4)
    assertEq(p.data.open, false, '保存后面板应收起')
    assertOk(p._formDirty === false, '保存成功应清脏标记，允许后续 get 回填')
    assertOk(p.data.saving === false, 'saving 必须复位')
  })

  await testCase('C3 保存后关闭页面重进 → 仍显示 30 / 7', async () => {
    const h = loadPage()
    // 第一次进入：保存 30 / 7
    const p1 = h.open()
    h.takeAll('get').forEach(c => resolveCall(c, { ok: true, configured: true, record: CLOUD_RECORD }))
    h.takeAll('month').forEach(c => resolveCall(c, { ok: true, configured: true, days: [] }))
    await tick(10)
    p1.toggleSetting()
    p1.onCycle({ detail: { value: '30' } })
    p1.onPeriodLen({ detail: { value: '7' } })
    p1.saveMenstrual()
    resolveCall(h.take('save'), { ok: true, revision: 1, nextStart: '2026-10-31', periodLen: 7 })
    await tick(10)
    h.takeAll('get').forEach(c => resolveCall(c, { ok: true, configured: true, record: { lastStart: '2026-10-01', cycle: 30, periodLen: 7, nextStart: '2026-10-31', revision: 1 } }))
    h.takeAll('month').forEach(c => resolveCall(c, { ok: true, configured: true, days: [] }))
    await tick(10)
    // 重新进入（新实例，全新 data）
    const p2 = h.open()
    h.takeAll('get').forEach(c => resolveCall(c, { ok: true, configured: true, record: { lastStart: '2026-10-01', cycle: 30, periodLen: 7, nextStart: '2026-10-31', revision: 1 } }))
    h.takeAll('month').forEach(c => resolveCall(c, { ok: true, configured: true, days: [] }))
    await tick(10)
    assertEq(p2.data.cycle, '30', '重进后周期')
    assertEq(p2.data.periodLen, '7', '重进后持续天数')
  })

  await testCase('C4 周期 61 非法 → 明确提示且不发请求', async () => {
    const h = loadPage()
    const p = h.open()
    h.takeAll('get').forEach(c => resolveCall(c, { ok: true, configured: true, record: CLOUD_RECORD }))
    h.takeAll('month').forEach(c => resolveCall(c, { ok: true, configured: true, days: [] }))
    await tick(10)
    p.toggleSetting()
    p.onCycle({ detail: { value: '61' } })
    const before = h.find('save').length
    p.saveMenstrual()
    assertEq(h.find('save').length, before, '非法输入不得发请求')
    assertOk(h.toasts.some(t => t.indexOf('15~60') !== -1), '应提示周期范围，实际: ' + h.toasts.join('|'))
  })

  await testCase('C5 持续天数 0 / 11 非法 → 明确提示，不误判常见的 7 天', async () => {
    for (const bad of ['0', '11']) {
      const h = loadPage()
      const p = h.open()
      h.takeAll('get').forEach(c => resolveCall(c, { ok: true, configured: true, record: CLOUD_RECORD }))
      h.takeAll('month').forEach(c => resolveCall(c, { ok: true, configured: true, days: [] }))
      await tick(10)
      p.toggleSetting()
      p.onPeriodLen({ detail: { value: bad } })
      p.saveMenstrual()
      assertEq(h.find('save').length, 0, bad + ' 不应发请求')
      assertOk(h.toasts.some(t => t.indexOf('1~10') !== -1), bad + ' 应提示持续天数范围，实际: ' + h.toasts.join('|'))
    }
  })

  await testCase('C6 常见值 30 / 7 不被误判为非法', async () => {
    const h = loadPage()
    const p = h.open()
    h.takeAll('get').forEach(c => resolveCall(c, { ok: true, configured: true, record: CLOUD_RECORD }))
    h.takeAll('month').forEach(c => resolveCall(c, { ok: true, configured: true, days: [] }))
    await tick(10)
    p.toggleSetting()
    p.onCycle({ detail: { value: '30' } })
    p.onPeriodLen({ detail: { value: '7' } })
    p.saveMenstrual()
    assertEq(h.find('save').length, 1, '30 / 7 必须允许保存')
  })

  await testCase('C7 保存失败 → 不谎报成功：saving 复位 + 失败提示', async () => {
    const h = loadPage()
    const p = h.open()
    h.takeAll('get').forEach(c => resolveCall(c, { ok: true, configured: true, record: CLOUD_RECORD }))
    h.takeAll('month').forEach(c => resolveCall(c, { ok: true, configured: true, days: [] }))
    await tick(10)
    p.toggleSetting()
    p.onCycle({ detail: { value: '30' } })
    p.onPeriodLen({ detail: { value: '7' } })
    p.saveMenstrual()
    resolveCall(h.take('save'), { ok: false, code: 'INTERNAL', msg: '保存失败' })
    await tick(10)
    assertEq(p.data.saving, false)
    assertEq(p.data.open, true, '失败时面板不能收起（否则用户以为成功了）')
    assertOk(h.toasts.indexOf('保存成功') === -1, '失败时绝不能提示保存成功')
    assertOk(h.toasts.some(t => t === '保存失败' || t.indexOf('失败') !== -1), '应有失败提示')
  })

  await testCase('C8 未绑定/关系失效 → 云函数返回 NOT_ACTIVE，前端原样提示不谎报', async () => {
    const h = loadPage()
    const p = h.open()
    h.takeAll('get').forEach(c => resolveCall(c, { ok: true, configured: true, record: CLOUD_RECORD }))
    h.takeAll('month').forEach(c => resolveCall(c, { ok: true, configured: true, days: [] }))
    await tick(10)
    p.toggleSetting()
    p.onCycle({ detail: { value: '30' } })
    p.saveMenstrual()
    resolveCall(h.take('save'), { ok: false, code: 'NOT_ACTIVE', msg: '当前情侣关系未生效，请重新绑定后再设置' })
    await tick(10)
    assertEq(p.data.saving, false)
    assertOk(h.toasts.some(t => t.indexOf('情侣关系') !== -1), '应显示关系失效原因: ' + h.toasts.join('|'))
  })

  await testCase('C9 保存进行中重复点击 → 只发一次请求', async () => {
    const h = loadPage()
    const p = h.open()
    h.takeAll('get').forEach(c => resolveCall(c, { ok: true, configured: true, record: CLOUD_RECORD }))
    h.takeAll('month').forEach(c => resolveCall(c, { ok: true, configured: true, days: [] }))
    await tick(10)
    p.toggleSetting()
    p.onCycle({ detail: { value: '30' } })
    p.saveMenstrual()
    p.saveMenstrual()
    p.saveMenstrual()
    assertEq(h.find('save').length, 1, 'saving 期间必须挡住重复提交')
  })
}

// ==================== D. 静态约束 ====================
async function runStaticTests() {
  console.log('\n=== D · 结构与契约静态检查 ===\n')

  const wxml = fs.readFileSync(path.join(ROOT, 'pages/calendar/calendar.wxml'), 'utf8')
  const wxss = fs.readFileSync(path.join(ROOT, 'pages/calendar/calendar.wxss'), 'utf8')
  const js = fs.readFileSync(path.join(ROOT, 'pages/calendar/calendar.js'), 'utf8')
  const cloud = fs.readFileSync(path.join(ROOT, 'cloudfunctions/menstrual/index.js'), 'utf8')

  await testCase('D1 两个数字输入框都有 placeholder 兜底 + maxlength', async () => {
    const inputs = wxml.match(/<input[^>]*num-input[^>]*>/g) || []
    assertEq(inputs.length, 2, '应有 2 个数字输入框')
    for (const tag of inputs) {
      assertOk(/placeholder="/.test(tag), '缺 placeholder: ' + tag)
      assertOk(/maxlength="/.test(tag), '缺 maxlength: ' + tag)
      assertOk(/bindblur=/.test(tag), '缺 bindblur 兜底: ' + tag)
    }
  })

  await testCase('D2 .num-input 有显式高度与盒模型，不会被内边距挤成空框', async () => {
    const block = /\.num-input\s*\{([^}]*)\}/.exec(wxss)
    assertOk(block, '未找到 .num-input 样式')
    const body = block[1]
    assertOk(/min-height\s*:/.test(body), '缺 min-height')
    assertOk(/box-sizing\s*:\s*border-box/.test(body), '缺 box-sizing:border-box')
    assertOk(/flex\s*:\s*0\s+0\s+auto/.test(body), '缺 flex:0 0 auto（会被左侧文案挤压）')
  })

  await testCase('D3 页面变量声明了范围常量且与提示文案一致', async () => {
    assertOk(/CYCLE_MIN\s*=\s*15/.test(js), 'CYCLE_MIN')
    assertOk(/CYCLE_MAX\s*=\s*60/.test(js), 'CYCLE_MAX')
    assertOk(/PERIOD_MIN\s*=\s*1/.test(js), 'PERIOD_MIN')
    assertOk(/PERIOD_MAX\s*=\s*10/.test(js), 'PERIOD_MAX')
    assertOk(wxml.indexOf('15~60') !== -1 && wxml.indexOf('1~10') !== -1, 'wxml 应显示范围提示')
  })

  await testCase('D4 前端不直写数据库 / 不带 _openid', async () => {
    assertOk(!/db\.collection\(/.test(js), '前端不得直接操作数据库')
    assertOk(!/_openid\s*:/.test(js), '前端不得传 _openid')
  })

  await testCase('D5 云函数保存前校验关系状态，且区分 NOT_ACTIVE 与 FORBIDDEN', async () => {
    const saveBlock = cloud.slice(cloud.indexOf("action === 'save'"), cloud.indexOf("action === 'save'") + 800)
    assertOk(/NOT_ACTIVE/.test(saveBlock), 'NOT_ACTIVE 分支缺失（会把权限问题误报成角色问题）')
    assertOk(/FORBIDDEN/.test(saveBlock), 'FORBIDDEN 分支缺失')
    assertOk(saveBlock.indexOf('NOT_ACTIVE') < saveBlock.indexOf('FORBIDDEN') ||
      /findHerOpenid\(OPENID\)[\s\S]*?=== null[\s\S]*?NOT_ACTIVE/.test(saveBlock), '先判关系再判角色')
  })

  await testCase('D6 云函数不做破坏性写（无 remove / 无重置用户数据）', async () => {
    assertOk(!/\.remove\(/.test(cloud), '经期云函数不得删除记录')
    assertOk(!/drop|清空/.test(cloud), '不得含清空逻辑')
  })
}

// ==================== 主流程 ====================
;(async () => {
  console.log('========================================')
  console.log(' 经期设置输入 / 保存 Bug 回归测试')
  console.log('========================================')
  await runInputTests()
  await runRaceTests()
  await runSaveTests()
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
