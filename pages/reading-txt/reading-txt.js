// ============================================================
// pages/reading-txt/reading-txt.js · 本机 TXT 内置阅读页（S5）
//
// 定位：只读本机（wx.env.USER_DATA_PATH）的 TXT 文件，不碰 CloudBase。
// 三条硬约束：
//   1. 内存有界：按页读取（每页 8KB 级），任意时刻只持有一页文本，
//      绝不整文件读入，更不整文件 setData
//   2. 绝不修改数据：文件丢失、读取失败、编码异常都只提示，
//      不删除记录、不删文件、不自动修复索引
//   3. 只有真正成功渲染出第一页才开始计时；结算最多一次
//
// 计时结算逻辑复用 utils/readingSession.js（注入式控制器），
// 与 pages/reading/reading.js 的现有结算语义保持一致。
// ============================================================

const { createTxtReader } = require('../../utils/txtReader')
const { createReadingSession, fmtDate, newRequestId } = require('../../utils/readingSession')
const { formatBytes, MAX_WHOLE_READ_BYTES } = require('../../utils/localBooks')
const { getCarryStore } = require('../../utils/readingCarry')
const { getPositionStore } = require('../../utils/readingPositions')
const { getDailyPending, flushDailyPending } = require('../../utils/readingDailyPending')

function localBooksRepo() {
  return require('../../utils/localBooks').getLocalBooks()
}

const ERROR_TEXT = {
  NO_LOCAL_ID: '本机记录无效，请返回书架重新进入',
  ENTRY_NOT_FOUND: '本机记录已失效，请返回书架刷新',
  NOT_LOCAL: '这本书不在本机书架上',
  UNSUPPORTED_EXT: '这不是 TXT 文件，请返回书架重新打开',
  INDEX_CORRUPT: '本机书单异常，已暂停阅读',
  FILE_MISSING: '本机文件已丢失，请重新导入',
  STAT_FAILED: '读不到这个文件，请重新导入',
  EMPTY_FILE: '这个文件是空的',
  READ_FAILED: '读取失败，请重试',
  READ_UNSUPPORTED: '当前微信版本不支持分段读取这个文件，请升级微信后重试'
}

// 只有这几类失败代表「文件不在了」，才允许去标丢失标记
const MISSING_CODES = ['FILE_MISSING']

Page({
  data: {
    mode: 'loading', // loading | reader | error
    bookName: '',
    sizeText: '',
    pageText: '',
    pageIndex: 0,
    pageCount: 0,
    hasPrev: false,
    hasNext: false,
    encodingWarning: false,
    errorCode: '',
    errorText: '',
    missing: false,
    jumpValue: '',
    scrollTop: 0,
    restored: false
  },

  onLoad(query) {
    const q = query || {}
    // localId 是本页唯一入参：一切记录与路径都从它出发，绝不接受路径直传
    this._localId = q.localId ? String(q.localId) : null
    this._reader = null
    this._reading = false
    this._restoredPage = 0
    this._lastPercent = null
    this._session = createReadingSession({
      now: () => Date.now(),
      formatDate: fmtDate,
      newRequestId: () => newRequestId(),
      addLocalMinutes: (localId, minutes) => this.writeLocalMinutes(localId, minutes),
      callDailyRead: data => wx.cloud.callFunction({ name: 'dailyRecord', data }).then(res => res && res.result),
      bufferDailyPending: entry => {
        try {
          return getDailyPending().push(entry)
        } catch (err) {
          return { ok: false, reason: 'PENDING_MODULE_UNAVAILABLE' }
        }
      },
      // 余量结转：不足一分钟的阅读时长保留下来，下次继续攒
      getCarry: key => getCarryStore().get(key),
      setCarry: (key, ms) => getCarryStore().set(key, ms),
      // 结算成功 = 云端刚被证明可达 → 顺手重放待补报：
      // 让「已提交但未确认」的 requestId 尽快确认出队，别拖到下次进入页面
      flushPending: () => this.flushDailyPendingQuietly(),
      showToast: o => wx.showToast(o),
      logError: (tag, info) => console.error('[' + tag + ']', info),
      logWarn: (tag, info) => console.warn('[' + tag + ']', info)
    })
    // 顺带把上次失败留下的每日统计补报上去（带幂等 requestId，安全重放）
    this.flushDailyPendingQuietly()
    return this.load()
  },

  // 待补报重放：只有云端明确成功才从队列移除；失败保留等下次
  flushDailyPendingQuietly() {
    try {
      return flushDailyPending({
        store: getDailyPending(),
        callDailyRead: data => wx.cloud.callFunction({ name: 'dailyRecord', data }).then(res => res && res.result),
        logError: (tag, info) => console.error('[' + tag + ']', info),
        logWarn: (tag, info) => console.warn('[' + tag + ']', info)
      }).catch(err => {
        console.warn('[DAILY_PENDING_FLUSH_FAILED]', { code: err && err.code })
        return null
      })
    } catch (err) {
      console.warn('[DAILY_PENDING_FLUSH_UNAVAILABLE]', { code: err && err.code })
      return Promise.resolve(null)
    }
  },

  // onShow 在 onLoad 之后触发，此时首屏还没渲染完（mode 仍是 loading），
  // 因此不会「未成功就起计时」；只有在已经渲染出正文（mode === 'reader'）时，
  // 也就是「切后台又回来继续读」的场景，才补起一个新会话。
  onShow() {
    if (this.data.mode === 'reader' && this._session && !this._session.active()) {
      this._session.begin({ localId: this._localId, bookId: null })
    }
  },

  onHide() { return this.settle('HIDE') },
  onUnload() { return this.settle('UNLOAD') },

  // ============ 打开链路 ============

  load() {
    const localId = this._localId
    if (!localId) return this.failState('NO_LOCAL_ID')
    const repo = localBooksRepo()
    // 索引损坏优先于一切：只备份、不修复、不覆盖，直接拒绝阅读（fail-closed）
    const idxRead = repo.readIndexResult()
    if (idxRead && idxRead.status === 'corrupt') {
      return this.failState('INDEX_CORRUPT', repo, idxRead.reason)
    }
    const entry = repo.get(localId)
    if (!entry) return this.failState('ENTRY_NOT_FOUND')
    if (entry.source && entry.source !== 'local') return this.failState('NOT_LOCAL')
    const ext = String(entry.ext || '').toLowerCase()
    if (ext !== 'txt') return this.failState('UNSUPPORTED_EXT')

    this.setData({ bookName: entry.name || '未命名' })
    return repo.statFile(localId).then(stats => {
      if (!stats.exists) {
        const code = stats.reason === 'INDEX_CORRUPT' ? 'INDEX_CORRUPT' : (stats.reason === 'FILE_MISSING' ? 'FILE_MISSING' : 'STAT_FAILED')
        return this.failState(code, repo, stats.reason)
      }
      // 文件回来了 → 顺手清掉陈旧丢失标记（失败也不阻断阅读）
      if (stats.entry && stats.entry.missing) {
        repo.markMissing(localId, false).catch(() => undefined)
      }
      if (!(stats.size > 0)) return this.failState('EMPTY_FILE')
      this._reader = createTxtReader({
        size: stats.size,
        maxFallbackBytes: MAX_WHOLE_READ_BYTES,
        readRange: o => repo.readRange(localId, o),
        // 分段读取（position/length）在真机不被支持时的**有界**兜底：
        // 仅 ≤2MB 才整读，超限一律拒绝，绝不整文件进内存
        readAll: () => repo.readWholeText(localId),
        onWarn: (tag, info) => console.warn('[' + tag + ']', info)
      })
      const restored = this.restorePosition()
      this._restoredPage = restored
      this.setData({
        sizeText: formatBytes(stats.size),
        pageCount: this._reader.pageCount,
        restored: restored > 0
      })
      return this.readPage(restored)
    }).catch(err => {
      console.error('[TXT_LOAD_FAILED]', { code: err && err.code, stage: err && err.stage })
      return this.failState('READ_FAILED')
    })
  },

  // 上次读到第几页：只在「页数与上次一致」时才恢复，
  // 避免文件被替换/重新导入后跳到不存在的位置
  restorePosition() {
    const localId = this._localId
    if (!localId) return 0
    let pos = null
    try {
      pos = getPositionStore().get(localId)
    } catch (err) {
      console.warn('[TXT_POSITION_RESTORE_FAILED]', { code: err && err.code })
      return 0
    }
    if (!pos || !Number.isFinite(pos.page) || pos.page <= 0) return 0
    const count = this._reader ? this._reader.pageCount : 0
    if (count <= 0) return 0
    if (pos.pageCount && pos.pageCount !== count) {
      console.warn('[TXT_POSITION_STALE_DROPPED]', { saved: pos.pageCount, now: count })
      return 0
    }
    return Math.max(0, Math.min(count - 1, pos.page))
  },

  // 保存阅读位置 + 同步真实的阅读进度（仅 TXT 有可靠页数，PDF 绝不伪造百分比）
  saveProgress(page, pageCount, percent) {
    const localId = this._localId
    if (!localId) return
    // 位置写失败绝不阻断阅读（位置是体验优化），但也不允许静默：
    // 写入结果与异常都留一条日志，便于用户反馈时定位。
    try {
      const r = getPositionStore().set(localId, { page, pageCount })
      if (!r || r.ok !== true) {
        console.warn('[TXT_POSITION_SAVE_FAILED]', { code: (r && r.reason) || 'WRITE_FAILED', page })
      }
    } catch (err) {
      console.warn('[TXT_POSITION_SAVE_FAILED]', { code: err && err.code, page })
    }
    if (this._lastPercent === percent) return
    this._lastPercent = percent
    const repo = localBooksRepo()
    const entry = repo.get(localId)
    if (!entry) return
    if (Number(entry.progressPercent) === percent) return
    repo.update(localId, { progressPercent: percent }).catch(err => {
      console.warn('[TXT_PROGRESS_SYNC_FAILED]', { code: err && err.code })
    })
  },

  // 失败态：保留记录、保留文件，只提示；索引损坏时连丢失标记都不写（fail-closed）
  failState(code, repo, detail) {
    const isMissing = MISSING_CODES.includes(code)
    if (isMissing && repo) {
      repo.markMissing(this._localId, true).then(r => {
        if (r && r.persisted === false) console.warn('[LOCAL_MISSING_FLAG_PERSIST_FAILED]', { reason: r.reason })
      }).catch(err => {
        console.error('[LOCAL_MISSING_MARK_FAILED]', { code: err && err.code, stage: err && err.stage })
      })
    }
    if (code === 'INDEX_CORRUPT') {
      console.error('[TXT_INDEX_CORRUPT_BLOCKED]', { localId: this._localId, reason: detail })
    }
    if (isMissing) console.warn('[TXT_FILE_MISSING]', { localId: this._localId, reason: detail })
    this.setData({
      mode: 'error',
      errorCode: code,
      errorText: ERROR_TEXT[code] || ERROR_TEXT.READ_FAILED,
      missing: isMissing
    })
    return Promise.resolve({ opened: false, reason: code })
  },

  backToShelf() {
    wx.navigateBack({
      fail: () => wx.switchTab({ url: '/pages/reading/reading' })
    })
  },

  // ============ 分页阅读 ============

  readPage(index) {
    if (!this._reader) return Promise.resolve({ ok: false, reason: 'NO_READER' })
    if (this._reading) return Promise.resolve({ ok: false, reason: 'READ_IN_FLIGHT' })
    this._reading = true
    const repo = localBooksRepo()
    return Promise.resolve()
      .then(() => this._reader.readPage(index))
      .then(res => {
        if (!res || res.ok !== true) {
          const reason = (res && res.reason) || 'READ_FAILED'
          console.error('[TXT_PAGE_READ_FAILED]', { index, reason, errCode: res && res.errCode })
          if (reason === 'FILE_MISSING' || reason === 'INDEX_CORRUPT') {
            return this.failState(reason === 'INDEX_CORRUPT' ? 'INDEX_CORRUPT' : 'FILE_MISSING', repo, reason)
          }
          // 分段读取不可用且兜底也不可行（文件太大 / 没有兜底入口）→ 明确告知，而不是含糊的「读取失败」
          const outcome = this._reader ? this._reader.fallbackOutcome : null
          if (outcome === 'too_large' || outcome === 'unavailable') {
            console.error('[TXT_READ_UNSUPPORTED]', { index, reason, outcome })
            return this.failState('READ_UNSUPPORTED', repo, reason)
          }
          return this.failState('READ_FAILED')
        }
        this.renderPage(res)
        return res
      })
      .catch(err => {
        console.error('[TXT_PAGE_READ_UNEXPECTED]', { code: err && err.code, index })
        return this.failState('READ_FAILED')
      })
      .then(res => {
        this._reading = false
        return res
      })
  },

  renderPage(res) {
    const count = this._reader ? this._reader.pageCount : 0
    const percent = count > 0
      ? Math.max(0, Math.min(100, Math.round(((res.index + 1) / count) * 100)))
      : 0
    this.setData({
      mode: 'reader',
      pageText: res.text,
      pageIndex: res.index,
      pageCount: count,
      hasPrev: res.index > 0,
      hasNext: res.index < count - 1,
      encodingWarning: res.encodingIssue === true,
      errorCode: '',
      errorText: '',
      missing: false,
      // 换页后回到顶部：值必须在 0 / 0.01 间跳一次，否则 scroll-top 不会重算
      scrollTop: this.data.scrollTop === 0 ? 0.01 : 0
    })
    // 阅读位置与进度的真实同步（仅 TXT 有可靠页数）
    this.saveProgress(res.index, count, percent)
    // 只有真正成功渲染出内容才开始计时（打开失败/读取失败一律 0 分钟）
    if (!this._session.active()) {
      this._session.begin({ localId: this._localId, bookId: null })
    }
  },

  prevPage() {
    if (!this.data.hasPrev) return Promise.resolve({ ok: false, reason: 'NO_PREV' })
    return this.readPage(this.data.pageIndex - 1)
  },

  nextPage() {
    if (!this.data.hasNext) return Promise.resolve({ ok: false, reason: 'NO_NEXT' })
    return this.readPage(this.data.pageIndex + 1)
  },

  onJumpInput(e) {
    this.setData({ jumpValue: (e && e.detail && e.detail.value) || '' })
  },

  jumpToPage() {
    const count = this._reader ? this._reader.pageCount : 0
    const raw = String(this.data.jumpValue || '').trim()
    const n = Number(raw)
    if (!raw || !Number.isFinite(n)) {
      wx.showToast({ title: '请输入页码', icon: 'none' })
      return Promise.resolve({ ok: false, reason: 'BAD_JUMP_INPUT' })
    }
    const idx = Math.max(0, Math.min(count - 1, Math.floor(n) - 1))
    this.setData({ jumpValue: '' })
    return this.readPage(idx)
  },

  retry() {
    if (this._reader) return this.readPage(this.data.pageIndex || 0)
    this.setData({ mode: 'loading', errorCode: '', errorText: '' })
    return this.load()
  },

  // ============ 计时结算 ============

  // 本机分钟：绝不向已被删除的 localId 写分钟；写失败由控制器如实上报，不静默丢
  writeLocalMinutes(localId, minutes) {
    const repo = localBooksRepo()
    const entry = repo.get(localId)
    if (!entry) return Promise.resolve({ ok: false, skipped: true, reason: 'ENTRY_GONE' })
    return repo.addMinutes(localId, minutes).then(
      r => ({
        ok: true,
        buffered: !!(r && r.buffered),
        pendingWriteFailed: !!(r && r.pendingWriteFailed),
        reason: r && r.pendingReason
      }),
      err => ({ ok: false, code: err && err.code, stage: err && err.stage })
    )
  },

  settle(reason) {
    if (!this._session) return Promise.resolve({ settled: false, reason: 'NO_SESSION' })
    return this._session.settle(reason)
  }
})
