// ============================================================
// tests/viewer-role.test.js · V1.1 P0 角色与绑定状态判定
//
// 覆盖：
//   A 归一化：role / coupleId 的脏值一律降级
//   B 四种状态：loading / role_unknown / unbound / bound
//   C 伴侣视图门槛：仅 role='him' 不进；role='him' + 绑定才进
//   D 安全降级：globalData 缺失、openid 缺失、role 缺失/非法
//   E 解绑与换绑：解绑后 role 残留不得误判；换绑后角色随新关系
//   F viewerFlags 扁平快照字段稳定
//   G 静态守护：两个页面只通过本工具读取角色，且默认值为 fail-closed
//
// 运行：node tests/viewer-role.test.js
// ============================================================
const path = require('path')
const fs = require('fs')

const ROOT = path.resolve(__dirname, '..')
const {
  normalizeRole, normalizeCoupleId, resolveViewer, viewerFlags
} = require(path.join(ROOT, 'utils/viewer-role.js'))

let passed = 0, failed = 0, failures = []

function testCase(name, fn) {
  return Promise.resolve().then(fn).then(() => { passed++; console.log('  PASS  ' + name) })
    .catch(e => { failed++; failures.push(name + ': ' + e.message); console.log('  FAIL  ' + name + '  -> ' + e.message) })
}
function assertEq(a, b, msg) { if (a !== b) throw new Error((msg || '') + ' 期望 ' + JSON.stringify(b) + ' 实际 ' + JSON.stringify(a)) }
function assertOk(v, msg) { if (!v) throw new Error(msg || '断言失败') }
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8') }

// 便捷构造：一份「已登录」的 globalData
function g(role, coupleId, openid) {
  return { openid: openid === undefined ? 'oA' : openid, role, coupleId }
}

async function runAll() {
  console.log('\n=== Viewer Role · 角色与绑定状态判定（V1.1 P0） ===\n')

  // ---- A. 归一化 ----
  await testCase('A1 normalizeRole 只接受 her / him', () => {
    assertEq(normalizeRole('her'), 'her')
    assertEq(normalizeRole('him'), 'him')
    assertEq(normalizeRole('HER'), null, '大小写变体不猜')
    assertEq(normalizeRole('Him'), null)
    assertEq(normalizeRole('her '), null, '带空白不猜')
    assertEq(normalizeRole(''), null)
    assertEq(normalizeRole(null), null)
    assertEq(normalizeRole(undefined), null)
    assertEq(normalizeRole(1), null)
    assertEq(normalizeRole('female'), null)
  })

  await testCase('A2 normalizeCoupleId 只接受非空字符串', () => {
    assertEq(normalizeCoupleId('CZ-1'), 'CZ-1')
    assertEq(normalizeCoupleId('  CZ-1  '), 'CZ-1', '两端空白应被裁剪')
    assertEq(normalizeCoupleId('   '), null, '纯空白视为无绑定')
    assertEq(normalizeCoupleId(''), null)
    assertEq(normalizeCoupleId(null), null)
    assertEq(normalizeCoupleId(undefined), null)
    assertEq(normalizeCoupleId(0), null, '数字不当作 id')
    assertEq(normalizeCoupleId({}), null)
  })

  // ---- B. 四种状态 ----
  await testCase('B1 已登录 + her + 绑定 → bound / isHer', () => {
    const v = resolveViewer(g('her', 'CZ-1'))
    assertEq(v.state, 'bound')
    assertEq(v.identityReady, true)
    assertEq(v.roleReady, true)
    assertEq(v.bound, true)
    assertEq(v.isHer, true)
    assertEq(v.isHim, false)
    assertEq(v.partnerRole, 'him')
    assertEq(v.canEnterPartnerView, false, 'her 不进伴侣视图')
    assertEq(v.degradeReason, null)
  })

  await testCase('B2 已登录 + him + 绑定 → bound / isHim / 可进伴侣视图', () => {
    const v = resolveViewer(g('him', 'CZ-1'))
    assertEq(v.state, 'bound')
    assertEq(v.isHim, true)
    assertEq(v.isHer, false)
    assertEq(v.partnerRole, 'her')
    assertEq(v.canEnterPartnerView, true)
  })

  await testCase('B3 已登录 + her + 无绑定 → unbound', () => {
    const v = resolveViewer(g('her', null))
    assertEq(v.state, 'unbound')
    assertEq(v.bound, false)
    assertEq(v.isHer, true)
    assertEq(v.canEnterPartnerView, false)
    assertEq(v.degradeReason, 'no-couple')
  })

  await testCase('B4 已登录 + him + 无绑定 → unbound（角色已确认但不可进伴侣视图）', () => {
    const v = resolveViewer(g('him', null))
    assertEq(v.state, 'unbound')
    assertEq(v.isHim, true, '角色本身是可信的')
    assertEq(v.bound, false)
    assertEq(v.canEnterPartnerView, false)
  })

  // ---- C. 伴侣视图门槛（本轮核心）----
  await testCase('C1 仅 role="him" 不足以进入伴侣视图（无有效 coupleId）', () => {
    const cases = [null, undefined, '', '   ', 0, false, {}, []]
    for (const cid of cases) {
      const v = resolveViewer(g('him', cid))
      assertEq(v.canEnterPartnerView, false, 'coupleId=' + JSON.stringify(cid) + ' 不应放行')
    }
  })

  await testCase('C1b 已知限制：工具不校验 coupleId 形态，非空字符串即视为「本地有绑定」', () => {
    // 这不是缺陷，而是刻意的最小实现：客户端无法证明 active。
    // 因此任何非空字符串都会过前置门槛，真正的授权必须由服务端再次确认。
    const v = resolveViewer(g('him', 'not-a-couple-id'))
    assertEq(v.bound, true, '非空字符串按本地绑定认领处理')
    assertEq(v.canEnterPartnerView, true, '前置门槛放行')
    assertEq(v.serverVerified, false, '但必须标记未经服务端复核')
  })

  await testCase('C2 him + 绑定才放行，且明确标记未经服务端复核', () => {
    const v = resolveViewer(g('him', 'CZ-9'))
    assertEq(v.canEnterPartnerView, true)
    assertEq(v.boundSource, 'local')
    assertEq(v.serverVerified, false, '本地 coupleId 不能当作 active 已确认')
  })

  // ---- D. 安全降级 ----
  await testCase('D1 globalData 缺失 → loading，全部角色位 false', () => {
    for (const src of [undefined, null, {}, 'x', 42]) {
      const v = resolveViewer(src)
      assertEq(v.state, 'loading')
      assertEq(v.roleReady, false)
      assertEq(v.isHer, false)
      assertEq(v.isHim, false)
      assertEq(v.bound, false)
      assertEq(v.canEnterPartnerView, false)
      assertEq(v.degradeReason, 'identity-not-ready')
    }
  })

  await testCase('D2 openid 缺失时即便 role/coupleId 齐全也保持 loading', () => {
    const v = resolveViewer({ openid: null, role: 'him', coupleId: 'CZ-1' })
    assertEq(v.state, 'loading')
    assertEq(v.bound, false)
    assertEq(v.canEnterPartnerView, false, '身份未就绪不得放行')
  })

  await testCase('D3 已登录但 role 缺失（历史用户）→ role_unknown', () => {
    const v = resolveViewer({ openid: 'oA', coupleId: 'CZ-1' })
    assertEq(v.state, 'role_unknown')
    assertEq(v.bound, false, '角色未知时不认绑定')
    assertEq(v.canEnterPartnerView, false)
    assertEq(v.degradeReason, 'role-missing')
  })

  await testCase('D4 role 非法值 → role_unknown，不猜角色', () => {
    for (const r of ['HER', 'female', 'boy', '', 0, true]) {
      const v = resolveViewer({ openid: 'oA', role: r, coupleId: 'CZ-1' })
      assertEq(v.state, 'role_unknown', 'role=' + JSON.stringify(r))
      assertEq(v.isHer, false)
      assertEq(v.isHim, false)
      assertEq(v.canEnterPartnerView, false)
    }
  })

  await testCase('D5 openid 纯空白 → 视为未就绪', () => {
    const v = resolveViewer({ openid: '   ', role: 'her', coupleId: 'CZ-1' })
    assertEq(v.state, 'loading')
    assertEq(v.roleReady, false)
  })

  // ---- E. 解绑 / 换绑 ----
  await testCase('E1 解绑后：role 残留 him 但 coupleId 清空 → unbound，不误判', () => {
    // 与 pages/mine/mine.js 的解绑收尾一致（只清 coupleId，不重置 role）
    const v = resolveViewer(g('him', null))
    assertEq(v.role, 'him', '历史 role 不被重置')
    assertEq(v.state, 'unbound')
    assertEq(v.canEnterPartnerView, false)
  })

  await testCase('E2 换绑后角色随新关系：同一人从 him 变为 her 时判定同步翻转', () => {
    const before = resolveViewer(g('him', 'CZ-1'))
    const after = resolveViewer(g('her', 'CZ-2'))
    assertEq(before.isHim, true)
    assertEq(after.isHer, true)
    assertEq(after.isHim, false)
    assertEq(after.canEnterPartnerView, false)
    assertEq(after.coupleId, 'CZ-2', '不沿用旧关系 id')
  })

  await testCase('E3 未开始登录（首屏 race）不会短暂放行伴侣视图', () => {
    const first = resolveViewer({ openid: null, role: null, coupleId: null })
    assertEq(first.canEnterPartnerView, false)
    const later = resolveViewer(g('him', 'CZ-1'))
    assertEq(later.canEnterPartnerView, true)
  })

  // ---- F. viewerFlags 契约 ----
  await testCase('F1 viewerFlags 只暴露固定 6 个字段且与 resolveViewer 一致', () => {
    const f = viewerFlags(g('him', 'CZ-1'))
    const keys = Object.keys(f).sort()
    assertEq(keys.join(','), 'bound,canEnterPartnerView,isHer,isHim,roleReady,viewerState')
    const v = resolveViewer(g('him', 'CZ-1'))
    assertEq(f.viewerState, v.state)
    assertEq(f.roleReady, v.roleReady)
    assertEq(f.isHer, v.isHer)
    assertEq(f.isHim, v.isHim)
    assertEq(f.bound, v.bound)
    assertEq(f.canEnterPartnerView, v.canEnterPartnerView)
  })

  await testCase('F2 viewerFlags 在未加载时全部为 fail-closed 值', () => {
    const f = viewerFlags(undefined)
    assertEq(f.viewerState, 'loading')
    assertEq(f.roleReady, false)
    assertEq(f.isHer, false)
    assertEq(f.isHim, false)
    assertEq(f.bound, false)
    assertEq(f.canEnterPartnerView, false)
  })

  // ---- G. 静态守护 ----
  await testCase('G1 首页与记录页统一通过 utils/viewer-role 读取角色', () => {
    for (const rel of ['pages/home/home.js', 'pages/record/record.js']) {
      const src = read(rel)
      assertOk(src.includes("require('../../utils/viewer-role')"), rel + ' 未引入 viewer-role')
      assertOk(src.includes('viewerFlags('), rel + ' 未使用 viewerFlags')
    }
  })

  await testCase('G2 首页与记录页不做临时角色比较（防止绕过门槛）', () => {
    for (const rel of ['pages/home/home.js', 'pages/record/record.js']) {
      const src = read(rel)
      const bad = [
        "globalData.role ===", 'globalData.role==',
        "=== 'him'", '=== "him"',
        "=== 'her'", '=== "her"'
      ]
      for (const needle of bad) {
        assertOk(src.indexOf(needle) === -1, rel + ' 出现临时角色比较：' + needle)
      }
    }
  })

  await testCase('G3 两个页面的 data 默认值为 fail-closed（未加载即不放行）', () => {
    for (const rel of ['pages/home/home.js', 'pages/record/record.js']) {
      const src = read(rel)
      assertOk(/viewerState:\s*'loading'/.test(src), rel + ' 缺 viewerState 默认值')
      assertOk(/roleReady:\s*false/.test(src), rel + ' 缺 roleReady 默认值')
      assertOk(/isHer:\s*false/.test(src), rel + ' 缺 isHer 默认值')
      assertOk(/isHim:\s*false/.test(src), rel + ' 缺 isHim 默认值')
      assertOk(/bound:\s*false/.test(src), rel + ' 缺 bound 默认值')
      assertOk(/canEnterPartnerView:\s*false/.test(src), rel + ' 缺 canEnterPartnerView 默认值')
    }
  })

  await testCase('G4 工具为纯函数：不引用 wx / getApp（可在 node 下直接单测）', () => {
    const src = read('utils/viewer-role.js')
    assertOk(!/\bwx\./.test(src), '工具不应依赖 wx API')
    assertOk(!/getApp\(/.test(src), '工具不应自行取 app 实例')
  })

  console.log('\n=== 结果: ' + passed + ' PASS / ' + failed + ' FAIL ===')
  if (failures.length) {
    failures.forEach(f => console.log('  - ' + f))
    process.exit(1)
  }
  console.log('Viewer Role: ALL GREEN')
}

runAll().catch(e => { console.error(e); process.exit(1) })
