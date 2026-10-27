// ============================================================
// tests/p3-share-client.test.js · V1.1 P3 客户端安全层 + 页面行为
//
// 覆盖：
//   A utils/record-share.js：严格布尔、文案、预览（只基于已保存内容）
//   B utils/partner-view.js：shared 白名单裁剪
//
// 记录级互动已在 V1.1 收尾移除：原 A6 / A7（点赞与留言归一）、B3（互动白名单）、
// D2 / D3 / D4（点赞与留言交互）随功能删除。
//   C 记录页（her）：分享状态加载、二次确认、失败不假装成功、日期竞态
//   D 记录页（him）：共享展示、点赞、留言、撤销后清空
//   E 版本兼容：旧客户端白名单丢弃新字段；新客户端遇旧云函数安全降级
//
// 运行：node tests/p3-share-client.test.js
// ============================================================
const path = require('path')
const fs = require('fs')

const ROOT = path.resolve(__dirname, '..')
const RECORD_PAGE = path.join(ROOT, 'pages/record/record.js')

const shareApi = require(path.join(ROOT, 'utils/record-share.js'))
const pv = require(path.join(ROOT, 'utils/partner-view.js'))

const D_A = '2026-10-20'
const D_B = '2026-10-21'

let passed = 0, failed = 0, failures = []

function testCase(name, fn) {
  return Promise.resolve().then(fn).then(() => { passed++; console.log('  PASS  ' + name) })
    .catch(e => { failed++; failures.push(name + ': ' + e.message); console.log('  FAIL  ' + name + '  -> ' + e.message) })
}
function assertEq(a, b, msg) {
  if (a !== b) throw new Error((msg || '') + ' 期望 ' + JSON.stringify(b) + ' 实际 ' + JSON.stringify(a))
}
function assertOk(v, msg) { if (!v) throw new Error(msg || '断言失败') }
function assertNo(text, needle, msg) {
  if (String(text).indexOf(needle) !== -1) throw new Error((msg || '') + ' 出现了不该出现的内容: ' + needle)
}
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8') }

const flush = () => new Promise(r => setTimeout(r, 0))
function deferred() {
  let resolve, reject
  const p = new Promise((res, rej) => { resolve = res; reject = rej })
  return { p, resolve, reject }
}

// ============================================================
// 记录页 harness（真实页面代码 + 假 wx）
// ============================================================
function loadRecordPage(opts) {
  const o = opts || {}
  const store = new Map()
  for (const k of Object.keys(o.storage || {})) store.set(k, o.storage[k])
  const calls = []
  const toasts = []
  const modals = []

  global.wx = {
    cloud: {
      callFunction: (args) => {
        calls.push(args)
        const action = args.data && args.data.action
        const handler = (o.responses || {})[action]
        if (!handler) return Promise.resolve({ result: { ok: true } })
        return Promise.resolve(handler(args.data, args.name)).then(result => ({ result }))
      }
    },
    getStorageSync: (k) => (store.has(k) ? store.get(k) : ''),
    setStorageSync: (k, v) => { store.set(k, v) },
    removeStorageSync: (k) => { store.delete(k) },
    showToast: (obj) => { toasts.push(obj && obj.title) },
    showModal: (obj) => {
      modals.push(obj)
      if (o.autoConfirm && typeof obj.success === 'function') obj.success({ confirm: true, cancel: false })
    },
    requestSubscribeMessage: () => {}
  }

  global.getApp = () => ({
    whenReady: (cb) => cb({
      openid: o.openid || 'A_her_openid',
      role: o.role || 'her',
      coupleId: o.coupleId || 'CZ-1'
    }),
    globalData: {
      openid: o.openid || 'A_her_openid',
      role: o.role || 'her',
      coupleId: o.coupleId || 'CZ-1',
      partnerName: ''
    },
    silentLogin: () => {},
    loginSnapshot: () => ({ state: 'ready', ok: true, canRetry: false })
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
  return { page, store, calls, toasts, modals }
}

function recordOf(date, extra) {
  return Object.assign({
    _id: 'rec_' + date,
    _openid: 'A_her_openid',
    date,
    coupleId: 'CZ-1',
    revision: 2,
    goals: [{ text: '目标', done: false, reminderOn: false, reminderTime: '21:00' }],
    todos: [],
    segments: { life: '已保存的生活', work: '', growth: '' },
    mood: { type: 'calm', weather: 'sunny' },
    score: 4,
    wishes: []
  }, extra || {})
}

// 新契约：服务端必须返回数字 rev（CAS 版本号），否则页面会 fail-closed 禁用开关
const shareNo = (extra) => Object.assign({
  ok: true, enabled: false, canShare: true, hasRecord: true, rev: 1
}, extra || {})

async function main() {
  console.log('\n=== P3.1 客户端 · 日期级分享 ===\n')

  // ---------------- A. utils/record-share ----------------
  await testCase('A1 分享状态：只有 enabled === true 才算开启', () => {
    const base = { ok: true, canShare: true, hasRecord: true }
    assertEq(shareApi.normalizeShareStatus({ result: Object.assign({ enabled: true }, base) }).enabled, true)
    for (const bad of ['true', 1, '1', {}, [], null, undefined]) {
      const r = shareApi.normalizeShareStatus({ result: Object.assign({ enabled: bad }, base) })
      assertEq(r.enabled, false, 'enabled=' + JSON.stringify(bad) + ' 必须视为未分享')
    }
  })

  await testCase('A2 分享状态：服务端 ok≠true → 一律按未分享 + 错误码', () => {
    const r = shareApi.normalizeShareStatus({ result: { ok: false, code: 'FORBIDDEN' } })
    assertEq(r.ok, false)
    assertEq(r.code, 'FORBIDDEN')
    assertEq(r.enabled, false)
    assertEq(r.canShare, false)
  })

  await testCase('A3 网络异常（无响应）→ NETWORK，不产生任何默认成功', async () => {
    const r = await shareApi.requestShareStatus(D_A, () => Promise.reject(new Error('offline')))
    assertEq(r.ok, false)
    assertEq(r.code, 'NETWORK')
    assertEq(r.enabled, false)
  })

  await testCase('A4 写入分享：非布尔参数直接拒绝，不误发请求', async () => {
    let called = 0
    const r = await shareApi.requestShareSet(D_A, 'true', () => { called++; return Promise.resolve({}) })
    assertEq(r.ok, false)
    assertEq(r.code, 'BAD_ARGS')
    assertEq(called, 0, '不该为一个非法参数发请求')
  })

  await testCase('A5 写入分享：服务端返回 enabled 严格布尔，否则视为未开启', async () => {
    const call = () => Promise.resolve({ result: { ok: true, enabled: 'true' } })
    const r = await shareApi.requestShareSet(D_A, true, call)
    assertEq(r.ok, true)
    assertEq(r.enabled, false, "'true' 不是 true")
  })

  await testCase('A8 预览：只列心情/天气/三段（含字数与摘要），空段落标「未填写」', () => {
    const p = shareApi.buildSharePreview({
      mood: { type: 'happy', weather: 'rain' },
      segments: { life: '今天去看了海，风很大', work: '', growth: '学会了拒绝' }
    })
    assertEq(p.lines.length, 4)
    assertOk(p.lines[0].indexOf('开心') !== -1 && p.lines[0].indexOf('雨') !== -1)
    assertOk(p.lines[1].indexOf('生活') !== -1 && p.lines[1].indexOf('字') !== -1)
    assertOk(p.lines[2].indexOf('未填写') !== -1)
    assertOk(p.lines[3].indexOf('成长') !== -1)
    assertEq(p.filledSegments, 2)
    assertOk(p.hasContent)
    // 超长内容必须被摘要，不能整段塞进确认弹窗
    const long = shareApi.buildSharePreview({ segments: { life: 'a'.repeat(200) } })
    assertOk(long.lines[1].length < 60, '预览必须截断长文本')
  })

  await testCase('A9 提示文案：未知错误码也有一句人话，且不含性别代词', () => {
    for (const code of ['NOT_SHARED', 'NO_RECORD', 'RECORD_NOT_IN_COUPLE', 'NETWORK', 'WHATEVER']) {
      const hint = shareApi.hintOf(code)
      assertOk(typeof hint === 'string' && hint.length > 0, code + ' 缺提示')
      assertNo(hint, '她')
      assertNo(hint.replace(/其他|他人|他们/g, ''), '他')
    }
    assertNo(shareApi.SHARE_NOTICE.replace(/其他|他人|他们/g, ''), '他')
    assertOk(shareApi.SHARE_NOTICE.indexOf('三段日记') !== -1, '必须说清楚会分享三段日记')
  })

  // ---------------- B. partner-view 白名单 ----------------
  await testCase('B1 shared：只保留 mood(type/weather) 与三段日记，其余字段丢弃', () => {
    const out = pv.pickShared({
      mood: { type: 'calm', weather: 'snow', extra: 'x' },
      segments: { life: 'L', work: 'W', growth: 'G', secret: 'S' },
      herSummary: 'H', score: 5, goals: []
    })
    assertEq(Object.keys(out).sort().join(','), 'mood,segments')
    assertEq(Object.keys(out.mood).sort().join(','), 'type,weather')
    assertEq(Object.keys(out.segments).sort().join(','), 'growth,life,work')
    assertNo(JSON.stringify(out), 'herSummary')
    assertNo(JSON.stringify(out), 'H')
  })

  await testCase('B2 shared：结构不认识 → null（不猜、不降级成空内容）', () => {
    assertEq(pv.pickShared(null), null)
    assertEq(pv.pickShared(undefined), null)
    assertEq(pv.pickShared('x'), null)
  })

  await testCase('B4 pickView 仍不接受整份响应：私人字段即使服务端多返回也不会进页面', () => {
    const view = pv.pickView({
      ok: true, role: 'him', score: 4, partnerSummary: 's',
      herSummary: 'SECRET', symptoms: ['x'], goals: [{ text: 'g' }],
      readProgress: 99, schemaVersion: 2,
      shared: { mood: { type: 'calm', weather: 'sunny' }, segments: { life: 'L', work: '', growth: '' } }
    })
    const json = JSON.stringify(view)
    assertNo(json, 'SECRET')
    assertNo(json, 'symptoms')
    assertNo(json, 'readProgress')
    assertOk(view.shared, 'shared 必须被保留')
  })

  await testCase('B5 只有共享内容（没有评分/小结/心愿）时状态是 ready，不是 empty', () => {
    const st = pv.viewStateOf({
      score: null, partnerSummary: '', wishes: [],
      shared: { mood: { type: 'calm', weather: 'sunny' }, segments: { life: '', work: '', growth: '' } }
    })
    assertEq(st, 'ready')
  })

  // ---------------- C. 记录页（her） ----------------
  await testCase('C1 进入记录页会按日期拉分享状态，默认未分享', async () => {
    const h = loadRecordPage({
      responses: {
        get: () => ({ ok: true, coupleId: 'CZ-1', record: recordOf(D_A) }),
        shareStatus: () => shareNo()
      }
    })
    h.page.onLoad()
    await flush()
    h.page.loadDay(D_A)
    await flush()
    assertEq(h.page.data.shareState, 'ready')
    assertEq(h.page.data.shareEnabled, false)
    assertEq(h.page.data.shareCanShare, true)
    const shareCalls = h.calls.filter(c => c.data.action === 'shareStatus')
    assertOk(shareCalls.length >= 1)
    assertEq(shareCalls[shareCalls.length - 1].data.date, D_A, '必须按当前日期查询')
  })

  await testCase('C2 开启分享：二次确认里写明会分享什么 + 预览只取已保存内容 + 未保存提醒', async () => {
    const h = loadRecordPage({
      responses: {
        get: () => ({ ok: true, coupleId: 'CZ-1', record: recordOf(D_A) }),
        shareStatus: () => shareNo(),
        shareSet: () => ({ ok: true, enabled: true })
      }
    })
    h.page.onLoad()
    await flush()
    h.page.loadDay(D_A)
    await flush()

    // 编辑但没有保存：草稿内容不得出现在预览里，且必须提示未保存
    h.page.setData({ segments: { life: '还没保存的草稿内容', work: '', growth: '' }, segCounts: { life: 10, work: 0, growth: 0 } })
    h.page._dirty = true

    h.page.onShareToggle()
    assertEq(h.modals.length, 1)
    const content = h.modals[0].content
    assertOk(content.indexOf(shareApi.SHARE_NOTICE) !== -1, '必须包含完整告知文案')
    assertOk(content.indexOf('生活') !== -1, '预览必须列出三段日记')
    assertOk(content.indexOf('未保存') !== -1, '必须提醒未保存的修改不会被分享')
    assertNo(content, '还没保存的草稿内容')

    h.modals[0].success({ confirm: true })
    await flush()
    assertEq(h.page.data.shareEnabled, true)
    assertEq(h.calls.filter(c => c.data.action === 'shareSet')[0].data.enabled, true)
  })

  await testCase('C3 写分享失败 → 不改状态、不假装成功（有明确失败提示）', async () => {
    const h = loadRecordPage({
      responses: {
        get: () => ({ ok: true, coupleId: 'CZ-1', record: recordOf(D_A) }),
        shareStatus: () => shareNo(),
        shareSet: () => ({ ok: false, code: 'RECORD_NOT_IN_COUPLE' })
      }
    })
    h.page.onLoad()
    await flush()
    h.page.loadDay(D_A)
    await flush()
    h.page._confirmEnableShare()
    h.modals[0].success({ confirm: true })
    await flush()
    assertEq(h.page.data.shareEnabled, false, '失败不得显示为已分享')
    assertOk(h.toasts.indexOf(shareApi.hintOf('RECORD_NOT_IN_COUPLE')) !== -1, '必须给出失败原因')
  })

  await testCase('C4 快速切日期：A 日的分享结果不得写到 B 日', async () => {
    const dA = deferred()
    const h = loadRecordPage({
      responses: {
        get: (data) => ({ ok: true, coupleId: 'CZ-1', record: recordOf(data.date) }),
        shareStatus: (data) => (data.date === D_A
          ? dA.p
          : Promise.resolve(shareNo({ enabled: false })))
      }
    })
    h.page.onLoad()
    await flush()

    h.page.loadDay(D_A)      // 慢请求
    await flush()
    h.page.loadDay(D_B)      // 快请求
    await flush()
    assertEq(h.page.data.date, D_B)

    dA.resolve(shareNo({ enabled: true }))   // A 的响应迟到
    await flush()
    assertEq(h.page.data.shareEnabled, false, '迟到的 A 日结果不得污染 B 日')
  })

  await testCase('C5 未共享时不给「已分享」的错觉：canShare=false 时按钮禁用且说明原因', async () => {
    const h = loadRecordPage({
      responses: {
        get: () => ({ ok: true, coupleId: 'CZ-1', record: recordOf(D_A) }),
        shareStatus: () => shareNo({ canShare: false })
      }
    })
    h.page.onLoad()
    await flush()
    h.page.loadDay(D_A)
    await flush()
    assertEq(h.page.data.shareCanShare, false)
    h.page.onShareToggle()
    assertEq(h.modals.length, 0, '不可分享时不应弹确认')
    assertOk(h.toasts.length > 0, '应提示为什么不能分享')
    const wxml = read('pages/record/record.wxml')
    assertOk(wxml.indexOf('暂时无法分享') !== -1, '页面上要有不可分享的说明')
  })

  await testCase('C6 关闭分享同样走二次确认，失败不显示为已关闭', async () => {
    const h = loadRecordPage({
      responses: {
        get: () => ({ ok: true, coupleId: 'CZ-1', record: recordOf(D_A) }),
        shareStatus: () => shareNo({ enabled: true }),
        shareSet: () => ({ ok: false, code: 'NETWORK' })
      }
    })
    h.page.onLoad()
    await flush()
    h.page.loadDay(D_A)
    await flush()
    assertEq(h.page.data.shareEnabled, true)
    h.page.onShareToggle()
    assertEq(h.modals.length, 1)
    h.modals[0].success({ confirm: true })
    await flush()
    assertEq(h.page.data.shareEnabled, true, '关闭失败必须仍然显示为已分享')
  })

  // ---------------- D. 记录页（him） ----------------
  const companionApp = (opts) => loadRecordPage(Object.assign({
    openid: 'B_him_openid',
    role: 'him',
    coupleId: 'CZ-1'
  }, opts))

  const himView = (extra) => Object.assign({
    ok: true, role: 'him', myPartnerName: '', score: null,
    wishes: [], partnerSummary: '', days: null,
    shared: { mood: { type: 'calm', weather: 'rain' }, segments: { life: '共享生活', work: '', growth: '共享成长' } }
  }, extra || {})

  await testCase('D1 已共享：展示三段日记；未共享：pvShared 为 null（不渲染占位）', async () => {
    const h = companionApp({ responses: { view: () => himView() } })
    h.page.onLoad()
    await flush()
    assertEq(h.page.data.viewMode, 'companion')
    assertOk(h.page.data.pvShared, '应拿到共享内容')
    assertEq(h.page.data.pvShared.segments.life, '共享生活')
    assertEq(h.page.data.pvMood, '平静')
    assertEq(h.page.data.pvWeather, '雨')

    const h2 = companionApp({ responses: { view: () => himView({ shared: null }) } })
    h2.page.onLoad()
    await flush()
    assertEq(h2.page.data.pvShared, null, '未共享时必须为 null')
  })

  await testCase('D5 切日期时清空上一天的共享内容（请求未回也不残留）', async () => {
    const dNext = deferred()
    const h = companionApp({
      responses: {
        view: (data) => (data.date === D_B ? dNext.p : himView())
      }
    })
    h.page.onLoad()
    await flush()
    assertOk(h.page.data.pvShared)
    h.page._pvGo(D_B)
    await flush()
    assertEq(h.page.data.pvShared, null, '切日期后立刻清空')
    assertEq(h.page.data.pvMood, '')
    assertEq(h.page.data.pvWeather, '')
    dNext.resolve(himView({ shared: null }))
    await flush()
    assertEq(h.page.data.pvShared, null)
  })

  // ---------------- E. 版本兼容 ----------------
  await testCase('E1 旧客户端 + 新云函数：旧白名单会把 shared 丢掉', () => {
    // 复刻 V1.0.3 的 pickView 白名单（只有这些字段）
    const OLD = ['role', 'myPartnerName', 'score', 'wishes', 'messages', 'unreadMsgs',
      'anniversary', 'days', 'partnerSummary', 'partnerSummaryAt', 'partnerRole']
    const resp = {
      ok: true, role: 'him', score: 3, partnerSummary: 's', wishes: [], messages: [],
      shared: { mood: { type: 'calm', weather: 'sunny' }, segments: { life: 'SECRET', work: '', growth: '' } }
    }
    const oldView = {}
    for (const k of OLD) if (resp[k] !== undefined) oldView[k] = resp[k]
    const json = JSON.stringify(oldView)
    assertNo(json, 'shared')
    assertNo(json, 'SECRET')
  })

  await testCase('E2 新客户端 + 旧云函数：shareStatus 返回 BAD_ACTION → 进入错误态，绝不当作已分享', async () => {
    const h = loadRecordPage({
      responses: {
        get: () => ({ ok: true, coupleId: 'CZ-1', record: recordOf(D_A) }),
        shareStatus: () => ({ ok: false, code: 'BAD_ACTION' })
      }
    })
    h.page.onLoad()
    await flush()
    h.page.loadDay(D_A)
    await flush()
    assertEq(h.page.data.shareState, 'error')
    assertEq(h.page.data.shareEnabled, false)
    assertOk(h.page.data.shareNote.length > 0)
  })

  await testCase('E3 新客户端 + 旧云函数：view 里没有 shared 字段 → him 侧不渲染任何共享内容', async () => {
    const h = companionApp({
      responses: { view: () => ({ ok: true, role: 'him', score: 4, partnerSummary: '', wishes: [] }) }
    })
    h.page.onLoad()
    await flush()
    assertEq(h.page.data.pvShared, null)
    assertEq(h.page.data.pvState, 'ready', '有评分仍应正常展示原有内容')
  })

  console.log('\n=== 结果: ' + passed + ' PASS / ' + failed + ' FAIL ===')
  if (failed) {
    console.log('\n失败用例:')
    for (const f of failures) console.log('  - ' + f)
    process.exit(1)
  }
  console.log('P3 Share Client: ALL GREEN')
}

main().catch(e => { console.error(e); process.exit(1) })
