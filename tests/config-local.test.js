// ============================================================
// tests/config-local.test.js · 本地私有配置层 + 缺配置 fail-closed
//
// 背景：公开仓库里的 config.js 只有占位符，真实云环境 ID / 模板 ID 来自
// 被 .gitignore 忽略的 config.local.js（模板 config.local.example.js 入库）。
// 本测试守住四件事：
//   A 缺失配置时的行为可诊断（不抛错、不静默、给出修复指引）
//   B 覆盖层生效，且空值不会把默认占位符悄悄抹掉
//   C 结构面无泄漏：占位符文件不含真实环境 ID / AppID，忽略规则到位
//   D app.js 真的在未配置时**拒绝**初始化云能力（fail-closed，不回落默认环境）
//   E 订阅模板 ID 走配置层，未配置时不拿占位符去申请授权
//
// 运行：node tests/config-local.test.js
// ============================================================
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8')

let passed = 0, failed = 0, failures = []
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  PASS  ' + name) }
  else { failed++; failures.push(name + (detail ? ' -> ' + detail : '')); console.log('  FAIL  ' + name + (detail ? ' -> ' + detail : '')) }
}
function eq(name, actual, expected) {
  check(name, actual === expected, '期望 ' + JSON.stringify(expected) + ' 实际 ' + JSON.stringify(actual))
}
const tick = () => new Promise(r => setTimeout(r, 0))

const CONFIG = require('../config')
const { mergeConfig, loadLocal, isCloudEnvReady, subscribeTmplIds, configStatus, configHint } =
  Object.assign({}, CONFIG)

const CONFIG_SRC = read('config.js')
const EXAMPLE_SRC = read('config.local.example.js')
const APP_SRC = read('app.js')
const GITIGNORE = read('.gitignore')

async function main() {
  console.log('\n=== 本地私有配置层 ===\n')

  // ---------------- A. 缺失配置：可诊断，不静默 ----------------
  console.log('--- A 缺失配置的可诊断行为 ---')
  check('A1 config.js 在无 config.local.js 时仍可加载（不抛错）', !!CONFIG && typeof CONFIG === 'object')

  // A2 断言的是**公开文件里的字面量**，不是运行时合并结果。
  // 本地配置填好之后 CONFIG.CLOUD_ENV 必然是真值，用合并值来断言会长期假红。
  const literal = /const DEFAULTS\s*=\s*\{[\s\S]*?CLOUD_ENV:\s*'([^']*)'/.exec(CONFIG_SRC)
  eq('A2 公开 config.js 的默认云环境字面量是占位符', literal && literal[1], 'YOUR_CLOUD_ENV_ID')

  // A2b 合并结果的正确规则：本地有值则用本地值，否则回落占位符。
  // 两态（已配置 / 未配置）都必须成立，这样才真正区分了「字面量」与「合并值」。
  const localState = loadLocal()
  const localEnv = localState.value && typeof localState.value.CLOUD_ENV === 'string'
    ? localState.value.CLOUD_ENV.trim() : ''
  eq('A2b 运行时合并值 = 本地值优先，否则占位符', CONFIG.CLOUD_ENV, localEnv || CONFIG.PLACEHOLDER_CLOUD_ENV)

  check('A3 占位符 / 空串 / YOUR_xxx / 含空格 一律判定未就绪',
    isCloudEnvReady('YOUR_CLOUD_ENV_ID') === false &&
    isCloudEnvReady('') === false &&
    isCloudEnvReady('   ') === false &&
    isCloudEnvReady('YOUR_ANYTHING') === false &&
    isCloudEnvReady('env with space') === false)
  check('A4 合法环境 ID 判定就绪', isCloudEnvReady('suiyuanji-dev-1a2b3c') === true)

  const st = configStatus()
  check('A5 体检快照字段齐备且不含真实值', typeof st.cloudEnvReady === 'boolean' &&
    ['loaded', 'absent', 'invalid'].indexOf(st.localConfig) !== -1 &&
    typeof st.templateIdsReady === 'number')
  check('A6 未配置时 configHint 给出可执行的修复指引',
    CONFIG.isCloudEnvReady(CONFIG.CLOUD_ENV) ? true : /init-local-config|config\.local\.js|CLOUD_ENV/.test(configHint()))
  check('A7 未配置时 app.js 会打印明确错误（console.error + 指引）',
    /console\.error\('\[config\] 云环境 ID 未配置/.test(APP_SRC) && APP_SRC.indexOf('CONFIG.configHint()') !== -1)

  // ---------------- B. 覆盖层 ----------------
  console.log('\n--- B 本地覆盖层 ---')
  const defaults = { CLOUD_ENV: 'YOUR_CLOUD_ENV_ID', SUB_TPL_CHAT: 'TEMPLATE_ID_HERE' }
  const m1 = mergeConfig(defaults, { CLOUD_ENV: 'my-env-001' })
  eq('B1 本地值覆盖默认值', m1.CLOUD_ENV, 'my-env-001')
  eq('B2 未提供的键保留默认值', m1.SUB_TPL_CHAT, 'TEMPLATE_ID_HERE')

  const m2 = mergeConfig(defaults, { CLOUD_ENV: '   ', SUB_TPL_CHAT: '' })
  eq('B3 空白字符串不覆盖默认（避免把默认悄悄抹掉）', m2.CLOUD_ENV, 'YOUR_CLOUD_ENV_ID')
  eq('B4 空字符串不覆盖默认', m2.SUB_TPL_CHAT, 'TEMPLATE_ID_HERE')

  const m3 = mergeConfig(defaults, { CLOUD_ENV: 'v', API_KEY: 'should-be-dropped' })
  check('B5 白名单：未声明的键被丢弃（防止密钥混进 CONFIG）', !('API_KEY' in m3))
  check('B6 不修改传入的 defaults（无副作用）', defaults.CLOUD_ENV === 'YOUR_CLOUD_ENV_ID')
  eq('B7 非对象本地配置被忽略', mergeConfig(defaults, null).CLOUD_ENV, 'YOUR_CLOUD_ENV_ID')

  eq('B8 加载成功 → state=loaded', loadLocal(() => ({ CLOUD_ENV: 'x' })).state, 'loaded')
  const absent = loadLocal(() => { const e = new Error("Cannot find module './config.local'"); e.code = 'MODULE_NOT_FOUND'; throw e })
  eq('B9 文件缺失 → state=absent（预期状态，不抛错）', absent.state, 'absent')
  const invalid = loadLocal(() => { throw new Error('SyntaxError: bad token') })
  eq('B10 内容写错 → state=invalid（必须能被区分出来）', invalid.state, 'invalid')
  eq('B11 导出数组 → state=invalid', loadLocal(() => []).state, 'invalid')
  eq('B12 导出字符串 → state=invalid', loadLocal(() => 'nope').state, 'invalid')

  // ---------------- C. 结构面无泄漏 ----------------
  console.log('\n--- C 结构面与忽略规则 ---')
  check('C1 config.js（跟踪文件）不含真实云环境 ID 形态',
    !/cloud1-[a-z0-9]{6,}/i.test(CONFIG_SRC) && !/tcloudbase\.com/i.test(CONFIG_SRC))
  check('C2 config.js 不含真实 AppID 形态', !/wx[0-9a-f]{16}/i.test(CONFIG_SRC))
  check('C3 config.js 不含服务端密钥赋值形态',
    !/sk-[A-Za-z0-9]{16,}/.test(CONFIG_SRC) &&
    !/API_KEY\s*[:=]\s*['"][^'"]{8,}/.test(CONFIG_SRC) &&
    !/AppSecret\s*[:=]/.test(CONFIG_SRC))

  const exampleValues = EXAMPLE_SRC.match(/:\s*'([^']*)'/g) || []
  check('C4 模板文件所有值都是占位符', exampleValues.length > 0 &&
    exampleValues.every(v => /YOUR_CLOUD_ENV_ID|TEMPLATE_ID_HERE/.test(v)), exampleValues.join(','))

  check('C5 .gitignore 忽略本地配置文件', /^config\.local\.js\s*$/m.test(GITIGNORE))
  check('C6 .gitignore 精确排除旧内部报告', /^\/docs\/OPEN_SOURCE_RELEASE_REPORT\.md\s*$/m.test(GITIGNORE))
  check('C7 模板文件不被忽略（新用户可看到）', !/^config\.local\.example\.js\s*$/m.test(GITIGNORE))
  check('C8 旧内部报告文件仍在本地（未被删除）',
    fs.existsSync(path.join(ROOT, 'docs/OPEN_SOURCE_RELEASE_REPORT.md')))

  // AppID 走 project.private.config.json（官方支持 appid 且优先级更高）
  const pcfg = JSON.parse(read('project.config.json'))
  eq('C9 跟踪的 project.config.json 仍是占位 AppID', pcfg.appid, 'wxYOUR_APPID')
  check('C10 project.private.config.json 已被忽略且不进包',
    /^project\.private\.config\.json\s*$/m.test(GITIGNORE) &&
    JSON.stringify(pcfg.packOptions.ignore).indexOf('project.private.config.json') !== -1)
  check('C11 模板文件不进小程序安装包',
    JSON.stringify(pcfg.packOptions.ignore).indexOf('config.local.example.js') !== -1)
  // 真实 AppID / 云环境 ID 一旦被写回这个**被跟踪**的文件，必须立刻判红
  const pcfgRaw = JSON.stringify(pcfg)
  check('C12 project.config.json 不含真实 AppID 形态', !/wx[0-9a-f]{16}/i.test(pcfgRaw))
  check('C13 project.config.json 不含真实云环境 ID 形态',
    !/cloud1-[a-z0-9]{6,}/i.test(pcfgRaw) && !/tcloudbase\.com/i.test(pcfgRaw))

  // ---------------- D. app.js fail-closed ----------------
  console.log('\n--- D app.js 配置闸口（真实 app.js + 假 wx） ---')
  const originalEnv = CONFIG.CLOUD_ENV

  // D1：未配置 → 不 init、明确失败态
  CONFIG.CLOUD_ENV = CONFIG.PLACEHOLDER_CLOUD_ENV
  let initCalls = []
  let app = loadApp(initCalls)
  app.onLaunch()
  eq('D1 未配置时不调用 wx.cloud.init', initCalls.length, 0)
  eq('D2 未配置时进入 failed 态', app.loginSnapshot().state, 'failed')
  eq('D3 错误码可诊断（cloud_env_missing）', app.loginSnapshot().error, 'cloud_env_missing')
  eq('D4 未配置时不发起登录云调用', app.__calls.length, 0)

  // D2：已配置 → 正常 init + 登录
  CONFIG.CLOUD_ENV = 'suiyuanji-test-env-9f8e7d'
  initCalls = []
  app = loadApp(initCalls)
  try {
    app.onLaunch()
    eq('D5 已配置时用真实环境 ID 初始化', initCalls.length === 1 ? initCalls[0].env : 'init 次数=' + initCalls.length, 'suiyuanji-test-env-9f8e7d')
    await tick()                       // 登录是异步发起的，等一个微任务周期再断言
    check('D6 已配置时才发起登录', app.__calls.length === 1, '实际 ' + app.__calls.length)
  } finally {
    app._clearLoginTimer()
    CONFIG.CLOUD_ENV = originalEnv
  }

  check('D7 源码中不存在「无 env 参数」的 cloud.init（防回落默认环境）',
    !/wx\.cloud\.init\(\s*\)/.test(APP_SRC) && !/wx\.cloud\.init\(\{\s*traceUser/.test(APP_SRC))

  // ---------------- E. 订阅模板走配置层 ----------------
  console.log('\n--- E 订阅模板 ID ---')
  const backup = {}
  for (const k of ['SUB_TPL_REMIND', 'SUB_TPL_SUMMARY', 'SUB_TPL_CHAT', 'SUB_TPL_PERIOD']) backup[k] = CONFIG[k]
  try {
    for (const k of Object.keys(backup)) CONFIG[k] = CONFIG.PLACEHOLDER_TEMPLATE
    eq('E1 全占位符时返回空列表（不拿占位符申请授权）', subscribeTmplIds().length, 0)
    CONFIG.SUB_TPL_CHAT = 'tpl-chat-1'
    CONFIG.SUB_TPL_PERIOD = 'tpl-chat-1'
    CONFIG.SUB_TPL_REMIND = 'tpl-remind-1'
    const ids = subscribeTmplIds()
    eq('E2 已配置的模板去重后进列表', ids.length, 2)
    check('E3 去重且保持声明顺序', ids[0] === 'tpl-remind-1' && ids[1] === 'tpl-chat-1', ids.join(','))
  } finally {
    for (const k of Object.keys(backup)) CONFIG[k] = backup[k]
  }

  const mineSrc = read('pages/mine/mine.js')
  check('E4 mine.js 的订阅模板来自配置层', /CONFIG\.subscribeTmplIds\(\)/.test(mineSrc))
  check('E5 mine.js 未配置时不调用 requestSubscribeMessage（判空在前）',
    mineSrc.indexOf('requestSubscribeMessage') > mineSrc.indexOf('if (!tmplIds.length)'))
  check('E6 mine.js 不再硬编码模板占位符', mineSrc.indexOf("['TEMPLATE_ID_HERE']") === -1)

  // ---------------- 汇总 ----------------
  console.log('\n=== 结果: ' + passed + ' PASS / ' + failed + ' FAIL ===')
  if (failed) {
    for (const f of failures) console.log('  - ' + f)
    process.exitCode = 1
  } else {
    console.log('Config local: ALL GREEN')
  }
}

// ---- 载入真实 app.js（与 p3-login-recovery 同款做法）----
function loadApp(initSink) {
  let cfg = null
  global.App = c => { cfg = c }
  const APP_PATH = path.join(ROOT, 'app.js')
  delete require.cache[APP_PATH]
  require(APP_PATH)
  const inst = {}
  for (const k of Object.keys(cfg)) inst[k] = cfg[k]
  inst.globalData = Object.assign({}, cfg.globalData)
  inst._loginState = 'idle'
  inst._loginError = ''
  inst._loginEpoch = 0
  inst._loginTimer = null
  inst._loginInflight = null
  inst._loginWaiters = []
  const calls = []
  global.wx = {
    cloud: {
      init(o) { if (initSink) initSink.push(o) },
      callFunction: (args) => { calls.push(args); return Promise.resolve({ result: {} }) }
    }
  }
  inst.__calls = calls
  return inst
}

main().catch(e => {
  console.error('测试自身异常：' + (e && e.stack || e))
  process.exitCode = 1
})
