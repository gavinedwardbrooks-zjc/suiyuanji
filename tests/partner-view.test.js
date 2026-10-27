// ============================================================
// tests/partner-view.test.js · V1.1 P2 伴侣数据安全层
//
// 覆盖：
//   A normalizeResponse：成功/失败/结构非法 的归一化
//   B pickView 白名单：私人字段即使出现也不会进入页面
//   C requestPartnerView：请求载荷、日期透传、抛错/拒绝 → NETWORK
//   D createController：日期乱序、身份变化、页面离开 → 旧请求作废
//   E viewStateOf：有内容才 ready，其余 empty（不推断「对方没记录」）
//   F 页面接线静态守护：失败兜底、防过期写回、无越权字段、无保存入口
//
// 运行：node tests/partner-view.test.js
// ============================================================
const path = require('path')
const fs = require('fs')

const ROOT = path.resolve(__dirname, '..')
const {
  CODE, pickView, normalizeResponse, identityKeyOf,
  createController, requestPartnerView, viewStateOf
} = require(path.join(ROOT, 'utils/partner-view.js'))

let passed = 0, failed = 0, failures = []

function testCase(name, fn) {
  return Promise.resolve().then(fn).then(() => { passed++; console.log('  PASS  ' + name) })
    .catch(e => { failed++; failures.push(name + ': ' + e.message); console.log('  FAIL  ' + name + '  -> ' + e.message) })
}
function assertEq(a, b, msg) { if (a !== b) throw new Error((msg || '') + ' 期望 ' + JSON.stringify(b) + ' 实际 ' + JSON.stringify(a)) }
function assertOk(v, msg) { if (!v) throw new Error(msg || '断言失败') }
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8') }

// 服务端真实返回形状（见 cloudfunctions/getPartnerView 默认 view 分支）
function serverView(extra) {
  return Object.assign({
    ok: true,
    role: 'him',
    myPartnerName: '小胖',
    score: 4,
    wishes: [{ _id: 'w1', type: 'eat', text: '火锅', status: 'pending', createdAt: 1 }],
    messages: [{ _id: 'm1', text: 'hi', fromRole: 'her', createdAt: 1, readAt: null, mine: false }],
    unreadMsgs: 1,
    anniversary: '2025-05-20',
    days: 520,
    nextStart: null,
    nextLabel: '',
    partnerSummary: '今天还不错',
    partnerSummaryAt: 111,
    partnerRole: 'her'
  }, extra || {})
}

async function runAll() {
  console.log('\n=== Partner View · 伴侣数据安全层（V1.1 P2） ===\n')

  // ---- A. 归一化 ----
  await testCase('A1 ok:true → ok 且带 data', () => {
    const r = normalizeResponse({ result: serverView() })
    assertEq(r.ok, true)
    assertEq(r.data.score, 4)
    assertEq(r.data.partnerSummary, '今天还不错')
  })

  await testCase('A2 NOT_ACTIVE / UNAUTHORIZED / BAD_ACTION 原样透出 code', () => {
    for (const code of ['NOT_ACTIVE', 'UNAUTHORIZED', 'BAD_ACTION']) {
      const r = normalizeResponse({ result: { ok: false, code, msg: 'x' } })
      assertEq(r.ok, false)
      assertEq(r.code, code)
    }
  })

  await testCase('A3 结构非法 → UNKNOWN（不把 undefined 当好数据）', () => {
    for (const bad of [undefined, null, 'str', 42, {}, { result: undefined }, { result: 'x' }]) {
      const r = normalizeResponse(bad)
      assertEq(r.ok, false, JSON.stringify(bad))
      assertEq(r.code, CODE.UNKNOWN)
    }
  })

  await testCase('A4 ok:false 但没有 code → UNKNOWN', () => {
    const r = normalizeResponse({ result: { ok: false } })
    assertEq(r.ok, false)
    assertEq(r.code, CODE.UNKNOWN)
  })

  // ---- B. 白名单 ----
  await testCase('B1 私人字段即使被服务端带出也不会进入页面 data', () => {
    const d = pickView(serverView({
      segments: { life: '私密日记' },
      mood: { type: 'low', weather: 'rain' },
      goals: [{ text: '私密目标' }],
      todos: [{ text: '私密小事' }],
      herSummary: '她版小结',
      symptoms: 'x',
      body: 'y',
      _openid: 'secret'
    }))
    for (const k of ['segments', 'mood', 'goals', 'todos', 'herSummary', 'symptoms', 'body', '_openid']) {
      assertOk(!(k in d), '越权字段混入：' + k)
    }
    assertEq(d.score, 4)
    assertEq(d.partnerSummary, '今天还不错')
  })

  await testCase('B2 wishes 只保留白名单字段；非数组归一为空数组', () => {
    const d = pickView({ wishes: [{ _id: 'w', type: 'do', text: 't', status: 'pending', secret: 'x', createdAt: 2 }] })
    assertEq(Object.keys(d.wishes[0]).sort().join(','), '_id,createdAt,status,text,type')
    assertEq(pickView({ wishes: 'nope' }).wishes.length, 0)
    assertEq(pickView({}).wishes.length, 0)
  })

  await testCase('B3 评分语义取证：score-picker 把 0 渲染为「未打分」→ 0 是哨兵不是合法零分', () => {
    // 证据 1：组件模板里 0 走三元假分支
    const sp = read('components/score-picker/score-picker.wxml')
    assertOk(sp.includes("value ? value + ' / 5' : '未打分'"), 'score-picker 未把 0 表达为未打分')
    // 证据 2：0 没有对应文案，心形从 1 开始
    const js = read('components/score-picker/score-picker.js')
    assertOk(/wordMap:\s*\{\s*0:\s*''/.test(js), '0 应无评分文案')
    assertOk(js.includes('hearts: [1, 2, 3, 4, 5]'), '心形刻度应为 1..5，不含 0')
    // 证据 3：页面与 P2 的展示判断保持一致（> 0 才展示）
    for (const rel of ['pages/home/home.js', 'pages/record/record.js']) {
      assertOk(read(rel).includes("typeof d.score === 'number' && d.score > 0"), rel + ' 评分存在性判断与既有语义不一致')
    }
  })

  await testCase('B4 null（无记录）与 0（有记录未打分）都归为无评分，文案不误导', () => {
    // 服务端：rec 存在时给 rec.score（可能是 0），rec 不存在时给 null
    assertEq(viewStateOf({ score: null }), 'empty')
    assertEq(viewStateOf({ score: 0 }), 'empty')
    // 两者都落到「还没有评分」，不声称对方有没有记录
  })

  await testCase('B5 空状态文案不得表述为「没有记录 / 未记录」', () => {
    for (const rel of ['pages/home/home.wxml', 'pages/record/record.wxml']) {
      const src = read(rel)
      const i = src.indexOf('wx:elif="{{viewMode === \'companion\'}}"')
      const region = src.slice(i)
      for (const bad of ['没有记录', '未记录', '没写记录', '今天没记录']) {
        assertOk(region.indexOf(bad) === -1, rel + ' 空状态出现会误导的表述：' + bad)
      }
      assertOk(region.includes('没有可查看的共享内容'), rel + ' 缺中性空状态文案')
    }
  })

  // ---- C. 取数 ----
  await testCase('C1 请求载荷固定为 getPartnerView + action:view，并透传日期', async () => {
    let seen = null
    const call = (payload) => { seen = payload; return Promise.resolve({ result: serverView() }) }
    await requestPartnerView('2026-10-01', call)
    assertEq(seen.name, 'getPartnerView')
    assertEq(seen.data.action, 'view')
    assertEq(seen.data.date, '2026-10-01')
  })

  await testCase('C2 不带日期时不传 date 字段（由服务端取今天）', async () => {
    let seen = null
    const call = (payload) => { seen = payload; return Promise.resolve({ result: serverView() }) }
    await requestPartnerView('', call)
    assertOk(!('date' in seen.data), '空日期不应传 date')
  })

  await testCase('C3 云函数抛错 / Promise 拒绝 → NETWORK（不抛出到页面）', async () => {
    const thrower = () => { throw new Error('boom') }
    const r1 = await requestPartnerView('2026-10-01', thrower)
    assertEq(r1.ok, false); assertEq(r1.code, CODE.NETWORK)
    const rejecter = () => Promise.reject(new Error('net'))
    const r2 = await requestPartnerView('2026-10-01', rejecter)
    assertEq(r2.ok, false); assertEq(r2.code, CODE.NETWORK)
  })

  await testCase('C4 未注入调用函数 → UNKNOWN（不静默成功）', async () => {
    const r = await requestPartnerView('2026-10-01', null)
    assertEq(r.ok, false)
    assertEq(r.code, CODE.UNKNOWN)
  })

  await testCase('C5 NOT_ACTIVE 透传到页面（用于 blocked 状态）', async () => {
    const call = () => Promise.resolve({ result: { ok: false, code: 'NOT_ACTIVE', msg: 'x' } })
    const r = await requestPartnerView('2026-10-01', call)
    assertEq(r.ok, false)
    assertEq(r.code, 'NOT_ACTIVE')
  })

  // ---- D. 防过期令牌 ----
  await testCase('D1 日期乱序：后发请求让先前请求作废', () => {
    const c = createController()
    const t1 = c.begin().token      // 10/01
    const t2 = c.begin().token      // 10/02（用户连点）
    assertEq(c.isCurrent(t1), false, '慢请求不得覆盖新日期')
    assertEq(c.isCurrent(t2), true)
  })

  await testCase('D2 身份变化（换绑/换账号）：旧令牌作废并报告变化', () => {
    const c = createController()
    assertEq(c.watchIdentity({ openid: 'A', role: 'him', coupleId: 'CZ-1' }), false, '首次只记录')
    const t = c.begin().token
    assertEq(c.watchIdentity({ openid: 'A', role: 'him', coupleId: 'CZ-2' }), true, 'coupleId 变化要报告')
    assertEq(c.isCurrent(t), false, '换绑后旧请求必须作废')
  })

  await testCase('D3 页面离开（invalidate）：在途请求作废', () => {
    const c = createController()
    const t = c.begin().token
    c.invalidate()
    assertEq(c.isCurrent(t), false)
  })

  await testCase('D4 身份未变时不应误发作废', () => {
    const c = createController()
    c.watchIdentity({ openid: 'A', role: 'him', coupleId: 'CZ-1' })
    const t = c.begin().token
    assertEq(c.watchIdentity({ openid: 'A', role: 'him', coupleId: 'CZ-1' }), false)
    assertEq(c.isCurrent(t), true, '同一身份下请求应正常写回')
  })

  await testCase('D5 identityKey 归一：undefined / null / 空白等价', () => {
    assertEq(identityKeyOf({ openid: 'A', role: 'him', coupleId: undefined }),
      identityKeyOf({ openid: 'A', role: 'him', coupleId: null }))
    assertEq(identityKeyOf({ openid: 'A', role: 'him', coupleId: '  ' }),
      identityKeyOf({ openid: 'A', role: 'him', coupleId: '' }))
    assertOk(identityKeyOf({ openid: 'A', role: 'him', coupleId: 'CZ-1' }) !==
      identityKeyOf({ openid: 'A', role: 'her', coupleId: 'CZ-1' }), '角色变化必须可识别')
  })

  await testCase('D6 页面隐藏后重新显示：旧令牌失效，新令牌有效（不沿用隐藏期间的旧结果）', () => {
    const c = createController()
    const beforeHide = c.begin().token
    c.invalidate()                 // onHide
    assertEq(c.isCurrent(beforeHide), false, '隐藏前的请求不得写回')
    const afterShow = c.begin().token // onShow 重新请求
    assertEq(c.isCurrent(afterShow), true)
    assertEq(c.isCurrent(beforeHide), false)
  })

  await testCase('D7 本地 bound=true 不等于服务端授权：NOT_ACTIVE 必须落到 blocked', () => {
    for (const rel of ['pages/home/home.js', 'pages/record/record.js']) {
      const src = read(rel)
      assertOk(src.includes("res.code === 'NOT_ACTIVE'"), rel + ' 未处理 NOT_ACTIVE')
      assertOk(src.includes("pvState: blocked ? 'blocked' : 'error'"), rel + ' NOT_ACTIVE 未落到 blocked')
    }
  })

  // ---- E. 状态判定 ----
  await testCase('E1 有评分/小结/心愿任一 → ready', () => {
    assertEq(viewStateOf({ score: 4 }), 'ready')
    assertEq(viewStateOf({ partnerSummary: 'a' }), 'ready')
    assertEq(viewStateOf({ wishes: [{ _id: 'w' }] }), 'ready')
  })

  await testCase('E2 全空 / score=0 → empty（不推断对方没记录）', () => {
    assertEq(viewStateOf({}), 'empty')
    assertEq(viewStateOf({ score: 0, partnerSummary: '', wishes: [] }), 'empty')
    assertEq(viewStateOf({ partnerSummary: '   ' }), 'empty')
  })

  // ---- F. 页面接线静态守护 ----
  await testCase('F1 两页都只经 partner-view 取数，且写回前校验令牌', () => {
    for (const rel of ['pages/home/home.js', 'pages/record/record.js']) {
      const src = read(rel)
      assertOk(src.includes("require('../../utils/partner-view')"), rel + ' 未引入 partner-view')
      assertOk(src.includes('requestPartnerView('), rel + ' 未使用统一取数')
      assertOk(src.includes('if (!ctl.isCurrent(token)) return'), rel + ' 缺防过期写回校验')
      assertOk(src.includes('ctl.watchIdentity(g)'), rel + ' 缺身份变化检测')
      assertOk(src.indexOf("name: 'getPartnerView'") === -1, rel + ' 绕过统一入口直接调用云函数')
    }
  })

  await testCase('F2 请求开始即清空旧数据，失败不回退', () => {
    for (const rel of ['pages/home/home.js', 'pages/record/record.js']) {
      const src = read(rel)
      assertOk(src.includes("pvState: 'loading'"), rel + ' 请求开始未置 loading')
      assertOk(/pvState:\s*blocked \? 'blocked' : 'error'/.test(src), rel + ' 失败未区分 blocked / error')
      // 失败分支里不得再写 pvScore / pvSummary（即不得保留旧内容）
      const failBlock = src.slice(src.indexOf("pvState: blocked ? 'blocked' : 'error'"))
      assertOk(!/pvScore:/.test(failBlock.slice(0, 200)), rel + ' 失败分支仍在写旧数据')
    }
  })

  await testCase('F3 记录页：非 owner 模式不得读/写个人记录', () => {
    const src = read('pages/record/record.js')
    assertOk(/loadDay\(date\)\s*\{\s*\n\s*\/\/[^\n]*\n\s*if \(this\.data\.viewMode !== VIEW_MODE_OWNER\) return/.test(src),
      'loadDay 缺模式守卫')
    assertOk(/save\(showTip\)\s*\{[\s\S]{0,200}viewMode !== VIEW_MODE_OWNER\) return/.test(src), 'save 缺模式守卫')
  })

  await testCase('F4 companion 区域不出现未经授权直接引用的私人字段（P3.1 只允许 pvShared.*）', () => {
    for (const rel of ['pages/home/home.wxml', 'pages/record/record.wxml']) {
      const src = read(rel)
      const i = src.indexOf('wx:elif="{{viewMode === \'companion\'}}"')
      assertOk(i !== -1, rel + ' 缺 companion 分支')
      const region = src.slice(i) // owner 分支在上方，天然排除
      // P3 之后 companion 会展示「她主动共享」的三段日记，但**只能**经由
      // pvShared（服务端授权后的白名单字段）读取；其余私人字段与保存入口仍然禁止。
      for (const bad of ['goals', 'todos', 'herSummary', 'herReport', 'symptoms',
        'record-save-btn', 'onSaveTap', 'pvGoals', 'pvSegments', 'pvRecord']) {
        assertOk(region.indexOf(bad) === -1, rel + ' companion 区域出现越权内容：' + bad)
      }
      for (const line of region.split('\n')) {
        if (line.indexOf('segments') !== -1) {
          assertOk(line.indexOf('pvShared.') !== -1,
            rel + ' companion 出现未经 pvShared 白名单的日记字段：' + line.trim())
        }
      }
      assertOk(region.indexOf('record.') === -1, rel + ' companion 直接引用了原始记录字段')
    }
  })

  await testCase('F5 两页都有 companion-blocked 安全状态分支', () => {
    for (const rel of ['pages/home/home.wxml', 'pages/record/record.wxml']) {
      assertOk(read(rel).includes('wx:elif="{{viewMode === \'companion-blocked\'}}"'),
        rel + ' 缺 companion-blocked 分支')
    }
  })

  await testCase('F7 清空发生在发起请求之前（等待期不得看到旧内容）', () => {
    const anchors = [
      ['pages/home/home.js', 'loadCompanion() {'],
      ['pages/record/record.js', '_loadPv(date) {']
    ]
    for (const [rel, anchor] of anchors) {
      const src = read(rel)
      const start = src.indexOf(anchor)
      assertOk(start > -1, rel + ' 找不到取数函数')
      const body = src.slice(start, start + 1200)
      const clearIdx = body.indexOf("pvState: 'loading'")
      const reqIdx = body.indexOf('requestPartnerView(')
      assertOk(clearIdx > -1, rel + ' 取数函数内未清空')
      assertOk(reqIdx > -1, rel + ' 取数函数内未发起请求')
      assertOk(clearIdx < reqIdx, rel + ' 清空晚于请求，会出现旧内容闪现')
    }
  })

  await testCase('F8 服务端角色必须与陪伴视图一致，否则按未授权处理', () => {
    for (const rel of ['pages/home/home.js', 'pages/record/record.js']) {
      const src = read(rel)
      assertOk(src.includes("if (d.role !== 'him')"), rel + ' 缺服务端角色一致性校验')
      assertOk(src.includes("pvCode: 'ROLE_MISMATCH'"), rel + ' 缺 ROLE_MISMATCH 状态')
      // 校验必须发生在写入展示字段之前
      const i = src.indexOf("if (d.role !== 'him')")
      const j = src.indexOf('pvScore:', i)
      assertOk(j === -1 || j > i, rel + ' 角色校验晚于数据写入')
    }
  })

  await testCase('F9 blocked / error 状态都能回到「我们」页或重试，不留在死胡同', () => {
    for (const rel of ['pages/home/home.wxml', 'pages/record/record.wxml']) {
      const src = read(rel)
      assertOk(src.includes('bindtap="goOurs"'), rel + ' 缺去「我们」页入口')
      assertOk(src.includes('重试'), rel + ' 缺重试入口')
    }
  })

  console.log('\n=== 结果: ' + passed + ' PASS / ' + failed + ' FAIL ===')
  if (failures.length) {
    failures.forEach(f => console.log('  - ' + f))
    process.exit(1)
  }
  console.log('Partner View: ALL GREEN')
}

runAll().catch(e => { console.error(e); process.exit(1) })
