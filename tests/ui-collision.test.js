// ============================================================
// tests/ui-collision.test.js · 布局碰撞回归锁（2026-08-28）
// 真机 3 处重叠修复后，静态锁定：
//   1. 首页空状态 CTA 无装饰叠加
//   2. 记录页 wish-add 行：icon | input(flex:1,min-width:0) | button(flex-shrink:0)
//   3. 记录页 todo-add 行：input(flex:1,min-width:0) | + 按钮(flex-shrink:0)
// 原则：禁止负 margin / translate 制造视觉重叠；装饰不得与按钮叠加
// 运行：node tests/ui-collision.test.js
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
// 取某个选择器的**第一层规则块**。
// 负向断言必须限定在块内：用 [\s\S]*? 扫到文件末尾，会把后面新增的
// 任何 position: absolute 都算成这个选择器的属性（2026-10-26 就踩到过）。
function blockOf(css, selector) {
  const i = css.indexOf(selector + ' {')
  if (i < 0) return ''
  const start = css.indexOf('{', i)
  const end = css.indexOf('}', start)
  return css.slice(start + 1, end)
}

console.log('\n=== UI Collision 布局碰撞回归锁 ===\n')

const homeWxml = read('pages/home/home.wxml')
const homeWxss = read('pages/home/home.wxss')
const recWxml = read('pages/record/record.wxml')
const recWxss = read('pages/record/record.wxss')

// ---------- 1. 首页空状态 ----------
check('H1 空状态无绝对定位装饰与 CTA 叠加',
  !/empty-state[\s\S]{0,600}?deco/.test(homeWxml) &&
  !homeWxml.match(/class="deco[^"]*"[^>]*>\s*<view class="candy-btn empty-cta"/),
  '空状态内不应再有 deco 装饰包住按钮')
check('H1 空状态 CTA 存在（去记录）', homeWxml.includes('empty-cta') && homeWxml.includes('去记录'))
check('H1 空状态 CTA 阴影为柔和（非实心偏移色条）',
  /\.empty-cta\s*\{[\s\S]*?box-shadow:\s*var\(--shadow-soft-ink\)/.test(homeWxss),
  'candy-btn 实心阴影(0 8rpx 0)会让按钮下方露出实体色条，空状态必须覆盖')
check('H1 空状态无负 margin / translate 造成覆盖',
  !/\.empty-state\s*\{[^}]*?margin(-[a-z]+)?:\s*-/.test(homeWxss) &&
  !/\.empty-cta\s*\{[^}]*?transform:\s*translate/.test(homeWxss))

// ---------- 2. 记录页 wish-row 三列 ----------
check('W1 wish-row 行使用 flex（icon-wrap|input|button 三列）',
  /\.wish-row\s*\{[\s\S]*?display:\s*flex/.test(recWxss),
  '.wish-row 需 flex 容器')
check('W2 record-inline-input flex:1 + width:0 + min-width:0（input 不被图标/按钮挤压）',
  /\.record-inline-input\s*\{[\s\S]*?flex:\s*1 1 0%[\s\S]*?width:\s*0[\s\S]*?min-width:\s*0/.test(recWxss),
  'input 需 flex:1 1 0% + width:0 + min-width:0')
check('W3 wish-icon-wrap 固定 48rpx + flex:0 0 48rpx（图标独立列，不压 input）',
  /\.wish-icon-wrap\s*\{[\s\S]*?width:\s*48rpx[\s\S]*?flex:\s*0 0 48rpx/.test(recWxss) &&
  !/position:\s*absolute/.test(blockOf(recWxss, '.wish-icon-wrap')),
  '图标必须独立固定列，不得 absolute 压 input')
check('W4 wish-action-btn flex-shrink 安全 + min-width ≤120rpx（不占太大）',
  /\.wish-action-btn\s*\{[\s\S]*?min-width:\s*(10[0-9]|11[0-9]|120)rpx/.test(recWxss) &&
  /\.wish-action-btn\s*\{[\s\S]*?height:\s*72rpx/.test(recWxss),
  '按钮 min-width 应 ≤120rpx、height 72rpx')
check('W5 wish-row 无负 margin / translate 覆盖',
  !/\.wish-row[^{]*\{[\s\S]*?margin(-[a-z]+)?:\s*-/.test(recWxss) &&
  !/\.wish-action-btn[^{]*\{[\s\S]*?transform:\s*translate/.test(recWxss))

// ---------- 3. 记录页 todo-compose 行 ----------
check('T1 todo-compose-row 行使用 flex', /\.todo-compose-row\s*\{[\s\S]*?display:\s*flex/.test(recWxss), '.todo-compose-row 需 flex 容器')
check('T2 record-inline-input 统一契约（todo 复用）',
  /\.record-inline-input\s*\{[\s\S]*?height:\s*72rpx[\s\S]*?padding:\s*0 20rpx/.test(recWxss),
  'input 需固定 height 72rpx + 仅水平 padding')
check('T3 todo-action-btn 正圆 + flex-shrink 安全（+ 按钮不挤压 input）',
  /\.todo-action-btn\s*\{[\s\S]*?width:\s*72rpx[\s\S]*?height:\s*72rpx[\s\S]*?border-radius:\s*50%/.test(recWxss) &&
  /\.todo-action-btn\s*\{[\s\S]*?flex:\s*0 0 72rpx/.test(recWxss) &&
  !/position:\s*absolute/.test(blockOf(recWxss, '.todo-action-btn')))
check('T3b ＋按钮三锁同值（width=min-width=max-width=72rpx，杜绝 button UA 撑宽）',
  (() => { const b = recWxss.match(/\.todo-action-btn\s*\{[^}]*\}/)
    return b && b[0].includes('width: 72rpx') && b[0].includes('min-width: 72rpx') &&
           b[0].includes('max-width: 72rpx') && b[0].includes('flex-grow: 0') &&
           b[0].includes('flex-shrink: 0') && b[0].includes('padding: 0') &&
           b[0].includes('margin: 0') })())
check('T3c ＋按钮无任何 ≥80rpx min-width 污染',
  !/\.todo-action-btn\s*\{[^}]*?min-width:\s*(?:8[0-9]|[1-9][0-9]{2,})rpx/.test(recWxss))
check('T3d input flex-grow(1) > ＋按钮 flex-grow(0)（input 为主角）',
  /\.todo-compose-input\s*\{[\s\S]*?flex:\s*1 1 0%/.test(recWxss) &&
  /\.todo-action-btn\s*\{[\s\S]*?flex-grow:\s*0/.test(recWxss))
check('T4 todo-compose-row 无负 margin / translate 覆盖',
  !/\.todo-compose-row[^{]*\{[\s\S]*?margin(-[a-z]+)?:\s*-/.test(recWxss))
check('T5 todo-item 独立浅卡片行（checkbox|text|× 三列）',
  /\.todo-item\s*\{[\s\S]*?display:\s*flex[\s\S]*?border-radius:\s*22rpx/.test(read('components/todo-item/todo-item.wxss')) &&
  /\.todo-item\s*\{[\s\S]*?padding:\s*18rpx 22rpx/.test(read('components/todo-item/todo-item.wxss')))
check('T6 todo-item 三列：check 固定 / txt flex:1 / del 右侧',
  /\.check\s*\{[\s\S]*?width:\s*40rpx/.test(read('components/todo-item/todo-item.wxss')) &&
  /\.txt\s*\{[\s\S]*?flex:\s*1/.test(read('components/todo-item/todo-item.wxss')) &&
  /\.del\s*\{[\s\S]*?flex-shrink:\s*0/.test(read('components/todo-item/todo-item.wxss')))

// ---------- 4. 记录页保存按钮（独立专用 class，不串圆钮） ----------
const recWxml2 = recWxml
check('S1 保存按钮用专用 class record-save-btn（不再裸用 btn-primary）',
  recWxml2.includes('record-save-btn') && recWxml2.includes('保存今日') && recWxml2.includes('bindtap="onSaveTap"'))
check('S2 record-save-btn 非圆形固定（width 不等于 height）',
  /\.record-save-btn\s*\{[\s\S]*?width:\s*84%[\s\S]*?min-height:\s*96rpx/.test(recWxss) &&
  !/\.record-save-btn\s*\{[\s\S]*?(width|height):\s*64rpx/.test(recWxss),
  '保存按钮不得被 64rpx 圆钮规则命中')
check('S3 record-save-btn position:static + 居中 + box-sizing',
  /\.record-save-btn\s*\{[^}]*\}/.test(recWxss) &&
  (() => { const b = recWxss.match(/\.record-save-btn\s*\{[^}]*\}/)[0]
    return b.includes('position: static') && b.includes('align-items: center') &&
           b.includes('justify-content: center') && b.includes('box-sizing: border-box') })())
check('S4 save-bar 垂直流布局（不再 flex 行把按钮挤到角落）',
  /\.save-bar\s*\{[\s\S]*?flex-direction:\s*column[\s\S]*?align-items:\s*center/.test(recWxss))

// ---------- 5. 首页装饰尺寸（防巨大星星） ----------
const hdWxss = read('style/handdrawn.wxss')
check('D1 .deco 全局有安全小尺寸（SVG 无固有尺寸时不会渲染成大图）',
  /\.deco\s*\{[\s\S]*?width:\s*48rpx[\s\S]*?height:\s*48rpx/.test(hdWxss),
  '缺少 .deco 默认小尺寸 → 微信真机按 SVG 固有尺寸放大渲染巨大星星')
check('D2 首页 hero/卡片装饰均用 .deco（继承 48rpx 小尺寸，无独立大尺寸）',
  (homeWxml.match(/class="deco[^"]*"/g) || []).every(c => !/w-[0-9]{3,}/.test(c)) &&
  (() => {
    const decoBlock = hdWxss.match(/\.deco\s*\{[^}]*\}/)
    return decoBlock && !/(width|height):\s*(?:1\d{2,}|[2-9]\d{2})rpx/.test(decoBlock[0])
  })(),
  '.deco 不得有 ≥100rpx 全局尺寸')
check('D3 目标卡装饰 deco-cute 小尺寸（≤64rpx）',
  /\.goal-card \.deco-cute\s*\{[\s\S]*?width:\s*(40|48|56|64)rpx[\s\S]*?height:\s*(40|48|56|64)rpx/.test(homeWxss),
  'goal 装饰必须 40-64rpx 小尺寸')

// ---------- 6. 业务事件契约（不得改名） ----------
check('B1 goRecord / addEatByButton / addDoByButton / addTodo 事件保留',
  homeWxml.includes('bindtap="goRecord"') &&
  recWxml.includes('bindtap="addEatByButton"') &&
  recWxml.includes('bindtap="addDoByButton"') &&
  recWxml.includes('bindtap="addTodo"'))
check('B2 bindinput/bindconfirm 保留',
  recWxml.includes('bindinput="onEatDraft"') &&
  recWxml.includes('bindconfirm="addEatByButton"') &&
  recWxml.includes('bindinput="onTodoDraft"') &&
  recWxml.includes('bindconfirm="addTodo"'))

console.log('\n=== 结果: ' + passed + ' PASS / ' + failed + ' FAIL ===')
console.log(failed ? 'UI Collision: FAIL' : 'UI Collision: ALL GREEN')
process.exit(failed ? 1 : 0)
