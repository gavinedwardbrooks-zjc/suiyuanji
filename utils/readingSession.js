// ============================================================
// utils/readingSession.js · 阅读计时唯一结算实现（最终版）
//
// 本模块是**全项目唯一的阅读计时结算逻辑**：
//   - pages/reading/reading.js（书架页：本机 PDF / 旧云端 PDF）
//   - pages/reading-txt/reading-txt.js（本机 TXT 内置阅读页）
// 两个入口都注入同一套控制器，因此不存在两套账。
//
// ------------------------------------------------------------
// 计时策略（明确、保守、不虚构）
// ------------------------------------------------------------
// 可确认的阅读时长 = 「计时页面处于前台可见状态」的累计时长。
//   - onShow / 打开成功后 begin
//   - onHide（切后台、切 tab、原生 PDF 查看器覆盖页面）→ settle
//   - onUnload → settle
//   - 从后台回来 / 从原生查看器回来 → onShow 再次 begin（余量继续结转）
//
// 已知的保守取舍：wx.openDocument 拉起微信原生查看器时，小程序页面会进入
// 后台（onHide），查看器里的停留时间**无法可靠观测**，因此**不计入**。
// 这是刻意的选择：宁少记、不虚构。旧实现把这种「无法确认的停留」按 1 分钟
// 硬记，属于虚构时长，本版已移除。
//
// ------------------------------------------------------------
// 余量结转（解决「不足一分钟被丢弃/被强行记成 1 分钟」）
// ------------------------------------------------------------
//   totalMs   = 本次会话时长 + 该书的既有余量
//   minutes   = floor(totalMs / 60000)      ← 只记整分钟
//   remainder = totalMs - minutes * 60000   ← 余量写回，下次继续攒
// 因此 25s + 25s + 25s = 1 分钟；单次 5s 记 0 分钟但余量保留，绝不丢弃。
//
// ------------------------------------------------------------
// 其它硬约束
// ------------------------------------------------------------
//   1. 单一结算：settle 第一步同步清空会话，onHide + onUnload + 重复调用
//      最多只结算一次
//   2. 本地单书分钟与每日阅读分钟**同源同值**（都用同一个 minutes）
//   3. 本机分钟先写，后续任何云端失败都不回滚已落地的本机分钟
//   4. 本机书籍绝不允许把 bookId 传给云端（否则会写云端 books.minutes）
//   5. 每日统计失败绝不静默丢弃：错误日志 + 待补报队列（带幂等 requestId）+ 提示
//   6. settle 永不 reject：任何意外都转成显式结果对象上报
// ============================================================

const MINUTE_MS = 60000

function pad2(n) { return String(n).padStart(2, '0') }

function fmtDate(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

let _reqSeq = 0
function newRequestId() {
  _reqSeq += 1
  return 'rd_' + Date.now().toString(36) + '_' + _reqSeq.toString(36) + '_' + Math.random().toString(36).slice(2, 8)
}

// deps:
//   now()                             -> 毫秒时间戳
//   addLocalMinutes(localId, min)     -> Promise<{ ok, buffered?, skipped?, reason?, code? }>
//   callDailyRead({action,date,minutes,requestId,bookId?}) -> Promise<{ok, code?}>
//   bufferDailyPending(entry)         -> { ok, reason? }
//   getCarry(key) / setCarry(key, ms) -> 余量读写（可省略 → 不结转）
//   reloadAfterSettle(result)         -> Promise（刷新列表，可省略）
//   showToast / logError / logWarn / formatDate / newRequestId 均可省略
function createReadingSession(deps) {
  const d = deps || {}
  const now = typeof d.now === 'function' ? d.now : () => Date.now()
  const addLocalMinutes = typeof d.addLocalMinutes === 'function'
    ? d.addLocalMinutes
    : () => Promise.resolve({ ok: true, skipped: true })
  // 没注入每日统计实现时如实上报失败：绝不默认「假装成功了」
  const callDailyRead = typeof d.callDailyRead === 'function'
    ? d.callDailyRead
    : () => Promise.resolve({ ok: false, code: 'NO_DAILY_SINK' })
  const bufferDailyPending = typeof d.bufferDailyPending === 'function'
    ? d.bufferDailyPending
    : () => ({ ok: false, reason: 'NO_PENDING_SINK' })
  const getCarry = typeof d.getCarry === 'function' ? d.getCarry : () => 0
  const setCarry = typeof d.setCarry === 'function' ? d.setCarry : () => ({ ms: 0, persisted: true })
  // 旧云端书籍的 books.minutes 累加（本机书籍绝不走这条路径）
  const addCloudBookMinutes = typeof d.addCloudBookMinutes === 'function'
    ? d.addCloudBookMinutes
    : () => Promise.resolve({ ok: true, skipped: true })
  const reloadAfterSettle = typeof d.reloadAfterSettle === 'function' ? d.reloadAfterSettle : () => Promise.resolve()
  // 待补报重放（每日统计）。仅在「云端刚被证明可达」时顺手触发（见 settle），
  // 未注入时不做任何事 —— 绝不默认假装补报过。
  const flushPending = typeof d.flushPending === 'function' ? d.flushPending : null
  const showToast = typeof d.showToast === 'function' ? d.showToast : () => undefined
  const logError = typeof d.logError === 'function' ? d.logError : () => undefined
  const logWarn = typeof d.logWarn === 'function' ? d.logWarn : () => undefined
  const formatDate = typeof d.formatDate === 'function' ? d.formatDate : fmtDate
  const makeRequestId = typeof d.newRequestId === 'function' ? d.newRequestId : newRequestId

  let session = null

  function safeGetCarry(key) {
    if (!key) return 0
    try {
      const v = Number(getCarry(key))
      return Number.isFinite(v) && v > 0 ? v : 0
    } catch (err) {
      logWarn('READ_CARRY_READ_FAILED', { key })
      return 0
    }
  }

  function safeSetCarry(key, ms) {
    if (!key) return { ms: 0, persisted: true }
    try {
      const r = setCarry(key, ms)
      return r && typeof r === 'object' ? r : { ms, persisted: true }
    } catch (err) {
      return { ms, persisted: false }
    }
  }

  function begin(target) {
    if (session) {
      // 已有会话时不覆盖：覆盖会丢掉先前那段未结算时长
      return { began: false, reason: 'ALREADY_ACTIVE' }
    }
    const t = target || {}
    const localId = t.localId ? String(t.localId) : null
    const bookId = t.bookId ? String(t.bookId) : null
    const carryKey = t.carryKey ? String(t.carryKey) : (localId ? 'L:' + localId : (bookId ? 'C:' + bookId : ''))
    session = {
      startedAt: now(),
      localId,
      bookId,
      carryKey,
      carryMs: safeGetCarry(carryKey)
    }
    return { began: true, reason: null, carryMs: session.carryMs }
  }

  function active() { return !!session }

  function isFor(localId) {
    return !!(session && session.localId && session.localId === localId)
  }

  function peek() {
    return session ? Object.assign({}, session) : null
  }

  // 中途放弃：清空会话但把已发生的时长结转到余量（不产生分钟）
  function abort(reason) {
    if (!session) return Promise.resolve({ settled: false, reason: 'NO_ACTIVE_SESSION' })
    const s = session
    session = null
    const elapsed = Math.max(0, Number(now()) - Number(s.startedAt) || 0)
    const totalMs = s.carryMs + elapsed
    const minutes = Math.floor(totalMs / MINUTE_MS)
    const remainder = totalMs - minutes * MINUTE_MS
    const persisted = safeSetCarry(s.carryKey, remainder)
    if (persisted && persisted.persisted === false) {
      logError('READ_CARRY_WRITE_FAILED', { key: s.carryKey, reason })
    }
    return Promise.resolve({
      settled: true,
      aborted: true,
      reason,
      minutes: 0,
      carryMs: remainder,
      localId: s.localId,
      bookId: s.bookId,
      dailySynced: null,
      dailyFailed: false,
      recorded: false
    })
  }

  function reset() { session = null }

  function settle(reason) {
    if (!session) return Promise.resolve({ settled: false, reason: 'NO_ACTIVE_SESSION' })
    const s = session
    // 原子清空：重复触发（onHide + onUnload / 连续点击）不得二次结算
    session = null

    const elapsedRaw = Number(now()) - Number(s.startedAt)
    const elapsed = Number.isFinite(elapsedRaw) && elapsedRaw > 0 ? elapsedRaw : 0
    const totalMs = s.carryMs + elapsed
    const minutes = Math.floor(totalMs / MINUTE_MS)
    const remainder = totalMs - minutes * MINUTE_MS
    const date = formatDate(new Date())

    // 不足一分钟：不记分钟、不调云端、不提示；余量原样存回，绝不丢弃、绝不强行记 1 分钟
    if (minutes <= 0) {
      const carryRes = safeSetCarry(s.carryKey, remainder)
      if (carryRes && carryRes.persisted === false) {
        logError('READ_CARRY_WRITE_FAILED', { key: s.carryKey, reason })
      }
      return Promise.resolve({
        settled: true,
        reason,
        minutes: 0,
        carryMs: remainder,
        localId: s.localId,
        bookId: s.bookId,
        dailySynced: null,
        dailyFailed: false,
        recorded: false
      })
    }

    // 1) 本机单书分钟：先写；后续任何失败都不得回滚
    const localMinutes = s.localId
      ? Promise.resolve()
        .then(() => addLocalMinutes(s.localId, minutes))
        .then(
          r => ({
            ok: !(r && r.ok === false),
            skipped: !!(r && r.skipped),
            buffered: !!(r && r.buffered),
            pendingWriteFailed: !!(r && r.pendingWriteFailed),
            reason: r && r.reason,
            code: r && r.code
          }),
          err => ({ ok: false, code: err && err.code, stage: err && err.stage })
        )
      : Promise.resolve({ ok: true, skipped: true })

    // 1b) 旧云端书籍：books.minutes 继续累加（行为与迁移前一致）。
    //     本机书籍绝不走这条路径 —— 否则会让云端 books 出现幽灵分钟。
    const cloudBookMinutes = (!s.localId && s.bookId)
      ? Promise.resolve()
        .then(() => addCloudBookMinutes(s.bookId, minutes))
        .then(
          r => ({ ok: !(r && r.ok === false) }),
          err => {
            logError('CLOUD_BOOK_MINUTES_FAILED', { errCode: err && err.errCode, errMsg: err && err.errMsg })
            return { ok: false }
          }
        )
      : Promise.resolve({ ok: true, skipped: true })

    // 2) 每日阅读统计：本机书籍**不带 bookId**，云函数因此不会触碰云端 books。
    //    带稳定 requestId：超时/响应丢失后重放不会重复累计。
    const requestId = String(makeRequestId())
    const dailyData = { action: 'addRead', date, minutes, requestId }
    if (!s.localId && s.bookId) dailyData.bookId = s.bookId
    const dailyRead = Promise.resolve()
      .then(() => callDailyRead(dailyData))
      .then(res => {
        const r = res && res.result !== undefined ? res.result : res
        if (!r || r.ok !== true) return { ok: false, code: (r && r.code) || 'DAILY_RECORD_NOT_OK' }
        return { ok: true }
      })
      .catch(err => ({ ok: false, code: 'DAILY_RECORD_CALL_FAILED', errMsg: err && (err.errMsg || err.message) }))

    return localMinutes
      .then(lr => {
        if (lr && lr.ok === false && lr.skipped) {
          logWarn('LOCAL_MINUTES_SKIPPED', { reason: lr.reason, minutes, localId: s.localId })
        } else if (lr && lr.ok === false) {
          logError('LOCAL_MINUTES_WRITE_FAILED', { code: lr.code, stage: lr.stage, minutes })
        } else if (lr && lr.pendingWriteFailed) {
          logError('LOCAL_MINUTES_PENDING_FAILED', { reason: lr.reason, minutes })
        } else if (lr && lr.buffered) {
          logWarn('LOCAL_MINUTES_BUFFERED', { minutes })
        }
        return dailyRead
      })
      .then(dr => {
        const dailyOk = !(dr && dr.ok === false)
        if (dailyOk && flushPending) {
          // 云端刚被证明可达 → 顺手把待补报重放一次（不 await、不阻塞结算、绝不上抛）。
          // 目的：让「已提交但未确认」的 requestId 尽快被确认并出队，而不是拖到下次
          // onShow —— 缩短「未确认」窗口本身是有价值的（云端窗口已大到真实数据下不会
          // 淘汰，服务端幂等也已原子化，所以这只是时效优化，不是正确性前提）。
          // 重放本身带单飞锁，叠加调用是安全的。
          Promise.resolve()
            .then(() => flushPending())
            .catch(err => logWarn('DAILY_PENDING_FLUSH_FAILED', { code: err && err.code }))
        }
        if (!dailyOk) {
          // 明确处理，绝不静默丢弃：错误日志 + 待补报队列 + 用户可见提示
          logError('DAILY_READ_SYNC_FAILED', { code: dr.code, minutes, date, localId: s.localId, requestId })
          let q = null
          try {
            q = bufferDailyPending({ date, minutes, localId: s.localId, bookId: s.localId ? null : s.bookId, requestId, at: now() })
          } catch (err) {
            q = { ok: false, reason: 'PENDING_SINK_THREW' }
          }
          if (!q || q.ok !== true) logError('DAILY_PENDING_WRITE_FAILED', { reason: q && q.reason })
          showToast({ title: '今日阅读统计未同步，已记为待补报', icon: 'none' })
        }
        return dailyOk
      })
      .then(dailyOk => cloudBookMinutes.then(cb => ({ dailyOk, cloudOk: cb.ok })))
      .then(({ dailyOk, cloudOk }) => {
        const carryRes = safeSetCarry(s.carryKey, remainder)
        if (carryRes && carryRes.persisted === false) {
          logError('READ_CARRY_WRITE_FAILED', { key: s.carryKey, reason })
        }
        return {
          settled: true,
          reason,
          minutes,
          carryMs: remainder,
          localId: s.localId,
          bookId: s.bookId,
          requestId,
          dailySynced: dailyOk === true,
          dailyFailed: dailyOk !== true,
          cloudBookMinutesOk: cloudOk,
          recorded: true
        }
      })
      .then(result => Promise.resolve()
        .then(() => reloadAfterSettle(result))
        .catch(err => {
          logWarn('RELOAD_AFTER_SETTLE_FAILED', { code: err && err.code })
        })
        .then(() => result))
      .catch(err => {
        logError('SETTLE_UNEXPECTED', { code: err && err.code, reason })
        return {
          settled: true,
          reason,
          minutes,
          carryMs: remainder,
          localId: s.localId,
          bookId: s.bookId,
          dailySynced: false,
          dailyFailed: true,
          recorded: true,
          unexpected: true
        }
      })
  }

  return { begin, active, isFor, peek, reset, abort, settle }
}

module.exports = {
  MINUTE_MS,
  pad2,
  fmtDate,
  newRequestId,
  createReadingSession
}
