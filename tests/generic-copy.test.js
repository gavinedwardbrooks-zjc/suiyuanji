// ============================================================
// tests/generic-copy.test.js · 去个人化文案守卫（面向所有情侣）
//
// 目标：小程序里**没有**任何写死的个人姓名、私人昵称、性别假设。
// 之前几轮攒下的「小宇 / 安安 / 小舟 / 她 / 他」必须清零，
// 任何角色都读起来自然 —— 因为产品要能开放给任意一对情侣。
//
// 覆盖：
//   G 用户可见层零个人身份        H 评分方向（给谁打分 / 谁给你打分）
//   I 心愿·留言·经期通用化        J 各绑定状态的默认文案
//   K 隔离与身份来源（只读审计）  L 云函数返回给前端的可见文字
//
// 运行：node tests/generic-copy.test.js
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
function assertOk(v, msg) { if (!v) throw new Error(msg || '断言失败') }
function assertNo(src, needle, msg) {
  if (src.indexOf(needle) !== -1) throw new Error((msg || '不应出现') + '：' + needle)
}
function assertHas(src, needle, msg) {
  if (src.indexOf(needle) === -1) throw new Error((msg || '缺少') + '：' + needle)
}

const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const exists = rel => fs.existsSync(path.join(ROOT, rel))

// 个人身份 / 私人昵称：任何位置（含注释）都不该再出现
const PERSONAL = ['小宇', '安安', '小舟']

function walkFiles(dir, ext) {
  const out = []
  const walk = (d) => {
    for (const name of fs.readdirSync(path.join(ROOT, d))) {
      const rel = d + '/' + name
      const st = fs.statSync(path.join(ROOT, rel))
      if (st.isDirectory()) walk(rel)
      else if (rel.endsWith(ext)) out.push(rel)
    }
  }
  walk(dir)
  return out
}

const wxmlFiles = walkFiles('pages', '.wxml').concat(walkFiles('components', '.wxml'))
const pageJs = walkFiles('pages', '.js').concat(walkFiles('components', '.js')).concat(walkFiles('utils', '.js'))

// 去注释（WXML 注释 / JS 行注释 + 块注释）后再做「不得出现」断言。
// 注释不渲染，本轮要保证的是「用户看得到的字」。
function stripWxmlComments(s) { return s.replace(/<!--[\s\S]*?-->/g, '') }
function stripJsComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

// 「她 / 他」作为代词出现（排除 其他 / 他人 / 他们 这类与性别无关的词）
function genderedHits(src) {
  const hits = []
  if (src.indexOf('她') !== -1) hits.push('她')
  const others = src.replace(/其他|他人|他们|他日/g, '')
  if (others.indexOf('他') !== -1) hits.push('他')
  return hits
}

;(async () => {
  console.log('\n=== G · 用户可见层零个人身份 ===\n')

  await testCase('G1 所有页面/组件 WXML（去注释）不含个人姓名与私人昵称', async () => {
    const hits = []
    for (const f of wxmlFiles) {
      const src = stripWxmlComments(read(f))
      for (const w of PERSONAL) if (src.indexOf(w) !== -1) hits.push(f + ' -> ' + w)
    }
    assertOk(hits.length === 0, hits.join(', '))
  })

  await testCase('G2 所有页面/组件 WXML（去注释）不含「她 / 他」性别代词', async () => {
    const hits = []
    for (const f of wxmlFiles) {
      const g = genderedHits(stripWxmlComments(read(f)))
      if (g.length) hits.push(f + ' -> ' + g.join('/'))
    }
    assertOk(hits.length === 0, hits.join(', '))
  })

  await testCase('G3 页面/组件/工具 JS 的可见字符串不含个人姓名与私人昵称', async () => {
    const hits = []
    for (const f of pageJs) {
      const src = read(f) // 注释里也不该再出现，这里连注释一起查
      for (const w of PERSONAL) if (src.indexOf(w) !== -1) hits.push(f + ' -> ' + w)
    }
    assertOk(hits.length === 0, hits.join(', '))
  })

  await testCase('G4 可见字符串里的性别代词已清零（排除「其他/他人/他们」）', async () => {
    const hits = []
    for (const f of pageJs) {
      const g = genderedHits(stripJsComments(read(f)))
      if (g.length) hits.push(f + ' -> ' + g.join('/'))
    }
    assertOk(hits.length === 0, hits.join(', '))
  })

  await testCase('G5 无「男朋友 / 女朋友 / 老公 / 老婆」等关系假设', async () => {
    const words = ['男朋友', '女朋友', '老公', '老婆', '男友', '女友']
    const hits = []
    for (const f of wxmlFiles.concat(pageJs)) {
      const src = read(f)
      for (const w of words) if (src.indexOf(w) !== -1) hits.push(f + ' -> ' + w)
    }
    assertOk(hits.length === 0, hits.join(', '))
  })

  console.log('\n=== H · 评分方向（必须与「谁给谁打」一致） ===\n')

  await testCase('H1 打分器按 readonly 区分方向，标签用 name（缺省回退 TA）', async () => {
    const sp = stripWxmlComments(read('components/score-picker/score-picker.wxml'))
    assertHas(sp, "readonly ? name + '给你打的分' : name + '的得分'",
      '标签必须随 readonly 切换，否则「我给他打」和「他给我打」会看反')
    const js = read('components/score-picker/score-picker.js')
    assertHas(js, "name: { type: String, value: 'TA' }", 'name 属性缺省应为 TA')
  })

  await testCase('H2 记录页是可编辑打分：标题「给 X 打几分」（X 为我给 TA 的称呼）', async () => {
    const rec = stripWxmlComments(read('pages/record/record.wxml'))
    assertHas(rec, '<view class="section-title">给{{partnerName}}打几分</view>')
    assertHas(rec, 'bind:change="onScoreChange"', '评分回写事件必须保留')
    // 记录页传入的 score-picker 不带 readonly（即可编辑）
    assertHas(rec, '<score-picker value="{{score}}" bind:change="onScoreChange" name="{{partnerName}}" />')
  })

  await testCase('H3 「我们」页不再展示今日评分（V1.1 收尾：与首页重复，已移除）', async () => {
    const ours = stripWxmlComments(read('pages/ours/ours.wxml'))
    assertNo(ours, '<score-picker', '我们页不应再出现评分组件')
    assertNo(ours, '今天给你打了几分', '我们页不应再出现评分标题')
    // 评分展示统一由首页承担：记录方看自己的得分，陪伴方看对方给的评分
    const home = stripWxmlComments(read('pages/home/home.wxml'))
    assertHas(home, '{{partnerName}}的得分')
    assertHas(home, 'TA 今天给你的评分')
  })

  await testCase('H4 首页状态卡 = 「X 的得分」，与记录页口径一致', async () => {
    const home = stripWxmlComments(read('pages/home/home.wxml'))
    assertHas(home, '<text class="stat-label">{{partnerName}}的得分</text>')
    const js = read('pages/home/home.js')
    assertHas(js, "今天给' + this.data.partnerName + '打几分呢", '空分提示未通用化')
    assertNo(js, '给他打', '仍残留「给他打」')
  })

  await testCase('H5 评分数据字段与算法未被改动', async () => {
    // 前端仍然把 score 写进当天记录；组件属性名仍是 value；事件名仍是 change
    const rec = read('pages/record/record.js')
    assertHas(rec, 'score', 'score 字段丢失')
    assertHas(rec, 'onScoreChange')
    const sp = read('components/score-picker/score-picker.js')
    assertHas(sp, 'value: { type: Number, value: 0 }', 'value 属性签名被改动')
    assertHas(sp, 'triggerEvent(', 'change 事件被移除')
  })

  console.log('\n=== I · 心愿 / 留言 / 经期通用化 ===\n')

  await testCase('I1 心愿区标题与空态按角色通用', async () => {
    const ours = stripWxmlComments(read('pages/ours/ours.wxml'))
    assertHas(ours, "role === 'him' ? 'TA 的心愿' : '我的心愿'")
    assertHas(ours, "role === 'him' ? 'TA 今天还没说想吃什么'")
  })

  await testCase('I2 「已安排」标签：自己安排的显示「已安排」，看对方安排的显示「TA 已安排」', async () => {
    const ours = stripWxmlComments(read('pages/ours/ours.wxml'))
    assertHas(ours, "{{role === 'him' ? '已安排' : 'TA 已安排'}}")
    // 只有 him 有「已安排」按钮，所以 done_by_partner 一定是 him 操作的
    assertHas(ours, "role === 'him' && item.status === 'pending'")
  })

  await testCase('I3 留言署名：自己「我」，对方用我给 TA 的称呼', async () => {
    const ours = stripWxmlComments(read('pages/ours/ours.wxml'))
    assertHas(ours, "{{item.mine ? '我' : myPartnerName}}")
  })

  await testCase('I4 经期预计已移至首页：陪伴方看对方，记录方看自己', async () => {
    const home = stripWxmlComments(read('pages/home/home.wxml'))
    assertHas(home, 'TA 预计下次姨妈')
    assertHas(home, '预计下次姨妈')
    // 可见性只来自服务端（menstrual get 已按 sharePeriod 授权判定），前端不自行推算
    assertHas(home, '{{homeNextLabel}}')
    const ours = stripWxmlComments(read('pages/ours/ours.wxml'))
    assertNo(ours, '预计下次姨妈', '我们页不应再重复经期卡片')
  })

  await testCase('I5 日历页陪伴方视角与空态文案通用', async () => {
    const cal = stripWxmlComments(read('pages/calendar/calendar.wxml'))
    assertHas(cal, 'TA 预计下次姨妈')
    assertHas(cal, '经期还没设置，等 TA 记录后就能看到预计日期')
  })

  await testCase('I6 「也提醒 TA」开关与其说明', async () => {
    const cal = stripWxmlComments(read('pages/calendar/calendar.wxml'))
    assertHas(cal, '也提醒 TA')
    assertHas(cal, 'TA 要用自己的微信订阅一次；关掉不影响你的提醒')
    // 开关仍然只给记录方（isHer）看到，权限模型未变
    assertHas(cal, 'wx:if="{{isHer}}"')
  })

  await testCase('I7 日历页提示文案与 Toast 均为通用称呼', async () => {
    const js = read('pages/calendar/calendar.js')
    assertHas(js, '先由 TA 打开下面的「也提醒 TA」')
    assertHas(js, '需要 TA 打开「也提醒 TA」之后')
    assertHas(js, '已开启：也会提醒 TA')
  })

  await testCase('I8 悄悄话数量口径：满 50 条说「最近 50 条」，不得说成全部历史', async () => {
    const ours = stripWxmlComments(read('pages/ours/ours.wxml'))
    assertHas(ours, "{{msgMaxed ? '最近 ' + msgLimit + ' 条' : '共 ' + messages.length + ' 条'}}",
      '数量文案必须区分「最近 N 条」与「共 N 条」')
    assertNo(ours, '共 {{messages.length}} 条', '不得再把已加载条数说成总数')
    assertNo(ours, '回看全部历史', '当前没有分页，不得宣称能看全部历史')
    const js = read('pages/ours/ours.js')
    assertHas(js, 'msgLimit: MSG_LIMIT_CLIENT', '客户端上限必须显式来自服务端同值常量')
  })

  console.log('\n=== J · 各绑定状态的默认文案 ===\n')

  await testCase('J1 未绑定态文案不含任何个人名与关系假设', async () => {
    const ours = stripWxmlComments(read('pages/ours/ours.wxml'))
    assertHas(ours, '先绑定，再见面')
    assertHas(ours, '你的绑定码（可复制发给对方）')
    assertHas(ours, '输入对方的绑定码完成绑定：')
    assertHas(ours, 'placeholder="如 XZ-ABCDEF12"', '绑定码占位示例被改动')
    // V1.1 收尾：不再规定「谁生成、谁输入」（绑定规则本来就是双方对称的）
    assertHas(ours, '一方生成配对码，另一方输入，确认后就能一起使用')
    assertNo(ours, '建议女生生成', '绑定说明不得再指定性别角色')
    assertNo(read('pages/mine/mine.wxml'), '建议女生生成', '「我的」页绑定说明同样不得指定性别角色')
  })

  await testCase('J2 非 active（解绑/被顶替）时服务端仍 fail-closed', async () => {
    const src = read('cloudfunctions/getPartnerView/index.js')
    assertHas(src, "status: 'active'", '鉴权必须限定 active 情侣关系')
    assertHas(src, 'NOT_ACTIVE', '非 active 必须有明确失败码')
  })

  await testCase('J3 新用户首屏不出现他人信息（未绑定不拉伴侣数据）', async () => {
    const ours = read('pages/ours/ours.js')
    // 未绑定时不调用 getPartnerView；只在有绑定时拉取
    assertHas(ours, 'notBound', '未绑定态必须存在')
    const wxml = stripWxmlComments(read('pages/ours/ours.wxml'))
    assertHas(wxml, 'wx:if="{{notBound}}"', '未绑定区块必须独立渲染')
  })

  console.log('\n=== K · 身份来源与隔离（只读审计） ===\n')

  await testCase('K1 没有任何硬编码 OpenID 字面量', async () => {
    const files = walkFiles('cloudfunctions', '.js').concat(pageJs)
    const re = /['"](o[A-Za-z0-9_-]{27})['"]/g
    const hits = []
    for (const f of files) {
      const src = read(f)
      let m
      while ((m = re.exec(src))) hits.push(f + ' -> ' + m[1])
    }
    assertOk(hits.length === 0, hits.join(', '))
  })

  await testCase('K2 身份一律来自 WXContext，不由前端传入', async () => {
    const src = read('cloudfunctions/getPartnerView/index.js')
    assertHas(src, 'cloud.getWXContext()')
    // 前端不得把 openid 当参数传给云函数
    const hits = []
    for (const f of pageJs) {
      const s = read(f)
      if (/callFunction\([\s\S]{0,200}openid\s*:/.test(s)) hits.push(f)
    }
    assertOk(hits.length === 0, '前端疑似传入 openid：' + hits.join(', '))
  })

  await testCase('K3 伴侣视图不含日记正文与私密字段', async () => {
    const src = read('cloudfunctions/getPartnerView/index.js')
    // 返回体里不得出现 herSummary / herReport / mood / body / symptoms 字段
    for (const f of ['herSummary', 'herReport', 'mood', 'symptoms']) {
      const re = new RegExp('^\\s*' + f + '\\s*:', 'm')
      assertOk(!re.test(src), '返回体疑似包含私密字段: ' + f)
    }
  })

  await testCase('K4 心愿按属主 + 情侣关系双重隔离，留言按 coupleId 隔离', async () => {
    const src = read('cloudfunctions/getPartnerView/index.js')
    assertHas(src, "where({ _openid: wishOwnerOpenid, coupleId: couple.coupleId })", '心愿查询未限定属主 + 情侣关系')
    // 归属复核收口在 visibleWishOf（同一套判定同时服务于「心愿列表」和「这天的愿望」）
    assertHas(src, 'function visibleWishOf(w, ctx)', '缺心愿归属判定函数')
    assertHas(src, 'wishScope.isWishShared(w, ctx)', '心愿查询未做情侣关系归属过滤')
    assertHas(src, 'visibleWishOf(w, wishCtx)', '心愿列表未走归属复核')
    assertHas(src, "collection('messages').where({ coupleId: couple.coupleId })", '留言查询未限定情侣')
  })

  console.log('\n=== L · 云函数返回给前端的可见文字 ===\n')

  await testCase('L1 aiSummary 的提示词与兜底文案不含个人姓名与性别代词', async () => {
    const src = read('cloudfunctions/aiSummary/index.js')
    for (const w of ['小宇', '小舟', '安安']) assertNo(src, w, 'aiSummary 仍写死个人身份')
    for (const w of ['多陪陪她', '她今天给你打', '这周她记录', '她许的心愿', '小宇指数']) {
      assertNo(src, w, 'aiSummary 仍残留性别/旧术语文案')
    }
    assertHas(src, '多陪陪 TA')
    assertHas(src, 'TA 的得分')
  })

  await testCase('L2 aiSummary 的“her/partner”字段名保留（数据结构未改）', async () => {
    const src = read('cloudfunctions/aiSummary/index.js')
    assertHas(src, 'return { her: ', '字段名 her/partner 属于数据结构，不应被文案改动波及')
    assertHas(src, 'partner: ')
  })

  await testCase('L3 三个 notify.js 仍逐字节一致（本轮不得破坏）', async () => {
    const a = fs.readFileSync(path.join(ROOT, 'cloudfunctions/getPartnerView/notify.js'))
    const b = fs.readFileSync(path.join(ROOT, 'cloudfunctions/dailyRecord/notify.js'))
    const c = fs.readFileSync(path.join(ROOT, 'cloudfunctions/menstrual/notify.js'))
    assertOk(a.equals(b) && b.equals(c), 'notify.js 三份副本已不一致')
  })

  await testCase('L4 订阅消息「消息来自」缺昵称时不得回退到个人姓名', async () => {
    const src = read('cloudfunctions/getPartnerView/notify.js')
    assertHas(src, "const DEFAULT_SENDER_NAME = '你的另一半'", '默认发信人仍是个人昵称')
    for (const w of PERSONAL) assertNo(src, w, 'notify.js 仍写死个人姓名')
    // 兜底分支不得再按角色分叉成两个不同名字
    assertOk(!/role === 'him' \? '你的另一半' : DEFAULT_SENDER_NAME/.test(src),
      '发信人兜底仍按角色分成两个名字')
    const notify = require(path.join(ROOT, 'cloudfunctions/getPartnerView/notify.js'))
    for (const args of [['', 'her'], ['', 'him'], ['她', 'her'], ['他', 'him'], [undefined, 'her']]) {
      const got = notify.senderNameOf(args[0], args[1])
      assertOk(got === '你的另一半', '兜底称呼不对: ' + JSON.stringify(args) + ' -> ' + got)
    }
    assertOk(notify.senderNameOf('小A', 'her') === '小A', '用户自己设的昵称必须优先')
  })

  await testCase('L5 云函数返回给前端的报错文案不含个人姓名', async () => {
    const src = read('cloudfunctions/getPartnerView/index.js')
    const msgs = src.match(/msg:\s*'[^']*'/g) || []
    assertOk(msgs.length > 0, '没有扫描到任何 msg 文案，正则可能失效')
    const bad = msgs.filter(m => PERSONAL.some(w => m.indexOf(w) !== -1))
    assertOk(bad.length === 0, bad.join(' / '))
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
