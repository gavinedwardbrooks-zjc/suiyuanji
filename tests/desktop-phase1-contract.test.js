// DESKTOP_V2_1_PRODUCT_PHASE_1 · 本地静态契约
// 覆盖：登录流程 UI/Rust 接线、二维码内容边界、token 不落前端、
//       daily 业务命令、desktopDaily 云函数安全面、窗口能力保留、用户文案/空状态。
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const ROOT = path.resolve(__dirname, '..')
const read = p => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8')
// 私人标识守卫（样本由码点构造，源码无明文）
const {
  PRIVATE_TERMS, findPrivateLeaks, describeTerm, listPublishableFiles, isBinary
} = require('./private-terms')

const appTsx = read('desktop/src/App.tsx')
const appCss = read('desktop/src/App.css')
const libRs = read('desktop/src-tauri/src/lib.rs')
const indexHtml = read('desktop/index.html')
const transportRs = read('desktop/src-tauri/src/auth_transport.rs')
const dailyFn = read('cloudfunctions/desktopDaily/index.js')

function test(name, fn) {
  try { fn(); console.log('#   PASS ', name) } catch (e) { console.error('#   FAIL ', name, '\n', e.message); process.exitCode = 1 }
}

console.log('# === Desktop V2.1 Product Phase 1 · 契约测试 ===')

// ---- Auth 命令接线 ----
test('AUTH_COMMANDS_WIRED', () => {
  assert.match(libRs, /auth_start_login/)
  assert.match(libRs, /auth_login_status/)
  assert.match(libRs, /auth_login_consume/)
  assert.match(libRs, /auth_session_state/)
  assert.match(libRs, /auth_logout/)
  for (const c of ['auth_start_login', 'auth_login_status', 'auth_login_consume', 'auth_session_state', 'auth_logout']) {
    assert.ok(libRs.includes(c), c)
  }
})
test('AUTH_STATE_MANAGED', () => {
  assert.match(libRs, /\.manage\(build_auth_state\(\)\)/)
  assert.ok(!/localStorage/.test(libRs), 'Rust 无 localStorage 概念')
})
test('AUTH_UI_REQUEST_CONTRACT', () => {
  assert.match(appTsx, /invoke<LoginResult>\("auth_start_login"\)/)
  assert.match(appTsx, /invoke<string>\("auth_login_status"\)/)
  assert.match(appTsx, /invoke\("auth_login_consume"\)/)
  assert.match(appTsx, /invoke<string>\("auth_session_state"\)/)
  assert.match(appTsx, /invoke\("auth_logout"\)/)
})
test('NO_HARDCODED_PRODUCTION_ENDPOINT', () => {
  // 脱敏回归：源码里不得再出现真实云环境端点 / AppID，配置只能从外部注入。
  assert.ok(!/cloud1-[a-z0-9]+/i.test(libRs), 'lib.rs 不得硬编码真实云环境 ID')
  assert.ok(!/tcloudbase\.com/i.test(libRs), 'lib.rs 不得硬编码真实云端点')
  assert.ok(!/wx[0-9a-f]{16}/i.test(libRs), 'lib.rs 不得硬编码 AppID')
  assert.match(libRs, /DESKTOP_AUTH_BASE_URL/, '必须支持环境变量注入基址')
  assert.match(libRs, /desktop\.config\.json/, '必须支持同目录配置文件注入基址')
  // 未配置时必须 fail-closed（空串 → endpoint() 直接拒绝）
  assert.match(transportRs, /trimmed\.is_empty\(\)/, 'endpoint 必须对空基址返回错误')
})
test('NO_PRIVATE_NICKNAME', () => {
  // 私人称呼不得进入公开仓库。
  // 匹配样本由 Unicode 码点运行时构造（见 tests/private-terms.js），
  // 本文件里不出现明文——否则守卫自己就成了泄漏点。
  const ROOT = path.resolve(__dirname, '..')
  const focus = [
    ['desktop/src/App.tsx', appTsx],
    ['desktop/src-tauri/src/lib.rs', libRs],
    ['desktop/src-tauri/tauri.conf.json', read('desktop/src-tauri/tauri.conf.json')],
    ['utils/desktop-qr.js', read('utils/desktop-qr.js')],
    ['pages/desktop-login-confirm/desktop-login-confirm.wxml', read('pages/desktop-login-confirm/desktop-login-confirm.wxml')]
  ]
  for (const [label, src] of focus) {
    const hits = findPrivateLeaks(src)
    assert.ok(hits.length === 0, label + ' 出现私人标识: ' + hits.join(' / '))
  }

  // 全量兜底：凡是「一旦提交就会公开」的文件都不许有
  const offenders = []
  for (const rel of listPublishableFiles(ROOT)) {
    if (isBinary(rel)) continue
    let text
    try { text = fs.readFileSync(path.join(ROOT, rel), 'utf8') } catch (e) { continue }
    const hits = findPrivateLeaks(text)
    if (hits.length) offenders.push(rel + ' [' + hits.join(' / ') + ']')
  }
  assert.ok(offenders.length === 0, '公开文件出现私人标识: ' + offenders.join('; '))
})
test('NO_PRIVATE_NICKNAME_DETECTOR_SELFTEST', () => {
  // 守卫的守卫：证明检测器没有退化成恒真（否则上一条断言毫无意义）。
  // 正向控制：把历史品牌「注入」样本，必须被抓到。
  for (const term of PRIVATE_TERMS) {
    const hits = findPrivateLeaks('<h1>' + term + '</h1>')
    assert.ok(hits.length === 1, '注入 ' + describeTerm(term) + ' 后检测器必须命中')
    assert.strictEqual(hits[0], describeTerm(term), '命中标签必须可追溯且有码点')
  }
  // 反向控制：脱敏后的真实写法不得误报。
  assert.deepStrictEqual(findPrivateLeaks('suiyuanji://desktop-login?v=1&sid=s&nonce=n'), [])
  assert.deepStrictEqual(findPrivateLeaks('碎愿集 · Desktop'), [])
  assert.deepStrictEqual(findPrivateLeaks(''), [])
})
test('NO_PRIVATE_NICKNAME_SCOPE', () => {
  // 排除 `.local/` 只能收窄**扫描范围**，不许削弱**检测强度**。
  // 用临时构造的仓库把四条边界钉死，避免以后有人用「反正被忽略了」当借口一路放宽。
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'syj-guard-scope-'))
  const term = PRIVATE_TERMS[0]                    // 明文只在运行时存在
  const write = (rel, text) => {
    const abs = path.join(root, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, text, 'utf8')
  }
  try {
    write('.gitignore', '/.local/\n')
    write('.local/reports/round-report.md', 'C:\\Users\\admin\\Desktop\\' + term + '\\app.js\n')
    write('config.js', 'module.exports = {}\n')
    write('README.md', '# doc\n')
    write('tests/sample.test.js', 'module.exports = 1\n')

    // 1) 忽略规则在场：.local/ 整体不参与扫描，源码/测试/文档照扫
    const listed = listPublishableFiles(root)
    assert.ok(!listed.some(rel => rel === '.local' || rel.startsWith('.local/')),
      '.local/ 不应进入可发布文件列表: ' + listed.filter(r => r.startsWith('.local')).join(','))
    for (const must of ['config.js', 'README.md', 'tests/sample.test.js']) {
      assert.ok(listed.indexOf(must) !== -1, must + ' 必须仍被扫描')
    }

    // 2) 检测器本身没有被削弱：.local 里的内容照样能抓到（只是没被枚举）
    const localHits = findPrivateLeaks(fs.readFileSync(path.join(root, '.local/reports/round-report.md'), 'utf8'))
    assert.ok(localHits.length === 1, '检测器对 .local 内容必须仍然命中')

    // 3) 同一字样出现在 tests/ 下 → 会被枚举 + 会被抓 = 真实回归会被判红
    write('tests/leak.test.js', 'const n = "' + term + '"\n')
    const listed2 = listPublishableFiles(root)
    assert.ok(listed2.indexOf('tests/leak.test.js') !== -1, 'tests/ 下的文件必须被枚举')
    assert.ok(findPrivateLeaks(fs.readFileSync(path.join(root, 'tests/leak.test.js'), 'utf8')).length === 1,
      'tests/ 下出现私人标识必须被抓到')

    // 4) 忽略规则被删掉 → 自动恢复严格扫描（fail-closed 回更严的一侧）
    write('.gitignore', '# 规则被人删了\n')
    const listed3 = listPublishableFiles(root)
    assert.ok(listed3.indexOf('.local/reports/round-report.md') !== -1,
      '缺少 /.local/ 忽略规则时必须重新扫描 .local（否则排除就是绕过守卫的后门）')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }

  // 5) 真实仓库现状：.local/ 被跳过，但被跟踪的源码/测试/文档一个都没漏
  const real = listPublishableFiles(ROOT)
  assert.ok(!real.some(rel => rel.startsWith('.local/')), '真实仓库的 .local/ 不应被扫描')
  for (const must of ['app.js', 'app.json', 'config.js', 'project.config.json',
    'desktop/src/App.tsx', 'tests/private-terms.js', 'tests/config-local.test.js', 'README.md']) {
    assert.ok(real.indexOf(must) !== -1, must + ' 必须仍在扫描范围内')
  }
})
test('QR_PAYLOAD_PUBLIC_ONLY', () => {
  // Rust 组装二维码：只含 sessionId + nonce；不得含 pollSecret / token / openid / user_uid
  assert.match(libRs, /suiyuanji:\/\/desktop-login\?v=1&sid=\{session_id\}&nonce=\{nonce\}/)
  const qrLine = libRs.split('\n').find(l => l.includes('qr_text ='))
  assert.ok(qrLine, 'qr_text 组装存在')
  assert.ok(!qrLine.includes('poll') && !qrLine.includes('token') && !qrLine.includes('openid') && !qrLine.includes('user_uid'))
})
test('POLL_SECRET_AND_TOKEN_RUST_ONLY', () => {
  // 前端不得出现 desktopToken/pollSecret 存取
  assert.ok(!/desktopToken|pollSecret/.test(appTsx), 'App.tsx 不接触 token/secret')
  assert.ok(!/localStorage\.setItem\([^)]*[Tt]oken/.test(appTsx))
  // Rust 中 pollSecret 注释明确不返回前端
  assert.match(transportRs, /pub fn require_token/)
})
test('AUTH_PENDING_APPROVED_CONSUME_FLOW', () => {
  assert.match(appTsx, /status === "approved"/)
  assert.match(appTsx, /status === "cancelled"/)
  assert.match(appTsx, /status === "expired"/)
  assert.match(appTsx, /setPhase\("authenticated"\)/)
})
test('LOGIN_UI_PRESENT', () => {
  assert.match(appTsx, /使用微信登录/)
  assert.match(appTsx, /扫码登录/)
  assert.match(appTsx, /重新生成/)
  assert.ok(!/用户名|邮箱登录|手机号登录|password/i.test(appTsx))
})
test('NO_IDENTITY_FIELD_DISPLAY', () => {
  assert.ok(!/OPENID|openid|desktopToken|pollSecret|user_uid/.test(appTsx), 'UI 不展示身份/secret 字段')
})

// ---- 业务命令与窗口能力 ----
test('DAILY_COMMANDS_WIRED', () => {
  assert.match(libRs, /fn daily_get/)
  assert.match(libRs, /fn daily_save/)
  assert.match(libRs, /daily_get,/)
  assert.match(libRs, /daily_save/)
})
test('WINDOW_NATIVE_FEATURES_PRESERVED', () => {
  assert.match(libRs, /SetLayeredWindowAttributes/)
  assert.match(libRs, /set_current_window_opacity/)
  assert.match(libRs, /desktop-ui-ready/)
  assert.match(libRs, /tauri_plugin_window_state/)
  assert.match(appTsx, /desktop-ui-ready/)
  assert.match(appTsx, /set_current_window_opacity/)
  assert.match(appTsx, /setAlwaysOnTop/)
  assert.match(appCss, /slider|chip|presets/)
})
// 回归守卫：desktop-ui-ready 在开发模式下会被 React StrictMode 投递两次，
// 用 once 注册会命中 tauri listener 的一次性通道断言并 panic。
test('UI_READY_DUPLICATE_SAFE', () => {
  assert.ok(!/\.once\(\s*"desktop-ui-ready"/.test(libRs), 'desktop-ui-ready 不得用 once 注册')
  assert.match(libRs, /listen\("desktop-ui-ready"/, 'desktop-ui-ready 必须用 listen 注册')
  assert.match(libRs, /AtomicBool/, '必须用原子标志忽略重复投递')
})
// 回归守卫：100% 不透明时不得给窗口加 WS_EX_LAYERED（WebView2 分层合成有整窗黑屏风险）
test('LAYERED_ONLY_WHEN_TRANSLUCENT', () => {
  assert.match(libRs, /clamped >= 0\.999 && !already_layered/, '100% 不透明必须跳过 layered')
  assert.match(libRs, /GetWindowLongW/, '扩展样式必须读取，不能用 SetWindowLongW(.., 0) 反取')
})
// 回归守卫：JS 加载失败时窗口必须可读，而不是空白
test('STATIC_BOOT_FALLBACK_PRESENT', () => {
  assert.match(indexHtml, /id="root"[\s\S]*正在启动碎愿集/, '#root 内必须有静态启动兜底')
})
test('SAVE_LOADING_AND_DOUBLE_SUBMIT', () => {
  assert.match(appTsx, /if \(saving\) return/)
  assert.match(appTsx, /disabled=\{saving\}/)
  assert.match(appTsx, /finally \{[\s\S]*setSaving\(false\)/)
})
test('USER_FRIENDLY_ERRORS', () => {
  assert.match(appTsx, /加载失败，请稍后重试/)
  assert.match(appTsx, /保存失败，请稍后重试/)
  assert.match(appTsx, /连接服务失败，请稍后重试/)
})
test('EMPTY_STATE_AND_REV_CONFLICT_UI', () => {
  assert.match(appTsx, /还没有小事，记一件吧/)
  assert.match(appTsx, /REV_CONFLICT/)
  assert.match(appTsx, /这份记录在别处被修改过/)
})

// ---- desktopDaily 云函数安全面 ----
test('DAILY_AUTHORITY_BEARER_ONLY', () => {
  assert.match(dailyFn, /Bearer [^\s]+\$/)
  assert.match(dailyFn, /validateDesktopSession/)
  assert.ok(!/event\.openid|event\.user_uid|event\.coupleId|event\.role/.test(dailyFn), '不信任客户端身份字段')
  assert.match(dailyFn, /users/ )
})
test('DAILY_FIELD_MERGE_ONLY_GOALS_TODOS', () => {
  // 只写 goals/todos；不写 segments/mood/wishes/score/readProgress
  const saveBlock = dailyFn.split('if (action === \'save\')')[1]
  assert.ok(saveBlock)
  assert.match(saveBlock, /goals,\s*todos,\s*revision:/)
  assert.ok(!/segments|mood|wishes|readProgress|score:/.test(saveBlock.split('return response')[0]), 'save 不覆盖其他业务字段')
})
test('DAILY_REVISION_AND_IDEMPOTENT', () => {
  assert.match(dailyFn, /lastRequestId === requestId/)
  assert.match(dailyFn, /REV_CONFLICT/)
  assert.match(dailyFn, /revision: clientRevision/)
})
test('DAILY_HTTP_HANDLER_SHAPE', () => {
  assert.match(dailyFn, /httpMethod/)
  assert.match(dailyFn, /METHOD_NOT_POST/)
  assert.match(dailyFn, /BODY_TOO_LARGE/)
  assert.match(dailyFn, /INVALID_JSON/)
})

console.log('# === Contract Tests Done ===')
