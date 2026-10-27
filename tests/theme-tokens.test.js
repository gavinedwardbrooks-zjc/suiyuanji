// ============================================================
// tests/theme-tokens.test.js · 主题令牌完整性测试
// 2026-08-26 真机 blocker 修复：:root 在微信小程序真机不生效导致 var() 全 invalid
// 验收：
//   1. 所有 wxss 中出现的 var(--xxx) 必须在 theme.wxss 中有定义
//   2. 变量必须定义在 `page {}` 选择器下（微信小程序真机可解析）
//   3. 变量定义不引用其他未定义变量（shadow 等复合值）
//   4. PRD §3.1 必备令牌存在
// 运行：node tests/theme-tokens.test.js
// ============================================================
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
let passed = 0, failed = 0, failures = []

function check(name, cond, detail) {
  if (cond) { passed++; console.log('  PASS  ' + name) }
  else { failed++; failures.push(name + (detail ? ' -> ' + detail : '')); console.log('  FAIL  ' + name + (detail ? ' -> ' + detail : '')) }
}

function walk(dir, ext, acc) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === '.workbuddy') continue
      walk(full, ext, acc)
    } else if (e.name.endsWith(ext)) acc.push(full)
  }
  return acc
}

const allWxss = walk(ROOT, '.wxss', [])
const themeFile = path.join(ROOT, 'style/theme.wxss')
const themeContent = fs.readFileSync(themeFile, 'utf8')

// 1. theme.wxss 中定义的变量（page 选择器块内）
const definedInPage = new Set()
const pageBlock = themeContent.match(/page\s*\{([\s\S]*?)\}/)
check('theme.wxss 使用 page 选择器定义变量（真机可解析，非 :root）', !!pageBlock, '未找到 page {} 块')
if (pageBlock) {
  const re = /--([a-zA-Z0-9-]+)\s*:/g
  let m
  while ((m = re.exec(pageBlock[1])) !== null) definedInPage.add('--' + m[1])
}
const rootExists = /:root\s*\{/.test(themeContent)
check('theme.wxss 无 :root 定义（避免真机失效）', !rootExists, '仍存在 :root 选择器')

// 2. 收集所有 wxss 使用到的 var(--xxx)
const usedVars = new Map() // name -> files[]
for (const f of allWxss) {
  const content = fs.readFileSync(f, 'utf8')
  const re = /var\((--[a-zA-Z0-9-]+)\)/g
  let m
  while ((m = re.exec(content)) !== null) {
    if (!usedVars.has(m[1])) usedVars.set(m[1], [])
    usedVars.get(m[1]).push(path.relative(ROOT, f))
  }
}

// 3. 排除动态变量（style="--c: {{color}}" 组件内联定义）
const DYNAMIC_VARS = new Set(['--c'])

// 4. 断言：所有使用都有定义
const missing = []
for (const [name, files] of usedVars) {
  if (DYNAMIC_VARS.has(name)) continue
  if (!definedInPage.has(name)) missing.push(name + ' (used by ' + [...new Set(files)].join(', ') + ')')
}
check('所有 var(--xxx) 都有定义（' + usedVars.size + ' 个变量，含动态排除）', missing.length === 0, '未定义: ' + missing.join('; '))

// 5. 动态变量白名单确认（--c 只在 goal-card 内联使用）
const cFiles = usedVars.get('--c') || []
check('动态变量 --c 仅限 goal-card 内联使用', cFiles.every(f => f.includes('goal-card')), '--c 出现在非 goal-card: ' + cFiles.join(', '))

// 6. PRD §3.1 必备令牌
const required = ['--bg', '--card', '--primary', '--secondary', '--ink', '--pink', '--pink-deep', '--yellow', '--blue', '--radius', '--radius-pill']
const missingReq = required.filter(r => !definedInPage.has(r))
check('PRD §3.1 必备令牌全部定义（' + required.length + ' 个）', missingReq.length === 0, '缺: ' + missingReq.join(', '))

// 7. 关键值抽查（防错值）
function tokenValue(name) {
  if (!pageBlock) return null
  const re = new RegExp('--' + name.replace(/^--/, '') + '\\s*:\\s*([^;]+);')
  const m = pageBlock[1].match(re)
  return m ? m[1].trim() : null
}
check('--pink-deep = #E8899C（按钮粉底）', tokenValue('--pink-deep') === '#E8899C', '实际 ' + tokenValue('--pink-deep'))
check('--card-warm 已补定义（6 文件引用）', !!tokenValue('--card-warm'), '--card-warm 未定义')
check('--radius-pill = 999rpx（全圆角）', tokenValue('--radius-pill') === '999rpx', '实际 ' + tokenValue('--radius-pill'))
check('--bg = #FBF6EF（纸感底）', tokenValue('--bg') === '#FBF6EF', '实际 ' + tokenValue('--bg'))

// 8. 复合值（--shadow 等）内部引用的变量也有定义
const shadowVars = []
if (pageBlock) {
  const re = /var\((--[a-zA-Z0-9-]+)\)/g
  let m
  while ((m = re.exec(pageBlock[1])) !== null) shadowVars.push(m[1])
}
const missingShadow = shadowVars.filter(v => !definedInPage.has(v))
check('变量定义内部无自引用未定义变量', missingShadow.length === 0, '缺: ' + missingShadow.join(', '))

console.log('\n=== 结果: ' + passed + ' PASS / ' + failed + ' FAIL ===')
if (failed) {
  failures.forEach(f => console.log('  - ' + f))
  process.exit(1)
}
console.log('Theme Tokens: ALL GREEN')
