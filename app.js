// ============================================================
// 碎愿集 · 全局入口
// 配置统一收口在 config.js（PRD v0.6 §4.1 B3）
// ============================================================
const CONFIG = require('./config')

// ============================================================
// 登录状态机（V1.1 · P3.0）
//
// 旧实现的缺陷：whenReady 用 setInterval 轮询 globalData.openid，8 秒后
// 只是 clearInterval —— 回调**永远不会执行**。登录失败（断网、云函数报错）
// 时页面就一直停在「正在确认身份…」，用户没有任何自救入口。
//
// 新实现的三条约束：
//   1. 状态显式化：idle / loading / ready / failed / timeout，页面据此渲染
//      中性加载态或「可重试的错误态」，绝不因为失败而回落到记录方表单。
//   2. 单调 epoch：每次登录尝试递增；旧请求晚于新请求返回时一律丢弃，
//      绝不覆盖新身份（换账号、重试连点都靠它）。
//   3. 超时是**明确的失败态**，不是假成功：不伪造 openid，不猜角色。
//      （超时后如果那次请求其实成功了，仍会正常升级为 ready —— 那是真实结果，
//       不是延时兜底；页面靠 whenReady 的回调拿到它。）
//
// whenReady(cb) 的语义保持不变：**只在拿到 openid 时回调**，
// 因此 mine / ours / home / record 等既有页面的行为不受影响。
// ============================================================
const LOGIN_IDLE = 'idle'
const LOGIN_LOADING = 'loading'
const LOGIN_READY = 'ready'
const LOGIN_FAILED = 'failed'
const LOGIN_TIMEOUT = 'timeout'

const LOGIN_TIMEOUT_MS = 8000
// 等待者上限：页面每次 onShow 都可能登记一次，登录长期失败时避免无限堆积。
// 超出后丢弃最早的（页面下次 onShow 会重新登记）。
const LOGIN_WAITER_LIMIT = 20

App({
  globalData: {
    openid: null,
    role: null,        // 'her' | 'him'：情侣双方的两个位置，不绑定性别
    coupleId: null,
    nickName: '',
    partnerName: '',   // 我给 TA 的称呼（自定义，空 = 通用「TA」）
    avatarUrl: '',
    bindCode: null
  },

  // ---- 登录态（刻意不放进 globalData：避免与 openid/role 混用）----
  _loginState: LOGIN_IDLE,
  _loginError: '',
  _loginEpoch: 0,
  _loginTimer: null,
  _loginInflight: null,
  _loginWaiters: [],

  onLaunch() {
    if (!wx.cloud) {
      console.error('请使用 2.2.3 或以上的基础库以使用云能力')
      // 没有云能力 = 永远不可能登录成功 → 直接进入可重试的失败态，
      // 让页面显示明确错误，而不是永久「正在确认身份…」
      this._loginState = LOGIN_FAILED
      this._loginError = 'no_cloud'
      return
    }
    // 配置闸口（fail-closed）：CLOUD_ENV 仍是占位符时**不**初始化云能力。
    // 绝不省略 env 参数让微信回落到「默认环境」—— 那可能静默连到不属于本项目的
    // 线上环境。宁可停在可诊断的失败态，也不猜。
    if (!CONFIG.isCloudEnvReady(CONFIG.CLOUD_ENV)) {
      console.error('[config] 云环境 ID 未配置，已拒绝初始化云能力。' + CONFIG.configHint())
      this._loginState = LOGIN_FAILED
      this._loginError = 'cloud_env_missing'
      return
    }
    wx.cloud.init({ env: CONFIG.CLOUD_ENV, traceUser: true })
    this.silentLogin()
  },

  // 静默登录：拿 openid，并建立/读取用户档案。
  // · 并发调用复用同一个在途请求（避免重复登录、重复回调）
  // · 已登录后再次调用 = 主动刷新身份（首页/记录页收到 NOT_ACTIVE 时会用），
  //   会真的重新向服务端确认，不会被去重逻辑吞掉。
  silentLogin() {
    if (this._loginState === LOGIN_LOADING && this._loginInflight) return this._loginInflight
    return this._startLogin()
  },

  // 用户主动「重试」：总是发起新的一次尝试（旧的在途请求会被 epoch 作废）
  retryLogin() {
    return this._startLogin()
  },

  // 给页面使用的：等待登录完成（只在拿到 openid 时回调，与旧语义一致）
  // 失败/超时不会回调 —— 页面用 loginSnapshot() 判断要不要显示错误与重试按钮。
  whenReady(cb) {
    if (typeof cb !== 'function') return
    if (this.globalData.openid) return cb(this.globalData)
    if (this._loginWaiters.length >= LOGIN_WAITER_LIMIT) this._loginWaiters.shift()
    this._loginWaiters.push(cb)
  },

  // 供页面渲染用的只读快照
  loginSnapshot() {
    const state = this._loginState
    return {
      state,
      error: this._loginError,
      ok: state === LOGIN_READY,
      settled: state === LOGIN_READY || state === LOGIN_FAILED || state === LOGIN_TIMEOUT,
      // 「可重试」只针对失败/超时；角色缺失（role_unknown）不属于登录失败
      canRetry: state === LOGIN_FAILED || state === LOGIN_TIMEOUT,
      hasIdentity: !!this.globalData.openid
    }
  },

  // ---- 内部实现 ----
  _startLogin() {
    const epoch = this._loginEpoch + 1
    this._loginEpoch = epoch
    this._loginState = LOGIN_LOADING
    this._loginError = ''
    this._clearLoginTimer()
    this._loginTimer = setTimeout(() => { this._onLoginTimeout(epoch) }, LOGIN_TIMEOUT_MS)

    const call = () => wx.cloud.callFunction({ name: 'login' })
    const p = Promise.resolve()
      .then(call)
      .then(
        res => { this._applyLogin(epoch, res && res.result) },
        err => {
          console.error('login failed', err)
          this._failLogin(epoch, 'network')
        }
      )
      .then(() => {
        if (this._loginInflight === p) this._loginInflight = null
        return this.loginSnapshot()
      })

    this._loginInflight = p
    return p
  },

  _clearLoginTimer() {
    if (this._loginTimer) {
      clearTimeout(this._loginTimer)
      this._loginTimer = null
    }
  },

  // 超时：进入明确的失败态（不伪造身份、不回调等待者）
  _onLoginTimeout(epoch) {
    this._loginTimer = null
    if (epoch !== this._loginEpoch) return       // 已有更新的尝试 → 忽略
    if (this._loginState !== LOGIN_LOADING) return
    this._loginState = LOGIN_TIMEOUT
    this._loginError = 'timeout'
  },

  // 登录失败：网络异常 / 未拿到 openid
  _failLogin(epoch, reason) {
    if (epoch !== this._loginEpoch) return false  // 旧请求 → 丢弃
    this._clearLoginTimer()
    this._loginState = LOGIN_FAILED
    this._loginError = reason || 'unknown'
    return false
  },

  // 登录成功：只有仍是当前 epoch 时才落地
  _applyLogin(epoch, r) {
    if (epoch !== this._loginEpoch) return false  // 旧请求晚到 → 不覆盖新身份
    const openid = r && typeof r.openid === 'string' ? r.openid.trim() : ''
    if (!openid) return this._failLogin(epoch, 'no_openid')
    Object.assign(this.globalData, {
      openid,
      role: r.role,
      coupleId: r.coupleId,
      nickName: r.nickName,
      partnerName: r.partnerName || '',
      avatarUrl: r.avatarUrl,
      bindCode: r.bindCode
    })
    this._loginState = LOGIN_READY
    this._loginError = ''
    this._clearLoginTimer()
    this._flushLoginWaiters()
    return true
  },

  _flushLoginWaiters() {
    const list = this._loginWaiters
    this._loginWaiters = []
    for (let i = 0; i < list.length; i++) {
      try {
        list[i](this.globalData)
      } catch (e) {
        // 单个页面的回调异常不得影响其他等待者（否则一个页面出错会连累全部）
        console.error('whenReady callback failed', e)
      }
    }
  }
})

module.exports = { LOGIN_IDLE, LOGIN_LOADING, LOGIN_READY, LOGIN_FAILED, LOGIN_TIMEOUT }
