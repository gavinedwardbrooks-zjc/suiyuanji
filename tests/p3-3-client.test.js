// ============================================================
// tests/p3-3-client.test.js · V1.1 P3.3 客户端侧
//
// 只覆盖本轮（P3.3）新增/变更的客户端契约：
//   F1 新增错误码都有中文文案，且不含性别代词
//   F2 needsIdentityRefresh 只对「关系层面」的码成立
//   F3 同一日期两次分享写入：先发后到的响应必须被丢弃（不覆盖新状态）
//   F4 STALE_RELATION → 清空分享区 + 重新同步身份，绝不显示为已开启
//   F5 CONFLICT / DB_ERROR → 不改变已确认的状态，只提示（不假装成功）
//   F6 页面不感知任何 openid 字段；记录级点赞 / 留言 UI 已彻底移除
//
// 记录级互动已在 V1.1 收尾移除：原 F6（公开留言标识）、F7（互动字段白名单）
// 随功能删除，原 F8 保留并加强为「互动 UI 不得复活」的静态契约。
//
// 运行：node tests/p3-3-client.test.js
// ============================================================
const path = require('path')
const fs = require('fs')

const ROOT = path.resolve(__dirname, '..')
const RECORD_PAGE = path.join(ROOT, 'pages/record/record.js')
const shareApi = require(path.join(ROOT, 'utils/record-share.js'))

const D_A = '2026-10-20'
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

const flush = () => new Promise(r => setTimeout(r, 0))
function deferred() {
  let resolve, reject
  const p = new Promise((res, rej) => { resolve = res; reject = rej })
  return { p, resolve, reject }
}

function loadPage(opts) {
  const o = opts || {}
  const calls = []
  const toasts = []
  const modals = []
  const logins = []

  global.wx = {
    cloud: {
      callFunction: (args) => {
        calls.push(args)
        const action = args.data && args.data.action
        const handler = (o.responses || {})[action]
        if (!handler) return Promise.resolve({ result: { ok: true } })
        return Promise.resolve(handler(args.data, args.name)).then(result => ({ result }))
      }
    },
    getStorageSync: () => '',
    setStorageSync: () => {},
    removeStorageSync: () => {},
    showToast: (obj) => { toasts.push(obj && obj.title) },
    showModal: (obj) => {
      modals.push(obj)
      if (o.autoConfirm && typeof obj.success === 'function') obj.success({ confirm: true, cancel: false })
    },
    requestSubscribeMessage: () => {}
  }

  global.getApp = () => ({
    whenReady: (cb) => cb({ openid: o.openid || 'A_her_openid', role: o.role || 'her', coupleId: 'CZ-1' }),
    globalData: {
      openid: o.openid || 'A_her_openid',
      role: o.role || 'her',
      coupleId: 'CZ-1',
      partnerName: ''
    },
    silentLogin: () => { logins.push(Date.now()); return Promise.resolve() },
    loginSnapshot: () => ({ state: 'ready', ok: true, canRetry: false })
  })

  let cfg = null
  global.Page = (c) => { cfg = c }
  delete require.cache[RECORD_PAGE]
  require(RECORD_PAGE)
  const page = Object.assign({}, cfg)
  page.data = JSON.parse(JSON.stringify(cfg.data))
  page.setData = function (patch, cb) {
    for (const key of Object.keys(patch || {})) {
      if (key.indexOf('.') === -1) { page.data[key] = patch[key]; continue }
      const parts = key.split('.')
      let cur = page.data
      for (let i = 0; i < parts.length - 1; i++) cur = cur[parts[i]] = cur[parts[i]] || {}
      cur[parts[parts.length - 1]] = patch[key]
    }
    if (cb) cb()
  }
  return { page, calls, toasts, modals, logins }
}

function recordOf(date) {
  return {
    _id: 'rec_' + date, _openid: 'A_her_openid', date, coupleId: 'CZ-1', revision: 2,
    goals: [], todos: [], segments: { life: '已保存的生活', work: '', growth: '' },
    mood: { type: 'calm', weather: 'sunny' }, score: 4, wishes: []
  }
}

// 新契约：服务端必须返回数字 rev（CAS 版本号），否则页面会 fail-closed 禁用开关
const shareOn = (extra) => Object.assign({
  ok: true, enabled: true, canShare: true, hasRecord: true, rev: 1
}, extra || {})

async function main() {
  console.log('\n=== P3.3 客户端 ===\n')

  await testCase('F1 新增错误码都有中文文案，且不含性别代词', () => {
    for (const code of ['STALE_RELATION', 'CONFLICT', 'DB_ERROR']) {
      const hint = shareApi.hintOf(code)
      assertOk(hint && hint !== shareApi.hintOf('UNKNOWN'), code + ' 缺少专门文案')
      assertOk(/[\u4e00-\u9fa5]/.test(hint), code + ' 文案应为中文')
      assertOk(hint.indexOf('她') === -1 && hint.indexOf('他') === -1, code + ' 文案不得含性别代词：' + hint)
    }
  })

  await testCase('F2 needsIdentityRefresh 只对关系层面的错误码成立', () => {
    for (const code of ['NOT_ACTIVE', 'UNAUTHORIZED', 'STALE_RELATION']) {
      assertEq(shareApi.needsIdentityRefresh(code), true, code)
    }
    for (const code of ['CONFLICT', 'DB_ERROR', 'NOT_SHARED', 'BAD_ARGS', 'NETWORK', 'UNKNOWN', '', null]) {
      assertEq(shareApi.needsIdentityRefresh(code), false, String(code))
    }
  })

  await testCase('F3 同一日期两次分享写入：先发后到的响应被丢弃，不覆盖新状态', async () => {
    const slow = deferred()
    const fast = deferred()
    let n = 0
    const h = loadPage({
      responses: {
        shareStatus: () => shareOn({ enabled: false }),
        shareSet: () => { n += 1; return n === 1 ? slow.p : fast.p }
      }
    })
    h.page.onLoad()
    await flush()
    assertEq(h.page.data.shareState, 'ready')

    h.page._setShare(true)                     // 请求 A（先发，后到）
    await flush()
    h.page._setShare(false)                    // 请求 B（后发，先到）
    await flush()

    fast.resolve({ ok: true, enabled: false })
    await flush()
    assertEq(h.page.data.shareEnabled, false, 'B 的结果先落地')

    slow.resolve({ ok: true, enabled: true })  // 迟到的旧响应
    await flush()
    assertEq(h.page.data.shareEnabled, false, '迟到的旧响应绝不能把状态改回已开启')
    assertEq(h.page.data.shareBusy, false)
  })

  await testCase('F4 STALE_RELATION → 清空分享区 + 重新同步身份，绝不显示为已开启', async () => {
    const h = loadPage({
      responses: {
        shareStatus: () => shareOn({ enabled: false }),
        shareSet: () => ({ ok: false, code: 'STALE_RELATION' })
      }
    })
    h.page.onLoad()
    await flush()
    h.page._setShare(true)
    await flush()

    assertEq(h.page.data.shareEnabled, false, '失败不得显示为已开启')
    assertEq(h.page.data.shareState, 'idle', '关系已变 → 分享区回到未加载态，等重新确认')
    assertEq(h.page.data.shareCanShare, false)
    assertOk(h.toasts.indexOf(shareApi.hintOf('STALE_RELATION')) !== -1, '必须给出可理解的提示')
    assertOk(h.logins.length >= 1, '必须重新向服务端确认身份')
  })

  await testCase('F5 CONFLICT / DB_ERROR → 状态不变、只提示（不假装成功、也不清空内容）', async () => {
    for (const code of ['CONFLICT', 'DB_ERROR']) {
      const h = loadPage({
        responses: {
          shareStatus: () => shareOn({ enabled: true }),
          shareSet: () => ({ ok: false, code })
        }
      })
      h.page.onLoad()
      await flush()
      assertEq(h.page.data.shareEnabled, true, '初始为已开启')

      h.page._setShare(false)     // 想关闭，但写入失败
      await flush()
      assertEq(h.page.data.shareEnabled, true, code + ' 失败不得显示为已关闭')
      assertEq(h.page.data.shareState, 'ready', code + ' 不该把分享区打成错误态')
      assertOk(h.toasts.indexOf(shareApi.hintOf(code)) !== -1, code + ' 必须有提示')
      assertEq(h.logins.length, 0, code + ' 不属于关系变化，不该触发重新登录')
    }
  })

  await testCase('F6 页面不感知 openid 字段；记录级点赞 / 留言 UI 已彻底移除', () => {
    const js = read('pages/record/record.js')
    assertOk(js.indexOf('actorOpenid') === -1, '页面不应感知 actorOpenid')
    assertOk(js.indexOf('ownerOpenid') === -1, '页面不应感知 ownerOpenid')
    assertOk(js.indexOf('himOpenid') === -1, '页面不应感知 himOpenid')

    // 事件与数据字段都已删除
    for (const gone of ['onLikeTap', 'onCommentTap', 'onCommentInput',
      'pvLiked', 'pvLikeCount', 'pvComments', 'pvCommentDraft',
      'shareLikeCount', 'shareComments']) {
      assertOk(js.indexOf(gone) === -1, '页面仍残留互动代码：' + gone)
    }

    const wxml = read('pages/record/record.wxml')
    for (const gone of ['pvLiked', 'pvComments', 'shareComments', 'share-inbox',
      'bindtap="onLikeTap"', 'bindinput="onCommentInput"', 'bindtap="onCommentTap"']) {
      assertOk(wxml.indexOf(gone) === -1, '界面仍残留互动元素：' + gone)
    }
    for (const word of ['点个赞', '已点赞', '回应这一天', '个赞', '条留言']) {
      assertOk(wxml.indexOf(word) === -1, '界面仍残留互动文案：' + word)
    }
  })

  console.log('\n=== 结果: ' + passed + ' PASS / ' + failed + ' FAIL ===')
  if (failed) {
    console.log('\n失败用例:')
    for (const f of failures) console.log('  - ' + f)
    process.exit(1)
  }
  console.log('P3.3 Client: ALL GREEN')
}

main()
