// ============================================================
// tests/role-branch.test.js · V1.1 P1 角色分支骨架与生命周期
//
// 覆盖：
//   A pageViewMode 推导：her / 未加载 / 未绑定 / 角色异常 一律回落 owner
//   B 角色快照的生命周期刷新完整性（静态守护两个页面）
//   C WXML 分支结构：owner 包裹原有模块、companion 仅为占位且无编辑入口
//   D 她侧回归：原有模块、保存入口、空状态结构都还在
//   E 与 P0 契约兼容：viewerFlags 仍为固定 6 键
//
// 运行：node tests/role-branch.test.js
// ============================================================
const path = require('path')
const fs = require('fs')

const ROOT = path.resolve(__dirname, '..')
const {
  viewerFlags, pageViewMode, resolveViewer,
  VIEW_MODE_OWNER, VIEW_MODE_COMPANION, VIEW_MODE_COMPANION_BLOCKED, VIEW_MODE_PENDING
} = require(path.join(ROOT, 'utils/viewer-role.js'))

let passed = 0, failed = 0, failures = []

function testCase(name, fn) {
  return Promise.resolve().then(fn).then(() => { passed++; console.log('  PASS  ' + name) })
    .catch(e => { failed++; failures.push(name + ': ' + e.message); console.log('  FAIL  ' + name + '  -> ' + e.message) })
}
function assertEq(a, b, msg) { if (a !== b) throw new Error((msg || '') + ' 期望 ' + JSON.stringify(b) + ' 实际 ' + JSON.stringify(a)) }
function assertOk(v, msg) { if (!v) throw new Error(msg || '断言失败') }
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8') }

function g(role, coupleId, openid) {
  return { openid: openid === undefined ? 'oA' : openid, role, coupleId }
}
// 取 WXML 中 companion 及其后的分支片段（owner 分支在上方，天然被排除）
function companionSlice(src) {
  const key = 'wx:elif="{{viewMode === \'companion\'}}"'
  const i = src.indexOf(key)
  return i === -1 ? null : src.slice(i)
}

async function runAll() {
  console.log('\n=== Role Branch · 角色分支与生命周期（V1.1 P1） ===\n')

  // ---- A. pageViewMode 推导 ----
  await testCase('A1 her 即使开关打开也永远是 owner', () => {
    assertEq(pageViewMode(g('her', 'CZ-1'), { companionViewEnabled: true }), VIEW_MODE_OWNER)
    assertEq(pageViewMode(g('her', null), { companionViewEnabled: true }), VIEW_MODE_OWNER)
  })

  await testCase('A2 him + 已绑定 + 开关关闭 → owner（本阶段零可见变化）', () => {
    assertEq(pageViewMode(g('him', 'CZ-1'), { companionViewEnabled: false }), VIEW_MODE_OWNER)
    assertEq(pageViewMode(g('him', 'CZ-1')), VIEW_MODE_OWNER, '缺省 options 也必须是 owner')
    assertEq(pageViewMode(g('him', 'CZ-1'), {}), VIEW_MODE_OWNER)
  })

  await testCase('A3 him + 已绑定 + 开关打开 → companion（P2 的接管语义）', () => {
    assertEq(pageViewMode(g('him', 'CZ-1'), { companionViewEnabled: true }), VIEW_MODE_COMPANION)
  })

  await testCase('A4 him + 未绑定 + 开关打开 → companion-blocked（安全状态，不回落到编辑页）', () => {
    for (const cid of [null, undefined, '', '   ']) {
      assertEq(pageViewMode(g('him', cid), { companionViewEnabled: true }), VIEW_MODE_COMPANION_BLOCKED,
        'coupleId=' + JSON.stringify(cid))
    }
  })

  await testCase('A5 角色未加载 / 角色缺失 + 开关打开 → pending（不猜角色，不渲染表单）', () => {
    // P2.1：原来回落 owner 会让人在首屏看到个人记录表单，已改为中性等待
    assertEq(pageViewMode(undefined, { companionViewEnabled: true }), VIEW_MODE_PENDING)
    assertEq(pageViewMode({ openid: null, role: 'him', coupleId: 'CZ-1' }, { companionViewEnabled: true }), VIEW_MODE_PENDING)
    assertEq(pageViewMode({ openid: 'oA', coupleId: 'CZ-1' }, { companionViewEnabled: true }), VIEW_MODE_PENDING)
    assertEq(pageViewMode({ openid: 'oA', role: 'HER', coupleId: 'CZ-1' }, { companionViewEnabled: true }), VIEW_MODE_PENDING)
  })

  await testCase('A5b 开关关闭时仍回落 owner（保持 P1 回退语义）', () => {
    assertEq(pageViewMode(undefined, { companionViewEnabled: false }), VIEW_MODE_OWNER)
    assertEq(pageViewMode({ openid: 'oA', role: 'him', coupleId: 'CZ-1' }, { companionViewEnabled: false }), VIEW_MODE_OWNER)
  })

  await testCase('A6 只有字面量 true 才打开开关，其他真值一律视为关闭', () => {
    for (const v of [1, 'true', 'yes', {}, []]) {
      assertEq(pageViewMode(g('him', 'CZ-1'), { companionViewEnabled: v }), VIEW_MODE_OWNER,
        'companionViewEnabled=' + JSON.stringify(v))
    }
  })

  // ---- B. 生命周期刷新完整性（静态）----
  await testCase('B1 首页：onShow→refresh→_syncViewer，且 refresh 内首帧与 whenReady 各同步一次', () => {
    const src = read('pages/home/home.js')
    assertOk(/onShow\(\)\s*\{\s*this\.refresh\(\)\s*\}/.test(src), '首页 onShow 未调用 refresh')
    assertOk(src.includes('_syncViewer(app.globalData)'), '首页 refresh 首帧未同步角色')
    assertOk(src.includes('this._syncViewer(g)'), '首页 whenReady 未重新同步角色')
    const calls = (src.match(/_syncViewer\(/g) || []).length
    assertOk(calls >= 3, '首页 _syncViewer 调用点不足（定义 1 + 使用 2），实际 ' + calls)
  })

  await testCase('B2 记录页：onLoad / whenReady / onShow 三处都同步角色', () => {
    const src = read('pages/record/record.js')
    const onLoadIdx = src.indexOf('onLoad() {')
    const onShowIdx = src.indexOf('onShow() {')
    assertOk(onLoadIdx !== -1, '缺 onLoad')
    assertOk(onShowIdx > onLoadIdx, '缺 onShow 或顺序异常')
    const onLoadBody = src.slice(onLoadIdx, onShowIdx)
    assertOk(onLoadBody.includes('this._syncViewer(app.globalData)'), 'onLoad 未同步角色')
    assertOk(onLoadBody.includes('this._syncViewer(g)'), 'whenReady 未重新同步角色')
    const onShowBody = src.slice(onShowIdx, onShowIdx + 600)
    // 必须写在方法顶层（4 空格缩进），不能被 partnerName 的 if 包住
    assertOk(/\n {4}(const mode = )?this\._syncViewer\(app\.globalData\)/.test(onShowBody),
      'onShow 的同步被条件分支包住了')
  })

  await testCase('B3 两页的 _syncViewer 都经 pageViewMode 且传入 companionViewEnabled', () => {
    for (const rel of ['pages/home/home.js', 'pages/record/record.js']) {
      const src = read(rel)
      assertOk(src.includes('pageViewMode(g, { companionViewEnabled: this.data.companionViewEnabled })'),
        rel + ' 未按开关推导 viewMode')
      assertOk(/viewMode:\s*'pending'/.test(src), rel + ' 首屏默认值必须是 pending（P2.1）')
      // P2 起陪伴视图正式启用；开关必须是字面量 true
      assertOk(/companionViewEnabled:\s*true/.test(src), rel + ' P2 开关应为 true')
    }
  })

  // ---- C. WXML 分支结构 ----
  await testCase('C1 两页都存在 pending / owner / companion / companion-blocked 四个分支', () => {
    for (const rel of ['pages/home/home.wxml', 'pages/record/record.wxml']) {
      const src = read(rel)
      // pending 必须是第一个分支（wx:if），其余依次 wx:elif，保证首屏只会是中性等待
      assertOk(src.includes('wx:if="{{viewMode === \'pending\'}}"'), rel + ' pending 分支必须是 wx:if')
      assertOk(src.includes('wx:elif="{{viewMode === \'owner\'}}"'), rel + ' 缺 owner 分支')
      assertOk(src.includes('wx:elif="{{viewMode === \'companion\'}}"'), rel + ' 缺 companion 分支')
      assertOk(src.includes('wx:elif="{{viewMode === \'companion-blocked\'}}"'), rel + ' 缺 companion-blocked 分支')
      // pending 之前不得出现任何其他 wx:if 分支（防止 owner 提前占位）
      const pendingIdx = src.indexOf('wx:if="{{viewMode === \'pending\'}}"')
      const ownerIdx = src.indexOf('wx:if="{{viewMode === \'owner\'}}"')
      assertEq(ownerIdx, -1, rel + ' owner 仍占用 wx:if，会抢在 pending 之前渲染')
      assertOk(pendingIdx > -1, rel + ' 缺 pending 分支')
      const open = (src.match(/<block/g) || []).length
      const close = (src.match(/<\/block>/g) || []).length
      assertEq(open, close, rel + ' <block> 标签未配对')
    }
  })

  await testCase('C1c pending 文案按状态区分（角色缺失给出可操作提示，不猜角色）', () => {
    for (const rel of ['pages/home/home.wxml', 'pages/record/record.wxml']) {
      const src = read(rel)
      assertOk(src.includes("viewerState === 'role_unknown'"), rel + ' pending 未区分角色缺失态')
      assertOk(src.includes('正在确认身份'), rel + ' 缺加载文案')
      const start = src.indexOf('wx:if="{{viewMode === \'pending\'}}"')
      const end = src.indexOf('wx:elif="{{viewMode === \'owner\'}}"')
      const slice = src.slice(start, end)
      // 不得在 waiting 文案里暗示身份是记录方或陪伴方
      for (const bad of ['记录方', '陪伴方', '你是']) {
        assertOk(slice.indexOf(bad) === -1, rel + ' pending 文案暗示了身份：' + bad)
      }
    }
  })

  await testCase('C1b pending 分支内不得出现表单/保存控件（P3.0 起允许唯一的登录重试入口）', () => {
    for (const rel of ['pages/home/home.wxml', 'pages/record/record.wxml']) {
      const src = read(rel)
      const start = src.indexOf('wx:if="{{viewMode === \'pending\'}}"')
      const end = src.indexOf('wx:elif="{{viewMode === \'owner\'}}"')
      assertOk(start > -1 && end > start, rel + ' 取不到 pending 分支')
      const slice = src.slice(start, end)
      for (const bad of ['bindinput', 'bindconfirm', 'record-save-btn', 'goal-card', 'todo-item', '<input', '<textarea']) {
        assertOk(slice.indexOf(bad) === -1, rel + ' pending 分支出现表单控件：' + bad)
      }
      // P3.0：pending 里唯一允许的可点击控件是「登录重试」，
      // 且必须挂在登录失败/超时的条件下（不能无条件出现，也不能是跳转/保存）。
      const taps = slice.split('bindtap').length - 1
      const retryTaps = slice.split('bindtap="onLoginRetry"').length - 1
      assertOk(taps === retryTaps, rel + ' pending 分支出现了除登录重试之外的交互控件')
      assertOk(retryTaps === 1, rel + ' pending 分支缺少登录重试入口')
      assertOk(slice.indexOf("loginState === 'failed'") !== -1, rel + ' 登录重试未按失败态展示')
    }
  })

  await testCase('C2 companion 分支内不得出现任何编辑 / 保存 / 互动输入入口', () => {
    for (const rel of ['pages/home/home.wxml', 'pages/record/record.wxml']) {
      const slice = companionSlice(read(rel))
      assertOk(slice, rel + ' 取不到 companion 分支')
      // 导航与重试按钮是允许的；编辑、保存、点赞、留言入口一律不允许
      for (const bad of ['onSaveTap', 'record-save-btn', 'goal-card', 'todo-item',
        'mood-weather', 'onSegInput', 'onGoalInput', 'onMoodChange',
        'onLikeTap', 'onCommentTap', 'onCommentInput']) {
        assertOk(slice.indexOf(bad) === -1, rel + ' companion 分支出现禁止入口：' + bad)
      }
      // 陪伴方不得编辑她的任何内容。
      // V1.1 产品调整：「一起做的事」（couple_todos）是双方对等的功能，已迁到记录页，
      // 因此 companion 分支**允许唯一一个**输入框（onSharedTodoInput）。
      // 它写的是 couple_todos，与日记 / 情绪 / 个人待办 / 未分享内容完全隔离。
      const names = (slice.match(/bindinput="([A-Za-z_]+)"/g) || [])
        .map(x => x.replace('bindinput="', '').replace('"', ''))
      const badInputs = names.filter(n => n !== 'onSharedTodoInput')
      assertEq(badInputs.join(','), '', rel + ' companion 分支出现非共同待办的输入框')
      // 写个人记录的入口一个都不能有（含分享、保存、打分、经期）
      for (const bad of ['onSegInput', 'onMoodChange', 'onScoreChange', 'onGoalInput', 'onEatDraft', 'onDoDraft', 'onShareToggle']) {
        assertOk(slice.indexOf(bad) === -1, rel + ' companion 分支出现个人记录写入入口：' + bad)
      }
    }
  })

  await testCase('C3 companion 占位文案不含性别代词与关系假设', () => {
    for (const rel of ['pages/home/home.wxml', 'pages/record/record.wxml']) {
      const slice = companionSlice(read(rel))
      const others = slice.replace(/其他|他人|他们|他日/g, '')
      assertOk(slice.indexOf('她') === -1, rel + ' 占位文案含性别代词')
      assertOk(others.indexOf('他') === -1, rel + ' 占位文案含性别代词')
      for (const w of ['男朋友', '女朋友', '老公', '老婆']) {
        assertOk(slice.indexOf(w) === -1, rel + ' 占位文案含关系假设：' + w)
      }
    }
  })

  // ---- D. 她侧回归 ----
  await testCase('D1 首页 owner 分支内原有模块齐全（Hero / 今日目标 / 今日小事 / 最近 7 天）', () => {
    const src = read('pages/home/home.wxml')
    for (const needle of ['hero-big', '今日目标', '今日小事', '最近 7 天']) {
      assertOk(src.indexOf(needle) !== -1, '首页缺少模块：' + needle)
    }
  })

  await testCase('D2 首页空状态 wx:if / wx:else 配对结构未被破坏', () => {
    const src = read('pages/home/home.wxml')
    assertOk(src.includes('wx:if="{{!hasRecord && !loading}}"'), '首页空状态条件被改动')
    assertOk(src.includes('<block wx:else>'), '首页空状态 wx:else 丢失')
  })

  await testCase('D3 记录页 owner 分支内六大编辑区块与保存入口齐全', () => {
    const src = read('pages/record/record.wxml')
    for (const needle of [
      '<goal-card', '今天的三段时光', '<mood-weather', '<score-picker',
      '今天想吃 / 想做', 'record-save-btn', 'bindtap="onSaveTap"'
    ]) {
      assertOk(src.indexOf(needle) !== -1, '记录页缺少：' + needle)
    }
  })

  await testCase('D4 两页仍未出现临时角色比较（P0 口径不得退化）', () => {
    for (const rel of ['pages/home/home.js', 'pages/record/record.js']) {
      const src = read(rel)
      for (const bad of ["globalData.role ===", '=== \'him\'', '=== "him"', '=== \'her\'', '=== "her"']) {
        assertOk(src.indexOf(bad) === -1, rel + ' 出现临时角色比较：' + bad)
      }
    }
  })

  // ---- F. 纪念日双方一致 + 悄悄话体验（V1.1 体验收尾第二轮）----
  await testCase('F1 首页 her / him 都有同款纪念日主视觉（同一套 class，天数为主）', () => {
    const src = read('pages/home/home.wxml')
    assertEq((src.match(/class="block note-pink anni-hero fade-in"/g) || []).length, 2,
      '首页应有两处 anni-hero（记录方 + 陪伴方）')
    for (const needle of ['{{ownDays}}', '{{pvDays}}', '{{ownAnniText}}', '{{pvAnniText}}']) {
      assertOk(src.includes(needle), '首页纪念日缺字段：' + needle)
    }
    // 天数必须作为主视觉：大字 class 在两处都出现
    assertEq((src.match(/class="anni-hero-num"/g) || []).length, 2, '两处都应有大号天数')
  })

  await testCase('F2 双方天数同源（都取服务端 days），且首页不写纪念日、不本地推算', () => {
    const src = read('pages/home/home.js')
    assertOk(src.includes("pvDays: typeof d.days === 'number' ? d.days : null"), '陪伴方天数未取服务端 days')
    assertOk(src.includes("ownDays: typeof d.days === 'number' ? d.days : null"), '记录方天数未取服务端 days')
    // 记录方必须复用现有接口，且仍经统一取数入口（白名单 + 防过期写回）
    assertOk(src.includes('requestPartnerView('), '记录方必须走 partner-view 统一入口')
    assertOk(src.indexOf("name: 'getPartnerView'") === -1, '不得绕过统一入口直接调云函数')
    assertOk(src.indexOf('setAnniversary') === -1, '首页不得写入纪念日')
    // 前端各算一遍会因时区/设备时间产生 1 天偏差 —— 禁止本地推算
    assertOk(!/daysBetween|dateDiff|\/ 86400000/.test(src), '首页不得本地推算天数')
  })

  await testCase('F3 未加载 / 读不到时既不显示 0 天也不显示「还没设置」假空态', () => {
    const wxml = read('pages/home/home.wxml')
    assertOk(wxml.includes("wx:if=\"{{ownAnniState === 'ready'}}\""), '记录方纪念日缺加载态保护')
    const src = read('pages/home/home.js')
    assertOk(src.includes("ownAnniState: 'idle'"), '默认态必须是 idle')
    assertOk(src.includes("ownAnniState: 'error'"), '读取失败必须是 error（不渲染空态提示）')
    assertOk(src.includes("ownAnniState: 'ready'"), '成功态缺失')
  })

  await testCase('F4 「我们」页只保留紧凑纪念日入口，设置 / 修改能力不丢', () => {
    const ours = read('pages/ours/ours.wxml')
    assertOk(ours.indexOf('anni-img') === -1, '我们页不应再有大插画')
    assertOk(ours.indexOf('anni-days') === -1, '我们页不应再有大天数展示')
    assertOk(ours.includes('{{anniversary ? anniLine : \'未设置\'}}'), '缺一行式纪念日摘要')
    assertOk(ours.includes('bindchange="onAnniversary"'), '缺日期选择')
    assertOk(ours.includes('bindtap="saveAnniversary"'), '缺保存入口')
    assertOk(ours.includes("{{anniversary ? (anniOpen ? '收起' : '修改') : '设置'}}"), '缺设置 / 修改切换')
    const js = read('pages/ours/ours.js')
    assertOk(js.includes("action: 'setAnniversary'"), '设置纪念日的调用被删除')
  })

  await testCase('F5 悄悄话：滚动容器有高度上限，数量口径如实（不说成全部历史）', () => {
    const wxml = read('pages/ours/ours.wxml')
    assertOk(wxml.includes('<scroll-view'), '悄悄话必须可滚动')
    assertOk(/class="msg-scroll"/.test(wxml), '缺滚动容器 class')
    const wxss = read('pages/ours/ours.wxss')
    assertOk(/\.msg-scroll\s*\{[^}]*max-height:\s*\d+rpx/.test(wxss),
      '滚动区必须限制高度上限（否则会无限增高 / 留大面积空白）')
    assertOk(wxml.includes("msgMaxed ? '最近 ' + msgLimit + ' 条'"), '满 50 条时数量文案必须写「最近」')
    assertOk(wxml.indexOf('共 {{messages.length}} 条') === -1, '不得把已加载条数说成总数')
    assertOk(wxml.indexOf('回看全部历史') === -1, '无分页时不得宣称可回看全部历史')
  })

  await testCase('F6 只有「进入页面 / 自己刚发送」才滚到底部（无关刷新不打断翻历史）', () => {
    const js = read('pages/ours/ours.js')
    assertOk(js.includes('this._wantBottom = true'), '缺「允许滚到底」标记')
    assertOk(js.includes('const wantBottom = this._wantBottom !== false'), 'loadPartner 未消费该标记')
    assertOk(/msgScrollTop:\s*wantBottom/.test(js), 'scroll-top 必须受该标记控制')
  })

  // ---- E. 与 P0 契约兼容 ----
  await testCase('E1 viewerFlags 仍为固定 6 键（P1 未改动该契约）', () => {
    const keys = Object.keys(viewerFlags(g('him', 'CZ-1'))).sort().join(',')
    assertEq(keys, 'bound,canEnterPartnerView,isHer,isHim,roleReady,viewerState')
  })

  await testCase('E2 resolveViewer 判定未变（抽样 him 未绑定）', () => {
    const v = resolveViewer(g('him', null))
    assertEq(v.state, 'unbound')
    assertEq(v.isHim, true)
    assertEq(v.canEnterPartnerView, false)
  })

  console.log('\n=== 结果: ' + passed + ' PASS / ' + failed + ' FAIL ===')
  if (failures.length) {
    failures.forEach(f => console.log('  - ' + f))
    process.exit(1)
  }
  console.log('Role Branch: ALL GREEN')
}

runAll().catch(e => { console.error(e); process.exit(1) })
