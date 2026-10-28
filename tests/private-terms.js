// ============================================================
// tests/private-terms.js · 私人标识守卫（共享实现，不是测试文件）
//
// 为什么要单独抽出来：
//   守卫本身如果把真实私人称呼写成明文，就等于「守卫即泄漏」——
//   公开仓库里仍然出现了那个词。所以本文件**不得**出现任何真实私人
//   称呼的明文（汉字与拉丁拼写都算），所有匹配样本一律在**运行时**
//   由 Unicode 码点构造；源码里只有十六进制数字。
//
// 本模块提供：
//   PRIVATE_TERMS        历史私人标识（码点构造，运行时才有明文）
//   findPrivateLeaks(s)  返回命中的样本**标签**（不返回明文）
//   describeTerm(t)      把样本渲染成 "U+84D3 U+84D3" 这类可读标签
//   listPublishableFiles(root)  列出「一旦提交就会公开」的文件
//
// 使用方：tests/desktop-phase1-contract.test.js、tests/config-local.test.js
// ============================================================
const fs = require('fs')
const path = require('path')

const fromCp = (...cps) => String.fromCodePoint(...cps)

// 历史私人标识（已在脱敏中废弃）。三种书写都禁：
//   1) 私人昵称（汉字，两个相同码点）
//   2) 私人品牌（汉字，两字）
//   3) 旧的私有 URI scheme / 目录名（拉丁拼写）
// 码点在此，明文只在运行时存在。
const PRIVATE_TERMS = [
  fromCp(0x84D3, 0x84D3),
  fromCp(0x5C0F, 0x90D1),
  fromCp(0x78, 0x69, 0x61, 0x6F, 0x7A, 0x68, 0x65, 0x6E, 0x67)
]

// 标签：只暴露码点，绝不把明文回显到日志/报错里
function describeTerm(term) {
  const out = []
  for (const ch of term) out.push('U+' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0'))
  return out.join(' ')
}

// 返回命中项**标签**数组（空数组 = 干净）。刻意不返回明文。
function findPrivateLeaks(text) {
  const hits = []
  if (typeof text !== 'string' || text === '') return hits
  for (const term of PRIVATE_TERMS) {
    if (text.indexOf(term) !== -1) hits.push(describeTerm(term))
  }
  return hits
}

// ---- 可发布文件枚举 ----
// 与根 .gitignore 保持一致：不算是「一旦提交就会公开」的路径不扫。
const SKIP_DIR_NAMES = new Set([
  '.git', 'node_modules', '.workbuddy', '.codebuddy',
  'dist', 'target', 'gen', 'coverage'
])

// 仓库根级私有工作目录（报告 / 日志 / 临时文件），由根 `.gitignore` 的 `/.local/` 完整忽略。
//
// 为什么需要在这条守卫里排除它：
//   该目录里的轮次报告会大量出现历史目录名、绝对路径等字样，如果一并扫描，
//   守卫会对「永远不会被提交」的文件持续误报，最终逼着人去削弱断言。
//
// 为什么不是无条件跳过：
//   这里每次都**回读** `.gitignore` 确认 `/.local/` 规则仍在。一旦那条忽略规则被删掉，
//   本函数会自动恢复对 `.local/` 的扫描（宁可误报，也不让「以为被忽略了」变成绕过守卫的后门）。
//   除此之外不排除任何路径——源码、测试、文档一律照扫。
const LOCAL_DIR_NAME = '.local'
function isLocalDirIgnored(root) {
  try {
    return /^\/\.local\/\s*$/m.test(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'))
  } catch (e) {
    return false
  }
}

// 相对仓库根的精确路径（本地私有 / 内部资料，永不发布）
const SKIP_EXACT_PATHS = new Set([
  'project.private.config.json',
  'config.local.js',
  'docs/OPEN_SOURCE_RELEASE_REPORT.md',
  'docs/style-references'
])
// 二进制/媒体：不作文本扫描（仍计入文件总数）
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.icns', '.bmp',
  '.exe', '.dll', '.zip', '.tar', '.gz', '.tgz', '.pdf',
  '.woff', '.woff2', '.ttf', '.otf', '.mp4', '.mov'
])

function isSkipped(rel) {
  const parts = rel.split('/')
  for (const p of parts.slice(0, -1)) if (SKIP_DIR_NAMES.has(p)) return true
  if (SKIP_EXACT_PATHS.has(rel)) return true
  if (rel.startsWith('docs/style-references/')) return true
  if (/^\.env(\..+)?$/.test(rel) && rel !== '.env.example') return true
  if (/\.log$/.test(rel)) return true
  return false
}

function listPublishableFiles(root) {
  const out = []
  // 只在「根 .gitignore 确实忽略 .local/」时才跳过它（见 isLocalDirIgnored 注释）
  const skipLocalDir = isLocalDirIgnored(root)
  const walk = (absDir, relDir) => {
    let entries
    try { entries = fs.readdirSync(absDir, { withFileTypes: true }) } catch (e) { return }
    for (const ent of entries) {
      const rel = relDir ? relDir + '/' + ent.name : ent.name
      if (ent.isDirectory()) {
        if (SKIP_DIR_NAMES.has(ent.name)) continue
        if (relDir === '' && ent.name === LOCAL_DIR_NAME && skipLocalDir) continue
        if (SKIP_EXACT_PATHS.has(rel)) continue
        walk(path.join(absDir, ent.name), rel)
      } else if (ent.isFile()) {
        if (isSkipped(rel)) continue
        out.push(rel)
      }
    }
  }
  walk(root, '')
  return out.sort()
}

function isBinary(rel) {
  return BINARY_EXT.has(path.extname(rel).toLowerCase())
}

module.exports = { PRIVATE_TERMS, findPrivateLeaks, describeTerm, listPublishableFiles, isBinary }
