// ============================================================
// dailyRecord · 云函数（PRD v0.6 §6.1 / §2.3 / §4.2 R1）
// action: 'get' | 'save' | 'addRead'
// save 幂等契约：
//   - 必带 requestId（前端 UUID）+ revision（新记录 0 → 首次落库 1 → 每次成功 +1）
//   - 重复 requestId → 幂等返回当前 revision，不重复写
//   - revision 不匹配（乐观锁）→ REV_CONFLICT，拒绝覆盖
// ============================================================
const cloud = require('wx-server-sdk')
const notify = require('./notify')
const wishScope = require('./wish-scope')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const SCHEMA_VERSION = 2

// ============================================================
// addRead · 服务端原子幂等（2026-10-16）
//
// 目标：同一个 requestId **即使并发到达，也最多累计一次**。不依赖客户端单飞锁，
// 也不依赖幂等窗口的容量 —— 这两者都只是缓解措施，不会成为幂等性的依据。
//
// 手段：云开发数据库事务（db.runTransaction；仅云函数可用，wx-server-sdk ≥ 1.7.0）
//   · 快照隔离 + 写锁：并发事务写同一条文档时，后到者必然失败而不是覆盖写，
//     不会出现「两个事务都读到旧值、各自 +N」的丢失更新
//   · runTransaction 自带冲突自动重试：重试时读到的是已提交的快照，于是能读到
//     对方刚写入的那条 requestId，直接返回 idempotent:true
//   → 「读 readRequestIds → 判重 → 累加」成为**一个原子操作**，「先查后写」的
//     竞态窗口在服务端被消除，而不是被客户端锁掩盖。
//
// 事务的能力边界（决定了下面代码的形状）：
//   · 事务内不支持 where 批量操作，只支持 collection.doc / collection.add
//     ⇒ 当日文档的 _id 必须在事务外先确定；新文档使用确定性 _id
//   · 事务内无法「先查是否存在再决定写什么」之外的复杂分支
//     ⇒ 创建与累加被拆成两条各自原子的路径（见 applyAddRead）
//
// books.minutes 与 readProgress 在**同一个事务**里累加：要么都生效、要么都不生效，
// 不存在「阅读分钟记了但书没记」的中间态。调用方因此不再直写云端 books
// （单一写入方，见 pages/reading/reading.js 的注释）。
//
// 回归测试：tests/daily-record-atomic.test.js（真实云函数逻辑 + 可复现并发的
// 数据库替身：并发同一/不同 requestId、失败注入、跨实例、重放）
// ============================================================
const TX_MAX_ATTEMPTS = 3

// 幂等键窗口。**按天隔离**的数组：每个日期文档只承载当天的结算键，
// 不存在跨年累积问题。上界推导（这才是「窗口不再是一道靠容量赌大小的闸门」的原因）：
//   · 每条幂等键都对应一次 minutes > 0 的结算 ⇒ 每条键至少代表 1 个已累计分钟
//   · 一天只有 1440 分钟 ⇒ 单日数组的**自然上界是 1440**
//   · 取 1600 > 1440 ⇒ 真实数据下**不可能发生淘汰**
// 1600 个键 ≈ 45KB，远低于单文档 16MB 上限。
// 注意：原子性由事务保证，本常量只负责「内存有界」；即使窗口被撑爆，
// 也不会退回「非法双记」——因为判重与累加在同一事务内。
// 对应回归测试：tests/daily-record-atomic.test.js 的 WINDOW_COVERS_PHYSICAL_DAILY_BOUND
const MAX_READ_REQUEST_IDS = 1600
const MINUTES_PER_DAY = 1440

// 惰性迁移：schemaVersion 缺失 = v1 → 2（幂等，仅补字段）
function migrate(doc) {
  if (!doc) return doc
  if (doc.schemaVersion >= SCHEMA_VERSION) return doc
  return { ...doc, schemaVersion: SCHEMA_VERSION }
}

// 心愿同步（SoT = wishes collection；daily_records 保留当天快照）
// 错误策略（2026-08-27 集成修复）：单条同步失败 → 不阻断主记录保存（业务成功），
// 但必须返回 wishSyncFailed 明确标志 + console.error，禁止无痕丢失。
//
// 关系归属（P0 隐私隔离 · 2026-10-18）：
//   每条心愿在创建时写入 coupleId —— 由云函数按 users.coupleId + couples(status=active)
//   推导，**不接受前端传入**；未绑定则显式写 null（便于精确判重、且永远不会被
//   当成任何人当前关系的心愿）。
//   判重也按关系作用域：同属主 + 同类型 + 同文本 + 同一段关系才算重复。
//   这样「换伴侣后重新许下同一个愿望」会正常生成新记录，而不会被上一段关系的
//   旧文档挡住（旧文档既不复用、也不改写、更不删除）。
//
// 业务日期归属（2026-10-26 · 用户批准）：
//   判重从 `openid + type + text`（关系作用域内）扩展为
//   `openid + coupleId + wishDate + type + text`：
//     · wishDate = **记录自身的 date**（服务端校验格式），客户端传不了；
//     · 同一天重复保存 → 命中判重，不新增；
//     · 不同日期的相同文本 → 各建一条（这正是本轮要修的缺陷）；
//     · createdAt 仍然只表示「真实写库时间」，语义不变；状态流转不改它。
//   记录日期非法（不是真实存在的 YYYY-MM-DD）→ 心愿同步直接跳过并回报
//   wishSyncSkipped='record-date-invalid'，绝不写一个没法归属的 wishDate。
//
//   写入侧的第二道闸门（本轮新增）：只有**产生于当前关系**的那条记录才可以
//   派生心愿。理由：心愿只能来自「当天的记录」，而一条记录的 coupleId 是创建时
//   写死的（之后覆盖保存也不会变）。于是：
//     · existing.coupleId === 当前关系  → 允许（正常路径）
//     · existing.coupleId 不等 / 未绑定 → 拒绝（上一段关系的记录不得向新关系产愿）
//     · existing 根本没有 coupleId 字段 → 无法证明归属 → 拒绝（fail-closed）
//   「记录创建于关系之外」这种边界（先记录、后绑定）同样拒绝：宁可这条不共享，
//   也不把可能来自上一段关系的文本带进新关系；调用方会收到 wishSyncSkipped。
// recordCoupleId 的三种取值：
//   'CZ-xxx'  库里有明确的关系标记
//   null      库里明确标记为「创建时未绑定」
//   undefined 库里**没有**这个字段（历史记录 / 关系解析失败）→ 不可证明
function canSyncWishes(recordCoupleId, ctx) {
  if (!ctx) return false                                   // 关系解析失败 → 绝不猜
  if (recordCoupleId === undefined) return false            // 字段缺失 → 不可证明
  return (recordCoupleId || null) === (ctx.coupleId || null)
}

async function syncWishes(openid, wishes, recordCoupleId, ctx, wishDate) {
  const list = Array.isArray(wishes) ? wishes : []
  const hasAny = list.some(w => w && String(w.text || '').trim())
  // 业务日期无效 → 不写、不猜。宁可这条不同步（调用方会看到 wishSyncSkipped），
  // 也不写入一个既不能展示、也不能正确判重的 wishDate。
  if (!wishScope.isValidBizDate(wishDate)) {
    if (hasAny) {
      console.error('[wish-sync-skip]', JSON.stringify({
        openid, reason: 'record-date-invalid', date: String(wishDate || '')
      }))
    }
    return { synced: 0, failed: false, created: [], skipped: hasAny ? 'record-date-invalid' : null }
  }
  // ctx === null 只代表「关系解析抛错」——这是基础设施故障，不是「判定为不同关系」。
  // 有心愿时按失败上报（客户端会提示稍后重试），一条都不写，绝不猜归属。
  if (!ctx) {
    if (hasAny) {
      console.error('[wish-scope-unresolved]', JSON.stringify({ openid, count: list.length }))
    }
    return { synced: 0, failed: hasAny, created: [], skipped: null }
  }
  // 闸门先于一切写入：不满足就直接返回，不建文档、不改归属
  if (!canSyncWishes(recordCoupleId, ctx)) {
    if (hasAny) {
      console.warn('[wish-sync-skip]', JSON.stringify({
        openid,
        reason: 'record-not-in-couple',
        recordCoupleId: recordCoupleId === undefined ? 'absent' : recordCoupleId,
        coupleId: ctx ? ctx.coupleId : 'unresolved'
      }))
    }
    return { synced: 0, failed: false, created: [], skipped: hasAny ? 'record-not-in-couple' : null }
  }
  if (!list.length) return { synced: 0, failed: false, created: [], skipped: null }
  const col = db.collection('wishes')
  let synced = 0
  const created = []
  for (const w of list) {
    if (!w || !w.text) continue
    const text = String(w.text).trim()
    if (!text) continue
    try {
      // 查重不限 status：同一段关系内、同 openid+type+trim 文本**同一天**已存在
      // （pending 或 done_by_partner）→ 跳过。
      // 保证：不重复创建；已「已安排」的心愿不会被再次保存的 record 重建 pending 副本；
      //       不同日期的相同文本各自独立（wishDate 不同 ⇒ 不算重复）。
      // 查重条件保持 `_openid + type + text`（沿用既有索引与行为），
      // 关系作用域与业务日期都在内存里复核：
      //   · isSameScope   → 只与同一段关系（或同为未绑定）的文档比较
      //   · isSameWishDate→ wishDate 严格等值；历史文档退回 createdAt 的北京日期
      //                      （仅用于避免重复创建，不当作展示归属依据）
      const dup = await col.where({ _openid: openid, type: w.type, text }).get()
      const candidates = dup.data || []
      const sameScope = candidates.filter(d => wishScope.isSameScope(d, ctx) && wishScope.isSameWishDate(d, wishDate))
      if (sameScope.length === 0) {
        const added = await col.add({
          data: {
            _openid: openid,
            // 关系标识：生效关系 → coupleId；未绑定 → null
            coupleId: wishScope.coupleIdForWrite(ctx),
            // 业务日期：恒等于记录自身的 date（服务端已校验），一经写入不再改动
            wishDate,
            type: w.type,
            text,
            status: 'pending',
            createdAt: Date.now()
          }
        })
        synced++
        created.push({ _id: (added && added._id) || null, type: w.type })
      }
    } catch (e) {
      console.error('[wish-sync-fail]', JSON.stringify({ openid, type: w.type, text, error: (e && (e.errMsg || e.message)) || String(e) }))
      return { synced, failed: true, created, skipped: null }
    }
  }
  return { synced, failed: false, created, skipped: null }
}

// ============================================================
// 新增心愿 → 微信订阅消息通知另一半（旁路，永不回滚业务）
//
// 触发点：本函数是心愿的唯一创建入口（record 页保存 → save → syncWishes），
//   所以「她新增了一条心愿」在这里判定最可靠：只有**真的新建了** wish 文档才通知，
//   重复保存 / 重试 / 编辑都会因 dup 判重而不产生新文档 ⇒ 天然幂等。
// 接收者：由服务端 users.coupleId + couples(status=active) 推导（见 notify.js），
//   前端无法指定接收者；解绑后 status 不再是 active ⇒ 不会继续发给旧伴侣。
// 内容：只说「新增了一条心愿」，不含心愿正文（隐私）。
// 失败：未配置模板 / 未授权 / 发送失败 → 只写 createdNotifySkipped，
//   绝不影响已保存的记录，也不会让调用方看到失败。
// ============================================================
async function notifyNewWishes(openid, created) {
  const list = (created || []).filter(x => x && x._id)
  if (!list.length) return { sent: false, reason: 'none' }
  // expectRole='her'：心愿的属主是她，她也只看得见自己的心愿。
  // 如果他（him）那边也建了心愿，她看不到，通知过去只会指向不存在的内容 —— 因而不发。
  const r = await notify.sendCoupleNotice({ db, cloud, env: process.env, openid, kind: 'wish', expectRole: 'her' })
  // 记账标记失败不影响任何业务
  for (const w of list) {
    try {
      await db.collection('wishes').doc(w._id).update({
        data: r.sent ? { createdNotifyAt: Date.now() } : { createdNotifySkipped: true }
      })
    } catch (e) {
      console.warn('[wish-notify-flag-fail]', (e && (e.errMsg || e.message)) || '')
    }
  }
  return r
}

// ============================================================
// addRead 的原子实现（全部走事务）
// ============================================================

// 当日文档的确定性 _id：同一用户 + 同一天恒定映射到同一条文档。
// 仅在**新建**时使用；已存在的遗留文档（随机 _id）继续沿用它自己的 _id，
// 不迁移、不重写（避免动历史数据）。
function dailyRecordId(openid, date) {
  return 'dr_' + openid + '_' + date
}

// books 文档是否存在：用 where 查而不是 doc().get()。
// 文档不存在时 where 返回空数组（不抛错）⇒ 不需要依赖 throwOnNotFound 选项，
// 也不需要解析任何错误码来区分「不存在」与「真故障」。
// 查询本身失败 → 本次不累加 books.minutes（宁可少记书、不可重复记书），并留下告警。
async function cloudBookExists(bookId) {
  if (!bookId) return false
  try {
    const r = await db.collection('books').where({ _id: String(bookId) }).get()
    return !!(r && r.data && r.data.length)
  } catch (e) {
    console.warn('[addRead] books 存在性检查失败，本次不累加 books.minutes', JSON.stringify({
      bookId, errMsg: e && (e.errMsg || e.message)
    }))
    return false
  }
}

// books.minutes 与 readProgress 必须在同一个事务里累加：要么都生效、要么都不生效。
// bookOk 为假（书籍不存在 / 存在性检查失败）时跳过，绝不让「书没了」把阅读分钟一起拖失败。
function bumpCloudBook(t, bookId, bookOk, minutes) {
  if (!bookOk) return Promise.resolve()
  return t.collection('books').doc(String(bookId)).update({ data: { minutes: _.inc(minutes) } })
}

// 路径一：当日文档已存在 → 一个事务内完成「判重 + 累加 readProgress + 累加 books.minutes」。
// 并发同一 requestId：快照隔离 + 写锁保证两个事务不会都读到旧值；冲突方会自动重试，
// 重试时读到已提交的 readRequestIds ⇒ 命中判重 ⇒ 返回 idempotent:true，不重复累加。
function addReadToExisting(recId, ctx) {
  return db.runTransaction(async t => {
    const got = await t.collection('daily_records').doc(recId).get()
    const rec = got && got.data
    if (!rec) {
      // 防御：文档在 where 与事务之间被删掉（正常业务不会发生）。
      // fail-closed：抛错回滚，让调用方把这条结算留在待补报里重试，绝不凭空新建覆盖。
      const err = new Error('daily_records 文档不存在: ' + recId)
      err.code = 'REC_NOT_FOUND'
      throw err
    }
    const applied = Array.isArray(rec.readRequestIds) ? rec.readRequestIds : []
    if (ctx.requestId && applied.indexOf(ctx.requestId) !== -1) {
      // 已生效过：不写任何东西（连 books 也不碰），返回当前累计值
      return { idempotent: true, readProgress: rec.readProgress || 0 }
    }
    const data = { readProgress: _.inc(ctx.minutes), schemaVersion: SCHEMA_VERSION }
    // 不带 requestId 的旧调用方：完全不触碰 readRequestIds，写入面与 V1 逐字段一致
    if (ctx.requestId) {
      data.readRequestIds = applied.concat([ctx.requestId]).slice(-MAX_READ_REQUEST_IDS)
    }
    await t.collection('daily_records').doc(recId).update({ data })
    await bumpCloudBook(t, ctx.bookId, ctx.bookOk, ctx.minutes)
    return { idempotent: false }
  }, TX_MAX_ATTEMPTS)
}

// 路径二：当日文档还不存在 → 用 add + 确定性 _id 在事务内创建（连同 books.minutes）。
// add 带显式 _id 受唯一约束保护：并发创建时只有一个能成功，另一个必然失败，
// 由 applyAddRead 复核后改走「已存在」路径 —— 因此绝不会出现同一用户同一天两条记录。
function addReadNewRecord(recId, ctx) {
  return db.runTransaction(async t => {
    await t.collection('daily_records').add({
      data: {
        _id: recId,
        _openid: ctx.openid,
        date: ctx.date,
        readProgress: ctx.minutes,
        readRequestIds: ctx.requestId ? [ctx.requestId] : [],
        schemaVersion: SCHEMA_VERSION,
        createdAt: Date.now()
      }
    })
    await bumpCloudBook(t, ctx.bookId, ctx.bookOk, ctx.minutes)
    return { idempotent: false, created: true }
  }, TX_MAX_ATTEMPTS)
}

// 落点选择：先确认当日文档是否已存在（事务外只读查询），再走对应的原子路径。
async function applyAddRead(ctx) {
  const col = db.collection('daily_records')
  const ex = (await col.where({ _openid: ctx.openid, date: ctx.date }).get()).data
  if (ex.length) return addReadToExisting(ex[0]._id, ctx)

  const recId = dailyRecordId(ctx.openid, ctx.date)
  try {
    return await addReadNewRecord(recId, ctx)
  } catch (e) {
    // 并发创建撞 _id 唯一约束是**预期路径**：复核一次，确认文档已存在就走累加路径
    // （累加路径里的判重会把「其实是我已经写进去的」认出来）。
    // 复核后仍然不存在 → 说明是真实故障，原样上抛（fail-closed，绝不吞掉）。
    const again = (await col.where({ _openid: ctx.openid, date: ctx.date }).get()).data
    if (!again.length) throw e
    return addReadToExisting(again[0]._id, ctx)
  }
}

exports.main = async (event = {}, context) => {
  const { OPENID } = cloud.getWXContext()
  if (!OPENID) return { ok: false, msg: '未获取到用户身份' }

  const col = db.collection('daily_records')

  // ---- get ----
  // 除记录本身外，额外返回服务端判定的**当前生效关系**（coupleId）。
  // 客户端据此判断「这份记录是不是当前关系的」，从而决定要不要把心愿回填到表单
  // （跨情侣回填是记录页最现实的一条泄露路径，因此归属判定必须由服务端给出）。
  // 关系解析失败 → coupleId 返回 null，客户端会按「不同关系」处理（不回填）。
  if (event.action === 'get') {
    const r = (await col.where({ _openid: OPENID, date: event.date }).get()).data[0]
    let coupleId = null
    try {
      const scope = await wishScope.resolveContext(db, OPENID)
      coupleId = scope.coupleId || null
    } catch (e) {
      console.warn('[dailyRecord.get] 关系解析失败，按未绑定返回', (e && (e.errMsg || e.message)) || '')
      coupleId = null
    }
    return { ok: true, record: r ? migrate(r) : null, coupleId }
  }

  // ---- addRead（累加阅读分钟：服务端原子幂等 + V1 兼容）----
  // 契约：
  //   · 可带 requestId（阅读结算时为每条结算生成的稳定 id）
  //   · 同一天内重复提交同一 requestId → 只累加一次，返回 idempotent:true
  //     （**并发提交也只累加一次**：判重与累加在同一个事务内完成）
  //   · 不带 requestId 的旧调用方行为完全不变（每次都累加，写入面与 V1 一致）
  //   · minutes ≤ 0 → 跳过不写库；缺 date → BAD_ARGS
  if (event.action === 'addRead') {
    const minutes = Number(event.minutes) || 0
    const date = event.date
    if (!date) return { ok: false, code: 'BAD_ARGS', msg: '缺少 date' }
    if (!(minutes > 0)) {
      // 非正数不再写出无意义的累加（例如余量结转为 0 分钟的请求）：
      // 明确回报跳过，不写库、不报错
      return { ok: true, skipped: true, msg: 'minutes 必须为正' }
    }
    if (typeof db.runTransaction !== 'function') {
      // 事务不可用时不退回「先查后写」：那正是本次要消除的竞态。
      // 明确失败，让客户端把这条结算留在待补报里等环境修好后重放（不会丢，也不会双记）。
      console.error('[addRead] 当前数据库句柄不支持 runTransaction（需要 wx-server-sdk ≥ 1.7.0 且在云函数内运行）；拒绝以非原子方式写入')
      return { ok: false, code: 'TX_UNSUPPORTED', retryable: true, msg: '当前环境不支持数据库事务，无法保证原子幂等' }
    }
    const requestId = event.requestId ? String(event.requestId) : ''
    // books 存在性在事务外查（事务内不允许 where）：只影响「要不要顺带累加 books.minutes」
    const bookOk = await cloudBookExists(event.bookId)
    try {
      const r = await applyAddRead({ openid: OPENID, date, minutes, requestId, bookId: event.bookId, bookOk })
      if (r && r.idempotent) return { ok: true, idempotent: true, readProgress: r.readProgress }
      return { ok: true }
    } catch (e) {
      console.error('[addRead-fail]', JSON.stringify({
        date, requestId, errCode: e && e.errCode, errMsg: e && (e.errMsg || e.message)
      }))
      return { ok: false, code: 'TX_FAILED', retryable: true, msg: '阅读统计写入失败，已保留待补报' }
    }
  }

  // ---- save（幂等 + revision 契约）----
  const date = event.date
  const requestId = event.requestId
  if (!date) return { ok: false, code: 'BAD_ARGS', msg: '缺少 date' }
  if (!requestId) return { ok: false, code: 'BAD_ARGS', msg: '缺少 requestId' }
  const clientRevision = typeof event.revision === 'number' ? event.revision : 0

  const payload = {
    goals: event.goals || [],
    todos: event.todos || [],
    segments: event.segments || { life: '', work: '', growth: '' },
    mood: event.mood || { type: 'calm', weather: 'sunny' },
    wishes: event.wishes || [],
    score: typeof event.score === 'number' ? event.score : null,
    readProgress: event.readProgress || 0
  }

  const existing = (await col.where({ _openid: OPENID, date }).get()).data[0]

  // 心愿业务日期 = 这条记录自身的 date（客户端传的是「页面上是哪一天」，不是时间戳）。
  // 服务端只校验格式与真实性；非法就不同步心愿（见 syncWishes 的 record-date-invalid）。
  const wishDate = wishScope.isValidBizDate(date) ? date : ''

  // 关系上下文：一次解析，创建与心愿同步共用。
  // 解析失败 → ctx = null → 既不写 coupleId（不猜归属），也不同步心愿。
  // 业务本身（记录保存）照常成功，失败只体现在 wishSyncSkipped 上。
  let scopeCtx = null
  try {
    const scope = await wishScope.resolveContext(db, OPENID)
    scopeCtx = wishScope.contextOf(scope.couple)
  } catch (e) {
    console.error('[wish-scope-fail]', JSON.stringify({ openid: OPENID, error: (e && (e.errMsg || e.message)) || String(e) }))
    scopeCtx = null
  }

  // 幂等：同 requestId 已处理 → 直接返回当前 revision（不重复写）
  if (existing && existing.lastRequestId === requestId) {
    return { ok: true, revision: existing.revision, idempotent: true, coupleId: scopeCtx ? scopeCtx.coupleId : null }
  }

  if (!existing) {
    // 新记录：客户端 revision 必须为 0（缺失按 0）；否则视为冲突
    if (clientRevision !== 0) {
      return { ok: false, code: 'REV_CONFLICT', msg: '记录已存在，请刷新', revision: null }
    }
    // 记录的关系标记：**只在创建时写一次**，之后任何覆盖保存都不改写。
    // 这样「这条记录产生于哪一段关系」成为不可变证据，读取侧才能据此判权限。
    // 解析失败时不写该字段（保持「不可证明」），写 null 只用于「已确认未绑定」。
    const coupleMark = scopeCtx ? { coupleId: scopeCtx.coupleId || null } : {}
    await col.add({
      data: { _openid: OPENID, date, ...payload, ...coupleMark, revision: 1, lastRequestId: requestId, schemaVersion: SCHEMA_VERSION, createdAt: Date.now(), updatedAt: Date.now() }
    })
    const recordCoupleId = scopeCtx ? (scopeCtx.coupleId || null) : undefined
    const wishSync = await syncWishes(OPENID, event.wishes, recordCoupleId, scopeCtx, wishDate)
    const notice = await notifyNewWishes(OPENID, wishSync.created)
    if (wishSync.failed) {
      return { ok: true, revision: 1, wishSyncFailed: true, wishNotifySent: notice.sent, msg: '记录已保存，心愿同步失败，请稍后重试', coupleId: scopeCtx ? scopeCtx.coupleId : null }
    }
    return {
      ok: true,
      revision: 1,
      wishNotifySent: notice.sent,
      wishNotifyReason: notice.reason,
      wishSyncSkipped: wishSync.skipped || null,
      coupleId: scopeCtx ? scopeCtx.coupleId : null
    }
  }

  // V1 兼容：旧记录无 revision 字段 → 先补 revision=0（仅补契约字段，不删/不改业务数据），
  // 使乐观锁 where {revision: 0} 可匹配，老记录首次保存成功而非误判冲突
  if (existing.revision === undefined) {
    await col.doc(existing._id).update({ data: { revision: 0 } })
    existing.revision = 0
  }

  // 乐观锁更新：仅当云端 revision === 客户端 revision 才允许覆盖
  const upd = await col.where({ _openid: OPENID, date, revision: clientRevision }).update({
    data: { ...payload, revision: existing.revision + 1, lastRequestId: requestId, schemaVersion: SCHEMA_VERSION, updatedAt: Date.now() }
  })
  if (!upd.stats || upd.stats.updated === 0) {
    return { ok: false, code: 'REV_CONFLICT', msg: '内容已被更新，请刷新后合并', revision: existing.revision }
  }
  // 更新已有记录：coupleId 不在 payload 里（不改写归属）。
  // 字段缺失（历史记录）→ undefined → 心愿同步会被闸门拒绝。
  const existingCoupleId = Object.prototype.hasOwnProperty.call(existing, 'coupleId')
    ? existing.coupleId
    : undefined
  const wishSync = await syncWishes(OPENID, event.wishes, existingCoupleId, scopeCtx, wishDate)
  const notice = await notifyNewWishes(OPENID, wishSync.created)
  if (wishSync.failed) {
    return { ok: true, revision: existing.revision + 1, wishSyncFailed: true, wishNotifySent: notice.sent, msg: '记录已保存，心愿同步失败，请稍后重试', coupleId: scopeCtx ? scopeCtx.coupleId : null }
  }
  return {
    ok: true,
    revision: existing.revision + 1,
    wishNotifySent: notice.sent,
    wishNotifyReason: notice.reason,
    wishSyncSkipped: wishSync.skipped || null,
    coupleId: scopeCtx ? scopeCtx.coupleId : null
  }
}
