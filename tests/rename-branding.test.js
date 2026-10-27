// ============================================================
// tests/rename-branding.test.js · 命名调整回归（v4：碎愿集 / 纸间心事 / 通用称呼）
//
// 历史沿革：
//   v1「小宇陪伴日记」→ v2「安安日记本」→ **v3/v4「碎愿集」**
//   模块名：「读写」→「书与心事」→ **「纸间心事」**
//   评分文案：「小宇指数 / 给小宇打几分」→「小舟得分 / 给小舟打几分」
//             → **「TA 的得分 / 给 TA 打几分」**（v4 去个人化）
//
// 红线：
//   · 只改用户可见文案 + 页面标题配置，**不改**路由、云函数名、集合名、AppID、云环境 ID；
//   · 不出现任何个人姓名 / 私人昵称（小宇、安安、小舟），也不假设性别（她/他）；
//   · desktop/ 桌面端源码不在本轮范围（小程序端改，桌面端后续单独同步）。
//
// 运行：node tests/rename-branding.test.js
// ============================================================
const path = require('path')
const fs = require('fs')

const ROOT = path.resolve(__dirname, '..')

let passed = 0, failed = 0
const failures = []

function testCase(name, fn) {
  return Promise.resolve().then(fn).then(() => {
    passed++
    console.log('  PASS  ' + name)
  }).catch(e => {
    failed++
    failures.push(name + ': ' + e.message)
    console.log('  FAIL  ' + name + '  -> ' + e.message)
  })
}
function assertEq(a, b, msg) {
  if (a !== b) throw new Error((msg || '') + ' 期望 ' + JSON.stringify(b) + ' 实际 ' + JSON.stringify(a))
}
function assertOk(v, msg) { if (!v) throw new Error(msg || '断言失败') }

const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const readJson = rel => JSON.parse(read(rel))

// 当前品牌
const BRAND = '碎愿集'
const TAB_READING = '纸间心事'
// 历史品牌名（一律不得出现在用户可见文案里）
const OLD_BRANDS = ['安安日记本', '小宇陪伴日记']
// 评分文案（v4 通用表达）
const SCORE_LABEL = 'TA 的得分'
const SCORE_ASK = '给 TA 打几分'

function collectWxml() {
  const files = []
  const walk = (dir) => {
    for (const name of fs.readdirSync(path.join(ROOT, dir))) {
      const rel = dir + '/' + name
      const st = fs.statSync(path.join(ROOT, rel))
      if (st.isDirectory()) walk(rel)
      else if (/\.wxml$/.test(name)) files.push(rel)
    }
  }
  walk('pages')
  walk('components')
  return files
}

// 去掉 WXML 注释后再断言：注释不渲染，逼着改注释等于扩大范围。
function visibleWxml(rel) {
  return read(rel).replace(/<!--[\s\S]*?-->/g, '')
}

;(async () => {
  console.log('========================================')
  console.log(' 命名调整回归（' + BRAND + ' / ' + TAB_READING + ' / ' + SCORE_LABEL + '）')
  console.log('========================================')

  const appJson = readJson('app.json')

  await testCase('B1 全局导航栏标题 = ' + BRAND, async () => {
    assertEq(appJson.window.navigationBarTitleText, BRAND)
  })

  await testCase('B2 底部 Tab 阅读模块 = ' + TAB_READING + '（无旧名残留）', async () => {
    const list = appJson.tabBar.list
    const reading = list.find(x => x.pagePath === 'pages/reading/reading')
    assertOk(reading, 'Tab 列表里找不到 reading 页')
    assertEq(reading.text, TAB_READING)
    assertOk(list.every(x => x.text !== '读写'), '仍有 Tab 叫「读写」')
    assertOk(list.every(x => x.text !== '书与心事'), '仍有 Tab 叫「书与心事」')
  })

  await testCase('B3 Tab 文案长度可控（≤4 个汉字，常见屏幕不截断）', async () => {
    const list = appJson.tabBar.list
    for (const item of list) {
      assertOk(item.text.length <= 4, 'Tab「' + item.text + '」超过 4 字，可能被截断')
    }
    assertEq(list.length, 5, 'Tab 数量不应变化（首页/记录/纸间心事/日历/我们）')
    assertEq(list.map(x => x.text).join(','), '首页,记录,纸间心事,日历,我们')
  })

  await testCase('B4 阅读页标题 = ' + TAB_READING + '（JSON + 页内主标题），副标题保留', async () => {
    assertEq(readJson('pages/reading/reading.json').navigationBarTitleText, TAB_READING)
    const wxml = read('pages/reading/reading.wxml')
    assertOk(new RegExp('<view class="rt">' + TAB_READING + '</view>').test(wxml), '页内主标题未改')
    assertOk(wxml.indexOf('书与心事') === -1, 'reading.wxml 仍残留「书与心事」')
    assertOk(wxml.indexOf('>读写<') === -1, 'reading.wxml 仍有 >读写<')
    assertOk(wxml.indexOf('读一点，也写一点。') !== -1, '副标题「读一点，也写一点。」不得被改动')
  })

  await testCase('B5 首页标题 = ' + BRAND, async () => {
    assertEq(readJson('pages/home/home.json').navigationBarTitleText, BRAND)
  })

  await testCase('B6 全部页面/组件 WXML 无旧品牌名残留', async () => {
    const files = collectWxml()
    assertOk(files.length > 10, '扫描到的 wxml 过少，路径有问题: ' + files.length)
    const hits = []
    for (const f of files) {
      const src = visibleWxml(f)
      for (const old of OLD_BRANDS) {
        if (src.indexOf(old) !== -1) hits.push(f + ' -> ' + old)
      }
    }
    assertEq(hits.join(','), '', '以下页面仍有旧品牌名: ' + hits.join(','))
  })

  await testCase('B7 我的页无旧品牌名残留', async () => {
    const mine = visibleWxml('pages/mine/mine.wxml')
    for (const old of OLD_BRANDS) assertOk(mine.indexOf(old) === -1, 'mine 页仍有 ' + old)
  })

  await testCase('B9 内部标识已脱敏为占位符（AppID / 云环境 / 路由 / 云函数）', async () => {
    assertEq(readJson('project.config.json').appid, 'wxYOUR_APPID')
    const cfg = read('config.js')
    assertOk(cfg.indexOf('YOUR_CLOUD_ENV_ID') !== -1, '云环境 ID 应为占位符')
    assertOk(cfg.indexOf('cloud1-') === -1, '云环境 ID 不应残留真实环境标识')
    const pages = appJson.pages
    for (const required of [
      'pages/home/home', 'pages/record/record', 'pages/reading/reading',
      'pages/calendar/calendar', 'pages/ours/ours', 'pages/mine/mine'
    ]) {
      assertOk(pages.indexOf(required) !== -1, '路由丢失: ' + required)
    }
    const fns = fs.readdirSync(path.join(ROOT, 'cloudfunctions'))
      .filter(n => fs.statSync(path.join(ROOT, 'cloudfunctions', n)).isDirectory())
    for (const fn of ['dailyRecord', 'getPartnerView', 'bindCouple', 'menstrual', 'login']) {
      assertOk(fns.indexOf(fn) !== -1, '云函数目录缺失/被改名: ' + fn)
    }
  })

  await testCase('B10 评分标题 = 「给 X 打几分」（X 为称呼，record 页），评分功能本体未变', async () => {
    const rec = visibleWxml('pages/record/record.wxml')
    assertOk(rec.indexOf('给{{partnerName}}打几分') !== -1, 'record 页评分标题未改为「给{{partnerName}}打几分」')
    for (const old of ['小宇指数', '给小宇打几分', '小舟']) {
      assertOk(rec.indexOf(old) === -1, 'record 页仍残留 ' + old)
    }
    assertOk(rec.indexOf('bind:change="onScoreChange"') !== -1, '评分事件绑定丢失')
    assertOk(rec.indexOf('<score-picker') !== -1, 'score-picker 组件被移除')
  })

  await testCase('B11 评分标签按「可编辑 / 只读」区分方向，称呼走 name 缺省 TA', async () => {
    const sp = visibleWxml('components/score-picker/score-picker.wxml')
    // 可编辑（记录页）：你给对方打分 → 标签「X 的得分」
    assertOk(sp.indexOf("name + '的得分'") !== -1, '可编辑态标签未用 name')
    // 只读（我们页）：对方给你打分 → 标签必须说明方向，否则会看反
    assertOk(sp.indexOf("name + '给你打的分'") !== -1, '只读态标签未用 name')
    assertOk(sp.indexOf('小舟') === -1, 'score-picker 仍残留「小舟」')
    // 交互本体不得改动
    assertOk(/class="heart /.test(sp), 'score-picker 爱心图标被删除')
    assertOk(sp.indexOf('未打分') !== -1, '未打分占位文案被删除')
    assertOk(sp.indexOf('bindtap="pick"') !== -1, '打分交互被删除')

    const home = visibleWxml('pages/home/home.wxml')
    assertOk(home.indexOf('>{{partnerName}}的得分</text>') !== -1, 'home 状态卡标签未用称呼')
    assertOk(home.indexOf('小舟') === -1, 'home 页仍残留「小舟」')
  })

  await testCase('B12 「我们」页评分展示已移除，首页评分仍用称呼（缺省 TA）', async () => {
    const ours = visibleWxml('pages/ours/ours.wxml')
    // V1.1 收尾：与首页重复的今日评分已从「我们」页移除
    assertOk(ours.indexOf('score-picker') === -1, '我们页评分展示应已移除')
    assertOk(ours.indexOf('她今天') === -1, '仍残留「她今天」')
    assertOk(ours.indexOf('小舟') === -1, '仍残留「小舟」')
    const home = visibleWxml('pages/home/home.wxml')
    assertOk(home.indexOf('>{{partnerName}}的得分</text>') !== -1, '首页得分标签未用称呼')
    assertOk(home.indexOf('TA 今天给你的评分') !== -1, '首页陪伴方评分标签缺失')
  })

  await testCase('B13 个人姓名 / 私人昵称在可见文案中零残留', async () => {
    const files = collectWxml()
    const hits = []
    for (const f of files) {
      const src = visibleWxml(f)
      for (const w of ['小宇', '安安', '小舟']) {
        if (src.indexOf(w) !== -1) hits.push(f + ' -> ' + w)
      }
    }
    assertEq(hits.join(','), '', '以下位置仍有个人姓名/昵称: ' + hits.join(','))

    // 「关于」页不得再有作者个人指代
    const mine = visibleWxml('pages/mine/mine.wxml')
    assertOk(mine.indexOf('记录属于你们的点滴') !== -1, '关于页文案未通用化')
  })

  await testCase('B14 模块名「书与心事」在小程序可见层零残留', async () => {
    const files = collectWxml().concat(['app.json'])
    const hits = []
    for (const f of files) {
      const src = read(f)
      if (src.indexOf('书与心事') !== -1) hits.push(f)
    }
    for (const p of appJson.pages) {
      const jp = p + '.json'
      if (fs.existsSync(path.join(ROOT, jp)) && read(jp).indexOf('书与心事') !== -1) hits.push(jp)
    }
    assertEq(hits.join(','), '', '以下位置仍显示旧模块名: ' + hits.join(','))
  })

  await testCase('B15 分享标题不残留旧品牌名', async () => {
    const files = []
    const walk = (dir) => {
      for (const name of fs.readdirSync(path.join(ROOT, dir))) {
        const rel = dir + '/' + name
        const st = fs.statSync(path.join(ROOT, rel))
        if (st.isDirectory()) walk(rel)
        else if (/\.js$/.test(name)) files.push(rel)
      }
    }
    walk('pages')
    const shareHits = files.filter(f => {
      const src = read(f)
      if (!/onShareAppMessage|onShareTimeline/.test(src)) return false
      return OLD_BRANDS.some(old => src.indexOf(old) !== -1)
    })
    assertEq(shareHits.join(','), '', '分享标题仍含旧名称: ' + shareHits.join(','))
  })

  await testCase('B16 「读写」只作为技术词存在，不再作为 Tab/标题', async () => {
    for (const p of appJson.pages) {
      const jsonPath = path.join(ROOT, p + '.json')
      if (!fs.existsSync(jsonPath)) continue
      const title = JSON.parse(fs.readFileSync(jsonPath, 'utf8')).navigationBarTitleText
      if (title) assertOk(title !== '读写', p + '.json 标题仍是「读写」')
    }
    assertOk(read('cloudfunctions/dailyRecord/package.json').indexOf('读写') !== -1,
      '技术描述里的「读写」不应被替换（本次只改 Tab 名）')
  })

  await testCase('B17 所有页面 JSON 仍可解析（改名未破坏结构）', async () => {
    for (const p of appJson.pages) {
      const jsonPath = path.join(ROOT, p + '.json')
      if (!fs.existsSync(jsonPath)) continue
      JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
    }
    JSON.parse(read('app.json'))
    JSON.parse(read('project.config.json'))
  })

  console.log('\n========================================')
  console.log(' 结果: ' + passed + ' PASS / ' + failed + ' FAIL')
  if (failures.length) {
    console.log(' 失败项:')
    failures.forEach(f => console.log('   · ' + f))
  }
  console.log('========================================')
  process.exit(failed === 0 ? 0 : 1)
})()
