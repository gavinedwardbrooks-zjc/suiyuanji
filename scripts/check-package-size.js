// ============================================================
// scripts/check-package-size.js · 小程序上传包体积核算
//
// 作用：上传前按 project.config.json 的 packOptions.ignore 模拟一遍打包内容，
//       算出真实会进主包的文件与体积，超 2MB 直接非零退出。
//
// 为什么要这个脚本：微信开发者工具报的「80051 source size exceed 2MB」只在
// 点上传时才出现，平时编译不报错，很容易在上传那一刻才发现。桌面端工程
// （desktop/，97MB，含 Tauri + node_modules）就放在项目根目录下，一旦
// packOptions.ignore 漏了它，整包会直接翻几倍。
//
// 运行：node scripts/check-package-size.js
// ============================================================
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const LIMIT_KB = 2048 // 微信主包上限 2MB

// 开发者工具自身从不打包的目录（与本脚本的模拟口径保持一致）
const ALWAYS_SKIP = new Set(['.git', 'node_modules'])

function readConfig() {
  const raw = fs.readFileSync(path.join(ROOT, 'project.config.json'), 'utf8')
  return JSON.parse(raw)
}

// 把 ignore 规则拆成「目录前缀」和「文件精确路径」两组
function parseIgnores(cfg) {
  const list = (cfg.packOptions && cfg.packOptions.ignore) || []
  const folders = []
  const files = []
  for (const it of list) {
    const v = String(it.value || '').replace(/^\.\//, '').replace(/\/+$/, '')
    if (!v) continue
    if (it.type === 'folder') folders.push(v)
    else files.push(v)
  }
  return { folders, files }
}

function isIgnored(rel, rules) {
  for (const f of rules.folders) {
    if (rel === f || rel.startsWith(f + '/')) return true
  }
  return rules.files.indexOf(rel) !== -1
}

function walk(base) {
  const out = []
  const stack = ['']
  while (stack.length) {
    const rel = stack.pop()
    const abs = rel ? path.join(base, rel) : base
    let entries
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true })
    } catch (e) {
      continue
    }
    for (const e of entries) {
      const r = rel ? rel + '/' + e.name : e.name
      if (e.isDirectory()) {
        if (ALWAYS_SKIP.has(e.name)) continue
        stack.push(r)
      } else if (e.isFile()) {
        let size = 0
        try {
          size = fs.statSync(path.join(base, r)).size
        } catch (err) {
          continue
        }
        out.push({ rel: r, size })
      }
    }
  }
  return out
}

function kb(n) {
  return (n / 1024).toFixed(1)
}

function main() {
  const cfg = readConfig()
  // miniprogramRoot 未设置时，开发者工具把项目根目录当小程序根目录
  const mpRoot = path.resolve(ROOT, cfg.miniprogramRoot || '.')
  const rules = parseIgnores(cfg)

  const all = walk(mpRoot)
  const kept = all.filter(f => !isIgnored(f.rel, rules))
  const dropped = all.filter(f => isIgnored(f.rel, rules))
  const sum = arr => arr.reduce((a, b) => a + b.size, 0)

  const keptKB = sum(kept) / 1024
  const droppedKB = sum(dropped) / 1024

  console.log('小程序根目录: ' + path.relative(ROOT, mpRoot) || '.')
  console.log('忽略规则: 目录 ' + rules.folders.length + ' 项 / 文件 ' + rules.files.length + ' 项')
  console.log('')
  console.log('会被上传: ' + kept.length + ' 个文件 · ' + kb(sum(kept)) + ' KB')
  console.log('已被排除: ' + dropped.length + ' 个文件 · ' + kb(sum(dropped)) + ' KB')
  console.log('')

  const byDir = {}
  for (const f of kept) {
    const key = f.rel.indexOf('/') !== -1 ? f.rel.split('/')[0] + '/' : '(根目录文件)'
    byDir[key] = (byDir[key] || 0) + f.size
  }
  console.log('--- 上传内容按目录 ---')
  Object.keys(byDir)
    .sort((a, b) => byDir[b] - byDir[a])
    .forEach(k => console.log('  ' + kb(byDir[k]).padStart(9) + ' KB  ' + k))

  console.log('')
  console.log('--- 占用最大的 10 个文件 ---')
  kept
    .slice()
    .sort((a, b) => b.size - a.size)
    .slice(0, 10)
    .forEach(f => console.log('  ' + kb(f.size).padStart(9) + ' KB  ' + f.rel))

  console.log('')
  if (keptKB >= LIMIT_KB) {
    console.log('[FAIL] 主包 ' + keptKB.toFixed(1) + ' KB ≥ ' + LIMIT_KB + ' KB 上限')
    console.log('  建议：检查 packOptions.ignore 是否漏了非小程序目录（desktop / docs / tests / cloudfunctions）')
    process.exit(1)
  }
  console.log('[PASS] 主包 ' + keptKB.toFixed(1) + ' KB < ' + LIMIT_KB + ' KB 上限'
    + '（余量 ' + (LIMIT_KB - keptKB).toFixed(1) + ' KB）')
}

main()
