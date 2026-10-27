const db = wx.cloud.database()

Page({
  data: {
    name: '', author: '', status: 'want', progressPercent: 0, minutes: 0, note: '', saving: false,
    statuses: [{ value: 'want', label: '想读' }, { value: 'reading', label: '在读' }, { value: 'finished', label: '已读' }]
  },
  onName(e) { this.setData({ name: e.detail.value }) },
  onAuthor(e) { this.setData({ author: e.detail.value }) },
  onNote(e) { this.setData({ note: e.detail.value }) },
  onProgress(e) { this.setData({ progressPercent: Number(e.detail.value) || 0 }) },
  onMinutes(e) { this.setData({ minutes: Number(e.detail.value) || 0 }) },
  selectStatus(e) { this.setData({ status: e.currentTarget.dataset.value }) },
  save() {
    if (!this.data.name.trim()) return wx.showToast({ title: '请写下书名', icon: 'none' })
    if (this.data.saving) return
    this.setData({ saving: true })
    db.collection('books').add({
      data: {
        name: this.data.name.trim(),
        author: this.data.author.trim(),
        status: this.data.status,
        progressPercent: Math.max(0, Math.min(100, this.data.progressPercent)),
        minutes: Math.max(0, this.data.minutes),
        note: this.data.note,
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
    }).then(() => wx.navigateBack())
      .catch(() => wx.showToast({ title: '保存失败，请检查网络后重试', icon: 'none' }))
      .finally(() => this.setData({ saving: false }))
  }
})
