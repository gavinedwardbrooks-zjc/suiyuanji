// ============================================================
// tests/p3-interaction-removed.test.js · V1.1 收尾验收
//
// 目的：证明「移除日记点赞 / 日记留言 / 互动计数」这件事是**客户端 + 服务端**一起完成的，
// 同时证明保留项没有被误删。
//
// 覆盖：
//   A 服务端：like / comment 两个 action 不再存在（BAD_ACTION），且零写入
//   B 返回结构：view 无 interaction、shareStatus 无 interactions
//   C 保留项：shareStatus / shareSet 仍然可用（含 expectedRev CAS）
//   D 保留项：V1.0.3 悄悄话（msg / readMsg / view.messages）不受影响
//   E 客户端：互动方法与白名单字段已删除
//   F 界面：记录页互动 UI 与文案已删除；分享区仍在
//
// 运行：node tests/p3-interaction-removed.test.js
// ============================================================
const Module = require('module')
const path = require('path')
const fs = require('fs')
const { MockDB } = require('./mock-db')

const ROOT = path.resolve(__dirname, '..')
const D1 = '2026-10-20'
const HER_A = 'A_her_openid'
const HIM_B = 'B_him_openid'

let OPENID = HER_A
let passed = 0, failed = 0, failures = []

function testCase(name, fn) {
  return Promise.resolve().then(fn).then(() => { passed++; console.log('  PASS  ' + name) })
    .catch(e => { failed++; failures.push(name + ': ' + e.message); console.log('  FAIL  ' + name + '  -> ' + e.message) })
}
function assertEq(a, b, msg) {
  if (a !== b) throw new Error((msg || '') + ' 期望 ' + JSON.stringify(b) + ' 实际 ' + JSON.stringify(a))
}
function assertOk(v, msg) { if (!v) throw new Error(msg || '断言失败') }
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8') }

function loadFn(db) {
  const origLoad = Module._load
  Module._load = function (request) {
    if (request === 'wx-server-sdk') {
      return {
        DYNAMIC_CURRENT_ENV: 'test',
        init() {},
        database: () => db,
        getWXContext: () => ({ OPENID }),
        openapi: { subscribeMessage: { send: async () => ({ errCode: 0 }) } }
      }
    }
    return origLoad.apply(this, arguments)
  }
  const fnPath = path.join(ROOT, 'cloudfunctions/getPartnerView/index.js')
  delete require.cache[fnPath]
  const mod = require(fnPath)
  Module._load = origLoad
  return mod
}

function seed() {
  return {
    users: [
      { _id: 'uA', _openid: HER_A, role: 'her', coupleId: 'CZ-1', partnerName: '' },
      { _id: 'uB', _openid: HIM_B, role: 'him', coupleId: 'CZ-1', partnerName: '' }
    ],
    couples: [{
      _id: 'c1', coupleId: 'CZ-1', status: 'active',
      herOpenid: HER_A, himOpenid: HIM_B, anniversary: '2026-01-01'
    }],
    daily_records: [{
      _openid: HER_A, date: D1, coupleId: 'CZ-1', revision: 2,
      goals: [], todos: [], segments: { life: '生活', work: '工作', growth: '成长' },
      mood: { type: 'calm', weather: 'sunny' }, score: 3, wishes: []
    }],
    record_shares: [{
      _id: 'sh_' + HER_A + '_' + D1, _openid: HER_A, date: D1,
      coupleId: 'CZ-1', himOpenid: HIM_B, enabled: true, rev: 4, createdAt: 1, updatedAt: 1
    }]
  }
}

const shareOf = db => (db.dump().record_shares || [])[0] || null
const inter = db => (db.dump().record_interactions || [])

async function main() {
  console.log('\n=== V1.1 收尾：记录级互动已移除 ===\n')

  // ---------------- A. 服务端 action 不再存在 ----------------
  await testCase('A1 him 调 like / comment → BAD_ACTION，零写入', async () => {
    const db = new MockDB(seed())
    const fn = loadFn(db)
    OPENID = HIM_B
    const like = await fn.main({ action: 'like', date: D1, liked: true })
    assertEq(like.ok, false)
    assertEq(like.code, 'BAD_ACTION')
    assertOk(String(like.msg).indexOf('like') !== -1, '错误信息应指出未知 action')

    const cm = await fn.main({ action: 'comment', date: D1, text: '还想留言', requestId: 'req_1' })
    assertEq(cm.ok, false)
    assertEq(cm.code, 'BAD_ACTION')
    assertEq(inter(db).length, 0, '不得写任何互动文档')
  })

  await testCase('A2 her 调 like / comment 同样是 BAD_ACTION（不因角色而放宽）', async () => {
    const db = new MockDB(seed())
    const fn = loadFn(db)
    OPENID = HER_A
    assertEq((await fn.main({ action: 'like', date: D1, liked: true })).code, 'BAD_ACTION')
    assertEq((await fn.main({ action: 'comment', date: D1, text: 'x', requestId: 'r' })).code, 'BAD_ACTION')
    assertEq(inter(db).length, 0)
  })

  // ---------------- B. 返回结构不再含互动字段 ----------------
  await testCase('B1 him 的 view：已共享也只有 shared，没有 interaction', async () => {
    const db = new MockDB(seed())
    const fn = loadFn(db)
    OPENID = HIM_B
    const v = await fn.main({ action: 'view', date: D1 })
    assertEq(v.ok, true)
    assertOk(v.shared, '分享仍在：him 能看到这一天')
    assertEq(Object.prototype.hasOwnProperty.call(v, 'interaction'), false, 'interaction 字段必须不存在')
    const keys = Object.keys(v)
    for (const gone of ['interaction', 'likedByMe', 'likeCount', 'comments']) {
      assertEq(keys.indexOf(gone), -1, '响应仍含字段：' + gone)
    }
  })

  await testCase('B2 shareStatus：字段集合固定，没有 interactions（点赞数 / 留言列表）', async () => {
    const db = new MockDB(seed())
    const fn = loadFn(db)
    OPENID = HER_A
    const s = await fn.main({ action: 'shareStatus', date: D1 })
    assertEq(s.ok, true)
    assertEq(Object.keys(s).sort().join(','), 'canShare,date,enabled,hasRecord,ok,rev')
  })

  // ---------------- C. 分享本身仍然可用 ----------------
  await testCase('C1 分享开关链路完整：关 → 他读不到；开 → 他读得到', async () => {
    const db = new MockDB(seed())
    const fn = loadFn(db)
    OPENID = HER_A
    const off = await fn.main({ action: 'shareSet', date: D1, enabled: false, expectedRev: 4 })
    assertEq(off.ok, true)
    assertEq(off.rev, 5, 'CAS 成功后版本号 +1')

    OPENID = HIM_B
    assertEq((await fn.main({ action: 'view', date: D1 })).shared, null, '关闭后读不到')

    OPENID = HER_A
    const on = await fn.main({ action: 'shareSet', date: D1, enabled: true, expectedRev: 5 })
    assertEq(on.ok, true)

    OPENID = HIM_B
    const v = await fn.main({ action: 'view', date: D1 })
    assertOk(v.shared, '重新开启后读得到')
    assertEq(v.shared.segments.life, '生活')
  })

  await testCase('C2 历史 record_interactions 数据残留不影响任何只读路径', async () => {
    const data = seed()
    // 模拟生产里尚未清理的旧互动文档（含旧格式 lk_ 前缀与 openid）
    data.record_interactions = [
      { _id: 'lk_' + HIM_B + '_' + HER_A + '_' + D1, kind: 'like', active: true, ownerOpenid: HER_A, actorOpenid: HIM_B },
      { _id: 'cm2_CZ-1_' + HIM_B + '_' + D1 + '_req_1', kind: 'comment', text: '历史留言', ownerOpenid: HER_A, actorOpenid: HIM_B }
    ]
    const db = new MockDB(data)
    const fn = loadFn(db)

    OPENID = HIM_B
    const v = await fn.main({ action: 'view', date: D1 })
    assertEq(v.ok, true)
    assertOk(v.shared, '分享不受影响')
    const json = JSON.stringify(v)
    assertOk(json.indexOf('历史留言') === -1, '历史留言不得出现在响应里')
    assertOk(json.indexOf(HIM_B) === -1, '响应不得含 openid')

    OPENID = HER_A
    const s = await fn.main({ action: 'shareStatus', date: D1 })
    assertEq(s.ok, true)
    assertOk(JSON.stringify(s).indexOf('历史留言') === -1, 'shareStatus 不得带出历史留言')
    // 只读路径绝不改写或删除历史文档
    assertEq(inter(db).length, 2, '历史互动数据保持原样（不删、不清）')
  })

  // ---------------- D. V1.0.3 悄悄话不受影响 ----------------
  await testCase('D1 悄悄话链路仍在：msg 写入成功，view.messages 能读到', async () => {
    const db = new MockDB(seed())
    const fn = loadFn(db)
    OPENID = HER_A
    const sent = await fn.main({ action: 'msg', text: '  今天也辛苦啦  ', requestId: 'req_msg_1' })
    assertEq(sent.ok, true, '悄悄话必须仍可发送')
    assertOk(sent.msgId, '应返回 msgId')

    const v = await fn.main({ action: 'view', date: D1 })
    assertEq(Array.isArray(v.messages), true, 'view 仍应返回 messages')
    assertEq(v.messages.length, 1)
    assertEq(v.messages[0].text, '今天也辛苦啦')
    assertEq(v.messages[0].mine, true)
  })

  await testCase('D2 readMsg 仍在：接收方标记已读后可写回 readAt', async () => {
    const db = new MockDB(seed())
    const fn = loadFn(db)
    OPENID = HER_A
    const sent = await fn.main({ action: 'msg', text: '在吗', requestId: 'req_msg_2' })

    OPENID = HIM_B
    const read1 = await fn.main({ action: 'readMsg', msgId: sent.msgId })
    assertEq(read1.ok, true)
    assertEq(read1.updated, 1, '接收方第一次标记应为 1')
    const read2 = await fn.main({ action: 'readMsg', msgId: sent.msgId })
    assertEq(read2.updated, 0, '幂等：第二次不再写入')
  })

  // ---------------- E. 客户端方法与白名单 ----------------
  await testCase('E1 utils/record-share 不再导出互动方法，分享方法齐全', () => {
    const api = require(path.join(ROOT, 'utils/record-share.js'))
    for (const gone of ['requestLike', 'requestComment', 'normalizeLike', 'normalizeComment',
      'normalizeCommentText', 'pickInteractions', 'COMMENT_MAX_LEN', 'COMMENT_LIMIT']) {
      assertEq(api[gone], undefined, '仍导出已移除的成员：' + gone)
    }
    assertEq(typeof api.requestShareStatus, 'function')
    assertEq(typeof api.requestShareSet, 'function')
    assertEq(typeof api.buildSharePreview, 'function')
    assertOk(api.CODE.NOT_SHARED, 'NOT_SHARED 必须保留')
    assertEq(api.CODE.REQUEST_ID_REUSED, undefined, 'REQUEST_ID_REUSED 应随留言一并移除')
  })

  await testCase('E2 utils/partner-view：白名单无 interaction，服务端多返回也会被丢弃', () => {
    const pv = require(path.join(ROOT, 'utils/partner-view.js'))
    assertEq(pv.VIEW_FIELDS.indexOf('interaction'), -1, '白名单仍含 interaction')
    assertOk(pv.VIEW_FIELDS.indexOf('shared') !== -1, 'shared 必须在白名单里')
    assertEq(pv.pickInteraction, undefined, 'pickInteraction 应已删除')

    const out = pv.pickView({
      ok: true, role: 'him', score: 3,
      shared: { mood: { type: 'calm', weather: 'rain' }, segments: { life: 'L', work: '', growth: '' } },
      interaction: { likedByMe: true, likeCount: 9, comments: [{ _id: 'x', text: '留言', createdAt: 1 }] }
    })
    assertOk(out.shared, 'shared 必须保留')
    assertEq(Object.prototype.hasOwnProperty.call(out, 'interaction'), false)
    assertOk(JSON.stringify(out).indexOf('留言') === -1, '互动内容不得进入页面 data')
  })

  await testCase('E3 云函数侧不再引用互动辅助函数（静态检查）', () => {
    const lib = require(path.join(ROOT, 'cloudfunctions/getPartnerView/record-share.js'))
    for (const gone of ['likeDocId', 'commentDocId', 'pickInteractionForHim', 'pickInteractionForHer',
      'pickCommentPublic', 'actorOf', 'isInvalidated', 'publicIdOf', 'newPublicId',
      'normalizeComment', 'normalizeRequestId', 'sameCommentText',
      'INTERACTION_COLLECTION', 'LIKE_ID_PREFIX', 'COMMENT_ID_PREFIX']) {
      assertEq(lib[gone], undefined, '判定模块仍导出：' + gone)
    }
    for (const keep of ['SHARE_COLLECTION', 'shareDocId', 'isShareActiveFor', 'shareRevOf',
      'normalizeExpectedRev', 'revConditionOf', 'pickSharedContent']) {
      assertOk(lib[keep] !== undefined, '必须保留：' + keep)
    }

    const idx = read('cloudfunctions/getPartnerView/index.js')
    for (const gone of ["action === 'like'", "action === 'comment'",
      'readInteractionForHim', 'readInteractionForHer', 'countActiveLikes', 'listComments']) {
      assertOk(idx.indexOf(gone) === -1, '云函数仍残留：' + gone)
    }
    // 保留项必须在位
    for (const keep of ["action === 'shareStatus'", "action === 'shareSet'",
      "action === 'msg'", "action === 'readMsg'", 'expectedRev']) {
      assertOk(idx.indexOf(keep) !== -1, '云函数缺少保留项：' + keep)
    }
  })

  // ---------------- F. 界面 ----------------
  await testCase('F1 记录页不再有任何赞 / 留言入口与文案', () => {
    const js = read('pages/record/record.js')
    const wxml = read('pages/record/record.wxml')
    for (const gone of ['onLikeTap', 'onCommentTap', 'onCommentInput',
      'pvLiked', 'pvLikeCount', 'pvComments', 'pvCommentDraft', 'shareLikeCount', 'shareComments',
      'requestLike', 'requestComment']) {
      assertEq(js.indexOf(gone), -1, '记录页仍残留：' + gone)
      assertEq(wxml.indexOf(gone), -1, '记录模板仍残留：' + gone)
    }
    for (const word of ['点个赞', '已点赞', '回应这一天', '个赞', '条留言']) {
      assertEq(wxml.indexOf(word), -1, '界面仍残留文案：' + word)
    }
  })

  await testCase('F2 分享区仍在：她侧有开关，他侧有只读的三段日记', () => {
    const wxml = read('pages/record/record.wxml')
    for (const keep of ['分享这一天', 'onShareToggle', 'share-toggle',
      'shareCanShare', 'shareState', 'share-seg-text']) {
      assertOk(wxml.indexOf(keep) !== -1, '分享 UI 缺失：' + keep)
    }
  })

  console.log('\n=== 结果: ' + passed + ' PASS / ' + failed + ' FAIL ===')
  if (failed) {
    console.log('\n失败用例:')
    for (const f of failures) console.log('  - ' + f)
    process.exit(1)
  }
  console.log('P3 Interaction Removed: ALL GREEN')
}

main()
