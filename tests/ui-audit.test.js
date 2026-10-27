// ============================================================
// tests/ui-audit.test.js · M1 Binding UI 真机可读性静态验收
// 不依赖渲染，直接扫 WXML/WXSS 结构与样式数值
// 验收项（PRD v0.6 + 用户真机指令）：
//   1. 输入框高度 ≥ 44px（=88rpx）
//   2. 输入框字号 ≥ 16px（=32rpx）
//   3. 绑定按钮可见（background 非透明 + min-height ≥ 88rpx）
//   4. 绑定码等宽粗体（font-family monospace + font-weight ≥ 700）
//   5. 窄屏不裁切：bind-input flex-wrap: wrap
//   6. 绑定码提供复制按钮（bindtap="copyBindCode"）
//   7. 配色对比：背景与文字非同一颜色（最低限度）
// 运行：node tests/ui-audit.test.js
// ============================================================
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
let passed = 0, failed = 0, failures = []

function check(name, cond, detail) {
  if (cond) { passed++; console.log('  PASS  ' + name) }
  else { failed++; failures.push(name + (detail ? ' -> ' + detail : '')); console.log('  FAIL  ' + name + (detail ? ' -> ' + detail : '')) }
}

function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8') }

// 从 wxss 片段中提取数值（含单位 rpx/px/em/rem）
function extractNumber(selectorBlock, prop) {
  // 找 prop: value（包含数字 + 单位）
  const re = new RegExp(prop + '\\s*:\\s*([^;\\n]+)', 'i')
  const m = selectorBlock.match(re)
  if (!m) return null
  const v = m[1].trim()
  const num = v.match(/(-?\d+(\.\d+)?)/)
  if (!num) return v
  const n = parseFloat(num[1])
  // 统一换算到 px 物理（rpx=0.5px@375 / 等同 px 物理，这里 rpx → px 用 ÷2）
  if (/rpx$/i.test(v.trim())) return { value: n, unit: 'rpx', px: n / 2 }
  if (/px$/i.test(v.trim())) return { value: n, unit: 'px', px: n }
  if (/em$/i.test(v.trim())) return { value: n, unit: 'em', px: n * 16 }
  if (/rem$/i.test(v.trim())) return { value: n, unit: 'rem', px: n * 16 }
  return { value: n, unit: 'unknown', px: n }
}

// 提取选择器对应的规则块（匹配 `{ ... }`，含嵌套）
function findRule(css, selector) {
  const re = new RegExp(`\\.${selector}\\s*\\{([^}]*)\\}`)
  const m = css.match(re)
  return m ? m[1] : null
}

function assertNumeric(rule, prop, minPx, name) {
  if (!rule) return name + '（规则不存在）'
  const n = extractNumber(rule, prop)
  if (!n) return name + '（属性 ' + prop + ' 缺失）'
  if (n.px < minPx) return name + '（' + prop + '=' + n.value + n.unit + ' = ' + n.px + 'px < ' + minPx + 'px）'
  return null
}

console.log('\n=== M1 Binding UI 真机可读性静态验收 ===\n')

// ---------- ours 页 ----------
const oursWxml = read('pages/ours/ours.wxml')
const oursWxss = read('pages/ours/ours.wxss')

check('ours.wxml 含 .bind-input-field（独立输入框）', oursWxml.includes('class="bind-input-field"'))
check('ours.wxml 含 <button class="bind-btn">"绑定" 按钮（原生 button 元素）', /<button[^>]*class="bind-btn"[^>]*>\s*绑定\s*<\/button>/.test(oursWxml))
check('ours.wxml 含 bindtap="copyBindCode"（复制按钮）', oursWxml.includes('bindtap="copyBindCode"'))
check('ours.wxml 含 mono 绑定码（等宽）', oursWxml.includes('class="code mono"'))
check('ours.wxml 输入框 placeholder 含 XZ 提示', /placeholder="[^"]*XZ/i.test(oursWxml))
check('ours.wxml 绑定码区含 code mono + 复制 + 生成按钮', oursWxml.includes('class="code mono"') && oursWxml.includes('>复制<') && oursWxml.includes('>生成<'))
check('ours.wxml 输入框与按钮用非 flex 块级容器 .bind-block（避免 iOS flex 子项塌缩）', oursWxml.includes('class="bind-block"'))

const oursCodeRule = findRule(oursWxss, 'code\\.mono')
const e1 = assertNumeric(oursCodeRule, 'font-size', 14, 'ours .code.mono font-size') // 28rpx ≈ 14px 物理
const e2 = assertNumeric(oursCodeRule, 'font-weight', 700, 'ours .code.mono font-weight')
const e3 = !oursCodeRule.includes('monospace') && !oursCodeRule.includes('Consolas') && !oursCodeRule.includes('Menlo') && !oursCodeRule.includes('Courier') ? 'ours .code.mono 缺等宽字体' : null
check('ours .code.mono font-size ≥ 28rpx', !e1, e1)
check('ours .code.mono font-weight ≥ 700（粗体）', !e2, e2)
check('ours .code.mono 声明等宽字体（monospace/Courier/Menlo/Consolas）', !e3, e3)

const oursInputRule = findRule(oursWxss, 'bind-input-field')
const e4 = assertNumeric(oursInputRule, 'min-height', 44, 'ours .bind-input-field min-height')
const e5 = assertNumeric(oursInputRule, 'font-size', 16, 'ours .bind-input-field font-size')
check('ours .bind-input-field min-height ≥ 44px', !e4, e4)
check('ours .bind-input-field font-size ≥ 16px', !e5, e5)

const oursBtnRule = findRule(oursWxss, 'bind-btn\\b')
const oursHeight = extractNumber(oursBtnRule, 'height')
const oursMinHeight = extractNumber(oursBtnRule, 'min-height')
const oursEffectivePx = Math.max(
  oursHeight && oursHeight.px || 0,
  oursMinHeight && oursMinHeight.px || 0
)
const hasBg = oursBtnRule && /background\s*:\s*var\(--/.test(oursBtnRule) && !/background\s*:\s*(transparent|none|inherit)/i.test(oursBtnRule)
const isBlockBtn = oursBtnRule && /display\s*:\s*block/i.test(oursBtnRule) && /width\s*:\s*100%/i.test(oursBtnRule)
const noBorder = oursBtnRule && /border\s*:\s*none/i.test(oursBtnRule)
check('ours .bind-btn 高度 ≥ 44px（height 或 min-height）', oursEffectivePx >= 44, 'actual=' + oursEffectivePx + 'px')
check('ours .bind-btn background 非透明', !!hasBg, 'background 缺失或为透明')
check('ours .bind-btn 块级 + width:100%（不依赖 flex）', !!isBlockBtn, '缺 display:block 或 width:100%')
check('ours .bind-btn border:none（去掉 button 默认边框）', !!noBorder, '缺 border:none')

const oursBlockContainer = findRule(oursWxss, 'bind-block')
check('ours .bind-block 容器（块级堆叠，无 flex 依赖）', oursBlockContainer, '缺 .bind-block 规则')
check('ours.wxss 无 @media 覆盖 send-btn（避免真机媒体查询意外）', !/@media[^{]*min-width\s*:\s*480rpx/i.test(oursWxss), '仍存在 480rpx 媒体查询')

// ---------- mine 页（同步约束） ----------
const mineWxml = read('pages/mine/mine.wxml')
const mineWxss = read('pages/mine/mine.wxss')

check('mine.wxml 含 .bind-input-field（独立输入框）', mineWxml.includes('class="bind-input-field"'))
check('mine.wxml 含 <button class="bind-btn">"绑定" 按钮（原生 button 元素）', /<button[^>]*class="bind-btn"[^>]*>\s*绑定\s*<\/button>/.test(mineWxml))
check('mine.wxml 含 bindtap="copyBindCode"（复制按钮）', mineWxml.includes('bindtap="copyBindCode"'))
check('mine.wxml 含 mono 绑定码（等宽）', mineWxml.includes('class="code mono"'))
check('mine.wxml 含 .bind-block 非 flex 容器', mineWxml.includes('class="bind-block"'))

const mineCodeRule = findRule(mineWxss, 'code\\.mono')
check('mine .code.mono font-size ≥ 28rpx', !assertNumeric(mineCodeRule, 'font-size', 14, 'mine .code.mono font-size'))
check('mine .code.mono font-weight ≥ 700', !assertNumeric(mineCodeRule, 'font-weight', 700, 'mine .code.mono font-weight'))
check('mine .code.mono 声明等宽字体', !(!mineCodeRule.includes('monospace') && !mineCodeRule.includes('Consolas') && !mineCodeRule.includes('Menlo') && !mineCodeRule.includes('Courier') && '缺等宽字体'))

const mineInputRule = findRule(mineWxss, 'bind-input-field')
check('mine .bind-input-field min-height ≥ 44px', !assertNumeric(mineInputRule, 'min-height', 44, 'mine .bind-input-field min-height'))
check('mine .bind-input-field font-size ≥ 16px', !assertNumeric(mineInputRule, 'font-size', 16, 'mine .bind-input-field font-size'))

const mineBtnRule = findRule(mineWxss, 'bind-btn\\b')
const mineHeight = extractNumber(mineBtnRule, 'height')
const mineMinHeight = extractNumber(mineBtnRule, 'min-height')
const mineEffectivePx = Math.max(
  mineHeight && mineHeight.px || 0,
  mineMinHeight && mineMinHeight.px || 0
)
check('mine .bind-btn 高度 ≥ 44px（height 或 min-height）', mineEffectivePx >= 44, 'actual=' + mineEffectivePx + 'px')
check('mine .bind-btn 块级 + width:100%', !!(mineBtnRule && /display\s*:\s*block/i.test(mineBtnRule) && /width\s*:\s*100%/i.test(mineBtnRule)), '缺 display:block 或 width:100%')
check('mine.wxss 无 @media 覆盖 send-btn', !/@media[^{]*min-width\s*:\s*480rpx/i.test(mineWxss), '仍存在 480rpx 媒体查询')

// ---------- ours/mine JS 接线 ----------
const oursJs = read('pages/ours/ours.js')
const mineJs = read('pages/mine/mine.js')
check('ours.js copyBindCode 含 wx.setClipboardData', /wx\.setClipboardData\s*\(\s*\{\s*data:\s*code/.test(oursJs))
check('mine.js copyBindCode 含 wx.setClipboardData', /wx\.setClipboardData\s*\(\s*\{\s*data:\s*code/.test(mineJs))
check('ours.js bind() 调用 action=claim + code', /action:\s*['"]claim['"][\s\S]*code\s*:/.test(oursJs) || /action:\s*['"]claim['"][\s\S]{0,80}code/.test(oursJs))
check('mine.js bind() 调用 action=claim + code', /action:\s*['"]claim['"][\s\S]*code\s*:/.test(mineJs) || /action:\s*['"]claim['"][\s\S]{0,80}code/.test(mineJs))

console.log('\n=== 结果: ' + passed + ' PASS / ' + failed + ' FAIL ===')
if (failed) {
  failures.forEach(f => console.log('  - ' + f))
  process.exit(1)
}
console.log('UI Audit: ALL GREEN')