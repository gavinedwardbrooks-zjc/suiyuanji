// ============================================================
// tests/mock-cloud-db.js · 云数据库**事务**替身（服务端语义）
//
// 为什么不能直接用 tests/mock-db.js 的 MockDB？
//   MockDB.runTransaction 是「深拷贝整库 → 回调 → 覆盖写回」的朴素快照，
//   既没有事务锁、也没有提交期版本校验 ⇒ **任何并发都不会冲突**，
//   用它测「并发同一 requestId 只累计一次」必然假绿。
//
// 本替身按云开发官方文档的语义建模（https://developers.weixin.qq.com/minigame/dev/wxcloud/guide/database/transaction.html）：
//   · 快照隔离：事务内读到的是快照，不是实时数据
//   · 写锁：写操作给对象加事务锁；其它事务写同一对象**直接失败**，
//           普通（非事务）写操作会被**阻塞**直到锁释放
//   · 提交期校验：提交时若快照里写入过的文档已被别人提交过 ⇒ 冲突
//           （first-committer-wins，防丢失更新）
//   · runTransaction(fn, times)：冲突**自动重试**，重试前等锁释放并取新快照
//   · 事务内只允许单记录操作（doc.add / doc.update / doc.get / …）；
//           使用 where 批量操作会像真机一样**失败**（BATCH_OP_IN_TRANSACTION）
//   · add 带显式 _id 受唯一约束保护：重复 _id 抛 DUPLICATE_KEY
//   · doc().get() 文档不存在时抛 NOT_EXIST（默认 throwOnNotFound: true）
//
// 局限（如实声明，避免把替身能力当成真机结论）：
//   · 单线程事件循环 + 微任务交错，不是真正的并行；竞态靠 await 让出点复现
//   · 无网络分区、无超时、无跨区一致性建模
//   · 锁等待无超时（真机有超时）；本仓库的代码路径不会出现「事务等非事务写」的死锁
// ============================================================
const { deepClone, genId, matchWhere, applyUpdate } = require('./mock-db')

function keyOf(col, id) {
  return col + '/' + id
}

function conflictErr(msg, blockedKey) {
  const e = new Error(msg || 'TRANSACTION_CONFLICT')
  e.errCode = -502002
  e.__conflict = true
  if (blockedKey) e.blockedKey = blockedKey
  return e
}

function isConflict(e) {
  return !!(e && e.__conflict)
}

function notFoundErr(id) {
  const e = new Error('document not exists: ' + id)
  e.errCode = -502004
  e.__notFound = true
  return e
}

function dupKeyErr(id) {
  const e = new Error('duplicate key error: _id "' + id + '" already exists')
  e.errCode = -502001
  e.__dupKey = true
  return e
}

function dbErr(msg) {
  const e = new Error(msg || 'database request failed (injected)')
  e.errCode = -502001
  e.__dbError = true
  return e
}

const BATCH_IN_TX = 'BATCH_OP_IN_TRANSACTION'

class AtomicMockDB {
  constructor(seed, opts) {
    this._data = deepClone(seed) || {}
    this._versions = new Map() // key -> 提交版本号（每次写入 +1）
    this._locks = new Map() // key -> 持有写锁的事务号
    this._waiters = new Map() // key -> [resolve...]
    this._seq = 0
    this._opts = Object.assign({ throwOnNotFound: true }, opts || {})
    this._faults = [] // 故障注入队列
    this._gates = [] // 确定性交错闸门（证明并发真的重叠，而不是碰巧顺序执行）
    this.stats = {
      transactions: 0,
      commits: 0,
      aborts: 0,
      conflicts: 0,
      retries: 0,
      waits: 0,
      writes: [],
      faultsFired: []
    }
    this.failCommitTimes = 0
    this.command = {
      inc: n => ({ __inc: n }),
      eq: v => ({ __eq: v }),
      neq: v => ({ __neq: v }),
      in: arr => ({ __in: arr }),
      remove: () => ({ __remove: true }),
      gte: n => ({ __gte: n }),
      lte: n => ({ __lte: n })
    }
  }

  // ---- 故障注入 ----------------------------------------------------------
  // 命中一次即消耗；times 可指定连续失败次数
  failOn(col, method, times, error) {
    this._faults.push({ col, method, left: times === undefined ? 1 : times, error: error || null })
    return this
  }

  _takeFault(col, method) {
    for (const f of this._faults) {
      if (f.left <= 0) continue
      if (f.col !== col) continue
      if (f.method !== method) continue
      f.left--
      this.stats.faultsFired.push({ col, method })
      return f.error || dbErr(col + '.' + method + ' 注入失败')
    }
    return null
  }

  // ---- 确定性交错闸门 ----------------------------------------------------
  // 让「事务内第 N 次 col.method」在真正落库前挂起，从而可以把两个并发调用
  // 精确地卡在「都已拿到快照、都准备写同一条记录」的位置上。
  // 没有闸门时，并发用例可能因为微任务顺序碰巧变成完全串行 —— 那样就会假绿。
  gateOn(col, method, count) {
    const g = {
      col,
      method,
      left: count === undefined ? 1 : count,
      enteredCount: 0,
      _enteredWaiters: [],
      resolve: null,
      promise: null
    }
    g.promise = new Promise(res => { g.resolve = res })
    g.entered = () => new Promise(res => {
      if (g.enteredCount > 0) res()
      else g._enteredWaiters.push(res)
    })
    g.release = () => g.resolve()
    this._gates.push(g)
    return g
  }

  _takeGate(col, method) {
    for (const g of this._gates) {
      if (g.left <= 0) continue
      if (g.col !== col || g.method !== method) continue
      g.left--
      g.enteredCount++
      g._enteredWaiters.forEach(r => r())
      g._enteredWaiters = []
      return g
    }
    return null
  }

  // ---- 基础访问 ----------------------------------------------------------
  _list(data, col) {
    if (!data[col]) data[col] = []
    return data[col]
  }

  _find(data, col, id) {
    return this._list(data, col).find(d => d._id === id)
  }

  _bump(key) {
    this._versions.set(key, (this._versions.get(key) || 0) + 1)
  }

  // ---- 锁 ----------------------------------------------------------------
  _acquire(view, key) {
    const owner = this._locks.get(key)
    if (owner && owner !== view.txnId) {
      throw conflictErr('写锁被事务 ' + owner + ' 持有: ' + key, key)
    }
    this._locks.set(key, view.txnId)
    view.locks.add(key)
  }

  _releaseLocks(view) {
    for (const key of view.locks) {
      if (this._locks.get(key) === view.txnId) this._locks.delete(key)
      const ws = this._waiters.get(key)
      if (ws && ws.length) {
        this._waiters.delete(key)
        ws.forEach(r => r())
      }
    }
    view.locks.clear()
  }

  _waitForRelease(keys) {
    const pending = []
    for (const key of keys) {
      if (!this._locks.has(key)) continue
      this.stats.waits++
      pending.push(new Promise(res => {
        const arr = this._waiters.get(key) || []
        arr.push(res)
        this._waiters.set(key, arr)
      }))
    }
    return pending.length ? Promise.all(pending) : Promise.resolve()
  }

  // 普通（非事务）写操作：被事务锁阻塞，直到锁释放
  _awaitUnlocked(keys) {
    return this._waitForRelease(keys)
  }

  // ---- 非事务集合 --------------------------------------------------------
  collection(name) {
    const self = this
    return {
      where(q) {
        const chain = {
          get: async () => {
            const injected = self._takeFault(name, 'whereGet')
            if (injected) throw injected
            return { data: deepClone(self._list(self._data, name).filter(d => matchWhere(d, q))) }
          },
          update: async ({ data }) => {
            const matched = self._list(self._data, name).filter(d => matchWhere(d, q))
            await self._awaitUnlocked(matched.map(d => keyOf(name, d._id)))
            let updated = 0
            for (const d of matched) {
              const injected = self._takeFault(name, 'whereUpdate')
              if (injected) throw injected
              applyUpdate(d, data)
              self._bump(keyOf(name, d._id))
              updated++
            }
            return { stats: { updated } }
          },
          remove: async () => {
            const list = self._list(self._data, name)
            const matched = list.filter(d => matchWhere(d, q))
            await self._awaitUnlocked(matched.map(d => keyOf(name, d._id)))
            for (let i = list.length - 1; i >= 0; i--) {
              if (matchWhere(list[i], q)) list.splice(i, 1)
            }
            return { stats: { removed: matched.length } }
          },
          count: async () => ({ total: self._list(self._data, name).filter(d => matchWhere(d, q)).length })
        }
        return chain
      },
      add: async ({ data }) => {
        const injected = self._takeFault(name, 'add')
        if (injected) throw injected
        const list = self._list(self._data, name)
        if (data && data._id !== undefined) {
          if (list.some(d => d._id === data._id)) throw dupKeyErr(data._id)
        }
        const doc = Object.assign({ _id: genId() }, deepClone(data))
        list.push(doc)
        self._bump(keyOf(name, doc._id))
        return { _id: doc._id }
      },
      count: async () => ({ total: self._list(self._data, name).length }),
      doc(id) {
        return {
          get: async () => {
            const injected = self._takeFault(name, 'get')
            if (injected) throw injected
            const found = self._find(self._data, name, id)
            if (!found) {
              if (self._opts.throwOnNotFound === false) return { data: null }
              throw notFoundErr(id)
            }
            return { data: deepClone(found) }
          },
          update: async ({ data }) => {
            if (!id) throw new Error('mock: doc id required (update)')
            const injected = self._takeFault(name, 'update')
            if (injected) throw injected
            await self._awaitUnlocked([keyOf(name, id)])
            const gate = self._takeGate(name, 'update')
            if (gate) await gate.promise
            const found = self._find(self._data, name, id)
            if (!found) throw notFoundErr(id)
            applyUpdate(found, data)
            self._bump(keyOf(name, id))
            return { stats: { updated: 1 } }
          },
          set: async ({ data }) => {
            const injected = self._takeFault(name, 'set')
            if (injected) throw injected
            await self._awaitUnlocked([keyOf(name, id)])
            const list = self._list(self._data, name)
            const idx = list.findIndex(d => d._id === id)
            const doc = Object.assign({ _id: id }, deepClone(data))
            if (idx >= 0) list[idx] = doc
            else list.push(doc)
            self._bump(keyOf(name, id))
            return { stats: { updated: idx >= 0 ? 1 : 0, created: idx < 0 ? 1 : 0 } }
          },
          remove: async () => {
            const list = self._list(self._data, name)
            const idx = list.findIndex(d => d._id === id)
            if (idx < 0) throw notFoundErr(id)
            list.splice(idx, 1)
            self._bump(keyOf(name, id))
            return { stats: { removed: 1 } }
          }
        }
      }
    }
  }

  // ---- 事务 --------------------------------------------------------------
  _mkTx(view) {
    const self = this
    // 事务内的写：先取写锁（真机：写操作给对象加事务锁），再落进本次快照
    const writeInto = async (col, id, method, mutate) => {
      const key = keyOf(col, id)
      self._acquire(view, key)
      const gate = self._takeGate(col, method)
      if (gate) await gate.promise
      mutate()
      view.written.set(key, { col, id })
      self.stats.writes.push({ txn: view.txnId, col, id })
    }
    return {
      collection(name) {
        return {
          // 事务内不支持批量操作（真机会直接失败）——替身同样失败，避免写出真机跑不通的代码
          where() {
            const e = new Error(BATCH_IN_TX + ': 事务内不支持 where 批量操作，只支持 collection.doc / collection.add')
            e.errCode = -502003
            e.__batchInTx = true
            throw e
          },
          add: async ({ data }) => {
            const injected = self._takeFault(name, 'add')
            if (injected) throw injected
            const id = data && data._id !== undefined ? data._id : genId()
            if (self._find(view.data, name, id)) throw dupKeyErr(id)
            await writeInto(name, id, 'add', () => {
              self._list(view.data, name).push(Object.assign({ _id: id }, deepClone(data)))
            })
            return { _id: id }
          },
          doc(id) {
            return {
              get: async () => {
                const injected = self._takeFault(name, 'get')
                if (injected) throw injected
                const found = self._find(view.data, name, id)
                if (!found) {
                  if (self._opts.throwOnNotFound === false) return { data: null }
                  throw notFoundErr(id)
                }
                return { data: deepClone(found) }
              },
              update: async ({ data }) => {
                if (!id) throw new Error('mock: doc id required (update)')
                const injected = self._takeFault(name, 'update')
                if (injected) throw injected
                if (!self._find(view.data, name, id)) throw notFoundErr(id)
                await writeInto(name, id, 'update', () => {
                  applyUpdate(self._find(view.data, name, id), data)
                })
                return { stats: { updated: 1 } }
              },
              set: async ({ data }) => {
                const injected = self._takeFault(name, 'set')
                if (injected) throw injected
                const existed = !!self._find(view.data, name, id)
                await writeInto(name, id, 'set', () => {
                  const list = self._list(view.data, name)
                  const idx = list.findIndex(d => d._id === id)
                  const doc = Object.assign({ _id: id }, deepClone(data))
                  if (idx >= 0) list[idx] = doc
                  else list.push(doc)
                })
                return { stats: { updated: existed ? 1 : 0, created: existed ? 0 : 1 } }
              },
              remove: async () => {
                if (!self._find(view.data, name, id)) throw notFoundErr(id)
                await writeInto(name, id, 'remove', () => {
                  const list = self._list(view.data, name)
                  const idx = list.findIndex(d => d._id === id)
                  if (idx >= 0) list.splice(idx, 1)
                })
                return { stats: { removed: 1 } }
              }
            }
          }
        }
      },
      rollback: async value => {
        const e = new Error('ROLLBACK')
        e.__rollback = true
        e.rollbackValue = value
        throw e
      }
    }
  }

  _commit(view) {
    // 第一轮：全部校验，任何一个不通过就整体不提交（要么都生效、要么都不生效）
    for (const [key] of view.written) {
      const now = this._versions.get(key) || 0
      const at = view.snapshotVersions.get(key) || 0
      if (now !== at) {
        throw conflictErr('commit: 快照已过期（' + key + '）')
      }
    }
    // 第二轮：原子落库
    for (const [key, meta] of view.written) {
      const doc = this._find(view.data, meta.col, meta.id)
      if (!doc) continue
      const list = this._list(this._data, meta.col)
      const idx = list.findIndex(d => d._id === meta.id)
      if (idx >= 0) list[idx] = deepClone(doc)
      else list.push(deepClone(doc))
      this._bump(key)
    }
  }

  runTransaction(fn, times) {
    const self = this
    const maxAttempts = Math.max(1, Number(times) || 1)
    let attempt = 0

    const attemptOnce = async () => {
      attempt++
      self.stats.transactions++
      const txnId = ++self._seq
      const view = {
        txnId,
        data: deepClone(self._data),
        snapshotVersions: new Map(self._versions),
        written: new Map(),
        locks: new Set()
      }
      try {
        const res = await fn(self._mkTx(view))
        if (self.failCommitTimes > 0) {
          self.failCommitTimes--
          self.stats.faultsFired.push({ col: null, method: 'commit' })
          throw dbErr('commit 注入失败')
        }
        self._commit(view)
        self.stats.commits++
        self._releaseLocks(view)
        return res
      } catch (e) {
        const conflicted = isConflict(e)
        if (conflicted) self.stats.conflicts++
        self._releaseLocks(view)
        if (conflicted && attempt < maxAttempts) {
          self.stats.retries++
          // 退避：等锁释放后再取新快照重试（真机重试也会晚于对方提交）
          await self._waitForRelease(e.blockedKey ? [e.blockedKey] : [])
          return attemptOnce()
        }
        self.stats.aborts++
        throw e
      }
    }
    return attemptOnce()
  }

  // ---- 观测 --------------------------------------------------------------
  dump() {
    return deepClone(this._data)
  }

  // 往某个集合放一条种子数据（测试夹具用；不做原子性承诺）
  seed(col, doc) {
    const list = this._list(this._data, col)
    const i = list.findIndex(d => d._id === doc._id)
    if (i >= 0) list[i] = deepClone(doc)
    else list.push(deepClone(doc))
    return this
  }

  liveLockCount() {
    return this._locks.size
  }

  waiterCount() {
    let n = 0
    for (const arr of this._waiters.values()) n += arr.length
    return n
  }

  versionOf(col, id) {
    return this._versions.get(keyOf(col, id)) || 0
  }
}

module.exports = {
  AtomicMockDB,
  isConflict,
  conflictErr,
  notFoundErr,
  dupKeyErr,
  BATCH_IN_TX,
  keyOf
}
