// pages/travel-detail/travel-detail.js · M8 地点/行程详情 + 编辑 + AI 重新生成
const app = getApp()

function genRequestId() {
  return 'req_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10)
}
const PERIOD_LABEL = { morning: '上午', noon: '中午', afternoon: '下午', evening: '晚上' }

Page({
  data: {
    id: '',
    place: null,
    notFound: false,
    editing: false,
    draftIntro: '',
    draftHighlights: '',
    draftPlanDays: '',
    draftTips: '',
    saving: false,
    generating: false,
    error: '',
    periodLabel: PERIOD_LABEL
  },

  onLoad(q) {
    this.setData({ id: q.id || '' })
    this.load()
  },

  load() {
    wx.cloud.callFunction({ name: 'lifePlanner', data: { action: 'getTravelPlace', placeId: this.data.id } })
      .then(res => {
        const r = res.result || {}
        if (r.ok && r.place) {
          const p = r.place
          this.setData({ place: p, notFound: false })
          this.initDraft(p)
        } else {
          this.setData({ notFound: true })
        }
      })
      .catch(() => this.setData({ notFound: true }))
  },

  initDraft(p) {
    this.setData({
      draftIntro: p.shortIntro || '',
      draftHighlights: (p.highlights || []).join('\n'),
      draftPlanDays: this.serializeDays(p.plan && p.plan.days || []),
      draftTips: (p.plan && p.plan.tips || []).join('\n')
    })
  },

  // days → 文本：Day 1 | 标题 | 时段：标题（描述）
  serializeDays(days) {
    return days.map(d => {
      const head = `Day ${d.day} | ${d.title}`
      const items = (d.items || []).map(it => `${PERIOD_LABEL[it.period] || it.period}：${it.title}（${it.description}）`)
      return [head, ...items].join('\n')
    }).join('\n\n')
  },

  // 文本 → days（服务端校验结构）
  parseDays(text) {
    const blocks = String(text || '').split(/\n\s*\n/).filter(Boolean)
    return blocks.map((block, i) => {
      const lines = block.split('\n').filter(Boolean)
      const dayMatch = /^Day\s*(\d+)/i.exec(lines[0])
      const title = dayMatch ? lines[0].replace(/^Day\s*\d+\s*[|\-]?\s*/i, '') : lines[0]
      const day = dayMatch ? Number(dayMatch[1]) : i + 1
      const items = lines.slice(1).map(l => {
        const m = /^(上午|中午|下午|晚上)[：:]\s*(.+?)(?:（(.*)）)?$/.exec(l)
        if (!m) return null
        const periodMap = { 上午: 'morning', 中午: 'noon', 下午: 'afternoon', 晚上: 'evening' }
        return { period: periodMap[m[1]], title: m[2], description: m[3] || '' }
      }).filter(Boolean)
      return { day, title, items }
    }).filter(d => d.items.length)
  },

  enterEdit() {
    const p = this.data.place
    this.setData({
      editing: true,
      draftIntro: p.shortIntro || '',
      draftHighlights: (p.highlights || []).join('\n'),
      draftPlanDays: this.serializeDays(p.plan && p.plan.days || []),
      draftTips: (p.plan && p.plan.tips || []).join('\n')
    })
  },
  cancelEdit() { this.setData({ editing: false }); this.initDraft(this.data.place) },

  onIntro(e) { this.setData({ draftIntro: e.detail.value }) },
  onHighlights(e) { this.setData({ draftHighlights: e.detail.value }) },
  onPlanDays(e) { this.setData({ draftPlanDays: e.detail.value }) },
  onTips(e) { this.setData({ draftTips: e.detail.value }) },

  save() {
    if (this.data.saving) return
    const highlights = this.data.draftHighlights.split('\n').map(s => s.trim()).filter(Boolean)
    const plan = {
      title: this.data.place.plan && this.data.place.plan.title || '旅行计划',
      days: this.parseDays(this.data.draftPlanDays),
      tips: this.data.draftTips.split('\n').map(s => s.trim()).filter(Boolean)
    }
    if (!highlights.length || !plan.days.length) {
      wx.showToast({ title: '亮点和计划不能为空', icon: 'none' })
      return
    }
    this.setData({ saving: true })
    wx.cloud.callFunction({
      name: 'lifePlanner',
      data: {
        action: 'saveTravelPlace',
        placeId: this.data.id,
        shortIntro: this.data.draftIntro,
        highlights, plan,
        requestId: genRequestId(),
        revision: this.data.place.revision || 1
      }
    }).then(res => {
      const r = res.result || {}
      this.setData({ saving: false })
      if (r.ok) {
        wx.showToast({ title: '已保存' })
        this.setData({ editing: false })
        this.load()
      } else if (r.code === 'REV_CONFLICT') {
        wx.showModal({
          title: '内容已被更新',
          content: '这份计划在别处被修改过。重新加载最新内容？',
          confirmText: '重新加载',
          success: m => { if (m.confirm) this.load() }
        })
      } else {
        wx.showToast({ title: r.msg || '保存失败', icon: 'none' })
      }
    }).catch(() => this.setData({ saving: false }))
  },

  regenerate() {
    if (this.data.generating) return
    wx.showModal({
      title: 'AI 重新生成',
      content: 'AI 会重新生成当前旅行计划，并覆盖编辑框中的内容。是否继续？',
      confirmText: '继续',
      cancelText: '取消',
      success: m => {
        if (!m.confirm) return
        this.setData({ generating: true, error: '' })
        wx.cloud.callFunction({ name: 'lifePlanner', data: { action: 'regenerateTravelPlace', placeId: this.data.id } })
          .then(res => {
            const r = res.result || {}
            this.setData({ generating: false })
            if (r.ok && r.draft) {
              // AI 成功 → 只进编辑预览，确认保存后才落库
              this.setData({
                editing: true,
                draftPlanDays: this.serializeDays(r.draft.days),
                draftTips: (r.draft.tips || []).join('\n')
              })
              wx.showToast({ title: 'AI 已生成，确认后保存', icon: 'none' })
            } else {
              this.setData({ error: r.msg || 'AI 生成失败，已保留原计划' })
            }
          })
          .catch(() => this.setData({ generating: false, error: 'AI 生成失败，已保留原计划' }))
      }
    })
  }
})
