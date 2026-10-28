// ============================================================
// tests/desktop-qr-parse.test.js · Desktop 登录二维码解析契约
// 安全契约（DESKTOP_V2_1_PHASE_1_5 §三）：
//   允许 v / type / scheme / sid / sessionId / nonce
//   禁止 pollSecret / desktopToken / openid / user_uid / coupleId / role
//   未知字段 fail-closed 拒绝
// 运行：node tests/desktop-qr-parse.test.js
// ============================================================
const { parseDesktopLoginResult } = require('../utils/desktop-qr')

let passed = 0, failed = 0, failures = []
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  PASS  ' + name) }
  else { failed++; failures.push(name + (detail ? ' -> ' + detail : '')); console.log('  FAIL  ' + name + (detail ? ' -> ' + detail : '')) }
}

function ok(r) { return r && r.ok === true }
function sid(r) { return r && r.sessionId }
function nonce(r) { return r && r.nonce }

function run() {
  console.log('\n=== Desktop 登录二维码解析契约 ===\n')

  // A. 合法形态（与 auth_start_login 拼接格式一致）
  const a1 = parseDesktopLoginResult('suiyuanji://desktop-login?v=1&sid=dls_abc123&nonce=nc_xyz')
  check('A1 标准 v/sid/nonce → ok', ok(a1) && sid(a1) === 'dls_abc123' && nonce(a1) === 'nc_xyz')

  const a2 = parseDesktopLoginResult('suiyuanji://desktop-login?v=1&sessionId=dls_s2&nonce=n2')
  check('A2 sessionId 别名 → 归一为 sessionId', ok(a2) && sid(a2) === 'dls_s2' && nonce(a2) === 'n2')

  const a3 = parseDesktopLoginResult('suiyuanji://desktop-login?v=1&type=desktop-login&scheme=suiyuanji&sid=s3&nonce=n3')
  check('A3 附带 type/scheme → ok', ok(a3) && sid(a3) === 's3' && nonce(a3) === 'n3')

  const a4 = parseDesktopLoginResult('suiyuanji://desktop-login?v=1&sid=%E4%B8%AD%E6%96%87%E4%BC%9A%E8%AF%9D&nonce=n4')
  check('A4 URL 编码值可解码', ok(a4))

  // B. 非 desktop-login 内容
  const b1 = parseDesktopLoginResult('https://example.com/suiyuanji://desktop-login')
  check('B1 非本站前缀 → NOT_DESKTOP_QR', !ok(b1) && b1.code === 'NOT_DESKTOP_QR')
  const b2 = parseDesktopLoginResult('suiyuanji://other-app?v=1&sid=s&nonce=n')
  check('B2 同 scheme 不同路径 → NOT_DESKTOP_QR', !ok(b2) && b2.code === 'NOT_DESKTOP_QR')
  const b3 = parseDesktopLoginResult('suiyuanji://desktop-login')
  check('B3 无 query → QR_MISSING_FIELDS', !ok(b3) && b3.code === 'QR_MISSING_FIELDS')
  const b4 = parseDesktopLoginResult('suiyuanji://desktop-login#fragment')
  check('B4 非法分隔 → NOT_DESKTOP_QR', !ok(b4) && b4.code === 'NOT_DESKTOP_QR')

  // C. 缺字段 / 协议版本
  const c1 = parseDesktopLoginResult('suiyuanji://desktop-login?v=2&sid=s&nonce=n')
  check('C1 v≠1 → QR_MISSING_FIELDS', !ok(c1) && c1.code === 'QR_MISSING_FIELDS')
  const c2 = parseDesktopLoginResult('suiyuanji://desktop-login?v=1&sid=s')
  check('C2 缺 nonce → QR_MISSING_FIELDS', !ok(c2) && c2.code === 'QR_MISSING_FIELDS')
  const c3 = parseDesktopLoginResult('suiyuanji://desktop-login?v=1&nonce=n')
  check('C3 缺 sid/sessionId → QR_MISSING_FIELDS', !ok(c3) && c3.code === 'QR_MISSING_FIELDS')

  // D. 禁止字段（安全契约核心）
  const forbidden = ['pollSecret', 'desktopToken', 'openid', 'user_uid', 'coupleId', 'role', 'secret', 'token', 'uid']
  for (const f of forbidden) {
    const r = parseDesktopLoginResult('suiyuanji://desktop-login?v=1&sid=s&nonce=n&' + f + '=evil')
    check('D 含禁止字段 ' + f + ' → QR_FORBIDDEN_FIELD', !ok(r) && r.code === 'QR_FORBIDDEN_FIELD')
  }

  // E. 未知字段 fail-closed
  const e1 = parseDesktopLoginResult('suiyuanji://desktop-login?v=1&sid=s&nonce=n&extra=1')
  check('E1 未知字段 → QR_FORBIDDEN_FIELD', !ok(e1) && e1.code === 'QR_FORBIDDEN_FIELD')

  // F. 重复 key fail-closed
  const f1 = parseDesktopLoginResult('suiyuanji://desktop-login?v=1&sid=s&sid=s2&nonce=n')
  check('F1 重复 key → QR_FORBIDDEN_FIELD', !ok(f1) && f1.code === 'QR_FORBIDDEN_FIELD')

  // G. 长度上限
  const g1 = parseDesktopLoginResult('suiyuanji://desktop-login?v=1&sid=' + 'x'.repeat(257) + '&nonce=n')
  check('G1 sessionId 超长 → QR_MISSING_FIELDS', !ok(g1) && g1.code === 'QR_MISSING_FIELDS')
  const g2 = parseDesktopLoginResult('suiyuanji://desktop-login?v=1&sid=s&nonce=' + 'y'.repeat(513))
  check('G2 nonce 超长 → QR_MISSING_FIELDS', !ok(g2) && g2.code === 'QR_MISSING_FIELDS')

  // H. 非字符串 / 空
  const h1 = parseDesktopLoginResult(null)
  check('H1 null → NOT_DESKTOP_QR', !ok(h1) && h1.code === 'NOT_DESKTOP_QR')
  const h2 = parseDesktopLoginResult(123)
  check('H2 非字符串 → NOT_DESKTOP_QR', !ok(h2) && h2.code === 'NOT_DESKTOP_QR')

  console.log('\n=== 结果: ' + passed + ' PASS / ' + failed + ' FAIL ===')
  if (failures.length) {
    failures.forEach(f => console.log('  - ' + f))
    process.exit(1)
  }
  console.log('Desktop QR Parse: ALL GREEN')
}

run()
