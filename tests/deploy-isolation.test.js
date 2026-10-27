// ============================================================
// tests/deploy-isolation.test.js · 云函数部署隔离静态测试
// 微信云开发每个云函数独立打包：运行时代码禁止跨云函数目录引用
// 非法形式：require('../<other-fn>/...') 或 import from '../<other-fn>/...'
// 合法形式：require('./core')（同目录）
// 运行：node tests/deploy-isolation.test.js
// ============================================================
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const FUNCS_DIR = path.join(ROOT, 'cloudfunctions')

// 匹配 require('../...') 或 from '../...'（含单双引号）
const CROSS_IMPORT_RE = /(?:require\s*\(\s*|from\s*)(['"])\.\.\//g

let passed = 0
let failed = 0
const failures = []

function check(name, cond, detail) {
  if (cond) {
    passed++
    console.log('  PASS  ' + name)
  } else {
    failed++
    failures.push(name + (detail ? ' -> ' + detail : ''))
    console.log('  FAIL  ' + name + (detail ? ' -> ' + detail : ''))
  }
}

function walk(dir, acc) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, acc)
    else if (entry.name.endsWith('.js')) acc.push(full)
  }
  return acc
}

const funcNames = fs.readdirSync(FUNCS_DIR, { withFileTypes: true })
  .filter(e => e.isDirectory())
  .map(e => e.name)
  .sort()

console.log('\n=== 云函数部署隔离测试 ===')
console.log('扫描云函数目录:', funcNames.join(', '))

check('发现全部 11 个云函数目录', funcNames.length === 11, '实际 ' + funcNames.length + ' : ' + funcNames.join(', ') )

for (const fn of funcNames) {
  const fnDir = path.join(FUNCS_DIR, fn)
  const files = walk(fnDir, [])
  const violations = []
  for (const file of files) {
    const rel = path.relative(FUNCS_DIR, file)
    const content = fs.readFileSync(file, 'utf8')
    CROSS_IMPORT_RE.lastIndex = 0
    let m
    while ((m = CROSS_IMPORT_RE.exec(content)) !== null) {
      violations.push(rel + ' 行内存在跨目录引用: ' + content.slice(Math.max(0, m.index - 40), m.index + 30).replace(/\n/g, ' '))
    }
  }
  check(fn + ' 无跨云函数引用', violations.length === 0, violations.join(' | '))
}

// 全局兜底：整个 cloudfunctions 树不允许出现 '../<cloudfunction>/'
const allFiles = walk(FUNCS_DIR, [])
let globalHits = []
for (const file of allFiles) {
  const rel = path.relative(ROOT, file)
  const content = fs.readFileSync(file, 'utf8')
  CROSS_IMPORT_RE.lastIndex = 0
  let m
  while ((m = CROSS_IMPORT_RE.exec(content)) !== null) globalHits.push(rel)
}
check('全局零跨云函数引用（兜底）', globalHits.length === 0, globalHits.join(', '))

console.log('\n=== 结果: ' + passed + ' PASS / ' + failed + ' FAIL ===')
if (failures.length) {
  failures.forEach(f => console.log('  - ' + f))
  process.exit(1)
}
console.log('Deploy Isolation: ALL GREEN')
