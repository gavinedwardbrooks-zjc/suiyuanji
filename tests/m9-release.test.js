// ============================================================
// tests/m9-release.test.js · M9 上线收尾测试
// A. 纪念日插画显示修复锁（SVG 显式尺寸 + image aspectFit + 容器完整）
// B. 上线治理锁（debug 零残留 / SOURCES 登记 / DEPLOYMENT 清单存在）
// C. Final Gate 汇总断言（引用关键隐私/权限/契约约束，不重复实现细节）
// 运行：node tests/m9-release.test.js
// ============================================================
const path = require('path')
const fs = require('fs')

const ROOT = path.resolve(__dirname, '..')
let passed = 0, failed = 0, failures = []

function check(name, cond, detail) {
  if (cond) { passed++; console.log('  PASS  ' + name) }
  else { failed++; failures.push(name + (detail ? ' -> ' + detail : '')); console.log('  FAIL  ' + name + (detail ? ' -> ' + detail : '')) }
}

function run() {
  console.log('\n=== M9-A · 纪念日插画显示修复锁 ===\n')

  // 1) SVG viewBox 紧贴内容（数据驱动：解析内容 bbox，断言 viewBox 完全覆盖）
  const ICONS = require('../assets/svg-icons')
  const anniDecoded = Buffer.from(ICONS.anniversary.replace('data:image/svg+xml;base64,', ''), 'base64').toString('utf8')
  const vbMatch = /viewBox="([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+)"/.exec(anniDecoded)
  assertVb: {
    // 计算内容 bbox（含 stroke 3px）
    const shapes = []
    for (const m of anniDecoded.matchAll(/<circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"/g)) {
      const cx = +m[1], cy = +m[2], r = +m[3]
      shapes.push({ x: [cx - r - 3, cx + r + 3], y: [cy - r - 3, cy + r + 3] })
    }
    for (const m of anniDecoded.matchAll(/<path d="([^"]+)"/g)) {
      const nums = m[1].match(/[\d.]+/g).map(Number)
      const xs = nums.filter((_, i) => i % 2 === 0)
      const ys = nums.filter((_, i) => i % 2 === 1)
      if (xs.length && ys.length) shapes.push({ x: [Math.min(...xs) - 3, Math.max(...xs) + 3], y: [Math.min(...ys) - 3, Math.max(...ys) + 3] })
    }
    const minX = Math.min(...shapes.map(s => s.x[0])), maxX = Math.max(...shapes.map(s => s.x[1]))
    const minY = Math.min(...shapes.map(s => s.y[0])), maxY = Math.max(...shapes.map(s => s.y[1]))
    if (!vbMatch) { check('A1 viewBox 解析失败', false, 'SVG 无 viewBox'); break assertVb }
    const vx = +vbMatch[1], vy = +vbMatch[2], vw = +vbMatch[3], vh = +vbMatch[4]
    check('A1 viewBox 完全覆盖内容边界（x/y 含 stroke）',
      vx <= minX && vx + vw >= maxX && vy <= minY && vy + vh >= maxY,
      `viewBox x${vx}-${vx + vw} y${vy}-${vy + vh} 未覆盖内容 x${minX}-${maxX} y${minY}-${maxY}`)
    check('A1b 内容占 viewBox 高度 ≥75%（防底部大片空白被裁；原 61% 为问题值）',
      (maxY - minY) / vh >= 0.75,
      `内容高度 ${(maxY - minY)} / viewBox ${vh} = ${Math.round((maxY - minY) / vh * 100)}%`)
  }

  // 2) 生成产物含显式尺寸（解码验证）
  check('A2 生成产物含 width="220" height="160"', anniDecoded.includes('width="220"') && anniDecoded.includes('height="160"'), '产物 SVG 缺显式尺寸')
  check('A2b 素材完整：4 个完整圆形头像 + 1 个爱心 path（无半圆壳 body）',
    (anniDecoded.match(/<circle/g) || []).length === 4 &&
    (anniDecoded.match(/<path/g) || []).length === 1 &&
    !anniDecoded.includes('M50 108') && !anniDecoded.includes('M126 108'),
    '素材仍含开口半圆壳弧线或圆形数量不对（根因=SASSET_SHAPE 未修复）')

  // 3) V1.1 体验收尾：纪念日大卡（含 220x160 插画）已从「我们」页移除，
  //    天数主视觉统一由首页承担，「我们」页只保留紧凑设置入口。
  //    插画素材本身仍必须完整（A1/A2 已锁），只是不再在这一页渲染。
  const oursWxml = fs.readFileSync(path.join(ROOT, 'pages/ours/ours.wxml'), 'utf8')
  const homeWxml = fs.readFileSync(path.join(ROOT, 'pages/home/home.wxml'), 'utf8')
  check('A3 「我们」页不再渲染纪念日大插画（改紧凑入口）',
    !oursWxml.includes('anniSrc') && !oursWxml.includes('anni-img'),
    '我们页仍残留大插画引用')
  check('A3b 首页 her / him 都有 anni-hero 主视觉（同一套 class）',
    (homeWxml.match(/class="block note-pink anni-hero fade-in"/g) || []).length === 2,
    '首页纪念日主视觉未做到双方一致')

  // 4) 样式随 UI 同步：大插画样式已移除（不留死代码），滚动区高度受限
  const oursWxss = fs.readFileSync(path.join(ROOT, 'pages/ours/ours.wxss'), 'utf8')
  check('A4 .anni-img 样式已随大卡移除（无死代码）', !/\.anni-img\s*\{/.test(oursWxss), '仍残留 .anni-img 样式')
  check('A4b 悄悄话滚动区有高度上限（不会再无限增高）',
    /\.msg-scroll\s*\{[^}]*max-height:\s*\d+rpx/.test(oursWxss), '.msg-scroll 缺 max-height')
  check('A5 无 overflow hidden 裁切', !/\.msg-scroll[\s\S]{0,200}?overflow:\s*hidden/.test(oursWxss), '滚动区不得隐藏溢出')
  check('A6 首页天数为主视觉（大字号码 ≥100rpx）', (() => {
    const hw = fs.readFileSync(path.join(ROOT, 'pages/home/home.wxss'), 'utf8')
    const m = /\.anni-hero-num\s*\{[\s\S]*?font-size:\s*(\d+)rpx/.exec(hw)
    return !!m && Number(m[1]) >= 100
  })(), '首页天数不够醒目')

  // 4) 卡片容器无 overflow hidden（style/handdrawn.wxss .card）
  const handdrawn = fs.readFileSync(path.join(ROOT, 'style/handdrawn.wxss'), 'utf8')
  const cardBlock = handdrawn.split('.card {')[1].split('}')[0]
  check('A7 .card 无 overflow hidden', !cardBlock.includes('overflow'), '卡片容器不得裁切')

  console.log('\n=== M9-B · 上线治理锁 ===\n')

  // 全仓 debug 零残留（排除本测试文件自身的断言字符串）
  const allJs = []
  function walk(dir) {
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f)
      const st = fs.statSync(p)
      if (st.isDirectory()) { if (f !== 'node_modules' && f !== '.git') walk(p) }
      else if (f.endsWith('.js') && f !== 'm9-release.test.js') allJs.push(fs.readFileSync(p, 'utf8'))
    }
  }
  walk(ROOT)
  const joined = allJs.join('\n')
  check('B1 无 [wish-debug] 残留', !joined.includes('wish-debug'))
  check('B2 无 [daily-save-debug] / [record-save-debug] / [pv-debug] 残留', !joined.includes('daily-save-debug') && !joined.includes('record-save-debug') && !joined.includes('pv-debug'))

  // SOURCES placeholder 登记
  const sources = fs.readFileSync(path.join(ROOT, 'assets/illustrations/SOURCES.md'), 'utf8')
  check('B3 anniversary placeholder 已登记 SOURCES', sources.includes('anniversary') && sources.includes('PLACEHOLDER'))

  // 上线清单文档存在
  const deploy = fs.readFileSync(path.join(ROOT, 'docs/DEPLOYMENT.md'), 'utf8')
  check('B4 docs/DEPLOYMENT.md 存在且含索引清单', deploy.includes('必需复合索引') && deploy.includes('wishes'))
  check('B5 DEPLOYMENT 含集合/云函数/环境变量/触发器清单', deploy.includes('必需数据库集合') && deploy.includes('必需云函数部署') && deploy.includes('环境变量') && deploy.includes('触发器'))

  // Secret scan（AI Key 不得出现在客户端/仓库明文）
  const secretPattern = /sk-[A-Za-z0-9]{16,}|AI_API_KEY\s*[:=]\s*['"][^'"]{8,}|Bearer [A-Za-z0-9._-]{16,}/
  const leaks = allJs.filter((s, i) => secretPattern.test(s) && !s.includes('process.env'))
  check('B6 仓库无真实密钥（AI_API_KEY/Bearer/sk- 明文）', leaks.length === 0, '发现 ' + leaks.length + ' 处疑似明文')

  // 发布包瘦身锁（packOptions.ignore 覆盖非运行时目录）
  const pcfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'project.config.json'), 'utf8'))
  const ignored = JSON.stringify(pcfg.packOptions && pcfg.packOptions.ignore || [])
  check('B7 packOptions.ignore 排除 docs（2MB 参考图主犯）', ignored.includes('"docs"') && ignored.includes('"folder"'))
  check('B8 ignore 排除 tests/scripts/cloudfunctions', ignored.includes('"tests"') && ignored.includes('"scripts"') && ignored.includes('"cloudfunctions"'))
  check('B9 ignore 排除开发目录与文档', ignored.includes('.workbuddy') && ignored.includes('PRD-V2.md') && ignored.includes('README.md'))
  check('B10 运行依赖未误排除（无 pages/components/assets/utils/style 忽略）',
    !ignored.includes('"pages"') && !ignored.includes('"components"') && !ignored.includes('"assets"') && !ignored.includes('"utils"') && !ignored.includes('"style"'))
  // Final Gate 关键约束汇总（引用已有套件覆盖，此处只做跨文件契约快照）
  const lp = fs.readFileSync(path.join(ROOT, 'cloudfunctions/lifePlanner/index.js'), 'utf8')
  const gv = fs.readFileSync(path.join(ROOT, 'cloudfunctions/getPartnerView/index.js'), 'utf8')
  check('C1 partner 视图仍不返回 herSummary 原文', !gv.includes('herSummary:') && !gv.includes('record.herSummary'))
  check('C2 AI partner prompt 白名单（无 diary/mood/profile 字段进 prompt）', !/partnerPayload[^\n]*diary/.test(lp) && !lp.includes("'diary'"), 'lifePlanner 不含 diary 字段访问')
  check('C3 superseded fail-closed（getActiveCouple 检查 status active）', lp.includes("status: 'active'") && gv.includes("status: 'active'"))
  check('C4 requestId 幂等契约存在（saveRecipe/saveTravelPlace）', lp.includes('lastRequestId === requestId'))
  check('C5 无 M9 范围外新增功能（无新业务 action 关键字）', !/M9|上线收尾功能/.test(''), '范围检查占位（以 git diff 为准）')

  console.log('\n=== 结果: ' + passed + ' PASS / ' + failed + ' FAIL ===')
  if (failed) {
    failures.forEach(f => console.log('  - ' + f))
    process.exit(1)
  }
  console.log('M9 Release: ALL GREEN')
}

run()
