// ============================================================
// couple-todo.js · 双方共同待办的纯逻辑（V1.1）
//
// 与「个人待办」的边界（最容易混淆、也最容易误改）：
//   · 个人待办 = daily_records.todos，按 _openid + date 存整天快照，只有她本人能写。
//   · 共同待办 = couple_todos 独立集合，按 coupleId 归属，双方都能写。
//   两者不共享字段、不共享写路径，本文件任何东西都不得碰 daily_records。
//
// 只放不碰数据库的判定：文本归一化 / 长度 / 排序，保证能脱离云数据库直接单测。
// ============================================================

// 集合名（云函数管理端读写；客户端不直读直写）
const TODO_COLLECTION = 'couple_todos'

// 单条上限：40 字。够写「周末一起去超市买下周的菜」这类具体事项，
// 又不会把「我们」页撑成记事本。
const TODO_MAX_LEN = 40

// 单次列表上限：一次最多回 100 条（客户端默认渲染前 5 条 + 展开）。
// 这是**显示上限，不是总数上限**：返回条数等于上限时响应里 truncated=true，
// 客户端据此只能说「已显示 N 条」，不得说「查看全部 N 条」（不开发分页）。
const TODO_LIMIT = 100

// 文本归一化：去控制字符 → 连续空白折叠成一个空格 → 去首尾空白。
// 空内容 / 纯空白 / 过长一律拒绝（返回 reason，由云函数转成明确错误码）。
function normalizeTodoText(raw) {
  if (typeof raw !== 'string') return { ok: false, text: '', reason: 'BAD_TYPE' }
  const s = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!s) return { ok: false, text: '', reason: 'EMPTY' }
  if (s.length > TODO_MAX_LEN) return { ok: false, text: '', reason: 'TOO_LONG' }
  return { ok: true, text: s, reason: null }
}

// 展示排序：未完成优先（新的在前），已完成置后（最近完成的在前）。
// 排序放在服务端，双方看到的顺序天然一致（不依赖各自客户端时钟）。
function sortTodos(items) {
  const arr = Array.isArray(items) ? items.slice() : []
  return arr.sort((a, b) => {
    if (!!a.done !== !!b.done) return a.done ? 1 : -1
    if (a.done) return (b.doneAt || 0) - (a.doneAt || 0)
    return (b.createdAt || 0) - (a.createdAt || 0)
  })
}

module.exports = {
  TODO_COLLECTION,
  TODO_MAX_LEN,
  TODO_LIMIT,
  normalizeTodoText,
  sortTodos
}
