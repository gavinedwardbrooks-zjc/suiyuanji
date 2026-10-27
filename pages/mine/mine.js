const app = getApp()

// 订阅消息模板 ID 列表（提醒 + 小结），在微信公众平台创建后替换
const SUB_TPLS = ['TEMPLATE_ID_HERE']

function bindErrorMessage(code) {
  return ({
    INVALID_CODE: '绑定码无效或已过期',
    EXPIRED_CODE: '绑定码已过期，请让对方生成新码',
    SELF_BIND: '不能绑定自己的绑定码',
    ALREADY_BOUND: '你当前已有情侣关系',
    PARTNER_ALREADY_BOUND: '对方已有情侣关系',
    RATE_LIMITED: '尝试次数过多，请稍后再试',
    NETWORK_ERROR: '网络异常，请稍后重试'
  })[code] || '绑定失败，请稍后重试'
}

// M1 Binding UI Hotfix：绑定状态机接线（PRD v0.6 §2.2 / §5.2）
// 操作：status（查状态）/ generate（her 生成码）/ claim（输入码）/ confirm（her 同意拒绝）/ cancel（her 取消）
Page({
  data: {
    bindCode: '',
    inputCode: '',
    coupleId: null,
    role: null,
    bound: false,
    pending: null,      // { requestId, state, needsMe }
    statusLoading: true,
    acting: false
  },

  onShow() { this.refresh() },

  refresh() {
    app.whenReady(() => {
      app.globalData.bindCode = null
      this.setData({ statusLoading: true, bindCode: '', pending: null })
      wx.cloud.callFunction({ name: 'bindCouple', data: { action: 'status' } })
        .then(res => {
          const r = res.result || {}
          if (!r.ok) {
            this.setData({ statusLoading: false })
            wx.showToast({ title: '加载失败，请稍后再试', icon: 'none' })
            return
          }
          app.globalData.coupleId = r.coupleId || null
          app.globalData.role = r.role
          app.globalData.bindCode = r.bindCode
          this.setData({
            bindCode: r.bindCode || '',
            coupleId: r.coupleId,
            role: r.role,
            bound: !!r.bound,
            pending: r.pending,
            statusLoading: false
          })
        })
        .catch(err => {
          console.error('LOAD_MINE_STATUS_FAILED', err)
          this.setData({ statusLoading: false })
          wx.showToast({ title: '加载失败，请稍后再试', icon: 'none' })
        })
    })
  },

  onInput(e) { this.setData({ inputCode: e.detail.value }) },

  // 复制自己的绑定码
  copyBindCode() {
    const code = this.data.bindCode
    if (!code) {
      wx.showToast({ title: '请先生成绑定码', icon: 'none' })
      return
    }
    wx.setClipboardData({
      data: code,
      success: () => wx.showToast({ title: '已复制，去发给 TA 吧', icon: 'none' })
    })
  },

  // 输入对方码 → 认领（him 视角或 her 主动输对方码）
  bind() {
    const code = this.data.inputCode.trim()
    if (!code) return
    if (this.data.acting) return
    this.setData({ acting: true })
    wx.cloud.callFunction({ name: 'bindCouple', data: { action: 'claim', code } })
      .then(res => {
        const r = res.result || {}
        if (r.ok) {
          wx.showToast({ title: '已提交，等对方确认', icon: 'none' })
        } else {
          console.error('BIND_FAILED', r.code || 'UNKNOWN', r.msg || '')
          wx.showToast({ title: bindErrorMessage(r.code), icon: 'none' })
        }
        this.setData({ inputCode: '', acting: false })
        this.refresh()
      })
      .catch(() => {
        this.setData({ acting: false })
        wx.showToast({ title: '网络异常，请重试', icon: 'none' })
      })
  },

  unbindCouple() {
    if (this.data.acting) return
    wx.showModal({
      title: '确认解除绑定',
      content: '解除绑定后，你们将无法继续查看彼此的伴侣数据，但已有个人记录不会删除。之后可以重新绑定。',
      cancelText: '取消',
      confirmText: '确认解除',
      success: (res) => {
        if (!res.confirm) return
        this.setData({ acting: true })
        wx.cloud.callFunction({ name: 'bindCouple', data: { action: 'unbind' } })
          .then(result => {
            const r = result.result || {}
            if (r.ok) {
              app.globalData.coupleId = null
              wx.showToast({ title: '已解除绑定', icon: 'success' })
            } else {
              wx.showToast({ title: r.msg || '解除失败', icon: 'none' })
            }
          })
          .catch(err => {
            console.error('UNBIND_FAILED', err && (err.errCode || err.errMsg || err.message || 'unknown'))
            wx.showToast({ title: '解除失败，请重试', icon: 'none' })
          })
          .then(() => { this.setData({ acting: false }); this.refresh() })
      }
    })
  },

  goPrivacy() {
    wx.navigateTo({ url: '/pages/privacy/privacy' })
  },

  // 注销账号：先 preview 展示影响范围 → 用户明确确认 → execute
  deleteAccount() {
    if (this.data.acting) return
    this.setData({ acting: true })
    wx.cloud.callFunction({ name: 'deleteAccount', data: { action: 'preview' } })
      .then(res => {
        this.setData({ acting: false })
        const r = res.result || {}
        if (!r.ok) {
          wx.showToast({ title: r.msg || '加载失败', icon: 'none' })
          return
        }
        const d = r.willDelete || {}
        const parts = [
          '日记 ' + (d.daily_records || 0) + ' 条',
          '心愿 ' + (d.wishes || 0) + ' 条',
          '经期 ' + (d.menstrual || 0) + ' 条',
          '画像 ' + (d.profiles || 0) + ' 条',
          '书籍 ' + (d.books || 0) + ' 本',
          '留言 ' + (d.messages || 0) + ' 条'
        ].join('、')
        const boundNote = r.bound ? '；解除与 TA 的绑定' : ''
        wx.showModal({
          title: '确认注销账号',
          content: '将永久删除你的个人数据（' + parts + '）' + boundNote + '。共享数据（关系、对方留言、周报）因涉及双方只解除绑定、不物理删除。此操作不可撤销，确定继续？',
          cancelText: '再想想',
          confirmText: '确认注销',
          success: (res) => {
            if (!res.confirm) return
            this.setData({ acting: true })
            wx.cloud.callFunction({ name: 'deleteAccount', data: { action: 'execute' } })
              .then(exec => {
                const er = exec.result || {}
                if (er.ok) {
                  app.globalData.coupleId = null
                  wx.showToast({ title: '已注销并删除数据', icon: 'success' })
                  app.silentLogin()
                } else {
                  wx.showToast({ title: er.msg || '注销失败，请重试', icon: 'none' })
                }
              })
              .catch(() => {
                wx.showToast({ title: '网络异常，请重试', icon: 'none' })
              })
              .then(() => { this.setData({ acting: false }); this.refresh() })
          }
        })
      })
      .catch(() => {
        this.setData({ acting: false })
        wx.showToast({ title: '网络异常，请重试', icon: 'none' })
      })
  },

  // her 生成/重置绑定码
  genCode() {
    if (this.data.acting) return
    this.setData({ acting: true })
    wx.cloud.callFunction({ name: 'bindCouple', data: { action: 'generate' } })
      .then(res => {
        const r = res.result || {}
        if (r.ok) {
          this.setData({ bindCode: r.bindCode })
          wx.showToast({ title: '新绑定码已生成', icon: 'none' })
        } else {
          wx.showToast({ title: r.msg || '生成失败', icon: 'none' })
        }
        this.setData({ acting: false })
        this.refresh()
      })
      .catch(() => {
        this.setData({ acting: false })
        wx.showToast({ title: '网络异常，请重试', icon: 'none' })
      })
  },

  // her 同意/拒绝 pending（accept: true/false）
  confirmPending(e) {
    const requestId = this.data.pending && this.data.pending.requestId
    const accept = e.currentTarget.dataset.accept === '1'
    if (!requestId || this.data.acting) return
    this.setData({ acting: true })
    wx.cloud.callFunction({ name: 'bindCouple', data: { action: 'confirm', requestId, accept } })
      .then(res => {
        const r = res.result || {}
        if (r.ok) {
          wx.showToast({ title: accept ? '绑定成功' : '已拒绝', icon: accept ? 'success' : 'none' })
          app.silentLogin()
        } else {
          wx.showToast({ title: r.msg || '操作失败', icon: 'none' })
        }
        this.setData({ acting: false })
        setTimeout(() => this.refresh(), 300)
      })
      .catch(() => {
        this.setData({ acting: false })
        wx.showToast({ title: '网络异常，请重试', icon: 'none' })
      })
  },

  // her 取消自己的 pending（换绑前清理）
  cancelPending() {
    const requestId = this.data.pending && this.data.pending.requestId
    if (!requestId || this.data.acting) return
    this.setData({ acting: true })
    wx.cloud.callFunction({ name: 'bindCouple', data: { action: 'cancel', requestId } })
      .then(res => {
        const r = res.result || {}
        if (r.ok) {
          app.globalData.bindCode = null
          this.setData({ acting: false, bindCode: '', pending: null })
          wx.showToast({ title: '已取消', icon: 'none' })
        } else {
          this.setData({ acting: false })
          wx.showToast({ title: r.msg || '取消失败', icon: 'none' })
        }
        this.refresh()
      })
      .catch(() => {
        this.setData({ acting: false })
        wx.showToast({ title: '网络异常，请重试', icon: 'none' })
        this.refresh()
      })
  },

  authSubscribe() {
    wx.requestSubscribeMessage({
      tmplIds: SUB_TPLS,
      success: () => wx.showToast({ title: '已开启提醒' }),
      fail: () => {}
    })
  }
})
