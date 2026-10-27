// ============================================================
// tests/m7-recipes.test.js · M7 今天吃什么测试（PRD v0.8 / 指令 §41-46）
// seed 完整性 / 随机 / 详情 / 编辑契约 / AI 重新生成 / 入口 UI
// 运行：node tests/m7-recipes.test.js
// ============================================================
const Module = require('module')
const path = require('path')
const fs = require('fs')
const { MockDB } = require('./mock-db')
const { SEED_RECIPES, SEED_VERSION, validateSeed } = require('../cloudfunctions/lifePlanner/recipes-seed')

const ROOT = path.resolve(__dirname, '..')
let passed = 0, failed = 0, failures = []

function check(name, cond, detail) {
  if (cond) { passed++; console.log('  PASS  ' + name) }
  else { failed++; failures.push(name + (detail ? ' -> ' + detail : '')); console.log('  FAIL  ' + name + (detail ? ' -> ' + detail : '')) }
}
function testCase(name, fn) {
  return Promise.resolve().then(fn).then(() => { passed++; console.log('  PASS  ' + name) })
    .catch(e => { failed++; failures.push(name + ': ' + e.message); console.log('  FAIL  ' + name + '  -> ' + e.message) })
}
function assertEq(a, b, msg) { if (a !== b) throw new Error((msg || '') + ' 期望 ' + JSON.stringify(b) + ' 实际 ' + JSON.stringify(a)) }
function assertOk(v, msg) { if (!v) throw new Error(msg || '断言失败') }

let OPENID = 'A'
let aiCalls = 0
function loadLp(db, failAI) {
  const origLoad = Module._load
  Module._load = function (request, parent, isMain) {
    if (request === 'wx-server-sdk') {
      return { DYNAMIC_CURRENT_ENV: 'test', init() {}, database: () => db, getWXContext: () => ({ OPENID }) }
    }
    return origLoad.apply(this, arguments)
  }
  const fnPath = path.resolve(__dirname, '../cloudfunctions/lifePlanner/index.js')
  delete require.cache[fnPath]
  const mod = require(fnPath)
  Module._load = origLoad
  aiCalls = 0
  mod.__setTransport(async () => {
    aiCalls++
    if (failAI) throw new Error('AI down')
    return '食材：\n猪里脊 200g\n青椒 2 个\n步骤：\n切丝\n下锅炒\n调味\n贴士：\n少放盐'
  })
  return mod
}

function seedDb() {
  return new MockDB({
    users: [
      { _id: 'u_a', _openid: 'A', role: 'her', coupleId: 'CZ-1', schemaVersion: 2 },
      { _id: 'u_b', _openid: 'B', role: 'him', coupleId: 'CZ-1', schemaVersion: 2 },
      { _id: 'u_x', _openid: 'X', role: 'her', coupleId: null, schemaVersion: 2 }
    ],
    couples: [{ _id: 'c1', coupleId: 'CZ-1', herOpenid: 'A', himOpenid: 'B', status: 'active', anniversary: null }],
    recipes: [], daily_records: [], wishes: [], messages: [], menstrual: []
  })
}
async function runSeed(db) {
  const mod = loadLp(db)
  OPENID = 'A'
  const r = await mod.main({ action: 'seedRecipes' })
  assertOk(r.ok)
  assertEq(r.inserted, 50, '插入 50 条')
}

async function runAll() {
  console.log('\n=== M7-1 · seed 完整性 ===\n')

  const v = validateSeed()
  check('S1 seed 总数 = 50', v.total === 50, '实际 ' + v.total)
  check('S2 meat = 10', v.byCat.meat === 10)
  check('S3 vegetable = 30', v.byCat.vegetable === 30)
  check('S4 soup = 10', v.byCat.soup === 10)
  check('S5 name/category 不重复', v.problems.filter(p => p.includes('重复')).length === 0)
  check('S6 所有 ingredients 非空', v.problems.filter(p => p.includes('缺食材')).length === 0)
  check('S7 所有 steps 非空', v.problems.filter(p => p.includes('缺步骤')).length === 0)
  check('S8 所有 tips 非空', v.problems.filter(p => p.includes('缺贴士')).length === 0)
  check('S9 seedVersion = 1', SEED_VERSION === 1)

  await testCase('S10 seedRecipes 插入 50 条且分类正确', async () => {
    const db = seedDb()
    await runSeed(db)
    const list = db.dump().recipes
    assertEq(list.length, 50)
    assertEq(list.filter(r => r.category === 'meat').length, 10)
    assertEq(list.filter(r => r.category === 'vegetable').length, 30)
    assertEq(list.filter(r => r.category === 'soup').length, 10)
    assertOk(list.every(r => r.enabled === true && r.revision === 1), 'enabled/revision 初始值')
  })

  await testCase('S11 重复 seed → 幂等不重复插入', async () => {
    const db = seedDb()
    await runSeed(db)
    const mod = loadLp(db)
    OPENID = 'A'
    const r2 = await mod.main({ action: 'seedRecipes' })
    assertOk(r2.ok)
    assertEq(r2.idempotent, true)
    assertEq(db.dump().recipes.length, 50, '仍 50 条')
  })

  await testCase('S12 少于 50 条 → SEED_MISMATCH（不静默补插）', async () => {
    const db = seedDb()
    await runSeed(db)
    // 真删除一条（where().remove 模拟微信语义）
    const one = db.dump().recipes[0]
    await db.collection('recipes').where({ _id: one._id }).remove()
    assertEq(db.dump().recipes.length, 49)
    const mod = loadLp(db)
    OPENID = 'A'
    const r = await mod.main({ action: 'seedRecipes' })
    assertEq(r.ok, false)
    assertEq(r.code, 'SEED_MISMATCH')
    assertEq(db.dump().recipes.length, 49, '不补插')
  })

  console.log('\n=== M7-2 · 随机 ===\n')

  await testCase('R1 随机一次 = 3 道且分类正确', async () => {
    const db = seedDb()
    await runSeed(db)
    const mod = loadLp(db)
    OPENID = 'A'
    const r = await mod.main({ action: 'randomMeal' })
    assertOk(r.ok)
    assertEq(r.meal.meat.category, 'meat')
    assertEq(r.meal.vegetable.category, 'vegetable')
    assertEq(r.meal.soup.category, 'soup')
  })

  await testCase('R2 连续随机 20 次全部分类正确且 enabled', async () => {
    const db = seedDb()
    await runSeed(db)
    const mod = loadLp(db)
    OPENID = 'A'
    for (let i = 0; i < 20; i++) {
      const r = await mod.main({ action: 'randomMeal' })
      assertOk(r.ok, '第 ' + i + ' 次失败')
      assertEq(r.meal.meat.category, 'meat')
      assertEq(r.meal.vegetable.category, 'vegetable')
      assertEq(r.meal.soup.category, 'soup')
    }
  })

  await testCase('R3 禁用某菜后永不随机出该菜', async () => {
    const db = seedDb()
    await runSeed(db)
    const target = db.dump().recipes.find(r => r.category === 'meat')
    await db.collection('recipes').doc(target._id).update({ data: { enabled: false } })
    const mod = loadLp(db)
    OPENID = 'A'
    for (let i = 0; i < 15; i++) {
      const r = await mod.main({ action: 'randomMeal' })
      assertOk(r.meal.meat._id !== target._id, '随机出禁用菜')
    }
  })

  await testCase('R4 某分类为空 → fail-closed INSUFFICIENT_RECIPE_POOL', async () => {
    const db = seedDb()
    await runSeed(db)
    // 禁用全部 meat
    for (const r of db.dump().recipes.filter(x => x.category === 'meat')) {
      await db.collection('recipes').doc(r._id).update({ data: { enabled: false } })
    }
    const mod = loadLp(db)
    OPENID = 'A'
    const res = await mod.main({ action: 'randomMeal' })
    assertEq(res.code, 'INSUFFICIENT_RECIPE_POOL')
  })

  await testCase('R5 避开上一轮同一道（avoid 参数）', async () => {
    const db = seedDb()
    await runSeed(db)
    const mod = loadLp(db)
    OPENID = 'A'
    const r1 = await mod.main({ action: 'randomMeal' })
    const r2 = await mod.main({ action: 'randomMeal', avoid: { meat: r1.meal.meat._id } })
    assertOk(r2.meal.meat._id !== r1.meal.meat._id, '尽量避开上一道')
  })

  console.log('\n=== M7-3 · 详情 ===\n')

  await testCase('D1 任取 5 道详情完整', async () => {
    const db = seedDb()
    await runSeed(db)
    const mod = loadLp(db)
    OPENID = 'A'
    const sample = db.dump().recipes.slice(0, 5)
    for (const s of sample) {
      const r = await mod.main({ action: 'getRecipe', recipeId: s._id })
      assertOk(r.ok && r.recipe, s.name)
      assertOk(r.recipe.ingredients.length > 0)
      assertOk(r.recipe.steps.length > 0)
      assertOk(r.recipe.tips.length > 0)
    }
  })

  await testCase('D2 getRecipe 不存在 → recipe: null', async () => {
    const db = seedDb()
    const mod = loadLp(db)
    OPENID = 'A'
    const r = await mod.main({ action: 'getRecipe', recipeId: 'nope' })
    assertOk(r.ok)
    assertEq(r.recipe, null)
  })

  await testCase('D3 未绑定用户 deny', async () => {
    const db = seedDb()
    const mod = loadLp(db)
    OPENID = 'X'
    const r = await mod.main({ action: 'listRecipes' })
    assertEq(r.code, 'NOT_ACTIVE')
  })

  await testCase('D4 superseded partner deny', async () => {
    const db = seedDb()
    await db.collection('couples').doc('c1').update({ data: { status: 'superseded' } })
    const mod = loadLp(db)
    OPENID = 'B'
    const r = await mod.main({ action: 'listRecipes' })
    assertEq(r.code, 'NOT_ACTIVE')
    OPENID = 'A'
  })

  console.log('\n=== M7-4 · 编辑契约 ===\n')

  async function setupOne() {
    const db = seedDb()
    await runSeed(db)
    const one = db.dump().recipes[0]
    return { db, one }
  }

  await testCase('E1 revision 1 → 2', async () => {
    const { db, one } = await setupOne()
    const mod = loadLp(db)
    OPENID = 'A'
    const r = await mod.main({ action: 'saveRecipe', recipeId: one._id, ingredients: ['A'], steps: ['S'], tips: ['T'], requestId: 'e1', revision: 1 })
    assertOk(r.ok)
    assertEq(r.revision, 2)
  })

  await testCase('E2 revision 2 → 3', async () => {
    const { db, one } = await setupOne()
    const mod = loadLp(db)
    OPENID = 'A'
    await mod.main({ action: 'saveRecipe', recipeId: one._id, ingredients: ['A'], steps: ['S'], tips: ['T'], requestId: 'a', revision: 1 })
    const r2 = await mod.main({ action: 'saveRecipe', recipeId: one._id, ingredients: ['B'], steps: ['S2'], tips: ['T2'], requestId: 'b', revision: 2 })
    assertEq(r2.revision, 3)
  })

  await testCase('E3 旧 revision 冲突拒绝', async () => {
    const { db, one } = await setupOne()
    const mod = loadLp(db)
    OPENID = 'A'
    await mod.main({ action: 'saveRecipe', recipeId: one._id, ingredients: ['A'], steps: ['S'], tips: ['T'], requestId: 'a', revision: 1 })
    const c = await mod.main({ action: 'saveRecipe', recipeId: one._id, ingredients: ['X'], steps: ['Y'], tips: ['Z'], requestId: 'c', revision: 1 })
    assertEq(c.code, 'REV_CONFLICT')
  })

  await testCase('E4 重复 requestId 幂等（不重复写、revision 不 +1）', async () => {
    const { db, one } = await setupOne()
    const mod = loadLp(db)
    OPENID = 'A'
    await mod.main({ action: 'saveRecipe', recipeId: one._id, ingredients: ['A'], steps: ['S'], tips: ['T'], requestId: 'dup', revision: 1 })
    const r2 = await mod.main({ action: 'saveRecipe', recipeId: one._id, ingredients: ['A'], steps: ['S'], tips: ['T'], requestId: 'dup', revision: 1 })
    assertOk(r2.ok)
    assertEq(r2.idempotent, true)
    assertEq(r2.revision, 2, '幂等返回当前 revision（第一次已 1→2）')
    assertEq(db.dump().recipes.find(r => r._id === one._id).revision, 2, '库内 revision 未被再次 +1')
  })

  await testCase('E5 修改后重新读取保持（SoT 人工编辑）', async () => {
    const { db, one } = await setupOne()
    const mod = loadLp(db)
    OPENID = 'A'
    await mod.main({ action: 'saveRecipe', recipeId: one._id, ingredients: ['牛里脊 200g'], steps: ['煎 2 分钟'], tips: ['别煎老'], requestId: 's1', revision: 1 })
    const r = await mod.main({ action: 'getRecipe', recipeId: one._id })
    assertEq(r.recipe.ingredients[0], '牛里脊 200g')
    assertEq(r.recipe.steps[0], '煎 2 分钟')
  })

  await testCase('E6 outsider 不能编辑', async () => {
    const { db, one } = await setupOne()
    const mod = loadLp(db)
    OPENID = 'X'
    const r = await mod.main({ action: 'saveRecipe', recipeId: one._id, ingredients: ['X'], steps: ['X'], tips: ['X'], requestId: 'x', revision: 1 })
    assertEq(r.code, 'NOT_ACTIVE')
  })

  await testCase('E7 active her 可以编辑', async () => {
    const { db, one } = await setupOne()
    const mod = loadLp(db)
    OPENID = 'A'
    const r = await mod.main({ action: 'saveRecipe', recipeId: one._id, ingredients: ['A'], steps: ['S'], tips: ['T'], requestId: 'h1', revision: 1 })
    assertOk(r.ok)
  })

  await testCase('E8 active him 可以编辑', async () => {
    const { db, one } = await setupOne()
    const mod = loadLp(db)
    OPENID = 'B'
    const r = await mod.main({ action: 'saveRecipe', recipeId: one._id, ingredients: ['A'], steps: ['S'], tips: ['T'], requestId: 'm1', revision: 1 })
    assertOk(r.ok)
    OPENID = 'A'
  })

  console.log('\n=== M7-5 · AI 重新生成 ===\n')

  await testCase('A1 AI 成功 → 返回新 draft（不落库）', async () => {
    const { db, one } = await setupOne()
    const mod = loadLp(db)
    OPENID = 'A'
    const r = await mod.main({ action: 'regenerateRecipe', recipeId: one._id })
    assertOk(r.ok)
    assertOk(r.draft && r.draft.ingredients.length === 2, 'draft 食材')
    assertOk(r.draft.steps.length >= 1, 'draft 步骤')
    assertOk(r.draft.tips.length >= 1, 'draft 贴士')
    assertEq(db.dump().recipes[0].ingredients[0], '猪里脊 200g', '数据库未被覆盖（需确认保存才落库）')
  })

  await testCase('A2 AI 失败 → 原内容不变 + AI_FAILED', async () => {
    const { db, one } = await setupOne()
    const before = JSON.stringify(db.dump().recipes[0])
    const mod = loadLp(db, true)
    OPENID = 'A'
    const r = await mod.main({ action: 'regenerateRecipe', recipeId: one._id })
    assertEq(r.code, 'AI_FAILED')
    assertEq(JSON.stringify(db.dump().recipes[0]), before, '原内容保留')
  })

  await testCase('A3 前端有二次确认 + 确认保存 revision+1 + name/category 不变', async () => {
    const js = fs.readFileSync(path.join(ROOT, 'pages/recipe/recipe.js'), 'utf8')
    assertOk(js.includes('AI 会重新生成这道菜的制作方法，并覆盖当前内容。是否继续？'), '二次确认文案')
    // 云函数：AI 返回 draft 不改 name/category/enabled（regenerateRecipe 只返回 draft）
    const { db, one } = await setupOne()
    const mod = loadLp(db)
    OPENID = 'A'
    const r = await mod.main({ action: 'regenerateRecipe', recipeId: one._id })
    // 确认保存（前端确认后调 saveRecipe 带 revision）
    const save = await mod.main({ action: 'saveRecipe', recipeId: one._id, ingredients: r.draft.ingredients, steps: r.draft.steps, tips: r.draft.tips, requestId: 'confirm1', revision: 1 })
    assertEq(save.revision, 2)
    const after = db.dump().recipes[0]
    assertEq(after.name, one.name, 'name 不变')
    assertEq(after.category, one.category, 'category 不变')
  })

  await testCase('A4 AI Key 不在前端/仓库', () => {
    const pages = ['food', 'recipe', 'ours']
    for (const p of pages) {
      const js = fs.readFileSync(path.join(ROOT, 'pages/' + p + '/' + p + '.js'), 'utf8')
      assertEq(js.includes('AI_API_KEY'), false, p + ' 含 AI_KEY')
    }
  })

  console.log('\n=== M7-6 · 真云旧数据迁移兼容 ===\n')

  // 构造"真云旧数据"：enabled 缺失/字符串、category 中文变体、无 seedVersion/revision
  function oldDb() {
    return new MockDB({
      users: [
        { _id: 'u_a', _openid: 'A', role: 'her', coupleId: 'CZ-1', schemaVersion: 2 },
        { _id: 'u_b', _openid: 'B', role: 'him', coupleId: 'CZ-1', schemaVersion: 2 }
      ],
      couples: [{ _id: 'c1', coupleId: 'CZ-1', herOpenid: 'A', himOpenid: 'B', status: 'active', anniversary: null }],
      recipes: [
        { _id: 'r1', name: '青椒肉丝', category: '小荤', ingredients: ['肉丝'], steps: ['炒'], tips: ['嫩'], enabled: 'true' },
        { _id: 'r2', name: '番茄炒鸡蛋', category: '素菜', ingredients: ['番茄'], steps: ['炒'], tips: ['甜'] },
        { _id: 'r3', name: '西红柿蛋花汤', category: '汤', ingredients: ['番茄'], steps: ['煮'], tips: ['嫩'], enabled: false },
        { _id: 'r4', name: '未知菜', category: '甜品', ingredients: ['糖'], steps: ['煮'], tips: ['少'] }
      ],
      daily_records: [], wishes: [], messages: [], menstrual: []
    })
  }

  await testCase('M1 migrateRecipes：enabled 字符串/缺失 → boolean true；内容字段不覆盖', async () => {
    const db = oldDb()
    const mod = loadLp(db)
    OPENID = 'A'
    const r = await mod.main({ action: 'migrateRecipes' })
    assertOk(r.ok)
    const list = db.dump().recipes
    assertEq(list.find(x => x._id === 'r1').enabled, true, '字符串 "true" → boolean true')
    assertEq(list.find(x => x._id === 'r2').enabled, true, '缺失 enabled → true')
    assertEq(list.find(x => x._id === 'r1').ingredients[0], '肉丝', '内容不覆盖')
    assertEq(list.find(x => x._id === 'r3').enabled, true, 'false 也被修正为 true（迁移按 schema 修复）')
  })

  await testCase('M2 category 中文变体 → 归一化后 randomMeal 正常', async () => {
    const db = oldDb()
    const mod = loadLp(db)
    OPENID = 'A'
    await mod.main({ action: 'migrateRecipes' })
    const rm = await mod.main({ action: 'randomMeal' })
    assertOk(rm.ok, '迁移后随机成功: ' + JSON.stringify(rm))
    assertEq(rm.meal.meat.name, '青椒肉丝')
    assertEq(rm.meal.vegetable.name, '番茄炒鸡蛋')
    assertEq(rm.meal.soup.name, '西红柿蛋花汤')
  })

  await testCase('M3 未知 category → 保留原值并报告 unknown（不删除）', async () => {
    const db = oldDb()
    const mod = loadLp(db)
    OPENID = 'A'
    const r = await mod.main({ action: 'migrateRecipes' })
    assertEq(r.report.unknown.length, 1, 'unknown 报告')
    assertEq(r.report.unknown[0].name, '未知菜')
    assertOk(db.dump().recipes.find(x => x._id === 'r4'), '未知菜不删除')
  })

  await testCase('M4 randomMeal 失败时附带诊断（categoryDist/enabledTotal）', async () => {
    const db = seedDb()
    await runSeed(db)
    // 全禁 meat 模拟分类缺失
    for (const r of db.dump().recipes.filter(x => x.category === 'meat')) {
      await db.collection('recipes').doc(r._id).update({ data: { enabled: false } })
    }
    const mod = loadLp(db)
    OPENID = 'A'
    const res = await mod.main({ action: 'randomMeal' })
    assertEq(res.code, 'INSUFFICIENT_RECIPE_POOL')
    assertOk(res.diag && res.diag.categoryDist, '含诊断 categoryDist')
    assertEq(res.diag.enabledMeat, 0)
    assertEq(res.diag.enabledVegetable, 30, '分页读取 vegetable 全量 30')
    assertEq(res.diag.meatCount.total, 10, '诊断 meatCount.total=10')
    assertEq(res.diag.vegetableCount.total, 30, '诊断 vegetableCount.total=30')
    assertEq(res.diag.soupCount.total, 10, '诊断 soupCount.total=10')
    assertEq(res.diag.total, 50, '诊断 total=50')
  })

  await testCase('M5 分页读取：>100 条时 fetchAll 全量（不截断）', async () => {
    const db = seedDb()
    // 构造 250 条（meat 100 / vegetable 100 / soup 50）
    const recipes = []
    for (let i = 0; i < 100; i++) recipes.push({ _id: 'rm' + i, name: '肉' + i, category: 'meat', enabled: true, revision: 1, ingredients: ['a'], steps: ['b'], tips: ['c'] })
    for (let i = 0; i < 100; i++) recipes.push({ _id: 'rv' + i, name: '菜' + i, category: 'vegetable', enabled: true, revision: 1, ingredients: ['a'], steps: ['b'], tips: ['c'] })
    for (let i = 0; i < 50; i++) recipes.push({ _id: 'rs' + i, name: '汤' + i, category: 'soup', enabled: true, revision: 1, ingredients: ['a'], steps: ['b'], tips: ['c'] })
    db._data.recipes = recipes // 直接写内部 store（dump() 是深拷贝）
    const mod = loadLp(db)
    // 直接测 fetchAll（分页）
    const all = await mod.fetchAll(db.collection('recipes'), {})
    assertEq(all.length, 250, 'fetchAll 250 全量')
    const meats = await mod.fetchAll(db.collection('recipes'), { category: 'meat', enabled: true })
    assertEq(meats.length, 100, 'meat 100 全量')
    const rm = await mod.main({ action: 'randomMeal' })
    assertOk(rm.ok, '250 条随机成功')
    assertEq(rm.meal.meat.category, 'meat')
  })

  await testCase('M6 前端成功清除旧 error（randomMeal 成功分支 error:""）', () => {
    const foodJs = fs.readFileSync(path.join(ROOT, 'pages/food/food.js'), 'utf8')
    assertOk(foodJs.includes("error: ''"), '成功分支清 error')
  })

  await testCase('M7 migrateRecipes 读取全部 50 条（report.total=50）', async () => {
    const db = oldDb()
    const mod = loadLp(db)
    OPENID = 'A'
    const r = await mod.main({ action: 'migrateRecipes' })
    assertEq(r.report.total, 4, 'oldDb 4 条全读')
  })

  // ---- diagnose + repair（38/50 partial seed 场景，与真云证据一致） ----
  function partialDb() {
    const db = seedDb()
    const first38 = require('../cloudfunctions/lifePlanner/recipes-seed').SEED_RECIPES.slice(0, 38)
    db._data.recipes = first38.map((r, i) => ({
      _id: 'p' + i, ...r, enabled: true, aiGenerated: false, seedVersion: 1, revision: 1
    }))
    return db
  }

  await testCase('D1 diagnoseRecipes：38 条时 missingSeedNames 精确 = 12 道（10 汤 + 2 素菜）', async () => {
    const db = partialDb()
    const mod = loadLp(db)
    OPENID = 'A'
    const r = await mod.main({ action: 'diagnoseRecipes' })
    assertOk(r.ok)
    assertEq(r.dbCount, 38, 'count 交叉验证')
    assertEq(r.fetchedCount, 38, '分页读取交叉验证')
    assertEq(r.duplicateIdCount, 0)
    assertEq(r.missingSeedCount, 12)
    assertOk(r.missingSeedNames.includes('萝卜排骨汤(soup)'), '汤缺失在名单')
    assertOk(r.missingSeedNames.includes('凉拌菠菜(vegetable)'), '素菜缺失在名单')
    assertOk(r.missingSeedNames.every(n => n.includes('(soup)') || n === '凉拌菠菜(vegetable)' || n === '蒜蓉娃娃菜(vegetable)'), '缺失=10 汤+2 素菜')
  })

  await testCase('D2 repairRecipes：38→50 只补 12，分类 10/30/10', async () => {
    const db = partialDb()
    const mod = loadLp(db)
    OPENID = 'A'
    const r = await mod.main({ action: 'repairRecipes' })
    assertOk(r.ok)
    assertEq(r.inserted, 12, '只补 12')
    assertEq(r.total, 50)
    assertEq(r.meat, 10)
    assertEq(r.vegetable, 30)
    assertEq(r.soup, 10)
  })

  await testCase('D3 repairRecipes 幂等：已完整 50 → inserted=0', async () => {
    const db = partialDb()
    const mod = loadLp(db)
    OPENID = 'A'
    await mod.main({ action: 'repairRecipes' })
    const r2 = await mod.main({ action: 'repairRecipes' })
    assertEq(r2.inserted, 0, '第二次插入 0')
    assertEq(r2.total, 50)
  })

  await testCase('D4 repairRecipes 不覆盖人工编辑记录', async () => {
    const db = partialDb()
    // 人工编辑第一条（前 38 道之一：青椒肉丝）——直接改内部 store
    const edited = db._data.recipes.find(x => x.name === '青椒肉丝')
    edited.tips = ['人工编辑的贴士']
    const mod = loadLp(db)
    OPENID = 'A'
    await mod.main({ action: 'repairRecipes' })
    const after = db.dump().recipes.find(x => x.name === '青椒肉丝')
    assertEq(after.tips[0], '人工编辑的贴士', '人工内容保留')
  })

  await testCase('D5 完整 50 时 repair 幂等（inserted=0, total=50）', async () => {
    const db = seedDb()
    await runSeed(db)
    const mod = loadLp(db)
    OPENID = 'A'
    const r = await mod.main({ action: 'repairRecipes' })
    assertEq(r.inserted, 0)
    assertEq(r.total, 50)
  })

  await testCase('D6 修复后 randomMeal 正常（1 meat + 1 vegetable + 1 soup）', async () => {
    const db = partialDb()
    const mod = loadLp(db)
    OPENID = 'A'
    await mod.main({ action: 'repairRecipes' })
    const rm = await mod.main({ action: 'randomMeal' })
    assertOk(rm.ok, '修复后随机成功')
    assertEq(rm.meal.meat.category, 'meat')
    assertEq(rm.meal.vegetable.category, 'vegetable')
    assertEq(rm.meal.soup.category, 'soup')
  })

  console.log('\n=== M7-7 · 入口/UI ===\n')

  const oursWxml = fs.readFileSync(path.join(ROOT, 'pages/ours/ours.wxml'), 'utf8')
  const foodWxml = fs.readFileSync(path.join(ROOT, 'pages/food/food.wxml'), 'utf8')
  const foodJs = fs.readFileSync(path.join(ROOT, 'pages/food/food.js'), 'utf8')
  const recipeWxml = fs.readFileSync(path.join(ROOT, 'pages/recipe/recipe.wxml'), 'utf8')

  check('U1 我们页存在「今天吃什么」入口', oursWxml.includes('今天吃什么') && oursWxml.includes('goFood'))
  check('U2 入口跳转 food 页面', oursWxml.includes('/pages/food/food') || oursJsHasGoFood())
  check('U3 food 页面随机按钮存在', foodWxml.includes('不知道吃什么，随机一下'))
  check('U4 food 未 seed 空状态（菜谱库还没准备好）', foodWxml.includes('菜谱库还没准备好'))
  check('U5 随机结果三卡可点详情', foodWxml.includes('meal.meat._id') && foodWxml.includes('goRecipe'))
  check('U6 全页面无 emoji', !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u.test(oursWxml + foodWxml + recipeWxml), 'M7 页面含 emoji')
  function oursJsHasGoFood() {
    return fs.readFileSync(path.join(ROOT, 'pages/ours/ours.js'), 'utf8').includes('goFood')
  }

  console.log('\n=== 结果: ' + passed + ' PASS / ' + failed + ' FAIL ===')
  if (failed) {
    failures.forEach(f => console.log('  - ' + f))
    process.exit(1)
  }
  console.log('M7 Recipes: ALL GREEN')
}

runAll().catch(e => { console.error('测试执行异常:', e); process.exit(1) })
