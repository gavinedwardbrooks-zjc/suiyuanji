// ============================================================
// tests/cloudfunction-shared-modules.test.js · 云函数部署产物一致性守卫
//
// 背景（真实风险）：
//   微信云函数只能访问**自己目录内**的文件，所以 cloudfunctions/ 根级的共享模块
//   必须各复制一份到 desktopAuthPublic / desktopAuthMiniapp / desktopDaily 里；
//   而单元测试 require 的是**根级**模块。
//   ⇒ 只改根级、忘了同步副本时：测试全绿，线上跑的还是旧代码。
//   本文件把这条“假绿”通道堵死。
//
// 三条断言：
//   D1 各函数目录里的根级共享模块副本，内容必须与根级模块一致（忽略换行差异）。
//   D2 同名模块出现在多个函数目录时（如 userIdentity/core.js），彼此必须一致。
//   D3 index.js 里所有 require('./x') 的相对依赖，必须在同目录内真实存在，
//      否则该函数一部署就 MODULE_NOT_FOUND。
// ============================================================
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const CF_ROOT = path.resolve(__dirname, '../cloudfunctions')
const FUNCTION_DIRS = ['desktopAuthPublic', 'desktopAuthMiniapp', 'desktopDaily', 'userIdentity', 'userUidMigration']
const normalize = p => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n')
const listJs = dir => fs.readdirSync(dir).filter(n => n.endsWith('.js'))

let passed = 0
let failed = 0
function testCase(name, fn) {
  try { fn(); passed++; console.log('  PASS  ' + name) }
  catch (e) { failed++; console.log('  FAIL  ' + name + '  -> ' + e.message) }
}

console.log('\n=== 云函数共享模块一致性 ===\n')

testCase('D1 函数目录内的共享模块副本与根级模块一致', () => {
  const rootModules = listJs(CF_ROOT)
  const drifted = []
  for (const dir of FUNCTION_DIRS) {
    const abs = path.join(CF_ROOT, dir)
    if (!fs.existsSync(abs)) { drifted.push(`${dir}（目录缺失）`); continue }
    for (const name of listJs(abs)) {
      if (name === 'index.js' || !rootModules.includes(name)) continue
      if (normalize(path.join(CF_ROOT, name)) !== normalize(path.join(abs, name))) drifted.push(`${dir}/${name}`)
    }
  }
  assert.deepStrictEqual(drifted, [], '副本与根级模块不一致（部署后会跑旧代码）：\n  ' + drifted.join('\n  '))
})

testCase('D2 index.js 调用的每个成员，在其本目录依赖里真实导出', () => {
  // 为什么不用「同名文件必须一致」：userIdentity/core.js 与 userUidMigration/core.js
  // 名字相同但**确实是两个模块**（迁移版只保留 diagnose/dryRun/execute，注释已说明）。
  // 真正会炸的是另一种情况：index.js 调用 foo.bar()，而本目录的 foo 没导出 bar
  // —— 测试跑根级模块时全绿，部署到函数目录就 TypeError。
  const exportedNames = (file) => {
    const src = fs.readFileSync(file, 'utf8')
    const m = src.match(/module\.exports\s*=\s*\{([\s\S]*?)\}/)
    if (!m) return null
    return m[1].split(',').map(s => s.trim().split(':')[0].trim()).filter(Boolean)
  }
  const problems = []
  for (const dir of FUNCTION_DIRS) {
    const abs = path.join(CF_ROOT, dir)
    const entry = path.join(abs, 'index.js')
    if (!fs.existsSync(entry)) continue
    const src = fs.readFileSync(entry, 'utf8')
    // alias = require('./x')  →  alias 指向本目录的 x.js
    const aliases = new Map()
    for (const m of src.matchAll(/const\s+(\w+)\s*=\s*require\(\s*['"]\.\/([^'"]+)['"]\s*\)/g)) aliases.set(m[1], m[2])
    for (const [alias, dep] of aliases) {
      const target = path.join(abs, dep.endsWith('.js') ? dep : dep + '.js')
      if (!fs.existsSync(target)) continue // D3 负责报缺失
      const names = exportedNames(target)
      if (!names) { problems.push(`${dir}/${alias} → ./${dep} 无 module.exports 字面量，无法静态校验`); continue }
      const used = new Set()
      for (const m of src.matchAll(new RegExp('\\b' + alias + '\\.([A-Za-z_$][\\w$]*)', 'g'))) used.add(m[1])
      for (const fn of used) if (!names.includes(fn)) problems.push(`${dir}: ${alias}.${fn}() 在 ./${dep} 中未导出`)
    }
  }
  assert.deepStrictEqual(problems, [], '函数目录内的导出面与调用不匹配：\n  ' + problems.join('\n  '))
})

testCase('D3 每个函数的相对依赖在本目录内真实存在（可部署性）', () => {
  const missing = []
  for (const dir of FUNCTION_DIRS) {
    const abs = path.join(CF_ROOT, dir)
    if (!fs.existsSync(abs)) continue
    for (const name of listJs(abs)) {
      const src = fs.readFileSync(path.join(abs, name), 'utf8')
      for (const m of src.matchAll(/require\(\s*['"]\.\/([^'"]+)['"]\s*\)/g)) {
        const dep = m[1]
        const target = path.join(abs, dep)
        if (!fs.existsSync(target) && !fs.existsSync(target + '.js')) missing.push(`${dir}/${name} → ./${dep}`)
      }
    }
  }
  assert.deepStrictEqual(missing, [], '相对依赖在函数目录内不存在（部署即 MODULE_NOT_FOUND）：\n  ' + missing.join('\n  '))
})

console.log(`\n=== ${passed} PASS / ${failed} FAIL ===`)
if (failed > 0) process.exit(1)
