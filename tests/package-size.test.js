// ============================================================
// tests/package-size.test.js · 小程序上传包体积与配置守卫
//
// 背景：微信开发者工具只在「上传」时才校验主包 ≤2MB，编译阶段不报错。
// 项目根目录同时放着桌面端 Tauri 工程（desktop/），
// 一旦 project.config.json 的 packOptions.ignore 漏掉它，
// 整包会从 ~400KB 涨到 ~2.7MB，上传直接报 80051。
//
// 本测试按 packOptions.ignore 模拟一遍打包内容：
//   · 主包必须 < 2MB，且给后续开发留出安全余量
//   · 非小程序目录必须被排除（desktop / docs / tests / cloudfunctions / scripts）
//   · 被排除后，运行期真正需要的文件必须一个不少（页面 / 组件 / 配置 / 资源）
//
// 运行：node tests/package-size.test.js
// ============================================================
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const LIMIT_KB = 2048 // 微信主包上限 2MB
const SAFE_KB = 1536 // 留 25% 余量，避免下次加个页面就又顶到上限

const ALWAYS_SKIP = new Set(['.git', 'node_modules'])

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

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'project.config.json'), 'utf8'))
const MP_ROOT = path.resolve(ROOT, cfg.miniprogramRoot || '.')

// packOptions.ignore 的两类规则：folder 按路径前缀，file 按精确路径
const rules = { folders: [], files: [] }
for (const it of (cfg.packOptions && cfg.packOptions.ignore) || []) {
  const v = String(it.value || '').replace(/^\.\//, '').replace(/\/+$/, '')
  if (!v) continue
  if (it.type === 'folder') rules.folders.push(v)
  else rules.files.push(v)
}

function ignored(rel) {
  for (const f of rules.folders) {
    if (rel === f || rel.startsWith(f + '/')) return true
  }
  return rules.files.indexOf(rel) !== -1
}

function walk() {
  const out = []
  const stack = ['']
  while (stack.length) {
    const rel = stack.pop()
    const abs = rel ? path.join(MP_ROOT, rel) : MP_ROOT
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
          size = fs.statSync(path.join(MP_ROOT, r)).size
        } catch (err) {
          continue
        }
        out.push({ rel: r, size })
      }
    }
  }
  return out
}

const all = walk()
const kept = all.filter(f => !ignored(f.rel))
const keptSet = new Set(kept.map(f => f.rel))
const totalKB = kept.reduce((a, b) => a + b.size, 0) / 1024

console.log('\n=== G · 主包体积（当前 ' + totalKB.toFixed(1) + ' KB） ===\n')

check('G1 主包 < 2MB 硬上限', totalKB < LIMIT_KB, totalKB.toFixed(1) + ' KB')
check('G2 主包留有余量（<' + SAFE_KB + 'KB）', totalKB < SAFE_KB, totalKB.toFixed(1) + ' KB')
check('G3 打包内容非空', kept.length > 50, '仅 ' + kept.length + ' 个文件')

console.log('\n=== H · 非小程序目录必须排除 ===\n')

// desktop 是本项目最容易漏的一项：97MB、含 node_modules 与 Tauri 产物
const MUST_IGNORE = [
  ['desktop', 2000], // 排除掉的体积至少这么多 KB，否则说明规则失效
  ['docs', 500],
  ['tests', 300],
  ['cloudfunctions', 200],
  ['scripts', 1],
  ['.workbuddy', 1],
  ['.codebuddy', 1]
]
for (const [dir, minKB] of MUST_IGNORE) {
  const inKept = kept.filter(f => f.rel === dir || f.rel.startsWith(dir + '/'))
  check('H·' + dir + ' 完全不进包', inKept.length === 0, '仍有 ' + inKept.length + ' 个文件')
}

console.log('\n=== I · 运行期必需文件必须全部进包 ===\n')

const app = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'))

// I1 页面四件套
const missingPage = []
for (const p of app.pages) {
  for (const ext of ['.js', '.json', '.wxml', '.wxss']) {
    if (!keptSet.has(p + ext)) missingPage.push(p + ext)
  }
}
check('I1 全部 ' + app.pages.length + ' 个页面四件套都在包内', missingPage.length === 0, missingPage.join(', '))

// I2 每个页面都在磁盘上真实存在（防止 app.json 写了空路径）
const diskMissing = []
for (const p of app.pages) {
  if (!fs.existsSync(path.join(ROOT, p + '.js'))) diskMissing.push(p + '.js')
}
check('I2 页面文件在磁盘上真实存在', diskMissing.length === 0, diskMissing.join(', '))

// I3 usingComponents 指向的组件都要进包
const missingComp = []
const compRefs = []
for (const p of app.pages) {
  const j = JSON.parse(fs.readFileSync(path.join(ROOT, p + '.json'), 'utf8'))
  const uc = j.usingComponents || {}
  for (const name in uc) {
    const v = uc[name]
    if (String(v).indexOf('plugin://') === 0) continue
    const rel = String(v).replace(/^\//, '')
    const base = v.charAt(0) === '/' ? rel : path.posix.join(path.posix.dirname(p), rel)
    compRefs.push(base)
    for (const ext of ['.js', '.json', '.wxml', '.wxss']) {
      if (!keptSet.has(base + ext)) missingComp.push(base + ext)
    }
  }
}
check('I3 全部 ' + compRefs.length + ' 处组件引用都在包内', missingComp.length === 0, missingComp.join(', '))

// I4 全局配置与样式
for (const f of ['app.js', 'app.json', 'app.wxss', 'sitemap.json', 'config.js']) {
  check('I4 ' + f + ' 在包内', keptSet.has(f))
}

// I5 sitemapLocation 指向的文件真实存在且进包
const sm = app.sitemapLocation || 'sitemap.json'
check('I5 sitemapLocation(' + sm + ') 有效', keptSet.has(sm.replace(/^\.\//, '')))

// I6 tabBar 里的页面都注册过
const tabs = (app.tabBar && app.tabBar.list) || []
const badTab = tabs.filter(t => app.pages.indexOf(t.pagePath) === -1).map(t => t.pagePath)
check('I6 tabBar 的 ' + tabs.length + ' 个页面都已注册', badTab.length === 0, badTab.join(', '))

// I7 没有配置分包时，全部页面必须在主包（防止有人误加 subpackages 却没搬文件）
const subs = app.subpackages || app.subPackages || []
check('I7 未启用分包（单包 400KB，无需分包）', subs.length === 0, JSON.stringify(subs))

console.log('\n=== J · 小程序代码不得反向依赖被排除的目录 ===\n')

// J1 小程序的 js/json/wxml/wxss 不得 require/import 到 desktop、docs 等目录
const SRC_EXT = ['.js', '.json', '.wxml', '.wxss']
const BANNED_REF = /(?:require\s*\(\s*|from\s*|src\s*=\s*|url\s*\(\s*)(['"])(?:\.\.\/)+(?:desktop|docs|tests|cloudfunctions|scripts)\//
const offenders = []
for (const f of kept) {
  if (SRC_EXT.indexOf(path.extname(f.rel)) === -1) continue
  let src = ''
  try {
    src = fs.readFileSync(path.join(MP_ROOT, f.rel), 'utf8')
  } catch (e) {
    continue
  }
  if (BANNED_REF.test(src)) offenders.push(f.rel)
}
check('J1 无跨出小程序根目录的引用', offenders.length === 0, offenders.join(', '))

// J2 资源引用（wxml 里的 src=""）指向的本地文件必须在包内
const missingAsset = []
for (const f of kept) {
  if (path.extname(f.rel) !== '.wxml') continue
  let src = ''
  try {
    src = fs.readFileSync(path.join(MP_ROOT, f.rel), 'utf8')
  } catch (e) {
    continue
  }
  const re = /src\s*=\s*"(\/[^"{}]+)"/g
  let m
  while ((m = re.exec(src))) {
    const ref = m[1].replace(/^\//, '')
    if (/^(https?:)?\/\//.test(ref)) continue
    if (!keptSet.has(ref) && !fs.existsSync(path.join(MP_ROOT, ref))) missingAsset.push(f.rel + ' -> ' + ref)
  }
}
check('J2 wxml 本地资源引用均可解析', missingAsset.length === 0, missingAsset.join(', '))

console.log('\n=== 结果：' + passed + ' PASS / ' + failed + ' FAIL ===')
if (failed) {
  console.log('失败项：')
  failures.forEach(f => console.log('  · ' + f))
  process.exit(1)
}
console.log('主包 ' + totalKB.toFixed(1) + ' KB / 上限 ' + LIMIT_KB + ' KB（余量 '
  + (LIMIT_KB - totalKB).toFixed(1) + ' KB）')
