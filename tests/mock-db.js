// ============================================================
// tests/mock-db.js · 内存版微信云数据库（用于 M1 Gate 单测）
// 支持：where().get() / add() / doc().update() / updateWhere()
//       command.inc / eq / remove / runTransaction（快照式）
//
// P3.3 追加：一次性「执行点钩子」injectHook(col, method, fn)
//   用于制造**可控的并发顺序**（例如：授权读取完成 → 暂停 → 撤销提交 → 恢复写入）。
//   钩子在指定操作的执行点 await，默认不存在 ⇒ 对既有测试零影响。
//   明确的能力边界：这只是单进程测试调度点，**不代表**生产数据库的锁/事务语义。
// ============================================================

function deepClone(o) {
  return o === undefined ? undefined : JSON.parse(JSON.stringify(o))
}

function genId() {
  return 'mock_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
}

// where 条件匹配（支持普通值 与 command.eq 包装）
function matchWhere(doc, q) {
  for (const key of Object.keys(q || {})) {
    const cond = q[key]
    if (cond && typeof cond === 'object' && cond.__and !== undefined) {
      // and([...])：全部子条件满足（模拟 command.gte().and(.lte())）
      for (const sub of cond.__and) {
        if (!matchWhere(doc, { [key]: sub })) return false
      }
    } else if (cond && typeof cond === 'object' && cond.__in !== undefined) {
      // in([...])：字段值在数组中
      if (!cond.__in.includes(doc[key])) return false
    } else if (cond && typeof cond === 'object' && cond.__gte !== undefined) {
      if (!(doc[key] >= cond.__gte)) return false
    } else if (cond && typeof cond === 'object' && cond.__lte !== undefined) {
      if (!(doc[key] <= cond.__lte)) return false
    } else if (cond && typeof cond === 'object' && cond.__neq !== undefined) {
      if (doc[key] === cond.__neq) return false
    } else if (cond && typeof cond === 'object' && cond.__eq !== undefined) {
      const expect = cond.__eq
      const actual = doc[key] === undefined ? null : doc[key]
      if (expect === null) {
        // eq(null)：字段缺失或为 null 均视为未认领
        if (!(doc[key] === undefined || doc[key] === null)) return false
      } else if (actual !== expect) return false
    } else if (cond === null) {
      if (!(doc[key] === undefined || doc[key] === null)) return false
    } else if (doc[key] !== cond) {
      return false
    }
  }
  return true
}

function applyUpdate(doc, data) {
  for (const key of Object.keys(data || {})) {
    const v = data[key]
    if (v && typeof v === 'object' && v.__inc !== undefined) {
      doc[key] = (doc[key] || 0) + v.__inc
    } else if (v && typeof v === 'object' && v.__remove) {
      delete doc[key]
    } else {
      doc[key] = deepClone(v)
    }
  }
  return doc
}

// 链式 and 辅助：{ __gte: n }.and({ __lte: m }) → { __and: [...] }
function andable(own) {
  return {
    and: other => ({ __and: [own, other] })
  }
}

class MockCol {
  constructor(store, name) {
    this.store = store // 引用共享数据源（事务内为快照）
    this.name = name
  }
  _list() {
    if (!this.store[this.name]) this.store[this.name] = []
    return this.store[this.name]
  }
  // 故障注入（测试用）：injectFail(col, 'add'|'update'[, times]) 后第 N 次对应操作抛错。
  // times 省略 = 一次性（触发即清空）；给次数时用完才清空，用于验证重试路径。
  _maybeFail(method) {
    const fail = this.store.__failOn
    if (!fail || fail.col !== this.name || fail.method !== method) return
    if (typeof fail.left === 'number') {
      if (fail.left <= 0) { this.store.__failOn = null; return }
      fail.left--
      if (fail.left <= 0) this.store.__failOn = null
    } else {
      this.store.__failOn = null
    }
    const err = new Error('injected ' + method + ' failure')
    err.errCode = -502001
    err.errMsg = 'mock injected ' + method + ' failure'
    throw err
  }
  // 执行点钩子（测试用）：injectHook(col, 'get'|'add'|'update', fn) 后，
  // 下一次对应操作会在执行点 await fn(ctx)。一次性触发（触发即清空）。
  // injectHookN(col, method, n, fn) 表示第 n 次调用才触发（用于「第二次读取时」等场景）。
  // get 的钩子在「数据已读出、尚未返回」时触发 —— 正好对应
  // 「服务端授权读取完成后、写入之前」这个竞态窗口。
  async _maybeHook(method, ctx) {
    const hook = this.store.__hookOn
    if (!hook || hook.col !== this.name || hook.method !== method) return
    if (typeof hook.left === 'number') {
      hook.left--
      if (hook.left > 0) return
    }
    this.store.__hookOn = null
    await hook.fn(ctx || {})
  }
  where(q) {
    const self = this
    // 惰性匹配（P3.3-R1）：条件在**执行时**才对当前数据求值，
    // 而不是在 where() 调用瞬间快照。真实数据库就是这个语义；
    // 之前的提前快照会让「读取过程中别人提交了写入」这类交错无法忠实构造，
    // 竞态测试会把旧值当新值，从而得出偏乐观的结论。
    const evalNow = () => self._list().filter(d => matchWhere(d, q))
    // 投影/排序/limit/skip 支持
    let project = null
    let order = null // { field, dir: 'asc'|'desc' }
    let limitN = 0
    let skipN = 0
    const chain = {
      get: async () => {
        self._maybeFail('get')
        let out = deepClone(evalNow())
        if (order) {
          const { field, dir } = order
          out.sort((a, b) => {
            const va = a[field] === undefined ? 0 : a[field]
            const vb = b[field] === undefined ? 0 : b[field]
            return dir === 'desc' ? vb - va : va - vb
          })
        }
        if (skipN > 0) out = out.slice(skipN)
        if (limitN > 0) out = out.slice(0, limitN)
        if (project) {
          out = out.map(d => {
            const r = { _id: d._id }
            for (const k of Object.keys(project)) if (project[k]) r[k] = d[k]
            return r
          })
        }
        await self._maybeHook('get', { q, data: out })
        return { data: out }
      },
      field: (fields) => { project = fields; return chain },
      orderBy: (field, dir) => { order = { field, dir }; return chain },
      limit: (n) => { limitN = n; return chain },
      skip: (n) => { skipN = n; return chain },
      // where().update：更新所有匹配文档（微信语义）。
      // 匹配与写入在同一个同步块内完成 → 模拟数据库的行级原子性。
      update: async ({ data }) => {
        self._maybeFail('update')
        await self._maybeHook('update', { q, data })
        const list = self._list()
        let updated = 0
        for (const d of list) {
          if (matchWhere(d, q)) {
            applyUpdate(d, data)
            updated++
          }
        }
        return { stats: { updated } }
      },
      // where().remove：删除所有匹配文档（微信语义）
      remove: async () => {
        self._maybeFail('remove')
        const list = self._list()
        let removed = 0
        for (let i = list.length - 1; i >= 0; i--) {
          if (matchWhere(list[i], q)) { list.splice(i, 1); removed++ }
        }
        return { stats: { removed } }
      }
    }
    return chain
  }
  async add({ data }) {
    // 故障注入（测试用）：injectFail('wishes','add') 后下一次 add 抛错，
    // 用于验证「同步失败不得无痕」的错误策略（避免真云失败本地假绿）
    this._maybeFail('add')
    await this._maybeHook('add', { data })
    // 真实云数据库的 _id 唯一约束：显式 _id 重复 → 抛错。
    // （并发创建同一确定性文档时触发，生产代码据此转换成幂等 / 重试路径）
    if (data && data._id !== undefined && this._list().some(d => d._id === data._id)) {
      const err = new Error('mock duplicate _id')
      err.errCode = -502001
      err.errMsg = 'mock duplicate _id'
      throw err
    }
    const doc = { _id: genId(), ...deepClone(data) }
    this._list().push(doc)
    return { _id: doc._id }
  }
  async count() {
    return { total: this._list().length }
  }
  doc(id) {
    const self = this
    return {
      async get() {
        if (!id) throw new Error('mock: doc id required (get)')
        self._maybeFail('get')
        const found = self._list().find(d => d._id === id)
        await self._maybeHook('get', { id })
        return { data: found ? deepClone(found) : null }
      },
      async update({ data }) {
        if (!id) throw new Error('mock: doc id required (update) — 文档缺少 _id')
        self._maybeFail('update')
        await self._maybeHook('update', { id, data })
        const found = self._list().find(d => d._id === id)
        if (!found) throw new Error('document not exists: ' + id)
        applyUpdate(found, data)
        return { stats: { updated: 1 } }
      },
      async remove() {
        if (!id) throw new Error('mock: doc id required (remove)')
        const list = self._list()
        const idx = list.findIndex(d => d._id === id)
        if (idx === -1) return { stats: { removed: 0 } }
        list.splice(idx, 1)
        return { stats: { removed: 1 } }
      }
    }
  }
  // 原子 update-where：匹配检查与写入在同一同步块内完成（模拟数据库原子性）
  async updateWhere({ where, data }) {
    const list = this._list()
    let updated = 0
    for (const d of list) {
      if (matchWhere(d, where)) {
        applyUpdate(d, data)
        updated++
      }
    }
    return { updated }
  }
}

class MockDB {
  constructor(seed) {
    this._data = deepClone(seed) || {}
    this.command = {
      inc: n => ({ __inc: n }),
      eq: v => ({ __eq: v }),
      neq: v => ({ __neq: v }),
      in: arr => ({ __in: arr }),
      remove: () => ({ __remove: true }),
      // 链式 and：_.gte(a).and(_.lte(b)) → { __and: [{__gte:a},{__lte:b}] }
      gte: n => Object.assign({ __gte: n }, andable({ __gte: n })),
      lte: n => Object.assign({ __lte: n }, andable({ __lte: n }))
    }
  }
  collection(name) {
    return new MockCol(this._data, name)
  }
  // 故障注入（测试用）：下一次对指定集合的指定方法调用抛错
  // times 可选：连续失败次数（默认 1）
  injectFail(col, method, times) {
    this._data.__failOn = { col, method }
    if (typeof times === 'number') this._data.__failOn.left = times
    return this
  }
  // 执行点钩子（测试用）：下一次对指定集合的指定方法调用会 await fn(ctx)
  // 用于制造可控并发顺序。一次性触发。
  injectHook(col, method, fn) {
    this._data.__hookOn = { col, method, fn }
    return this
  }
  // 第 n 次调用才触发（1-based）。用于「首次读取放行、第二次读取暂停」这类交错。
  injectHookN(col, method, n, fn) {
    this._data.__hookOn = { col, method, fn, left: n }
    return this
  }
  // 快照式事务：成功 commit 写回，失败丢弃（模拟回滚）
  async runTransaction(fn) {
    const snapshot = deepClone(this._data)
    const t = new MockCol(snapshot, '__txn')
    const txnAdapter = {
      collection: name => new MockCol(snapshot, name)
    }
    const res = await fn(txnAdapter)
    this._data = snapshot
    return res
  }
  dump() {
    return deepClone(this._data)
  }
}

module.exports = { MockDB, deepClone, genId, matchWhere, applyUpdate }
