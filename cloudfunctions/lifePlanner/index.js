// ============================================================
// lifePlanner · 云函数（PRD v0.8 M7 — 今天吃什么）
// actions:
//   seedRecipes      — 初始化 50 道菜 seed（幂等；数量不符 → SEED_MISMATCH）
//   listRecipes      — 列出菜谱（分类筛选可选）
//   randomMeal       — 随机 1 小荤 + 1 素菜 + 1 汤（fail-closed）
//   getRecipe        — 详情
//   saveRecipe       — 人工编辑（requestId + revision 契约）
//   regenerateRecipe — AI 重新生成（返回 draft，不直接覆盖；二次确认后 saveRecipe 落库）
//
// 安全：仅 active couple 的 her/him 可访问（superseded/未绑定 → NOT_ACTIVE）
// recipes 为共享集合（不依赖 _openid 归属），鉴权由本云函数执行
// AI Key 复用 M6 环境变量（AI_API_URL / AI_API_KEY / AI_MODEL）
// ============================================================
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const https = require('https')
const { SEED_RECIPES, SEED_VERSION, validateSeed } = require('./recipes-seed')
const { TRAVEL_PLACES, TRAVEL_SEED_VERSION, validateTravelSeed } = require('./travel-places-seed')
// V1.1：今日决定（吃什么 / 去哪里）的纯逻辑（日期 / 确定性 ID / 参数形状）
const dayChoice = require('./day-choice')

const TRAVEL_PERIODS = ['morning', 'noon', 'afternoon', 'evening']
const TRAVEL_STALE_HINT = '行程仅供参考。开放时间、预约规则、票价及交通信息可能调整，出发前请以官方最新信息为准。'

const AI_URL = process.env.AI_API_URL || ''
const AI_KEY = process.env.AI_API_KEY || ''
const AI_MODEL = process.env.AI_MODEL || 'gpt-3.5-turbo'

// ---------- 情侣鉴权（active her/him） ----------
async function getActiveCouple(openid) {
  const me = (await db.collection('users').where({ _openid: openid }).get()).data[0]
  if (!me || !me.coupleId) return null
  const c = (await db.collection('couples').where({ coupleId: me.coupleId, status: 'active' }).get()).data[0]
  if (!c) return null
  return { couple: c, me }
}

// 严格版鉴权（V1.1 今日决定专用，不改动上面那个既有 helper 的行为）：
// 除「users.coupleId 指向 active 关系」外，还要求 OPENID 真的是这段关系的成员。
// 原因：couples 里同时有 herOpenid / himOpenid，只按 coupleId 等值查会把
// 「人工改库 / 换绑中断后遗留的 coupleId」变成越权入口。角色也以 couples 文档为准，
// 不读 users.role（users 字段可被历史数据写歪，couples 才是这段关系的权威）。
async function getActiveCoupleStrict(openid) {
  const me = (await db.collection('users').where({ _openid: openid }).get()).data[0]
  if (!me || !me.coupleId) return null
  const c = (await db.collection('couples').where({ coupleId: me.coupleId, status: 'active' }).get()).data[0]
  if (!c) return null
  const isHer = c.herOpenid === openid
  const isHim = c.himOpenid === openid
  if (!isHer && !isHim) return null
  return {
    couple: c,
    me,
    role: isHer ? 'her' : 'him',
    partnerOpenid: isHer ? (c.himOpenid || null) : (c.herOpenid || null)
  }
}

// 读取某一天的确认结果（零写入）。
// fail-closed：文档不存在 / 不是这一天 / coupleId 与当前关系不符 → 一律返回 null，
// 绝不因为「键算出来一样」就把上一段关系（或哈希碰撞到的别人）的决定交出去。
async function readDayChoice(couple, date, kind) {
  const id = dayChoice.choiceDocId(couple.coupleId, date, kind)
  if (!id) return null
  const doc = (await db.collection(dayChoice.CHOICE_COLLECTION).where({ _id: id }).get()).data[0]
  if (!doc) return null
  if (doc.coupleId !== couple.coupleId) return null
  if (doc.date !== date || doc.kind !== kind) return null
  const name = typeof doc.nameSnapshot === 'string' ? doc.nameSnapshot : ''
  if (!name) return null
  return {
    kind,
    date,
    refIds: Array.isArray(doc.refIds) ? doc.refIds.filter(x => typeof x === 'string').slice(0, 3) : [],
    name,
    decidedAt: typeof doc.decidedAt === 'number' ? doc.decidedAt : 0
  }
}

// ---------- 随机工具 ----------
function pickOne(list, avoidId) {
  if (!list.length) return null
  if (list.length === 1) return list[0]
  if (avoidId) {
    const others = list.filter(x => x._id !== avoidId)
    if (others.length) return others[Math.floor(Math.random() * others.length)]
  }
  return list[Math.floor(Math.random() * list.length)]
}

// ---------- 分页读取全部（消除 .get() limit 上限不确定性；云函数端单页上限 1000，分页兜底） ----------
async function fetchAll(col, where, pageSize = 100) {
  const out = []
  let skip = 0
  for (let round = 0; round < 20; round++) { // 安全上限 20 页（2000 条）
    const batch = (await col.where(where).skip(skip).limit(pageSize).get()).data
    out.push(...batch)
    if (batch.length < pageSize) break
    skip += pageSize
  }
  return out
}

// ---------- AI 调用（复用 M6 环境变量；transport 可注入测试） ----------
let _transport = null
function callAI(messages) {
  if (_transport) return _transport(messages)
  if (!AI_URL || !AI_KEY) return Promise.reject(new Error('AI not configured'))
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: AI_MODEL, messages, temperature: 0.8 })
    const u = new URL(AI_URL)
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + AI_KEY, 'Content-Length': Buffer.byteLength(body) },
      timeout: 15000
    }, res => {
      let d = ''
      res.on('data', c => d += c)
      res.on('end', () => {
        try {
          const j = JSON.parse(d)
          const text = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content
          if (!text) reject(new Error('invalid AI response'))
          else resolve(text.trim())
        } catch (e) { reject(e) }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(new Error('AI timeout')) })
    req.write(body)
    req.end()
  })
}

// AI 输出解析：要求按行返回 食材/步骤/贴士 三段（JSON 兜底）
function parseAIRecipe(text) {
  const clean = String(text || '').trim()
  const jsonM = clean.match(/\{[\s\S]*\}/)
  if (jsonM) {
    try {
      const j = JSON.parse(jsonM[0])
      if (Array.isArray(j.ingredients) && Array.isArray(j.steps) && Array.isArray(j.tips)) {
        return { ingredients: j.ingredients, steps: j.steps, tips: j.tips }
      }
    } catch (e) { /* fallthrough */ }
  }
  // 行解析：1. 开头为食材/步骤/贴士 的段落
  const sections = { ingredients: [], steps: [], tips: [] }
  let cur = null
  for (const line of clean.split('\n')) {
    const l = line.trim().replace(/^[\d一二三四五六七八九十]+[.、)]\s*/, '')
    if (!l) continue
    if (/^食材[:：]/.test(l)) { cur = 'ingredients'; continue }
    if (/^步骤[:：]/.test(l)) { cur = 'steps'; continue }
    if (/^贴士[:：]|^小贴士[:：]/.test(l)) { cur = 'tips'; continue }
    if (cur) sections[cur].push(l)
  }
  if (sections.ingredients.length && sections.steps.length) return sections
  throw new Error('AI 输出无法解析')
}

function stripListNumbers(arr) {
  return (arr || []).map(s => String(s).replace(/^[\d一二三四五六七八九十]+[.、)]\s*/, ''))
}

// ---------- 类别枚举归一化（migrateRecipes 用；兼容真云旧数据变体） ----------
const CATEGORY_ALIASES = {
  meat: 'meat', 肉类: 'meat', 小荤: 'meat', 荤菜: 'meat', 肉: 'meat', 荤: 'meat', 'Meat': 'meat',
  vegetable: 'vegetable', 素菜: 'vegetable', 蔬菜: 'vegetable', 素: 'vegetable', 'Vegetable': 'vegetable',
  soup: 'soup', 汤: 'soup', 汤类: 'soup', 羹: 'soup', 'Soup': 'soup'
}

// ---------- 导出 ----------
exports.main = async (event = {}, context) => {
  const { OPENID } = cloud.getWXContext()
  if (!OPENID) return { ok: false, code: 'UNAUTHORIZED', msg: '未获取到用户身份' }
  const active = await getActiveCouple(OPENID)
  if (!active) return { ok: false, code: 'NOT_ACTIVE', msg: '当前情侣关系未生效' }

  const action = event.action
  const col = db.collection('recipes')

  // ---- seedRecipes：初始化 50 道（幂等） ----
  if (action === 'seedRecipes') {
    const v = validateSeed()
    if (v.total !== 50 || v.problems.length) {
      return { ok: false, code: 'SEED_MISMATCH', msg: 'seed 数据不完整: ' + JSON.stringify(v) }
    }
    const existing = (await col.where({}).limit(200).get()).data
    if (existing.length >= 50) {
      // 已 seed：检查是否同版本
      const ver = existing.find(r => r.seedVersion === SEED_VERSION)
      return { ok: true, idempotent: true, count: existing.length, seedVersion: SEED_VERSION }
    }
    if (existing.length > 0) {
      return { ok: false, code: 'SEED_MISMATCH', msg: 'recipes 已有 ' + existing.length + ' 条但不足 50，请人工处理（不静默补插）' }
    }
    let inserted = 0
    for (const r of SEED_RECIPES) {
      const dup = (await col.where({ name: r.name, category: r.category }).get()).data
      if (dup.length) continue
      await col.add({
        data: {
          ...r,
          enabled: true,
          aiGenerated: false,
          seedVersion: SEED_VERSION,
          revision: 1,
          createdAt: Date.now(),
          updatedAt: Date.now()
        }
      })
      inserted++
    }
    return { ok: true, inserted, total: SEED_RECIPES.length }
  }

  // ---- migrateRecipes：一次性安全迁移（只修 schema 字段，不覆盖 ingredients/steps/tips） ----
  // 真云兼容：category 枚举归一化（中文/变体 → meat/vegetable/soup）、enabled 补 boolean true、
  // seedVersion/revision/aiGenerated 补齐。不删除记录、不覆盖人工编辑内容。
  if (action === 'migrateRecipes') {
    // 分页读取全部 50 条（不得只处理前 N 条）
    const all = await fetchAll(col, {})
    if (!all.length) {
      return { ok: true, migrated: 0, report: { meat: 0, vegetable: 0, soup: 0, unknown: [], total: 0 } }
    }
    let fixed = 0
    const report = { meat: 0, vegetable: 0, soup: 0, unknown: [], total: all.length }
    for (const r of all) {
      const upd = {}
      let changed = false
      // enabled → boolean true（字符串 "true" / 缺失 / 其他值 → 修正）
      if (r.enabled !== true) { upd.enabled = true; changed = true }
      // category 枚举归一化
      let cat = r.category
      if (typeof cat === 'string') {
        const norm = CATEGORY_ALIASES[cat.trim()]
        if (norm && norm !== cat.trim()) { upd.category = norm; cat = norm; changed = true }
        else if (!norm) { report.unknown.push({ _id: r._id, name: r.name, category: cat }); cat = null }
      } else if (Array.isArray(cat)) {
        const first = String(cat[0] == null ? '' : cat[0]).trim()
        const norm = CATEGORY_ALIASES[first]
        if (norm) { upd.category = norm; cat = norm; changed = true }
        else { report.unknown.push({ _id: r._id, name: r.name, category: JSON.stringify(cat) }); cat = null }
      } else {
        report.unknown.push({ _id: r._id, name: r.name, category: String(cat) })
        cat = null
      }
      if (cat) report[cat] = (report[cat] || 0) + 1
      // schema 字段补齐（不覆盖内容）
      if (r.seedVersion === undefined) { upd.seedVersion = SEED_VERSION; changed = true }
      if (r.revision === undefined) { upd.revision = 1; changed = true }
      if (r.aiGenerated === undefined) { upd.aiGenerated = false; changed = true }
      if (changed) {
        await col.doc(r._id).update({ data: { ...upd, updatedAt: Date.now() } })
        fixed++
      }
    }
    return { ok: true, migrated: fixed, report }
  }

  // ---- diagnoseRecipes：纯诊断（独立 count + 分页交叉验证，不复用 fetchAll） ----
  if (action === 'diagnoseRecipes') {
    const cnt = await col.count()
    // 独立分页读取（与 fetchAll 无关的交叉验证实现）
    const fetched = []
    for (let skip = 0; skip < 2000; skip += 100) {
      const batch = (await col.where({}).skip(skip).limit(100).get()).data
      fetched.push(...batch)
      if (batch.length < 100) break
    }
    const ids = new Set()
    let duplicateIdCount = 0
    const nameKeys = new Set()
    const catDist = {}
    const enabledDist = { true: 0, false: 0, missing: 0 }
    for (const r of fetched) {
      if (ids.has(r._id)) duplicateIdCount++
      ids.add(r._id)
      const key = r.name + '/' + r.category
      nameKeys.add(key)
      catDist[r.category] = (catDist[r.category] || 0) + 1
      if (r.enabled === true) enabledDist.true++
      else if (r.enabled === false) enabledDist.false++
      else enabledDist.missing++
    }
    // 固定 seed 50 道与真云差集
    const missing = SEED_RECIPES.filter(r => !nameKeys.has(r.name + '/' + r.category))
    const fetchedNames = fetched.map(r => r.name)
    return {
      ok: true,
      dbCount: cnt.total,
      fetchedCount: fetched.length,
      idsCount: ids.size,
      duplicateIdCount,
      namesCount: nameKeys.size,
      categoryDist: catDist,
      enabledDist,
      firstNames: fetchedNames.slice(0, 3),
      lastNames: fetchedNames.slice(-3),
      missingSeedCount: missing.length,
      missingSeedNames: missing.map(r => `${r.name}(${r.category})`)
    }
  }

  // ---- repairRecipes：只补缺失 seed（幂等；不覆盖/不删除已有记录） ----
  if (action === 'repairRecipes') {
    // 先 count 区分：数据库若已 ≥50 但 fetch 少 → 读取问题，绝不插入（避免 62 条）
    const cnt = await col.count()
    const existing = await fetchAll(col, {})
    if (cnt.total >= SEED_RECIPES.length && existing.length < SEED_RECIPES.length) {
      return { ok: false, code: 'READ_MISMATCH', msg: `count=${cnt.total} 但读取=${existing.length}，疑似读取问题，未插入任何数据` }
    }
    const existKey = new Set(existing.map(r => r.name + '/' + r.category))
    const missing = SEED_RECIPES.filter(r => !existKey.has(r.name + '/' + r.category))
    let inserted = 0
    for (const r of missing) {
      await col.add({
        data: {
          ...r,
          enabled: true, aiGenerated: false, seedVersion: SEED_VERSION,
          revision: 1, createdAt: Date.now(), updatedAt: Date.now()
        }
      })
      inserted++
    }
    const after = await fetchAll(col, {})
    const byCat = { meat: 0, vegetable: 0, soup: 0 }
    after.forEach(r => { if (byCat[r.category] !== undefined) byCat[r.category]++ })
    return {
      ok: true,
      inserted,
      missingCount: missing.length,
      total: after.length,
      meat: byCat.meat, vegetable: byCat.vegetable, soup: byCat.soup
    }
  }

  // ---- listRecipes ----
  if (action === 'listRecipes') {
    const where = { enabled: true }
    if (event.category) where.category = event.category
    const data = (await col.where(where).orderBy('category', 'asc').limit(200).get()).data
    return { ok: true, recipes: data.map(r => ({ _id: r._id, name: r.name, category: r.category, revision: r.revision || 1 })) }
  }

  // ---- randomMeal：1 荤 + 1 素 + 1 汤 ----
  if (action === 'randomMeal') {
    // 分页读取全部（不依赖单次 .get() 的 limit 上限）
    const meats = await fetchAll(col, { category: 'meat', enabled: true })
    const vegs = await fetchAll(col, { category: 'vegetable', enabled: true })
    const soups = await fetchAll(col, { category: 'soup', enabled: true })
    if (!meats.length || !vegs.length || !soups.length) {
      // 诊断（不修数据）：全量分类计数 + enabled 计数，帮助定位真云字段不一致
      const all = await fetchAll(col, {})
      const catDist = {}
      const meatCount = { total: 0, enabled: 0 }
      const vegetableCount = { total: 0, enabled: 0 }
      const soupCount = { total: 0, enabled: 0 }
      let enabledTotal = 0
      for (const r of all) {
        const catKey = typeof r.category === 'string' ? r.category : JSON.stringify(r.category)
        catDist[catKey] = (catDist[catKey] || 0) + 1
        if (r.category === 'meat') { meatCount.total++; if (r.enabled === true) meatCount.enabled++ }
        else if (r.category === 'vegetable') { vegetableCount.total++; if (r.enabled === true) vegetableCount.enabled++ }
        else if (r.category === 'soup') { soupCount.total++; if (r.enabled === true) soupCount.enabled++ }
        if (r.enabled === true) enabledTotal++
      }
      return {
        ok: false,
        code: 'INSUFFICIENT_RECIPE_POOL',
        msg: '菜谱库分类不足，请先完成 seed（可调用 migrateRecipes 修复字段）',
        diag: {
          total: all.length,
          meatCount, vegetableCount, soupCount,
          enabledTotal,
          enabledMeat: meats.length, enabledVegetable: vegs.length, enabledSoup: soups.length,
          categoryDist: catDist
        }
      }
    }
    const avoid = event.avoid || {}
    const meat = pickOne(meats, avoid.meat)
    const vegetable = pickOne(vegs, avoid.vegetable)
    const soup = pickOne(soups, avoid.soup)
    return { ok: true, meal: { meat, vegetable, soup } }
  }

  // ---- getRecipe ----
  if (action === 'getRecipe') {
    if (!event.recipeId) return { ok: false, code: 'BAD_ARGS', msg: '缺少 recipeId' }
    const r = (await col.where({ _id: event.recipeId }).get()).data[0]
    if (!r) return { ok: true, recipe: null }
    return { ok: true, recipe: r }
  }

  // ---- saveRecipe：人工编辑（requestId + revision） ----
  if (action === 'saveRecipe') {
    const { recipeId, ingredients, steps, tips, requestId, revision } = event
    if (!recipeId) return { ok: false, code: 'BAD_ARGS', msg: '缺少 recipeId' }
    if (!requestId) return { ok: false, code: 'BAD_ARGS', msg: '缺少 requestId' }
    if (!Array.isArray(ingredients) || !Array.isArray(steps) || !Array.isArray(tips)) {
      return { ok: false, code: 'BAD_ARGS', msg: 'ingredients/steps/tips 必须为数组' }
    }
    const clientRevision = typeof revision === 'number' ? revision : 0
    const ex = (await col.where({ _id: recipeId }).get()).data[0]
    if (!ex) return { ok: true, code: 'NOT_FOUND', recipe: null }
    // 幂等
    if (ex.lastRequestId === requestId) {
      return { ok: true, idempotent: true, revision: ex.revision || 1 }
    }
    // V1 兼容补 revision
    if (ex.revision === undefined) {
      await col.doc(ex._id).update({ data: { revision: 0 } })
      ex.revision = 0
    }
    if (ex.revision !== clientRevision) {
      return { ok: false, code: 'REV_CONFLICT', msg: '内容已被更新，请刷新', revision: ex.revision }
    }
    const upd = await col.where({ _id: recipeId, revision: clientRevision }).update({
      data: {
        ingredients: stripListNumbers(ingredients),
        steps: stripListNumbers(steps),
        tips: stripListNumbers(tips),
        aiGenerated: false,
        revision: ex.revision + 1,
        lastRequestId: requestId,
        updatedAt: Date.now()
      }
    })
    if (!upd.stats || upd.stats.updated === 0) {
      return { ok: false, code: 'REV_CONFLICT', msg: '内容已被更新，请刷新', revision: ex.revision }
    }
    return { ok: true, revision: ex.revision + 1 }
  }

  // ---- regenerateRecipe：AI 重新生成（返回 draft，不落库） ----
  if (action === 'regenerateRecipe') {
    if (!event.recipeId) return { ok: false, code: 'BAD_ARGS', msg: '缺少 recipeId' }
    const r = (await col.where({ _id: event.recipeId }).get()).data[0]
    if (!r) return { ok: true, code: 'NOT_FOUND', recipe: null }
    // 只改 ingredients/steps/tips；name/category/enabled 不动（M7 §23）
    const prompt = [
      `你是家常菜谱助手。为「${r.name}」（分类：${r.category}）重新生成一份家常做法。`,
      '要求：家常、简单、新手友好、少步骤（3-6 步）、常见食材、不需要专业设备、不做复杂摆盘。',
      '严格按以下格式输出三行标题段落：',
      '食材：\n...每行一种食材带用量...',
      '步骤：\n...每行一步...',
      '贴士：\n...每行一条...'
    ].join('\n')
    let text
    try {
      text = await callAI([{ role: 'user', content: prompt }])
    } catch (e) {
      console.error('regenerate AI fail', r._id, e.message)
      return { ok: false, code: 'AI_FAILED', msg: 'AI 生成失败，已保留原内容', recipe: r }
    }
    let parsed
    try {
      parsed = parseAIRecipe(text)
    } catch (e) {
      return { ok: false, code: 'AI_FAILED', msg: 'AI 输出无法解析，已保留原内容', recipe: r }
    }
    // 返回 draft（前端二次确认后调 saveRecipe 落库）
    return {
      ok: true,
      draft: { ingredients: parsed.ingredients, steps: parsed.steps, tips: parsed.tips },
      recipe: r
    }
  }

  // ================= V1.1 今日决定（吃什么 / 去哪里） =================
  //
  // 与「推荐」的关系：推荐（randomMeal / randomTravel）只负责给出候选，
  // 本组 action 负责把候选**确认成这一天的决定**并持久化，供双方首页读取。
  //
  // 权限口径：
  //   · 读：当前 active 关系的双方都可以（her / him）
  //   · 写：只有 her（记录方）；him 一律 FORBIDDEN —— 前端隐藏按钮不算鉴权
  //   · 归属：coupleId / 角色 / openid 全部由服务端解析，客户端传什么都不看
  //   · 隔离：确定性 _id 绑定 coupleId 的哈希；换绑后新关系算不出旧 ID，
  //           即使读到也会因文档内 coupleId 不符而返回 null

  // ---- getDayChoice：读取某一天的决定（默认今天；双方可读） ----
  if (action === 'getDayChoice') {
    const strict = await getActiveCoupleStrict(OPENID)
    if (!strict) return { ok: false, code: 'NOT_ACTIVE', msg: '当前情侣关系未生效' }

    const today = dayChoice.beijingToday()
    let date = today
    const rawDate = event.date
    if (rawDate !== undefined && rawDate !== null && rawDate !== '') {
      if (!dayChoice.isValidDate(rawDate)) {
        return { ok: false, code: 'BAD_ARGS', msg: '日期格式应为 YYYY-MM-DD' }
      }
      // 不能读未来：未来日期不可能有决定，允许它会变成「探测别人是否已决定」的入口
      if (rawDate > today) return { ok: false, code: 'BAD_ARGS', msg: '日期不能晚于今天' }
      date = rawDate
    }

    let wantKind = null
    const rawKind = event.kind
    if (rawKind !== undefined && rawKind !== null && rawKind !== '') {
      wantKind = dayChoice.normalizeKind(rawKind)
      if (!wantKind) return { ok: false, code: 'BAD_ARGS', msg: 'kind 必须为 meal 或 travel' }
    }

    const out = { ok: true, date, today, role: strict.role, meal: null, travel: null }
    for (const kind of (wantKind ? [wantKind] : dayChoice.KINDS)) {
      out[kind] = await readDayChoice(strict.couple, date, kind)
    }
    return out
  }

  // ---- confirmDayChoice：确认 / 重新确认今天的选择（仅 her） ----
  if (action === 'confirmDayChoice') {
    const strict = await getActiveCoupleStrict(OPENID)
    if (!strict) return { ok: false, code: 'NOT_ACTIVE', msg: '当前情侣关系未生效' }
    if (strict.role !== 'her') {
      return { ok: false, code: 'FORBIDDEN', msg: '只有记录方可以确定今天的选择' }
    }

    const kind = dayChoice.normalizeKind(event.kind)
    if (!kind) return { ok: false, code: 'BAD_ARGS', msg: 'kind 必须为 meal 或 travel' }

    const rawRefIds = Array.isArray(event.refIds) ? event.refIds : []
    const refIds = rawRefIds.map(x => (typeof x === 'string' ? x.trim() : ''))
    if (!dayChoice.isValidRefIds(kind, refIds)) {
      return {
        ok: false, code: 'BAD_ARGS',
        msg: kind === 'meal' ? '需要 1 小荤 + 1 素菜 + 1 汤 三个菜谱' : '需要一个地点'
      }
    }

    // 「今天」由服务端决定：完全不采信客户端传来的日期（跨天伪造 → 直接无效）
    const date = dayChoice.beijingToday()

    // 显示名快照 + 可选性校验：必须真的存在、必须 enabled === true
    let snapshot = ''
    let canonicalIds = []
    if (kind === 'meal') {
      const rows = []
      for (const id of refIds) {
        const r = (await col.where({ _id: id }).get()).data[0]
        if (!r) return { ok: false, code: 'NOT_FOUND', msg: '推荐的菜谱不存在，请重新随机' }
        if (r.enabled !== true) return { ok: false, code: 'UNAVAILABLE', msg: '这道菜暂时不可选，请重新随机' }
        rows.push(r)
      }
      const byCat = { meat: [], vegetable: [], soup: [] }
      for (const r of rows) {
        if (!byCat[r.category]) {
          return { ok: false, code: 'BAD_ARGS', msg: '菜谱分类不合法，请重新随机' }
        }
        byCat[r.category].push(r)
      }
      if (byCat.meat.length !== 1 || byCat.vegetable.length !== 1 || byCat.soup.length !== 1) {
        return { ok: false, code: 'BAD_ARGS', msg: '需要 1 小荤 + 1 素菜 + 1 汤' }
      }
      // 名称由服务端读库生成，客户端传的 name / nameSnapshot 一律不用
      snapshot = dayChoice.mealName(byCat.meat[0].name, byCat.vegetable[0].name, byCat.soup[0].name)
      if (!snapshot) return { ok: false, code: 'UNAVAILABLE', msg: '菜谱名称不完整，请重新随机' }
      // 落库顺序固定为 荤 → 素 → 汤（不依赖客户端数组顺序）
      canonicalIds = [byCat.meat[0]._id, byCat.vegetable[0]._id, byCat.soup[0]._id]
    } else {
      const p = (await db.collection('travel_places').where({ _id: refIds[0] }).get()).data[0]
      if (!p) return { ok: false, code: 'NOT_FOUND', msg: '推荐的地点不存在，请重新随机' }
      if (p.enabled !== true) return { ok: false, code: 'UNAVAILABLE', msg: '这个地点暂时不可选，请重新随机' }
      snapshot = dayChoice.limitName(p.name)
      if (!snapshot) return { ok: false, code: 'UNAVAILABLE', msg: '地点名称不完整，请重新随机' }
      canonicalIds = [p._id]
    }

    const id = dayChoice.choiceDocId(strict.couple.coupleId, date, kind)
    if (!id) return { ok: false, code: 'SERVER_ERROR', msg: '无法生成唯一的决定标识' }

    const now = Date.now()
    const patch = {
      coupleId: strict.couple.coupleId,
      date,
      kind,
      refIds: canonicalIds,
      nameSnapshot: snapshot,
      decidedRole: 'her',
      decidedOpenid: OPENID,
      himOpenid: strict.couple.himOpenid || null,
      decidedAt: now,
      updatedAt: now
    }

    const existing = (await db.collection(dayChoice.CHOICE_COLLECTION).where({ _id: id }).get()).data[0]
    let mode = 'created'
    if (existing) {
      // 重新确认 = 覆盖这一天的这一份结果（不堆版本号、不做审批流）
      // where 里再钉一次 coupleId：即使 _id 撞车，也绝不可能改写别人的决定
      const upd = await db.collection(dayChoice.CHOICE_COLLECTION)
        .where({ _id: id, coupleId: strict.couple.coupleId })
        .update({ data: patch })
      if (((upd && upd.stats && upd.stats.updated) || 0) !== 1) {
        return { ok: false, code: 'CONFLICT', msg: '这一天的决定正在被修改，请重试' }
      }
      mode = 'replaced'
    } else {
      try {
        await db.collection(dayChoice.CHOICE_COLLECTION)
          .add({ data: Object.assign({ _id: id, createdAt: now }, patch) })
      } catch (e) {
        // 并发：另一个请求刚创建了同一个确定性 _id（唯一约束）→ 按覆盖再写一次
        console.warn('confirmDayChoice create race', (e && e.errCode) || 'write_fail')
        try {
          const upd = await db.collection(dayChoice.CHOICE_COLLECTION)
            .where({ _id: id, coupleId: strict.couple.coupleId })
            .update({ data: patch })
          if (((upd && upd.stats && upd.stats.updated) || 0) !== 1) {
            return { ok: false, code: 'DB_ERROR', msg: '决定没有保存成功，请稍后重试' }
          }
          mode = 'replaced'
        } catch (e2) {
          return { ok: false, code: 'DB_ERROR', msg: '决定没有保存成功，请稍后重试' }
        }
      }
    }

    return {
      ok: true, date, kind, refIds: canonicalIds,
      name: snapshot, decidedAt: now, mode
    }
  }

  // ================= M8 今天去哪里 =================
  const tcol = db.collection('travel_places')


  // ---- seedTravelPlaces：初始化 60 条（并发分批，防 timeout 部分落库） ----
  if (action === 'seedTravelPlaces') {
    const v = validateTravelSeed()
    if (v.total !== 60 || v.problems.length) {
      return { ok: false, code: 'SEED_MISMATCH', msg: 'travel seed 不完整: ' + JSON.stringify(v) }
    }
    const existing = await fetchAll(tcol, {})
    if (existing.length >= 60) {
      const ver = existing.find(p => p.seedVersion === TRAVEL_SEED_VERSION)
      return { ok: true, idempotent: true, count: existing.length, seedVersion: TRAVEL_SEED_VERSION }
    }
    const existKey = new Set(existing.map(p => p.name + '/' + p.type))
    const missing = TRAVEL_PLACES.filter(p => !existKey.has(p.name + '/' + p.type))
    // 并发分批写入（每批 10 条 Promise.all），避免 60 次串行 await 超时
    let inserted = 0
    for (let i = 0; i < missing.length; i += 10) {
      const batch = missing.slice(i, i + 10)
      await Promise.all(batch.map(p => tcol.add({
        data: {
          ...p,
          enabled: true, aiGenerated: false, seedVersion: TRAVEL_SEED_VERSION,
          revision: 1, createdAt: Date.now(), updatedAt: Date.now()
        }
      })))
      inserted += batch.length
    }
    return { ok: true, inserted, total: TRAVEL_PLACES.length }
  }

  // ---- diagnoseTravelPlaces：纯诊断（count + 独立分页交叉验证） ----
  if (action === 'diagnoseTravelPlaces') {
    const cnt = await tcol.count()
    const fetched = []
    for (let skip = 0; skip < 2000; skip += 100) {
      const batch = (await tcol.where({}).skip(skip).limit(100).get()).data
      fetched.push(...batch)
      if (batch.length < 100) break
    }
    const ids = new Set()
    let duplicateIdCount = 0
    const nameKeys = new Set()
    const typeDist = { beijing: 0, outside: 0 }
    const enabledDist = { true: 0, false: 0, missing: 0 }
    for (const p of fetched) {
      if (ids.has(p._id)) duplicateIdCount++
      ids.add(p._id)
      nameKeys.add(p.name + '/' + p.type)
      if (p.type === 'beijing') typeDist.beijing++
      else if (p.type === 'outside') typeDist.outside++
      if (p.enabled === true) enabledDist.true++
      else if (p.enabled === false) enabledDist.false++
      else enabledDist.missing++
    }
    const missing = TRAVEL_PLACES.filter(p => !nameKeys.has(p.name + '/' + p.type))
    return {
      ok: true,
      dbCount: cnt.total, fetchedCount: fetched.length,
      idsCount: ids.size, duplicateIdCount, namesCount: nameKeys.size,
      typeDist, enabledDist,
      missingSeedCount: missing.length,
      missingSeedNames: missing.map(p => `${p.name}(${p.type})`)
    }
  }

  // ---- repairTravelPlaces：只补缺失 seed（幂等；不覆盖已存在/人工编辑） ----
  if (action === 'repairTravelPlaces') {
    const cnt = await tcol.count()
    const existing = await fetchAll(tcol, {})
    if (cnt.total >= TRAVEL_PLACES.length && existing.length < TRAVEL_PLACES.length) {
      return { ok: false, code: 'READ_MISMATCH', msg: `count=${cnt.total} 但读取=${existing.length}，未插入任何数据` }
    }
    const existKey = new Set(existing.map(p => p.name + '/' + p.type))
    const missing = TRAVEL_PLACES.filter(p => !existKey.has(p.name + '/' + p.type))
    let inserted = 0
    for (let i = 0; i < missing.length; i += 10) {
      const batch = missing.slice(i, i + 10)
      await Promise.all(batch.map(p => tcol.add({
        data: {
          ...p, enabled: true, aiGenerated: false, seedVersion: TRAVEL_SEED_VERSION,
          revision: 1, createdAt: Date.now(), updatedAt: Date.now()
        }
      })))
      inserted += batch.length
    }
    const after = await fetchAll(tcol, {})
    const byType = { beijing: 0, outside: 0 }
    after.forEach(p => { if (byType[p.type] !== undefined) byType[p.type]++ })
    return { ok: true, inserted, missingCount: missing.length, total: after.length, beijing: byType.beijing, outside: byType.outside }
  }

  // ---- listTravelPlaces ----
  if (action === 'listTravelPlaces') {
    if (!event.type || (event.type !== 'beijing' && event.type !== 'outside')) {
      return { ok: false, code: 'BAD_ARGS', msg: 'type 必须为 beijing 或 outside' }
    }
    const list = await fetchAll(tcol, { type: event.type, enabled: true })
    return { ok: true, places: list.map(p => ({ _id: p._id, name: p.name, type: p.type, city: p.city, defaultDays: p.defaultDays })) }
  }

  // ---- randomTravel：按 type 随机 1 条（fail-closed） ----
  if (action === 'randomTravel') {
    if (!event.type || (event.type !== 'beijing' && event.type !== 'outside')) {
      return { ok: false, code: 'BAD_ARGS', msg: 'type 必须为 beijing 或 outside' }
    }
    const pool = await fetchAll(tcol, { type: event.type, enabled: true })
    if (!pool.length) {
      return { ok: false, code: 'TRAVEL_POOL_EMPTY', msg: '该分类暂无可推荐的地点' }
    }
    const place = pickOne(pool, event.excludeId)
    return { ok: true, place }
  }

  // ---- getTravelPlace：详情（按 _id；disabled 可读但不入随机池） ----
  if (action === 'getTravelPlace') {
    if (!event.placeId) return { ok: false, code: 'BAD_ARGS', msg: '缺少 placeId' }
    const p = (await tcol.where({ _id: event.placeId }).get()).data[0]
    if (!p) return { ok: false, code: 'NOT_FOUND', msg: '地点不存在' }
    return { ok: true, place: p }
  }

  // ---- saveTravelPlace：人工编辑（requestId + revision；name/type/city/province 不可改） ----
  if (action === 'saveTravelPlace') {
    const { placeId, shortIntro, highlights, plan, requestId, revision } = event
    if (!placeId) return { ok: false, code: 'BAD_ARGS', msg: '缺少 placeId' }
    if (!requestId) return { ok: false, code: 'BAD_ARGS', msg: '缺少 requestId' }
    if (!Array.isArray(highlights) || !plan || !Array.isArray(plan.days)) {
      return { ok: false, code: 'BAD_ARGS', msg: 'highlights/plan 结构不合法' }
    }
    const clientRevision = typeof revision === 'number' ? revision : 0
    const ex = (await tcol.where({ _id: placeId }).get()).data[0]
    if (!ex) return { ok: false, code: 'NOT_FOUND', msg: '地点不存在' }
    if (ex.lastRequestId === requestId) {
      return { ok: true, idempotent: true, revision: ex.revision || 1 }
    }
    if (ex.revision === undefined) {
      await tcol.doc(ex._id).update({ data: { revision: 0 } })
      ex.revision = 0
    }
    if (ex.revision !== clientRevision) {
      return { ok: false, code: 'REV_CONFLICT', msg: '内容已被更新，请刷新', revision: ex.revision }
    }
    const upd = await tcol.where({ _id: placeId, revision: clientRevision }).update({
      data: {
        shortIntro: typeof shortIntro === 'string' ? shortIntro : ex.shortIntro,
        highlights,
        plan,
        aiGenerated: false,
        revision: ex.revision + 1,
        lastRequestId: requestId,
        updatedAt: Date.now()
      }
    })
    if (!upd.stats || upd.stats.updated === 0) {
      return { ok: false, code: 'REV_CONFLICT', msg: '内容已被更新，请刷新', revision: ex.revision }
    }
    return { ok: true, revision: ex.revision + 1 }
  }

  // ---- regenerateTravelPlace：AI 重新生成（draft 不落库；schema 校验） ----
  if (action === 'regenerateTravelPlace') {
    if (!event.placeId) return { ok: false, code: 'BAD_ARGS', msg: '缺少 placeId' }
    const p = (await tcol.where({ _id: event.placeId }).get()).data[0]
    if (!p) return { ok: false, code: 'NOT_FOUND', msg: '地点不存在' }
    const isBj = p.type === 'beijing'
    const prompt = [
      isBj ? `为北京地点「${p.name}」生成 1 日情侣轻松游计划。` : `为城市「${p.city || p.name}」生成 3 天 2 夜情侣轻松游计划。`,
      '要求：情侣轻松、避免过度赶路、景点与吃饭休息结合。',
      '禁止编造实时票价、开放时间、预约状态、实时交通；如涉及此类信息一律不写具体数值。',
      '严格输出 JSON：{"title": string, "days": [{"day": 1, "title": string, "items": [{"period": "morning|noon|afternoon|evening", "title": string, "description": string}]}], "tips": [string]}'
    ].join('\n')
    let text
    try {
      text = await callAI([{ role: 'user', content: prompt }])
    } catch (e) {
      console.error('travel regenerate AI fail', p._id, e.message)
      return { ok: false, code: 'AI_FAILED', msg: 'AI 生成失败，已保留原计划', place: p }
    }
    const draft = parseTravelDraft(text, isBj ? 1 : 3)
    if (!draft) {
      return { ok: false, code: 'AI_INVALID_RESPONSE', msg: 'AI 输出格式不合法，已保留原计划', place: p }
    }
    return { ok: true, draft, place: p }
  }

  return { ok: false, code: 'BAD_ACTION', msg: '未知操作: ' + action }
}

// ---------- M8 AI 行程 draft 解析 + schema 校验 ----------
function parseTravelDraft(text, expectDays) {
  const clean = String(text || '').trim()
  const jsonM = clean.match(/\{[\s\S]*\}/)
  if (!jsonM) return null
  let j
  try { j = JSON.parse(jsonM[0]) } catch (e) { return null }
  if (typeof j.title !== 'string' || !j.title.trim()) return null
  if (!Array.isArray(j.days) || !j.days.length) return null
  if (Array.isArray(j.tips) === false) return null
  for (const d of j.days) {
    if (typeof d.day !== 'number' || !Number.isInteger(d.day)) return null
    if (typeof d.title !== 'string') return null
    if (!Array.isArray(d.items) || !d.items.length) return null
    for (const it of d.items) {
      if (!TRAVEL_PERIODS.includes(it.period)) return null
      if (typeof it.title !== 'string' || !it.title.trim()) return null
      if (typeof it.description !== 'string') return null
    }
  }
  // 天数符合预期（北京 1 / 外地 3），多一两天可容忍，但必须覆盖预期
  if (j.days.length < expectDays) return null
  return { title: j.title, days: j.days.slice(0, expectDays), tips: j.tips }
}

// 导出（单测）
module.exports.main = exports.main
module.exports.validateSeed = validateSeed
module.exports.pickOne = pickOne
module.exports.parseAIRecipe = parseAIRecipe
module.exports.fetchAll = fetchAll
module.exports.CATEGORY_ALIASES = CATEGORY_ALIASES
module.exports.parseTravelDraft = parseTravelDraft
module.exports.TRAVEL_STALE_HINT = TRAVEL_STALE_HINT
// V1.1 今日决定：纯逻辑（日期 / 确定性 ID / 参数形状）供单测直接引用
module.exports.dayChoice = dayChoice
module.exports.__setTransport = (fn) => { _transport = fn }
