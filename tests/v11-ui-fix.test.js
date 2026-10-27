// ============================================================
// tests/v11-ui-fix.test.js · 三处 UI 体验修复的回归（V1.1）
//
//   A. 「一起做的事」输入框：占位/输入文字垂直居中、与按钮同高对齐
//      （该卡片 V1.1 已从「我们」页迁到「记录」页，断言随之搬过去；A6 反向锁定迁移）
//   B. 「微信消息提醒」卡片：只留一行辅助文案，不再重复解释一次性订阅
//   C. 「经期提醒」卡片：同上，且双方配合的前置条件仍然保留
//
// 分档（不得互相冒充）：
//   [L1] 代码结构 / 静态文案  —— 源码与 WXML 断言
//   [L2] 本地模拟运行         —— 真实页面代码 + 假 wx
//   [L3] 微信云环境 / [L4] 开发者工具实际渲染 —— 未覆盖（本文件不测渲染像素）
//
// 运行：node tests/v11-ui-fix.test.js
// ============================================================
const path = require('path')
const fs = require('fs')

const ROOT = path.resolve(__dirname, '..')
const OURS_JS = path.join(ROOT, 'pages/ours/ours.js')
const OURS_WXML = path.join(ROOT, 'pages/ours/ours.wxml')
const OURS_WXSS = path.join(ROOT, 'pages/ours/ours.wxss')
const RECORD_WXML = path.join(ROOT, 'pages/record/record.wxml')
const RECORD_WXSS = path.join(ROOT, 'pages/record/record.wxss')
const CAL_JS = path.join(ROOT, 'pages/calendar/calendar.js')
const CAL_WXML = path.join(ROOT, 'pages/calendar/calendar.wxml')

let passed = 0, failed = 0
const failures = []

function testCase(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => { passed++; console.log('  PASS  ' + name) })
    .catch(e => { failed++; failures.push(name + ': ' + e.message); console.log('  FAIL  ' + name + '  -> ' + e.message) })
}
function assertOk(v, msg) { if (!v) throw new Error(msg || '断言失败') }
function assertNo(v, msg) { if (v) throw new Error(msg || '断言失败（期望不存在）') }
// 「文本里不得出现某个词」——注意参数顺序是 (文本, 词)，不是 (条件, 说明)
function assertNotIn(text, needle, msg) {
  if (String(text).indexOf(needle) !== -1) throw new Error((msg || '不得出现「' + needle + '」') + ' 实际: ' + text)
}
function assertEq(a, b, msg) { if (a !== b) throw new Error((msg || '') + ' 期望 ' + JSON.stringify(b) + ' 实际 ' + JSON.stringify(a)) }

const read = (p) => fs.readFileSync(p, 'utf8')
const noComment = (s) => s.replace(/<!--[\s\S]*?-->/g, '')
// 取出指定选择器的样式块（只取第一层大括号，足够用）
function cssBlock(css, selector) {
  const i = css.indexOf(selector + ' {')
  if (i < 0) return ''
  const start = css.indexOf('{', i)
  const end = css.indexOf('}', start)
  return css.slice(start + 1, end)
}

// 真实页面代码 + 假 wx（只为了能调页面方法）
function loadOurs() {
  const wx = {
    cloud: { callFunction: () => Promise.resolve({ result: { ok: true } }) },
    getStorageSync: () => '', setStorageSync: () => {}, removeStorageSync: () => {},
    showToast: () => {}, showModal: () => {}, navigateTo: () => {}, switchTab: () => {}
  }
  global.getApp = () => ({
    globalData: { openid: 'o1', role: 'her', coupleId: 'CZ-1', bindCode: null, wishOpenOnEnter: false, partnerName: '' },
    whenReady: () => {}, loginSnapshot: () => ({ state: 'ready' }), silentLogin: () => {}
  })
  global.wx = wx
  let def = null
  global.Page = (c) => { def = c }
  delete require.cache[OURS_JS]
  require(OURS_JS)
  const page = Object.assign({}, def)
  page.data = JSON.parse(JSON.stringify(def.data))
  page.setData = function (patch) { Object.assign(page.data, patch || {}) }
  return page
}

async function main() {
  console.log('\n=== V1.1 三处 UI 体验修复 ===\n')
  const css = read(RECORD_WXSS)
  const recordWxml = noComment(read(RECORD_WXML))
  const oursWxml = noComment(read(OURS_WXML))
  const calWxml = noComment(read(CAL_WXML))

  // ============================================================
  // A. 输入框
  // ============================================================
  await testCase('[L1] A1 输入框有确定高度且与按钮同高（76rpx），竖向 padding 归零', () => {
    const b = cssBlock(css, '.shared-todo-input')
    assertOk(b, '缺 .shared-todo-input 样式')
    assertOk(/height:\s*76rpx/.test(b), '输入框必须有确定高度 76rpx')
    assertOk(/padding:\s*0\s+24rpx/.test(b), '竖向 padding 必须归零（否则原生 input 会把文字挤出可见区）')
    assertOk(/box-sizing:\s*border-box/.test(b), '必须 box-sizing: border-box')
    const btn = cssBlock(css, '.shared-todo-btn')
    assertOk(/height:\s*76rpx/.test(btn), '按钮高度必须也是 76rpx 才能对齐')
  })

  await testCase('[L1] A2 不再有把文字挤出可见区的竖向 padding（裁字根因已消，且没改全局样式）', () => {
    const b = cssBlock(css, '.shared-todo-input')
    assertNo(/padding:\s*22rpx/.test(b), '.shared-todo-input 不得出现 22rpx 竖向 padding')
    // 全局 .soft-input 保持原样（悄悄话 / 绑定输入框不受牵连）
    const global2 = read(path.join(ROOT, 'style/handdrawn.wxss'))
    assertOk(/\.soft-input\s*\{[\s\S]*?padding:\s*22rpx 26rpx/.test(global2), '全局 .soft-input 不应被改动')
  })

  await testCase('[L1] A3 长占位/长输入不会把按钮挤出屏幕：输入框 min-width:0，按钮不收缩', () => {
    const b = cssBlock(css, '.shared-todo-input')
    assertOk(/min-width:\s*0/.test(b), 'flex 子项必须 min-width: 0')
    const btn = cssBlock(css, '.shared-todo-btn')
    assertOk(/flex:\s*0 0 auto/.test(btn), '按钮必须 flex: 0 0 auto')
    assertOk(/white-space:\s*nowrap/.test(btn), '按钮文字不得换行')
  })

  await testCase('[L1] A4 键盘弹出可正常操作：输入框带 adjust-position 与 cursor-spacing', () => {
    const idx = recordWxml.indexOf('shared-todo-input')
    assertOk(idx > 0, '缺 shared-todo-input')
    const tag = recordWxml.slice(recordWxml.lastIndexOf('<input', idx), recordWxml.indexOf('/>', idx) + 2)
    assertOk(/adjust-position="true"/.test(tag), '缺 adjust-position="true"')
    assertOk(/cursor-spacing="24"/.test(tag), '缺 cursor-spacing')
    assertOk(/bindinput="onSharedTodoInput"/.test(tag), 'bindinput 缺失')
    assertOk(/bindconfirm="addSharedTodo"/.test(tag), 'bindconfirm 缺失')
    assertOk(/maxlength="40"/.test(tag), '长度限制缺失（服务端另有 40 字上限）')
  })

  await testCase('[L1] A5 输入框与按钮在同一行 flex 容器里，且保留米白底输入框 + 粉色按钮', () => {
    // 米白底 / 圆角 / 描边由本页既有的 .record-inline-input 提供（原生 input 垂直居中契约）
    assertOk(/class="record-inline-input shared-todo-input"/.test(recordWxml), '输入框应同时带 record-inline-input')
    const base = cssBlock(css, '.record-inline-input')
    assertOk(/height:\s*72rpx/.test(base) && /padding:\s*0\s+20rpx/.test(base), 'record-inline-input 的高度/横向 padding 契约被改动了')
    assertOk(/background:\s*var\(--cream-soft\)/.test(base), '输入框应仍是米白底')
    const btn = cssBlock(css, '.shared-todo-btn')
    assertOk(/background:\s*var\(--candy-pink\)/.test(btn), '添加按钮应仍是粉色（candy 主粉）')
    const row = cssBlock(css, '.shared-todo-add')
    assertOk(/display:\s*flex/.test(row) && /align-items:\s*center/.test(row), '.shared-todo-add 应 flex + 居中对齐')
    assertOk(/flex-wrap:\s*nowrap/.test(row), '不允许换行（换行会让按钮掉到下一行）')
  })

  await testCase('[L1] A6 迁移锁定：「我们」页不再有共同待办卡片，记录页 her/him 两个分支都有', () => {
    assertNo(/一起做的事/.test(oursWxml), '我们页仍渲染共同待办卡片')
    const blocks = recordWxml.match(/class="block note-green fade-in shared-todo"/g) || []
    assertEq(blocks.length, 2, '记录页应在记录方与陪伴方两个分支各有一份')
    assertOk(recordWxml.includes('bindtap="addSharedTodo"') && recordWxml.includes('bindtap="toggleSharedTodo"'), '记录页缺添加/完成入口')
  })

  // ============================================================
  // B. 微信消息提醒卡片
  // ============================================================
  await testCase('[L1] B1 底部只留一行辅助文案，旧的长解释已删除', () => {
    const foots = oursWxml.match(/class="notify-foot"/g) || []
    assertEq(foots.length, 1, '辅助文案只允许出现一处')
    const foot = oursWxml.slice(oursWxml.indexOf('class="notify-foot"'))
    const line = foot.slice(foot.indexOf('>') + 1, foot.indexOf('</text>')).trim()
    assertEq(line, '微信每次仅提醒一次，需要时可再次开启。', '辅助文案应为约定的一行')
    assertNo(/微信只支持一次性订阅/.test(oursWxml), '旧的长解释必须删除')
    assertNo(/页面上的提示一直都有/.test(oursWxml), '旧的长解释必须删除')
  })

  await testCase('[L1] B2 标题、状态标签、按钮三项都还在（不清空功能）', () => {
    assertOk(/微信消息提醒/.test(oursWxml), '缺标题')
    assertOk(/已记录 ' \+ myQuotaTotal \+ ' 次/.test(oursWxml), '缺「已记录 N 次」状态')
    assertOk(/bindtap="notifySub"/.test(oursWxml), '缺订阅按钮')
    assertOk(/再开启几次|开启微信提醒/.test(oursWxml), '按钮文案应保留')
  })

  await testCase('[L2] B3 状态提示保持三态且都是短句：不谎称「还能收 N 次」，也不承诺永久', () => {
    const page = loadOurs()
    // 开源模板的 template ID 是占位符 → notifyReady 默认 false，
    // 这里必须显式置 true 才能验证「已配置模板」下的三态文案（B4 反过来验未配置态）。
    page.setData({ notifyReady: true })
    const off = page.buildNotifyHint({ chat: 0 })
    assertOk(off.indexOf('还没开启') !== -1, '0 次应说还没开启: ' + off)
    assertOk(off.length <= 40, '未开启提示过长（应是一行）: ' + off)

    const on = page.buildNotifyHint({ chat: 3 })
    assertOk(on.indexOf('3') !== -1, '应显示真实次数: ' + on)
    assertOk(/服务端记账/.test(on), '必须说明次数是服务端记账: ' + on)
    assertNotIn(on, '一次性订阅', '一次性说明不该在这里重复第二遍')
    assertNotIn(on, '可收', '不得声称还能收 N 次')
    assertNotIn(on, '永久', '不得承诺永久')
    assertOk(on.length <= 30, '已开启提示过长（应是一行）: ' + on)
  })

  await testCase('[L2] B4 模板未配置时仍然明确反馈（不能因为精简就把错误提示省掉）', () => {
    const page = loadOurs()
    page.setData({ notifyReady: false })
    const hint = page.buildNotifyHint({ chat: 0 })
    assertOk(/模板还没配置/.test(hint), '必须告知模板未配置: ' + hint)
    assertOk(/收不到微信提醒/.test(hint), '必须说明收不到提醒: ' + hint)
    assertNotIn(hint, '永久', '不得承诺永久')
  })

  // ============================================================
  // C. 经期提醒卡片
  // ============================================================
  await testCase('[L1] C1 底部只留一行，旧的一次性订阅长解释已删除，且仍说清「提醒一次」', () => {
    const foots = calWxml.match(/class="remind-foot"/g) || []
    assertEq(foots.length, 1, '辅助文案只允许出现一处')
    const foot = calWxml.slice(calWxml.indexOf('class="remind-foot"'))
    const line = foot.slice(foot.indexOf('>') + 1, foot.indexOf('</text>')).trim()
    assertEq(line, '开启后，预计经期前 2 天提醒一次。', '辅助文案应为约定的一行')
    assertNo(/微信只支持一次性订阅/.test(calWxml), '旧的长解释必须删除')
    assertNo(/每同意一次只能收到一条/.test(calWxml), '旧的长解释必须删除')
  })

  await testCase('[L1] C2 标题/状态/按钮/「也提醒 TA」前置条件都还在', () => {
    assertOk(/经期提醒/.test(calWxml), '缺标题')
    assertOk(/已记录 ' \+ remindQuota \+ ' 次/.test(calWxml), '缺「已记录 N 次」状态')
    assertOk(/subscribeRemind/.test(calWxml), '缺订阅入口')
    assertOk(/也提醒 TA/.test(calWxml), '双方配合的前置条件不得删除')
    assertOk(/onPartnerRemind/.test(calWxml), '「也提醒 TA」开关不得删除')
  })

  await testCase('[L1] C3 她正常态不再重复状态：提示行有 wx:if 且她分支返回空串', () => {
    assertOk(/wx:if="\{\{remindHint\}\}"[^>]*class="remind-hint"|class="remind-hint"[^>]*wx:if/.test(calWxml), '提示行必须带 wx:if，空字符串时不占位')
    const js = read(CAL_JS)
    assertOk(/if \(isHer\) return ''/.test(js), '她正常状态下提示行应为空（状态已在右上角标签）')
    assertOk(/也提醒 TA/.test(js), '他的前置条件提示必须保留')
    assertNo(/每收一条少一次/.test(js), '旧的长解释必须删除')
    assertNo(/永久/.test(js.replace(/\/\/[^\n]*/g, '')), '不得承诺永久')
  })

  await testCase('[L1] C4 她与他的提示行都短（避免换行把卡片再次撑高）', () => {
    const js = read(CAL_JS)
    const body = js.slice(js.indexOf('function buildRemindHint'), js.indexOf('Page({'))
    const lines = body.match(/return\s+'(?:[^'\\]|\\.)*'|return\s+`[^`]*`/g) || []
    assertOk(lines.length >= 3, '应至少有 3 个分支返回，实际 ' + lines.length)
    for (const l of lines) {
      const text = l.replace(/^return\s+['"`]/, '').replace(/['"`]$/, '')
      assertOk(text.length <= 32, '提示过长（>32 字）: ' + text)
    }
  })

  console.log('\n=== 结果: ' + passed + ' PASS / ' + failed + ' FAIL ===')
  if (failed) {
    console.log('失败项：')
    failures.forEach(f => console.log('  - ' + f))
    process.exitCode = 1
  } else {
    console.log('V1.1 UI Fix: ALL GREEN')
  }
}

main().catch(e => { console.error(e); process.exitCode = 1 })
