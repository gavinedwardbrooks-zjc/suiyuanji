// ============================================================
// pages/desktop-login-confirm · 电脑登录确认
// 目的：仅确认「是否允许这台电脑登录碎愿集」。
// 安全：sessionId/nonce 只存内存 data，绝不渲染到 WXML；
//       身份由云函数侧 cloud.getWXContext().OPENID 服务端解析，
//       本页不提交、不展示 openid / user_uid / coupleId / role。
// 流程：mine 页 wx.scanCode → 解析 sid+nonce → navigateTo 本页
//       → inspect（仅校验，不 approve）→ 用户点「确认登录」
//       → 调 desktopAuthMiniapp confirm → 桌面轮询到 approved。
// ============================================================

const { parseDesktopLoginResult } = require('../../utils/desktop-qr')

// 云函数返回码 → 页面状态（fail-closed：未知一律按请求异常处理）
const CODE_TO_STATE = {
  SESSION_EXPIRED: 'expired',
  SESSION_NOT_PENDING: 'expired',
  SESSION_NOT_APPROVED: 'expired',
  INVALID_LOGIN_REQUEST: 'invalid'
}

Page({
  data: {
    // state: checking | ready | confirming | confirmed | cancelling | cancelled
    //        | expired | invalid | error
    state: 'checking',
    deviceName: '',
    busy: false
  },

  onLoad(options) {
    const raw = options && options.q
    const parsed = parseDesktopLoginResult(raw)
    if (!parsed.ok) {
      this.setData({ state: 'invalid' })
      return
    }
    this.sessionId = parsed.sessionId
    this.nonce = parsed.nonce
    this.inspect()
  },

  // 仅校验会话是否 pending + 可确认（不 approve，确认必须由用户点击）
  inspect() {
    wx.cloud.callFunction({
      name: 'desktopAuthMiniapp',
      data: { action: 'inspect', sessionId: this.sessionId, nonce: this.nonce }
    }).then(res => {
      const r = res.result || {}
      if (!r.ok || !r.valid) {
        this.setData({ state: CODE_TO_STATE[r.code] || 'error' })
        return
      }
      this.setData({ state: 'ready', deviceName: r.desktopDeviceName || '' })
    }).catch(() => {
      this.setData({ state: 'error' })
    })
  },

  // 用户明确点击「确认登录」后才调用（不扫码即 approve）
  confirmLogin() {
    if (this.data.busy || this.data.state !== 'ready') return
    this.setData({ busy: true, state: 'confirming' })
    wx.cloud.callFunction({
      name: 'desktopAuthMiniapp',
      data: { action: 'confirm', sessionId: this.sessionId, nonce: this.nonce }
    }).then(res => {
      const r = res.result || {}
      if (r.ok && r.approved) {
        this.setData({ state: 'confirmed', busy: false })
      } else {
        this.setData({ state: CODE_TO_STATE[r.code] || 'error', busy: false })
      }
    }).catch(() => {
      this.setData({ state: 'error', busy: false })
    })
  },

  cancelLogin() {
    if (this.data.busy || this.data.state !== 'ready') return
    this.setData({ busy: true, state: 'cancelling' })
    wx.cloud.callFunction({
      name: 'desktopAuthMiniapp',
      data: { action: 'cancel', sessionId: this.sessionId, nonce: this.nonce }
    }).then(res => {
      const r = res.result || {}
      if (r.ok && r.cancelled) {
        this.setData({ state: 'cancelled', busy: false })
      } else {
        this.setData({ state: CODE_TO_STATE[r.code] || 'error', busy: false })
      }
    }).catch(() => {
      this.setData({ state: 'error', busy: false })
    })
  },

  goBack() {
    const pages = getCurrentPages()
    if (pages.length > 1) {
      wx.navigateBack()
    } else {
      wx.reLaunch({ url: '/pages/mine/mine' })
    }
  }
})
