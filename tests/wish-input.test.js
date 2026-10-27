// ============================================================
// tests/wish-input.test.js · 心愿输入交互（M5 UX 修复）
// 按钮主入口 addWish/removeWish 纯函数 + WXML 静态断言
// 覆盖：0→1 / wishCount=2 / trim 去重 / chip 本体不删 / × 删
// 运行：node tests/wish-input.test.js
// ============================================================
const fs = require('fs')
const path = require('path')
const { addWish, removeWish } = require('../utils/wish-input')

const ROOT = path.resolve(__dirname, '..')
let passed = 0, failed = 0, failures = []

function check(name, cond, detail) {
  if (cond) { passed++; console.log('  PASS  ' + name) }
  else { failed++; failures.push(name + (detail ? ' -> ' + detail : '')); console.log('  FAIL  ' + name + (detail ? ' -> ' + detail : '')) }
}
function assertEq(a, b, msg) { if (a !== b) throw new Error((msg || '') + ' 期望 ' + JSON.stringify(b) + ' 实际 ' + JSON.stringify(a)) }

function run() {
  console.log('\n=== 心愿输入交互（按钮主入口） ===\n')

  // 纯函数逻辑
  const r1 = addWish([], '寿司')
  check('A 点击添加按钮 → eatCount 0→1', r1.added === true && r1.list.length === 1 && r1.list[0] === '寿司')
  const r2 = addWish(['寿司'], '看电影')
  check('B 添加第二条 → 2 条', r2.added === true && r2.list.length === 2)
  const r3 = addWish(['寿司'], ' 寿司 ')
  check('C trim 相同 → 不重复（dup）', r3.added === false && r3.reason === 'dup' && r3.list.length === 1)
  const r4 = addWish(['寿司'], '   ')
  check('D 空值（仅空白）→ 不加', r4.added === false && r4.reason === 'empty')
  const r5 = addWish([], null)
  check('E null/undefined → 不加', r5.added === false)

  // removeWish：× 删除 / 非法索引保护
  const rm1 = removeWish(['寿司', '火锅'], 0)
  check('F 点 × 删除第 1 条 → 剩 1 条', rm1.length === 1 && rm1[0] === '火锅')
  const rm2 = removeWish(['寿司'], 99)
  check('G 越界索引 → 不删除', rm2.length === 1)
  const rm3 = removeWish(['寿司'], -1)
  check('H 负索引 → 不删除', rm3.length === 1)

  // WXML 静态断言
  const wxml = fs.readFileSync(path.join(ROOT, 'pages/record/record.wxml'), 'utf8')
  const js = fs.readFileSync(path.join(ROOT, 'pages/record/record.js'), 'utf8')

  check('I wxml 有「添加」按钮（eat 行）', /bindtap="addEatByButton"[\s\S]*?>添加<\/view>/.test(wxml) || (wxml.includes('addEatByButton') && wxml.includes('>添加<')), '缺 eat 添加按钮')
  check('J wxml 有「添加」按钮（do 行）', wxml.includes('addDoByButton') && wxml.includes('>添加<'))
  check('K bindconfirm 复用按钮函数（双入口）', wxml.includes('bindconfirm="addEatByButton"') && wxml.includes('bindconfirm="addDoByButton"'))
  check('L chip 本体不再绑定删除（无 bindtap deleteEat）', !/wchip[^>]*bindtap="delete(Eat|Do)"/.test(wxml), 'chip 本体仍绑删除')
  check('M chip 的 × 用 catchtap 删除（阻止冒泡）', wxml.includes('catchtap="deleteEat"') && wxml.includes('catchtap="deleteDo"'))
  check('N js 提供 addEatByButton/addDoByButton', js.includes('addEatByButton') && js.includes('addDoByButton'))
  check('O js 不再有旧 addEat()/addDo() 空实现（改由 ByButton 承载）', !/^\s{2}addEat\(\)/.test(js) && !/^\s{2}addDo\(\)/.test(js), '旧 addEat/addDo 仍存在')

  // 组合：2 条心愿 → save payload wishCount=2（与 record.js 同构）
  const eats = addWish([], '寿司').list
  const dos = addWish([], '看电影').list
  const payload = [...eats.map(t => ({ type: 'eat', text: t })), ...dos.map(t => ({ type: 'do', text: t }))]
  check('P 保存前 wishCount=2', payload.length === 2 && payload[0].type === 'eat' && payload[1].type === 'do')

  console.log('\n=== 结果: ' + passed + ' PASS / ' + failed + ' FAIL ===')
  if (failed) {
    failures.forEach(f => console.log('  - ' + f))
    process.exit(1)
  }
  console.log('Wish Input: ALL GREEN')
}

run()
