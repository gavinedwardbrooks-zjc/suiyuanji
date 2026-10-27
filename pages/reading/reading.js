const app = getApp()
const ICONS = require('../../assets/svg-icons')
const { formatBytes } = require('../../utils/localBooks')
const { createReadingSession, fmtDate, newRequestId } = require('../../utils/readingSession')
const { getCarryStore } = require('../../utils/readingCarry')
const { getDailyPending, flushDailyPending } = require('../../utils/readingDailyPending')
const db = wx.cloud.database()

function localBooksRepo() {
  return require('../../utils/localBooks').getLocalBooks()
}

// 唯一云端入口：把 callFunction 的 { result } 拆平，交给结算控制器判断
function callDailyRecord(data) {
  return wx.cloud.callFunction({ name: 'dailyRecord', data }).then(res => res && res.result)
}

function logErr(tag, info) { console.error('[' + tag + ']', info) }
function logWrn(tag, info) { console.warn('[' + tag + ']', info) }

// 本机书籍的阅读概览：只呈现真实存在的字段
//   - 分钟数总是真实的（本机 minutes）
//   - 百分比只有 TXT 才有可靠依据（按页计算）；PDF 拿不到原生阅读器页码，
//     因此绝不显示「已读 x%」，避免伪造进度
function buildLocalMeta(b) {
  if (!b) return ''
  if (b.missing) return '文件已丢失，请重新导入'
  const mins = Number(b.minutes) || 0
  const parts = [mins > 0 ? '已读 ' + mins + ' 分钟' : '还没开始读']
  if (b.ext === 'txt' && Number(b.progressPercent) > 0) {
    parts.push('进度 ' + Number(b.progressPercent) + '%')
  }
  return parts.join(' · ')
}

// 云端书籍「保存到本机」的失败文案：绝不与成功提示混淆
function migrateMessage(err) {
  const code = err && err.code
  if (code === 'ALREADY_MIGRATED') return '这本书已经在本机书架了'
  if (code === 'NO_CLOUD_FILE') return '这条记录没有云端文件'
  if (code === 'UNSUPPORTED_TYPE') return '只支持 PDF / TXT 文件'
  if (code === 'TEMP_URL_FAILED') return '云端文件不可用，请稍后再试'
  if (code === 'DOWNLOAD_FAILED') return '下载失败，请检查网络后重试'
  if (code === 'STORAGE_FULL') return '本机存储空间不足'
  if (code === 'FILE_TOO_LARGE') return '单个文件超过 100MB'
  if (code === 'EMPTY_FILE') return '这个文件是空的'
  if (code === 'DUPLICATE') return '本机已有同名文件，无需重复保存'
  if (code === 'INDEX_CORRUPT_LOCKED') return '本机书单异常，已暂停保存'
  if (code === 'MISSING_TEMP_PATH') return '云端文件为空，无法保存'
  return '保存失败，请重试'
}

function migrateFail(code, extra) {
  return Object.assign(new Error(code), Object.assign({ code, stage: 'LOCAL_MIGRATE' }, extra || {}))
}

// S4：删除失败的用户可见文案。绝不与成功提示混淆。
function localDeleteMessage(err) {
  const code = err && err.code
  if (code === 'INDEX_CORRUPT_LOCKED') return '本机书单异常，已暂停删除'
  if (code === 'DELETE_FILE_FAILED') return '文件删除失败，记录已保留'
  if (code === 'DELETE_META_FAILED') return '文件已删除，记录清理失败，请重试'
  if (code === 'NOT_FOUND') return '这本书已不在书架上'
  return '删除失败，请重试'
}

// S6：旧云端书籍删除失败的用户可见文案。绝不与「已删除」混淆。
function cloudDeleteMessage(err) {
  const code = err && err.code
  if (code === 'NOT_FOUND') return '这本书已不在阅读清单里'
  if (code === 'NOT_OWNER') return '这本书不属于当前账号，无法删除'
  if (code === 'DELETE_NOT_APPLIED') return '云端记录未删除成功，请重试'
  if (code === 'VERIFY_UNAVAILABLE') return '删除结果未能确认，请重新进入页面查看'
  if (code === 'FETCH_FAILED') return '读取云端记录失败，请检查网络后重试'
  return '删除失败，请重试'
}

function cloudDeleteFail(code, extra) {
  return Object.assign(new Error(code), Object.assign({ code, stage: 'CLOUD_DELETE' }, extra || {}))
}

// S6：旧云端书籍删除的二次确认。文案与范围都由用户这一次点击明确授权。
function askCloudDeleteConfirm(name) {
  const title = String(name || '这本书')
  return new Promise(resolve => {
    wx.showModal({
      title: '删除书籍',
      content: `确定将《${title}》从阅读清单中删除吗？此操作无法撤销。`,
      confirmText: '删除',
      cancelText: '取消',
      success: res => resolve(!!(res && res.confirm)),
      fail: () => resolve(false)
    })
  })
}

// S4：删除二次确认。有文件 → 明确告知文件与记录一起删除；手动书单 → 只删清单项。
function askLocalDeleteConfirm(name, hasFile) {
  const title = String(name || '这本书')
  const content = hasFile
    ? `确定删除《${title}》吗？本机文件和阅读记录将一起删除，无法撤销。`
    : `确定从阅读清单中删除《${title}》吗？`
  return new Promise(resolve => {
    wx.showModal({
      title: '删除确认',
      content,
      confirmText: '删除',
      cancelText: '取消',
      success: res => resolve(!!(res && res.confirm)),
      fail: () => resolve(false)
    })
  })
}

// 每日阅读统计的「待补报」队列：失败事实必须落地，绝不静默丢弃。
// 每条都带稳定 requestId，云端 addRead 幂等，因此可安全重放（见 flushDailyPendingQuietly）。
function bufferDailyPending(entry) {
  try {
    return getDailyPending().push(entry)
  } catch (err) {
    return { ok: false, reason: 'PENDING_MODULE_UNAVAILABLE' }
  }
}

// S2：导入失败的用户可见文案。绝不与成功提示混淆。
function localImportMessage(err) {
  const code = err && err.code
  if (code === 'UNSUPPORTED_TYPE') return '只支持 PDF / TXT 文件'
  if (code === 'EMPTY_FILE') return '这个文件是空的'
  if (code === 'FILE_TOO_LARGE') return '单个文件超过 100MB'
  if (code === 'STORAGE_FULL') return '本机存储空间不足'
  if (code === 'DUPLICATE') return '本机已有同名文件'
  if (code === 'INDEX_CORRUPT_LOCKED') return '本机书单异常，请勿清理小程序数据'
  if (code === 'MISSING_TEMP_PATH') return '没有选中文件'
  return '导入失败，请重试'
}

Page({
  data: {
    books: [],
    localBooks: [],
    localUsageText: '0 个文件 · 0 B / 200.0 MB',
    localUsagePercent: 0,
    localUsageWarning: false,
    localIndexCorrupted: false,
    uploading: false,
    decoBookSrc: ICONS.deco_plant,
    writings: []
  },

  onShow() {
    this._loadErrorShown = false
    // 从后台 / 原生 PDF 查看器回到本页：若刚才在读某本书，接着计时。
    // 计时采用「余量结转」：切走时只结算整分钟，不足一分钟的部分存下来，
    // 因此既不会丢弃真实时长，也不会把几秒钟强行记成 1 分钟。
    if (this._lastTarget && this._rs && !this._rs.active()) {
      this.startReadingSession(this._lastTarget)
    }
    this.loadBooks()
    this.loadWritings()
    this.loadLocalBooks()
    // 顺带把上次失败留下的每日统计补报上去（带幂等 requestId，安全重放）
    this.flushDailyPendingQuietly()
  },

  // 待补报重放：只有云端明确成功才从队列移除；失败保留等下次
  flushDailyPendingQuietly() {
    try {
      return flushDailyPending({
        store: getDailyPending(),
        callDailyRead: callDailyRecord,
        logError: logErr,
        logWarn: logWrn
      }).catch(err => {
        logWrn('DAILY_PENDING_FLUSH_FAILED', { code: err && err.code })
        return null
      })
    } catch (err) {
      logWrn('DAILY_PENDING_FLUSH_UNAVAILABLE', { code: err && err.code })
      return Promise.resolve(null)
    }
  },
  showLoadError() {
    if (this._loadErrorShown) return
    this._loadErrorShown = true
    wx.showToast({ title: '加载失败，请稍后再试', icon: 'none' })
  },
  openWriting() { wx.navigateTo({ url: '/pages/writing-edit/writing-edit' }) },
  openBookEditor() { wx.navigateTo({ url: '/pages/book-edit/book-edit' }) },
  openWritingItem(e) { wx.navigateTo({ url: `/pages/writing-edit/writing-edit?writingId=${e.currentTarget.dataset.id}` }) },
  loadWritings() {
    const api = require('../../utils/writingApi')
    api.listWritings()
      .then(r => this.setData({ writings: (r.writings || []).slice(0, 5) }))
      .catch(err => {
        console.error('LOAD_WRITINGS_FAILED', err)
        this.showLoadError()
      })
  },

  loadBooks() {
    return db.collection('books').orderBy('createdAt', 'desc').get().then(res => {
      const books = res.data.map(b => ({
        ...b,
        author: b.author || '',
        status: b.status || 'reading',
        pct: typeof b.progressPercent === 'number' ? Math.max(0, Math.min(100, b.progressPercent)) : (b.totalMin > 0 ? Math.min(100, Math.round((b.minutes || 0) / b.totalMin * 100)) : 0),
        isLegacyFile: !b.status && !!b.fileID
      }))
      this.setData({ books })
      this.applyCloudMigrationFlags(this.data.localBooks)
      // 返回本次真实读到的列表：删除后用它核验「记录是否真的没了」，
      // 读失败时返回 null（调用方据此拒绝谎报成功）
      return books
    }).catch(err => {
      console.error('LOAD_BOOKS_FAILED', err)
      this.showLoadError()
      return null
    })
  },

  // ============ S2：本机文件书架 ============
  // 导入只落 wx.env.USER_DATA_PATH，不上传云存储、不写 books 集合。
  // 云端 books 仅作历史数据继续展示（loadBooks），本轮不删不改。

  applyLocalState(res, usage) {
    const books = (res && res.books ? res.books : []).map(b => Object.assign({}, b, {
      pct: typeof b.progressPercent === 'number' ? Math.max(0, Math.min(100, b.progressPercent)) : 0,
      localHint: b.missing
        ? '文件已丢失，请重新导入'
        : (b.ext === 'txt' ? '本机文件 · 点击阅读' : '本机文件 · 点击打开'),
      localMeta: buildLocalMeta(b)
    }))
    const u = usage || { fileCount: 0, bytes: 0, limitBytes: 0, percent: 0, warning: false }
    this.setData({
      localBooks: books,
      localIndexCorrupted: !!(res && res.corrupted),
      localUsageText: `${u.fileCount} 个文件 · ${formatBytes(u.bytes)} / ${formatBytes(u.limitBytes)}`,
      localUsagePercent: u.percent,
      localUsageWarning: u.warning === true
    })
    this.applyCloudMigrationFlags(books)
  },

  // 云端行上的「已存到本机」标记：完全由本机索引的 migratedFrom 推导，
  // 不写云端任何字段
  applyCloudMigrationFlags(localList) {
    const migrated = {}
    for (const b of (localList || [])) {
      if (b && b.migratedFrom) migrated[String(b.migratedFrom)] = b.localId
    }
    const cloud = (this.data.books || []).map(b => {
      const localId = migrated[String(b._id)]
      return Object.assign({}, b, { migratedLocalId: localId || null })
    })
    if (cloud.length || (this.data.books || []).length) this.setData({ books: cloud })
  },

  loadLocalBooks() {
    const repo = require('../../utils/localBooks').getLocalBooks()
    return repo.flushPending()
      .catch(err => {
        console.warn('[LOCAL_PENDING_FLUSH_FAILED]', { code: err && err.code })
        return null
      })
      .then(() => repo.list())
      .then(res => {
        this.applyLocalState(res, repo.usage())
        if (res.corrupted) {
          const w = (res.warnings || [])[0] || {}
          console.error('[LOCAL_BOOKS_INDEX_CORRUPT]', { reason: w.reason, backupKey: w.backupKey })
        }
        if ((res.warnings || []).some(w => w.code === 'MISSING_FLAG_PERSIST_FAILED')) {
          console.warn('[LOCAL_MISSING_FLAG_PERSIST_FAILED]')
        }
        return res
      })
      .catch(err => {
        console.error('[LOAD_LOCAL_BOOKS_FAILED]', { code: err && err.code, stage: err && err.stage })
        this.setData({ localBooks: [], localIndexCorrupted: false })
        this.showLoadError()
        return { books: [], corrupted: false, warnings: [] }
      })
  },

  importBook() {
    if (this.data.uploading) return
    const repo = require('../../utils/localBooks').getLocalBooks()
    let picked = null
    return wx.chooseMessageFile({ count: 1, type: 'file', extension: ['pdf', 'txt'] })
      .then(res => {
        const f = res.tempFiles && res.tempFiles[0]
        if (!f) throw Object.assign(new Error('no file selected'), { stage: 'LOCAL_SELECT_FAILED', code: 'MISSING_TEMP_PATH' })
        const tempFilePath = f.path || f.tempFilePath
        if (!tempFilePath) throw Object.assign(new Error('missing temp file path'), { stage: 'LOCAL_SELECT_FAILED', code: 'MISSING_TEMP_PATH' })
        picked = {
          tempFilePath,
          name: f.name,
          ext: (String(f.name).split('.').pop() || '').toLowerCase(),
          size: f.size
        }
        this.setData({ uploading: true })
        return repo.importFile(picked)
      })
      .then(result => this.finishLocalImport(result))
      .catch(err => {
        if (err && err.code === 'DUPLICATE' && picked) {
          return this.confirmReplaceDuplicate(repo, picked)
        }
        this.failLocalImport(err)
      })
  },

  confirmReplaceDuplicate(repo, picked) {
    return new Promise(resolve => {
      wx.showModal({
        title: '本机已有同名文件',
        content: '同名同大小的文件已在本机，替换后原有阅读进度会保留。',
        confirmText: '替换',
        cancelText: '取消',
        success: res => resolve(!!(res && res.confirm)),
        fail: () => resolve(false)
      })
    }).then(confirmed => {
      if (!confirmed) {
        this.setData({ uploading: false })
        return
      }
      return repo.importFile(picked, { onDuplicate: 'replace' })
        .then(result => this.finishLocalImport(result))
        .catch(err => this.failLocalImport(err))
    })
  },

  finishLocalImport(result) {
    this.setData({ uploading: false })
    if (!result || !result.entry) {
      // 没有真实写入记录 → 绝不显示成功
      this.failLocalImport(Object.assign(new Error('no entry returned'), { code: 'IMPORT_NO_ENTRY' }))
      return Promise.resolve()
    }
    const repo = require('../../utils/localBooks').getLocalBooks()
    return repo.flushPending()
      .catch(() => undefined)
      .then(() => this.loadLocalBooks())
      .catch(() => undefined)
      .then(() => { wx.showToast({ title: '已存到本机书架' }) })
  },

  failLocalImport(err) {
    this.setData({ uploading: false })
    console.error('[LOCAL_IMPORT_FAILED]', {
      code: err && err.code,
      stage: err && err.stage,
      errCode: err && err.errCode
    })
    wx.showToast({ title: localImportMessage(err), icon: 'none' })
  },

  // ============ S3：本机 PDF 打开链路 ============
  // localId（权威记录）→ 运行时 USER_DATA_PATH 派生路径 → 存在性检查 → wx.openDocument
  // 绝不走 CloudBase / getTempFileURL / downloadFile，也绝不回落到旧云端打开链路。
  // 本地 TXT 走 S5 的内置阅读页（openLocalTxt），同样不碰云端。

  openLocalBook(e) {
    const ds = (e && e.currentTarget && e.currentTarget.dataset) || {}
    const localId = ds.id || (ds.b && ds.b.localId) || null
    if (!localId) {
      wx.showToast({ title: '本机记录异常，请重新进入页面', icon: 'none' })
      return Promise.resolve({ opened: false, reason: 'NO_LOCAL_ID' })
    }
    if (this._openingLocalId) {
      // 重复点击：上一枪还没结束，直接忽略，避免并发打开与重复计时
      return Promise.resolve({ opened: false, reason: 'OPEN_IN_FLIGHT' })
    }
    this._openingLocalId = localId
    // 用 Promise.resolve 包一层：同步异常也必须走同一条失败链，不得抛出未捕获异常
    return Promise.resolve()
      .then(() => this.openLocalById(localId))
      .catch(err => {
        console.error('[LOCAL_OPEN_FAILED]', { code: err && err.code, stage: err && err.stage })
        wx.showToast({ title: '打开失败，请重试', icon: 'none' })
        return { opened: false, reason: (err && err.code) || 'OPEN_FAILED' }
      })
      .then(result => {
        if (this._openingLocalId === localId) this._openingLocalId = null
        return result
      })
  },

  openLocalById(localId) {
    const repo = localBooksRepo()
    const entry = repo.get(localId)
    if (!entry) {
      // 记录已被移除但列表尚未刷新 → 不打开、不乱标丢失，刷新列表
      wx.showToast({ title: '本机记录已失效，请重新进入页面', icon: 'none' })
      this.loadLocalBooks()
      return Promise.resolve({ opened: false, reason: 'ENTRY_NOT_FOUND' })
    }
    const ext = String(entry.ext || '').toLowerCase()
    if (ext === 'txt') {
      // S5：本地 TXT 交给内置阅读页（openDocument 的 fileType 合法值不含 txt）。
      // 只传 localId，路径与记录校验都在阅读页内完成，本页不预先拼路径。
      return this.openLocalTxt(localId)
    }
    if (ext !== 'pdf') {
      wx.showToast({ title: '本机暂不支持这种格式', icon: 'none' })
      return Promise.resolve({ opened: false, reason: 'UNSUPPORTED_LOCAL_EXT' })
    }
    return repo.verifyFile(localId).then(chk => {
      if (!chk.exists) return this.handleLocalFileMissing(repo, localId, chk.reason)
      // 文件回来了 → 顺手清掉陈旧丢失标记（不落盘成功也不阻断打开）
      if (entry.missing) {
        repo.markMissing(localId, false).catch(() => undefined)
      }
      return this.openLocalPdf(chk.path, localId).then(ok => ({
        opened: ok,
        reason: ok ? null : 'OPEN_DOCUMENT_FAILED'
      }))
    })
  },

  handleLocalFileMissing(repo, localId, reason) {
    console.warn('[LOCAL_FILE_MISSING]', { localId, reason })
    return repo.markMissing(localId, true)
      .then(r => {
        if (r && r.persisted === false) {
          console.warn('[LOCAL_MISSING_FLAG_PERSIST_FAILED]', { reason: r.reason })
        }
      })
      .catch(err => {
        console.error('[LOCAL_MISSING_MARK_FAILED]', { code: err && err.code, stage: err && err.stage })
      })
      .then(() => this.loadLocalBooks())
      .catch(() => undefined)
      .then(() => {
        // 保留元数据，绝不自动删除记录；绝不调用 openDocument
        wx.showToast({ title: '本机文件已丢失，请重新导入', icon: 'none' })
        return { opened: false, reason: 'FILE_MISSING' }
      })
  },

  openLocalPdf(filePath, localId) {
    return new Promise(resolve => {
      let settled = false
      const settle = v => { if (!settled) { settled = true; resolve(v) } }
      if (!filePath) {
        wx.showToast({ title: '本机文件路径异常，请重新导入', icon: 'none' })
        settle(false)
        return
      }
      wx.openDocument({
        filePath,
        fileType: 'pdf',
        showMenu: true,
        success: () => {
          console.info('[LOCAL_PDF_OPEN_OK]')
          // 只有真正打开成功才允许开始阅读计时
          this.startReadingSession({ localId, bookId: null })
          settle(true)
        },
        fail: err => {
          console.error('[LOCAL_PDF_OPEN_FAILED]', {
            errCode: err && err.errCode,
            errMsg: err && err.errMsg
          })
          wx.showToast({ title: '打开失败，请重试', icon: 'none' })
          settle(false)
        }
      })
    })
  },

  // S5：跳转内置 TXT 阅读页。计时在本页**不启动**（本机会话统一由阅读页负责），
  // 因此不会出现「跳转失败却开始计时」或两页各自计时的重复累计。
  openLocalTxt(localId) {
    try {
      wx.navigateTo({
        url: '/pages/reading-txt/reading-txt?localId=' + encodeURIComponent(localId),
        fail: err => {
          console.error('[LOCAL_TXT_NAV_FAILED]', { errMsg: err && err.errMsg })
          wx.showToast({ title: '打开失败，请重试', icon: 'none' })
        }
      })
      return Promise.resolve({ opened: true, reason: null, route: 'TXT_READER' })
    } catch (err) {
      console.error('[LOCAL_TXT_NAV_FAILED]', { errMsg: err && (err.errMsg || err.message) })
      wx.showToast({ title: '打开失败，请重试', icon: 'none' })
      return Promise.resolve({ opened: false, reason: 'TXT_NAV_FAILED' })
    }
  },

  // ============ S4：本机书籍删除 ============
  // 只允许删除 source='local' 的本地条目。
  // 本机删除（删文件 + 删本机记录）与云端删除（只删 books 记录，保留云存储文件）
  // 是两条**互不混用**的链路：本页不调 wx.cloud.deleteFile、不调
  // db.collection('books').doc().remove()，云端删除见下方 S6 段落。
  // 删除能力完全复用 utils/localBooks.remove()，本页不重写删除逻辑。

  deleteLocalBook(e) {
    const ds = (e && e.currentTarget && e.currentTarget.dataset) || {}
    const localId = ds.id || null
    if (!localId) {
      wx.showToast({ title: '本机记录异常，请重新进入页面', icon: 'none' })
      return Promise.resolve({ deleted: false, reason: 'NO_LOCAL_ID' })
    }
    if (this._deletingLocalId) {
      // 重复点击：上一枪还没结束，直接忽略
      return Promise.resolve({ deleted: false, reason: 'DELETE_IN_FLIGHT' })
    }
    this._deletingLocalId = localId
    // 用 Promise.resolve 包一层：同步异常也走同一条失败链，不得抛出未捕获异常
    return Promise.resolve()
      .then(() => this.confirmAndDeleteLocal(localId))
      .catch(err => {
        console.error('[LOCAL_DELETE_FAILED]', { code: err && err.code, stage: err && err.stage })
        wx.showToast({ title: localDeleteMessage(err), icon: 'none' })
        return { deleted: false, reason: (err && err.code) || 'DELETE_FAILED' }
      })
      .then(result => {
        if (this._deletingLocalId === localId) this._deletingLocalId = null
        return result
      })
  },

  confirmAndDeleteLocal(localId) {
    const repo = localBooksRepo()
    const entry = repo.get(localId)
    if (!entry) {
      // 记录已被移除但列表尚未刷新
      wx.showToast({ title: '本机记录已失效，请重新进入页面', icon: 'none' })
      this.loadLocalBooks()
      return Promise.resolve({ deleted: false, reason: 'ENTRY_NOT_FOUND' })
    }
    if (entry.source && entry.source !== 'local') {
      wx.showToast({ title: '历史云端书籍暂不支持删除', icon: 'none' })
      return Promise.resolve({ deleted: false, reason: 'NOT_LOCAL_SOURCE' })
    }
    if (this.hasActiveSessionFor(localId)) {
      // 绝不丢弃未结算分钟，也绝不允许结算时向已删除的 localId 写分钟
      wx.showToast({ title: '这本书正在阅读中，请先结束阅读再删除', icon: 'none' })
      return Promise.resolve({ deleted: false, reason: 'SESSION_ACTIVE' })
    }
    const hasFile = !!entry.fileName
    return askLocalDeleteConfirm(entry.name, hasFile).then(confirmed => {
      if (!confirmed) return { deleted: false, reason: 'USER_CANCELLED' }
      // 文件与元数据删除顺序由 utils/localBooks.remove() 保证：
      // 先删文件（失败即中止、元数据不动）→ 再写元数据 → 最后清该书的待补写分钟
      return repo.remove(localId).then(res => {
        if (!res || res.removed !== true) {
          return this.loadLocalBooks().then(() => (
            { deleted: false, reason: (res && res.reason) || 'NOT_FOUND' }
          ))
        }
        if (res.pendingCleared === false) {
          console.warn('[LOCAL_DELETE_PENDING_CLEAR_FAILED]', { reason: res.pendingReason })
        }
        return this.loadLocalBooks().then(() => {
          wx.showToast({ title: '已删除' })
          return {
            deleted: true,
            reason: null,
            droppedPendingMinutes: res.droppedPendingMinutes || 0
          }
        })
      })
    })
  },

  hasActiveSessionFor(localId) {
    const rs = this._rs
    return !!(rs && rs.isFor(localId))
  },

  // 云端书籍是否正在被计时（按 bookId 判定；本机书不带 bookId，永不误判）
  hasActiveSessionBook(bookId) {
    const rs = this._rs
    if (!rs || !bookId) return false
    const cur = rs.peek && rs.peek()
    return !!(cur && cur.bookId && String(cur.bookId) === String(bookId))
  },

  // 当前登录 openid（静默登录完成后可读；未就绪时返回 null，不阻断任何流程）
  currentOpenid() {
    try {
      const app0 = getApp && getApp()
      const id = app0 && app0.globalData && app0.globalData.openid
      return id ? String(id) : null
    } catch (err) {
      return null
    }
  },

  // ============ S6：旧云端书籍删除 ============
  // 范围严格限定为 **当前这一条 books 记录**：
  //   · 只删 1 条，且只用 doc(id).remove()：绝无 where 条件删除、无批量删除
  //   · 不调 wx.cloud.deleteFile → 云存储里的原始 PDF/TXT 始终保留
  //   · 不写任何其它字段（另一次 update/add 都没有）
  //   · 不触碰本机索引：已迁移到本机的副本是独立记录，永久保留
  //   · 不触碰 daily_records / 待补报队列：历史与未结算分钟一字不改
  // 归属与权限：books 集合按创建者隔离，读/删他人的记录一定失败；前端只负责
  // 不让入口误触，绝不把「按钮藏起来」当作唯一防线（见 fetchCloudBookRecord
  // 的显式存在性 + 归属复核）。

  deleteCloudBook(e) {
    const ds = (e && e.currentTarget && e.currentTarget.dataset) || {}
    const bookId = ds.id
    // 只接受字符串 id：绝不接受对象/条件，避免把一次点击放大成范围删除
    if (typeof bookId !== 'string' || !bookId) {
      wx.showToast({ title: '这条记录异常，请刷新后重试', icon: 'none' })
      return Promise.resolve({ deleted: false, reason: 'NO_BOOK_ID' })
    }
    if (this._deletingCloudId) {
      // 重复/并发点击：上一枪还没结束，直接忽略
      return Promise.resolve({ deleted: false, reason: 'DELETE_IN_FLIGHT' })
    }
    this._deletingCloudId = bookId
    return Promise.resolve()
      .then(() => this.confirmAndDeleteCloudBook(bookId))
      .catch(err => {
        console.error('[CLOUD_DELETE_FAILED]', {
          code: err && err.code,
          errCode: err && err.errCode,
          stage: err && err.stage
        })
        wx.showToast({ title: cloudDeleteMessage(err), icon: 'none' })
        return { deleted: false, reason: (err && err.code) || 'DELETE_FAILED' }
      })
      .then(result => {
        if (this._deletingCloudId === bookId) this._deletingCloudId = null
        return result
      })
  },

  confirmAndDeleteCloudBook(bookId) {
    // 1) 只认「当前列表里真实存在」的那一条：不信任 dataset 里的其它字段，
    //    也就绝不会用传入内容构造出模糊条件去删到别的记录
    const listed = (this.data.books || []).filter(b => b && String(b._id) === String(bookId))[0]
    if (!listed) {
      wx.showToast({ title: '这本书已不在阅读清单里', icon: 'none' })
      this.loadBooks()
      return Promise.resolve({ deleted: false, reason: 'ENTRY_NOT_FOUND' })
    }
    // 2) 正在阅读：先结束阅读再删。
    //    否则结算会把分钟写到一本已经消失的书上（每日分钟不会丢，但归属已无意义），
    //    与本机删除保持同一套规则。
    if (this.hasActiveSessionBook(bookId)) {
      wx.showToast({ title: '这本书正在阅读中，请先结束阅读再删除', icon: 'none' })
      return Promise.resolve({ deleted: false, reason: 'SESSION_ACTIVE' })
    }
    return askCloudDeleteConfirm(listed.name).then(confirmed => {
      if (!confirmed) {
        // 取消：零写入（不查询、不删除、不改列表、不碰队列）
        return { deleted: false, reason: 'USER_CANCELLED' }
      }
      // 3) 删除前尽力清一次待补报：能在书还在时结算的分钟，books.minutes 会
      //    与每日分钟一起落入。清不掉也**不丢分钟** —— 云函数对已不存在的书
      //    会跳过 books.minutes，只累加每日阅读分钟，不会失败也不会重复。
      //    这里刻意只处理「本队列」，绝不因为删一本书就把全局补报清空。
      return this.flushDailyPendingQuietly()
        .then(() => this.fetchCloudBookRecord(bookId))
        .then(() => this.removeCloudBookRecord(bookId))
        // 4) 用刷新后的真实列表核验：列表里还有这条 = 没删掉 → 绝不谎报成功
        .then(() => this.loadBooks())
        .then(rows => {
          if (!rows) throw cloudDeleteFail('VERIFY_UNAVAILABLE')
          const still = rows.some(b => b && String(b._id) === String(bookId))
          if (still) throw cloudDeleteFail('DELETE_NOT_APPLIED')
          wx.showToast({ title: '已删除' })
          return {
            deleted: true,
            reason: null,
            cloudRecordRemoved: true,
            cloudFileKept: true,
            localCopyKept: true
          }
        })
    })
  },

  // 删除前的记录复核：确认「这条记录确实存在、且可被我读到」。
  // 用 where 查而不是 doc().get()，是为了不依赖 throwOnNotFound、也不去猜错误码
  // 区分「不存在」与「真故障」—— 查不到就是不删（fail-closed）。
  fetchCloudBookRecord(bookId) {
    return db.collection('books').where({ _id: bookId }).get().then(res => {
      const rows = (res && res.data) || []
      const rec = rows.filter(r => r && String(r._id) === String(bookId))[0]
      if (!rec) throw cloudDeleteFail('NOT_FOUND')
      // 归属复核（纵深防御）：记录带 _openid 时必须与当前登录用户一致。
      // 拿不到 openid（静默登录未完成）时不阻断，仍由集合权限兜底 —— 绝不
      // 因为「读不到身份」就放宽删除范围。
      const mine = this.currentOpenid()
      if (mine && rec._openid && String(rec._openid) !== mine) {
        throw cloudDeleteFail('NOT_OWNER')
      }
      return rec
    }).catch(err => {
      if (err && err.code) throw err
      console.error('[CLOUD_DELETE_FETCH_FAILED]', {
        errCode: err && err.errCode,
        errMsg: err && (err.errMsg || err.message)
      })
      throw cloudDeleteFail('FETCH_FAILED', { errCode: err && err.errCode })
    })
  },

  // 唯一的删除动作：doc(_id).remove()，一次只影响这一条文档。
  removeCloudBookRecord(bookId) {
    return db.collection('books').doc(bookId).remove().then(res => {
      // 只有在**明确知道**一条都没删掉时才判失败；
      // 返回结构不含 stats 时不臆造结论，交给刷新后的列表核验（见上）
      const removed = res && res.stats && typeof res.stats.removed === 'number'
        ? res.stats.removed
        : null
      if (removed === 0) throw cloudDeleteFail('DELETE_NOT_APPLIED')
      return { removed }
    }).catch(err => {
      if (err && err.code) throw err
      console.error('[CLOUD_DELETE_REMOVE_FAILED]', {
        errCode: err && err.errCode,
        errMsg: err && (err.errMsg || err.message)
      })
      throw cloudDeleteFail('DELETE_FAILED', { errCode: err && err.errCode })
    })
  },

  // ============ 旧云端书籍：逐本「保存到本机」 ============
  // 只由用户主动点击触发，绝不自动批量迁移。
  // 云端记录与云存储文件始终保留（全程不调 deleteFile、不 remove 云端记录）。
  // 手动书单（无 fileID）在 WXML 层就不显示入口，绝不被伪装成可下载的文件。

  migrateCloudBook(e) {
    const ds = (e && e.currentTarget && e.currentTarget.dataset) || {}
    const book = ds.b || null
    const bookId = book && book._id
    if (!bookId) {
      wx.showToast({ title: '这条记录异常，请刷新后重试', icon: 'none' })
      return Promise.resolve({ migrated: false, reason: 'NO_BOOK_ID' })
    }
    if (this._migratingId) {
      // 并发/重复点击：上一枪还没结束，直接忽略
      return Promise.resolve({ migrated: false, reason: 'MIGRATE_IN_FLIGHT' })
    }
    this._migratingId = bookId
    return Promise.resolve()
      .then(() => this.doMigrateCloudBook(book))
      .catch(err => {
        console.error('[LOCAL_MIGRATE_FAILED]', {
          code: err && err.code,
          stage: err && err.stage,
          errCode: err && err.errCode
        })
        wx.showToast({ title: migrateMessage(err), icon: 'none' })
        return { migrated: false, reason: (err && err.code) || 'MIGRATE_FAILED' }
      })
      .then(result => {
        if (this._migratingId === bookId) this._migratingId = null
        return result
      })
  },

  // 已迁移判定：以本机索引里的 migratedFrom 为唯一依据
  findMigratedLocalId(cloudId) {
    const repo = localBooksRepo()
    const idx = repo.readIndex()
    const found = (idx.books || []).find(b => b.migratedFrom && String(b.migratedFrom) === String(cloudId))
    return found ? found.localId : null
  },

  doMigrateCloudBook(book) {
    const repo = localBooksRepo()
    const cloudId = book._id

    // 1) 防重复迁移：已在本机就绝不重复下载
    const existing = this.findMigratedLocalId(cloudId)
    if (existing) {
      wx.showToast({ title: '这本书已经在本机书架了', icon: 'none' })
      return Promise.resolve({ migrated: false, reason: 'ALREADY_MIGRATED', localId: existing })
    }
    // 2) 没有云端文件的记录不是可下载内容
    if (!book.fileID) {
      wx.showToast({ title: '这条记录没有云端文件', icon: 'none' })
      return Promise.resolve({ migrated: false, reason: 'NO_CLOUD_FILE' })
    }
    const ext = String(book.ext || '').toLowerCase() ||
      (String(book.fileID).split('.').pop() || '').toLowerCase()
    if (['pdf', 'txt'].indexOf(ext) === -1) {
      throw migrateFail('UNSUPPORTED_TYPE', { ext })
    }

    return this.fetchTempUrl(book.fileID)
      .then(url => this.downloadToTemp(url))
      .then(tempFilePath => repo.importFile({
        tempFilePath,
        name: (book.name || '未命名') + '.' + ext,
        ext,
        // size 故意不传：downloadFile 不返回大小，真实大小由 importFile 的
        // stat 决定，避免「按声明大小放行 / 误拒」
        size: undefined
      }, {
        // 迁移元数据：书名/类型来自记录本身，作者与阅读元数据一并带过去
        meta: {
          author: book.author,
          status: book.status,
          progressPercent: book.progressPercent,
          minutes: book.minutes,
          note: book.note,
          coverColor: book.coverColor,
          migratedFrom: cloudId
        }
      }).catch(err => this.cleanupTempFile(tempFilePath).then(() => { throw err })))
      .then(result => {
        if (!result || !result.entry) {
          throw migrateFail('MIGRATE_NO_ENTRY')
        }
        // 原云端记录与云存储文件**始终保留**：这里只刷新本机列表
        return this.loadLocalBooks().then(() => {
          wx.showToast({ title: '已保存到本机' })
          return {
            migrated: true,
            reason: null,
            localId: result.entry.localId,
            cloudId,
            cloudKept: true
          }
        })
      })
  },

  // 云端文件是否存在 + 取临时访问地址。下载失败/地址失效都必须显式失败，绝不假装成功。
  fetchTempUrl(fileID) {
    return wx.cloud.getTempFileURL({ fileList: [fileID] }).then(res => {
      const item = res && res.fileList && res.fileList[0]
      const url = item && item.tempFileURL
      if (!url) {
        console.error('[LOCAL_MIGRATE_TEMP_URL_FAILED]', { status: item && item.status })
        throw migrateFail('TEMP_URL_FAILED', { status: item && item.status })
      }
      return url
    }).catch(err => {
      if (err && err.code) throw err
      throw migrateFail('TEMP_URL_FAILED', { errMsg: err && (err.errMsg || err.message) })
    })
  },

  // 迁移失败的回滚：只清理「本次下载到框架临时目录的那一份」。
  // saveFile 成功即等于临时文件已被移走（unlink 会 1300002），因此这里容忍失败；
  // 绝不触碰 books 目录下的正式文件，也绝不触碰云端任何东西。
  cleanupTempFile(tempFilePath) {
    if (!tempFilePath) return Promise.resolve()
    return new Promise(resolve => {
      wx.getFileSystemManager().unlink({
        filePath: tempFilePath,
        success: () => resolve(),
        fail: () => resolve()
      })
    }).catch(() => undefined)
  },

  downloadToTemp(url) {
    return new Promise((resolve, reject) => {
      wx.downloadFile({
        url,
        success: res => {
          if (!res || res.statusCode !== 200 || !res.tempFilePath) {
            console.error('[LOCAL_MIGRATE_DOWNLOAD_FAILED]', { statusCode: res && res.statusCode })
            reject(migrateFail('DOWNLOAD_FAILED', { statusCode: res && res.statusCode }))
            return
          }
          resolve(res.tempFilePath)
        },
        fail: err => {
          console.error('[LOCAL_MIGRATE_DOWNLOAD_FAILED]', { errCode: err && err.errCode, errMsg: err && err.errMsg })
          reject(migrateFail('DOWNLOAD_FAILED', { errCode: err && err.errCode }))
        }
      })
    })
  },

  openBook(e) {
    const b = e.currentTarget.dataset.b
    if (!b.fileID) {
      wx.showToast({ title: '这是手动书单记录', icon: 'none' })
      return
    }
    wx.cloud.getTempFileURL({ fileList: [b.fileID] }).then(r => {
      const url = r.fileList[0].tempFileURL
      console.info('[PDF_DOWNLOAD_REACHED]')
      wx.downloadFile({
        url,
        success: res => {
          if (res.statusCode !== 200 || !res.tempFilePath) {
            const err = { stage: 'PDF_DOWNLOAD_FAILED', errCode: res.statusCode, errMsg: 'download returned non-200 or missing tempFilePath' }
            console.error('[PDF_DOWNLOAD_FAILED]', { errCode: err.errCode, errMsg: err.errMsg })
            wx.showToast({ title: '打开失败，请稍后再试', icon: 'none' })
            return
          }
          console.info('[PDF_DOWNLOAD_OK]')
          console.info('[PDF_OPEN_REACHED]')
          const fileType = b.ext === 'txt' ? 'txt' : 'pdf'
          wx.openDocument({
            filePath: res.tempFilePath,
            fileType,
            showMenu: true,
            success: () => {
              console.info('[PDF_OPEN_OK]')
              // 旧云端书籍：计时目标仍是云端 books._id，行为与迁移前一致
              this.startReadingSession({ bookId: b._id, localId: null })
            },
            fail: err => {
              console.error('[PDF_OPEN_FAILED]', {
                errCode: err && err.errCode,
                errMsg: err && err.errMsg
              })
              wx.showToast({ title: '打开失败，请稍后再试', icon: 'none' })
            }
          })
        },
        fail: err => {
          console.error('[PDF_DOWNLOAD_FAILED]', {
            errCode: err && err.errCode,
            errMsg: err && err.errMsg
          })
          wx.showToast({ title: '打开失败', icon: 'none' })
        }
      })
    }).catch(err => {
      console.error('[PDF_DOWNLOAD_FAILED]', {
        errCode: err && err.errCode,
        errMsg: err && (err.errMsg || err.message)
      })
      wx.showToast({ title: '打开失败', icon: 'none' })
    })
  },

  onHide() { return this.stopTimer() },
  onUnload() { return this.finalizeOnUnload() },

  // ============ 阅读计时（唯一实现：utils/readingSession.js） ============
  // 真实时序与结论：
  //   1. openDocument success → startReadingSession（唯一计时入口）
  //   2. 切后台 / 切 tab / 原生 PDF 查看器覆盖页面 → onHide → settle
  //   3. 返回上一页（本页是 tab 页，通常不触发 onUnload）→ onUnload → settle
  //   4. 从后台 / 查看器回到本页 → onShow → 接着 begin（余量继续结转）
  // 单一结算：settle 第一步同步清空会话，onHide + onUnload 双触发最多结算一次。
  // 余量结转：不足一分钟的时长存进 readingCarry，下次继续攒 —— 既不丢弃真实
  //           时长，也绝不把几秒钟强行记成 1 分钟。
  // 保守取舍：wx.openDocument 拉起原生查看器时的停留时间无法可靠观测，**不计入**。
  //           宁少记、不虚构（旧实现按 1 分钟硬记属于虚构，已移除）。
  // 目标互斥：localId 存在 → 本机链路（绝不写云端 books）；
  //           否则 bookId → 旧云端链路（行为与迁移前一致）。
  // 云端书籍的 books.minutes 唯一写入方是云函数 addRead（与 readProgress 同事务），
  // 客户端不再直写 —— 见下方 addCloudBookMinutes 的说明。

  readingSession() {
    if (this._rs) return this._rs
    const page = this
    this._rs = createReadingSession({
      now: () => Date.now(),
      formatDate: fmtDate,
      newRequestId: () => newRequestId(),
      addLocalMinutes: (localId, minutes) => localBooksRepo().addMinutes(localId, minutes).then(
        r => ({
          ok: true,
          buffered: !!(r && r.buffered),
          pendingWriteFailed: !!(r && r.pendingWriteFailed),
          reason: r && r.pendingReason
        }),
        err => ({ ok: false, code: err && err.code, stage: err && err.stage })
      ),
      callDailyRead: callDailyRecord,
      bufferDailyPending: bufferDailyPending,
      // 旧云端书籍的 books.minutes：由云函数 addRead 在**同一个事务**里与
      // readProgress 一起累加（cloudfunctions/dailyRecord）。
      // 这里刻意**不再**注入客户端直写 books：
      //   ① 同一字段两个写入方 = 每次结算累计两次（历史缺陷：客户端 +1 次、
      //      云函数又 +1 次，2026-10-16 修复为单一写入方）
      //   ② 客户端直写无法与每日统计保持原子 —— 一次失败就会留下
      //      「阅读分钟记了、书没记」的中间态
      //   ③ 客户端直写没有幂等键，重放时会重复累加
      // 保留这个注入点（默认空实现）是为了 readingSession 的契约不变。
      addCloudBookMinutes: () => Promise.resolve({ ok: true, skipped: true, byServer: true }),
      getCarry: key => getCarryStore().get(key),
      setCarry: (key, ms) => getCarryStore().set(key, ms),
      reloadAfterSettle: result => page.reloadAfterSettle(result),
      // 结算成功 = 云端刚被证明可达 → 顺手重放待补报：
      // 让「已提交但未确认」的 requestId 尽快确认出队，别拖到下次 onShow
      flushPending: () => page.flushDailyPendingQuietly(),
      showToast: o => wx.showToast(o),
      logError: logErr,
      logWarn: logWrn
    })
    return this._rs
  },

  startReadingSession(target) {
    const t = target || {}
    const res = this.readingSession().begin(t)
    if (res.began) {
      // 镜像字段：便于诊断与既有断言（唯一权威仍是控制器内部状态）
      const active = this._rs.peek()
      this._start = active ? active.startedAt : Date.now()
      this._localId = t.localId || null
      this._bookId = t.bookId || null
      this._lastTarget = { localId: t.localId || null, bookId: t.bookId || null }
    } else {
      logWrn('READ_SESSION_ALREADY_ACTIVE', { reason: res.reason })
    }
    return res
  },

  stopTimer() {
    return this.settleSession('HIDE_OR_UNLOAD')
  },

  finalizeOnUnload() {
    return this.settleSession('UNLOAD').then(res => {
      // 页面销毁：清掉「回来继续读」的目标，避免下次进入误起计时
      this._lastTarget = null
      return res
    })
  },

  settleSession(reason) {
    const rs = this._rs
    if (!rs || !rs.active()) return Promise.resolve({ settled: false, reason: 'NO_ACTIVE_SESSION' })
    return rs.settle(reason).then(res => {
      this._start = null
      this._localId = null
      this._bookId = null
      return res
    })
  },

  reloadAfterSettle(result) {
    // 本机会话只刷新本机清单；云端会话保持原有 loadBooks 行为
    return (result && result.localId) ? this.loadLocalBooks() : this.loadBooks()
  }
})
