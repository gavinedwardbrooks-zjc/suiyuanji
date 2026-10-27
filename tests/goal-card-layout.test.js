// ============================================================
// tests/goal-card-layout.test.js · 「今日目标 · 三件大事」布局与契约回归锁
//
// 背景（2026-10-16）：
//   记录页三项任务之间被拉得很开、卡片整体过长、出现大量纵向空白。
//   根因是 **行布局在自定义组件内部失效**：
//     自定义组件默认 styleIsolation: isolated —— 官方文档明确
//     「app.wxss 中的样式、组件所在页面的样式对自定义组件无效」。
//     goal-card 此前把行布局交给 app.wxss 里的全局 class `.row-between`，
//     它进不到组件内部 → `.top` / `.remind` 退化为 block →
//     内部 display:flex 的块级子节点各自独占一行 → 每张卡片被纵向撑高。
//
// 本文件锁定：
//   G1 组件自行声明行布局（不再依赖组件外的全局 class）
//   G2 没有任何「撑开」三项任务的固定高度 / flex 拉伸
//   G3 输入框不再用 min-height + 上下 padding 撑高行
//   G4 间距参数落在紧凑区间内
//   G5 不改结构：编号 / 勾选框 / 输入框 / 到点提醒 / 提醒开关全部保留
//   G6 事件契约真实执行（输入、勾选、提醒开关、时间选择）
//   G7 记录页绑定与组件注册不变；其他页面不回归
// 运行：node --test tests/goal-card-layout.test.js
// ============================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

const CARD_WXML = read('components/goal-card/goal-card.wxml')
const CARD_WXSS = read('components/goal-card/goal-card.wxss')
const RECORD_WXML = read('pages/record/record.wxml')
const RECORD_WXSS = read('pages/record/record.wxss')

// 取出某条选择器的声明块
function block(wxss, sel) {
  const re = new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}')
  const m = wxss.match(re)
  return m ? m[1] : null
}

// ---------------- G1 组件自带行布局 ----------------

test('G1_TOP_ROW_DECLARES_ITS_OWN_FLEX_LAYOUT', () => {
  const b = block(CARD_WXSS, '.top')
  assert.ok(b, '.top 必须定义在组件自己的 wxss 里')
  assert.match(b, /display:\s*flex/, '.top 必须自带 display:flex（全局 .row-between 进不了组件）')
  assert.match(b, /align-items:\s*center/)
  assert.match(b, /justify-content:\s*space-between/)
})

test('G1_REMIND_ROW_DECLARES_ITS_OWN_FLEX_LAYOUT', () => {
  const b = block(CARD_WXSS, '.remind')
  assert.ok(b, '.remind 必须定义在组件自己的 wxss 里')
  assert.match(b, /display:\s*flex/)
  assert.match(b, /align-items:\s*center/)
  assert.match(b, /justify-content:\s*space-between/)
})

test('G1_CARD_NO_LONGER_DEPENDS_ON_GLOBAL_CLASS_FOR_LAYOUT', () => {
  // 依赖全局类是这次「被拉得很开」的直接原因：必须能从组件自身 wxss 闭环
  const required = ['.top', '.remind']
  for (const sel of required) {
    const b = block(CARD_WXSS, sel)
    assert.match(b, /display:\s*flex/, sel + ' 必须自带行布局，不得依赖 app.wxss 的 .row-between')
  }
  // 组件根节点自带 box-sizing（组件内同样拿不到 app.wxss 的标签选择器之外的类规则）
  assert.match(block(CARD_WXSS, '.gc'), /box-sizing:\s*border-box/)
})

// ---------------- G2 不得「撑开」三项任务 ----------------

test('G2_NO_FIXED_HEIGHT_OR_STRETCH_OF_GOAL_ITEMS', () => {
  const gc = block(CARD_WXSS, '.gc')
  assert.doesNotMatch(gc, /(^|;|\s)height:\s*[^;]+/, '卡片不得设固定 height')
  assert.doesNotMatch(gc, /min-height/, '卡片不得设 min-height')
  assert.doesNotMatch(gc, /flex(-grow)?:\s*(1|\d\d%)/, '卡片不得被 flex 拉伸（父容器撑开会导致三项被拉开）')
  assert.doesNotMatch(gc, /justify-content:\s*space-between/, '卡片内部不得用 space-between 拉开子元素')
  // 组件根节点不能被父级拉伸：不得出现 flex:1 / height:100%
  assert.doesNotMatch(CARD_WXSS, /:host\s*\{[^}]*?flex:\s*1/)
  assert.doesNotMatch(CARD_WXSS, /height:\s*100%/)
})

test('G2_PARENT_BLOCK_DOES_NOT_STRETCH_GOALS', () => {
  // 记录页「今日目标」块：不得用固定高度 / flex 纵向拉伸 / space-between 排布子项
  const pink = block(RECORD_WXSS, '.block')
  assert.ok(pink, '记录页 .block 必须存在')
  assert.doesNotMatch(pink, /justify-content:\s*space-between/)
  assert.doesNotMatch(pink, /min-height/)
  // 模板只是按数据条数平铺 goal-card，没有额外的空白占位元素
  const seg = RECORD_WXML.slice(RECORD_WXML.indexOf('今日目标 · 三件大事'), RECORD_WXML.indexOf('小事 · 提醒事项'))
  assert.match(seg, /<goal-card[\s\S]*?wx:for="\{\{goals\}\}"/, '三项任务由 goals 数据平铺渲染')
  assert.doesNotMatch(seg, /class="(spacer|gap-box|placeholder)"/, '不得有空白占位元素')
  assert.doesNotMatch(seg, /style="[^"]*height/, '不得在模板里写死高度')
})

// ---------------- G3 输入框不再撑高行 ----------------

test('G3_INPUT_USES_FIXED_HEIGHT_WITH_HORIZONTAL_PADDING_ONLY', () => {
  const b = block(CARD_WXSS, '.ginput')
  assert.ok(b, '.ginput 必须存在')
  assert.match(b, /padding:\s*0\s+18rpx/, '只保留水平 padding（原生 input 靠固定高度垂直居中）')
  assert.doesNotMatch(b, /min-height:\s*8[0-9]rpx/, '不得再用 88rpx min-height 撑高输入行')
  const h = b.match(/height:\s*(\d+)rpx/)
  assert.ok(h, '必须显式给出固定高度')
  assert.ok(Number(h[1]) <= 80, '输入框固定高度必须 ≤ 80rpx（原为 min-height 88rpx + 上下 padding）')
  assert.doesNotMatch(b, /line-height/, '与记录页其它 input 保持一致：不设 line-height')
})

// ---------------- G4 间距参数紧凑 ----------------

test('G4_SPACING_VALUES_ARE_COMPACT', () => {
  const gc = block(CARD_WXSS, '.gc')
  const pad = gc.match(/padding:\s*(\d+)rpx\s+(\d+)rpx/)
  assert.ok(pad, '.gc 必须给出纵向/横向 padding')
  assert.ok(Number(pad[1]) <= 20, '卡片纵向 padding 必须 ≤ 20rpx')
  const mb = gc.match(/margin-bottom:\s*(\d+)rpx/)
  assert.ok(mb, '.gc 必须给出 margin-bottom')
  assert.ok(Number(mb[1]) <= 12, '卡片间距必须 ≤ 12rpx')

  const top = block(CARD_WXSS, '.top').match(/margin-bottom:\s*(\d+)rpx/)
  assert.ok(top && Number(top[1]) <= 12, '.top 下间距必须 ≤ 12rpx')
  const remind = block(CARD_WXSS, '.remind')
  const rmt = remind.match(/margin-top:\s*(\d+)rpx/)
  const rpt = remind.match(/padding-top:\s*(\d+)rpx/)
  assert.ok(rmt && Number(rmt[1]) <= 12, '.remind 上间距必须 ≤ 12rpx')
  assert.ok(rpt && Number(rpt[1]) <= 14, '.remind 内上间距必须 ≤ 14rpx')
})

// ---------------- G5 结构不缩水 ----------------

test('G5_ALL_FIVE_ELEMENTS_ARE_KEPT', () => {
  assert.match(CARD_WXML, /class="num"[^>]*>\{\{index \+ 1\}\}</, '必须保留任务编号')
  assert.match(CARD_WXML, /class="done-box/, '必须保留勾选框')
  assert.match(CARD_WXML, /<input class="ginput"/, '必须保留输入框')
  assert.match(CARD_WXML, /到点提醒/, '必须保留「到点提醒」文字')
  assert.match(CARD_WXML, /class="switch/, '必须保留提醒开关')
  assert.match(CARD_WXML, /<picker[^>]*mode="time"/, '必须保留提醒时间选择')
  // 卡片根不可换标签/加包裹层（结构不动）
  assert.match(CARD_WXML, /^<view class="gc hand-border"/)
})

test('G5_VISUAL_LANGUAGE_IS_PRESERVED', () => {
  const gc = block(CARD_WXSS, '.gc')
  assert.match(gc, /border-radius:\s*var\(--radius\)/, '圆角必须沿用主题变量')
  assert.match(gc, /transition:\s*all \.3s var\(--ease\)/, '过渡（视觉风格）必须保留')
  // 背景色仍由页面内联传入的 goal 颜色决定（粉色渐变便签风格不变）
  assert.match(CARD_WXML, /style="border-color: \{\{color\}\}; background: \{\{color\}\}14;"/)
  assert.match(CARD_WXSS, /background:\s*var\(--cream-soft\)/, '输入框底色沿用主题变量')
  assert.match(CARD_WXSS, /font-size:\s*30rpx/, '输入框字号不变')
  // 未引入任何新的硬编码色值
  assert.strictEqual((CARD_WXSS.match(/#[0-9A-Fa-f]{3,6}/g) || []).length, 2,
    '只允许既有两处硬编码色值（.num 白字、.knob 白点），不得新增')
})

// ---------------- G6 事件契约真实执行 ----------------

function loadComponent() {
  let cfg = null
  global.Component = c => { cfg = c }
  const p = require.resolve('../components/goal-card/goal-card.js')
  delete require.cache[p]
  require(p)
  delete global.Component
  return cfg
}

test('G6_EVENT_CONTRACT_IS_INTACT', () => {
  const cfg = loadComponent()
  assert.ok(cfg, 'goal-card 必须是一个 Component')
  // 默认属性形状不变（任务数量与数据结构都不动）
  assert.strictEqual(cfg.properties.goal.value.done, false)
  assert.strictEqual(cfg.properties.goal.value.reminderOn, false)
  assert.strictEqual(cfg.properties.goal.value.reminderTime, '21:00')
  assert.strictEqual(cfg.properties.index.value, 0)

  const fired = []
  const ctx = Object.assign({}, cfg.methods, {
    data: { index: 2, goal: { text: '', done: false, reminderOn: false, reminderTime: '21:00' } },
    triggerEvent(name, detail) { fired.push({ name, detail }) }
  })

  ctx.onInput({ detail: { value: '写一页' } })
  ctx.onToggleDone()
  ctx.onToggleReminder()
  ctx.onTime({ detail: { value: '20:30' } })

  assert.deepStrictEqual(fired, [
    { name: 'input', detail: { index: 2, text: '写一页' } },
    { name: 'toggleDone', detail: { index: 2 } },
    { name: 'toggleReminder', detail: { index: 2 } },
    { name: 'changeTime', detail: { index: 2, time: '20:30' } }
  ], '输入 / 勾选 / 提醒开关 / 时间选择四个事件契约一字未改')
})

test('G6_RECORD_PAGE_BINDINGS_AND_REGISTRATION_ARE_INTACT', () => {
  assert.match(RECORD_WXML, /bind:input="onGoalInput"/)
  assert.match(RECORD_WXML, /bind:toggleDone="onGoalToggleDone"/)
  assert.match(RECORD_WXML, /bind:toggleReminder="onGoalToggleReminder"/)
  assert.match(RECORD_WXML, /bind:changeTime="onGoalChangeTime"/)
  assert.match(RECORD_WXML, /goal="\{\{item\}\}" color="\{\{colors\[gi\]\}\}" index="\{\{gi\}\}"/)
  // 任务数量仍是 3（{{goalDoneCount}}/3），不扩不缩
  assert.match(RECORD_WXML, /今日目标 · 三件大事/)
  assert.match(RECORD_WXML, /\{\{goalDoneCount\}\}\/3 完成/)
  const recJson = JSON.parse(read('pages/record/record.json'))
  assert.strictEqual(recJson.usingComponents['goal-card'], '/components/goal-card/goal-card')
  // 组件 wxss/js/wxml 之外的配置文件未被改动
  const cardJson = JSON.parse(read('components/goal-card/goal-card.json'))
  assert.strictEqual(cardJson.component, true)
  assert.deepStrictEqual(cardJson.usingComponents, {})
})

// ---------------- G7 其他页面不回归 ----------------

test('G7_HOME_PAGE_GOAL_CARDS_ARE_UNTOUCHED', () => {
  const homeWxss = read('pages/home/home.wxss')
  const homeWxml = read('pages/home/home.wxml')
  // 首页用的是同名 .goal-card **class**（不是本组件），必须仍然自足紧凑
  const b = block(homeWxss, '.goal-card')
  assert.ok(b, '首页 .goal-card 样式必须存在')
  assert.match(b, /display:\s*flex/)
  assert.match(b, /min-height:\s*100rpx/, '首页目标行高度不得被本次修复带偏')
  assert.match(homeWxml, /class="goal-card note-\{\{goalColorForIndex\(index\)\}\}/)
})

test('G7_OTHER_COMPONENTS_LAYOUT_CONTRACT_UNCHANGED', () => {
  // 本次只动 goal-card.wxss；其他组件的行为不得被牵连
  assert.match(block(read('components/todo-item/todo-item.wxss'), '.todo-item'), /display:\s*flex/)
  assert.match(block(read('components/score-picker/score-picker.wxss'), '.display'), /display:\s*flex/)
  assert.match(block(read('components/mood-weather/mood-weather.wxss'), '.chip'), /display:\s*inline-flex/)
})
