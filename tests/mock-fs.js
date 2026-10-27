// ============================================================
// tests/mock-fs.js · 内存版小程序文件系统 + 本地存储适配
// 用途：让 utils/localBooks.js 的行为测试可在 Node 下真实执行
// （不是静态断言），覆盖 saveFile 移动语义、unlink 缺失、目录创建、
// 配额、storage 写失败等分支。
// 非 .test.js 命名，因此不会被 tests/*.test.js 循环当成测试文件。
// ============================================================

function normalizeBytes(v) {
  if (v === undefined || v === null) return null
  if (Buffer.isBuffer(v)) return Buffer.from(v)
  if (v instanceof Uint8Array) return Buffer.from(v)
  return Buffer.from(String(v), 'utf8')
}

// 种子文件没注入内容时按空格填充：需要读内容的测试必须显式注入字节，
// 避免「读到一串 0 却以为读到了真实文本」的假验证。
function materializeBytes(rec) {
  if (rec && rec.bytes) return rec.bytes
  const size = rec && Number.isFinite(Number(rec.size)) ? Number(rec.size) : 0
  return Buffer.alloc(size, 0x20)
}

// 官方 readFile 语义：position / length 以字节为单位；不传 encoding 返回 ArrayBuffer。
// utf8 解码沿用 Node Buffer.toString('utf8')，与小程序一样会把非法/半个字符解成 U+FFFD。
function sliceBytes(rec, position, length, encoding) {
  const buf = materializeBytes(rec)
  const pos = Number.isFinite(Number(position)) ? Math.max(0, Number(position)) : 0
  const len = Number.isFinite(Number(length)) ? Math.max(0, Number(length)) : (buf.length - pos)
  const slice = buf.subarray(pos, pos + len)
  if (!encoding) return slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength)
  const enc = String(encoding).toLowerCase()
  if (enc === 'binary' || enc === 'latin1') return slice.toString('latin1')
  if (enc === 'hex') return slice.toString('hex')
  if (enc === 'base64') return slice.toString('base64')
  return slice.toString('utf8')
}

function createMockFs(options) {
  const opts = options || {}
  const USER_DATA_PATH = opts.userDataPath || 'wxfile://usr'
  const files = new Map() // path -> { size }
  const dirs = new Set([USER_DATA_PATH])
  const calls = []
  const failNext = new Map() // op -> error（一次性）

  function dirname(p) {
    const i = String(p).lastIndexOf('/')
    return i <= 0 ? '' : String(p).slice(0, i)
  }

  function err(errCode, errMsg) {
    return Object.assign(new Error(errMsg), { errCode, errMsg })
  }

  function setFailNext(op, e) {
    failNext.set(op, e)
  }

  function maybeFail(op) {
    if (failNext.has(op)) {
      const e = failNext.get(op)
      failNext.delete(op)
      throw e
    }
  }

  const fsApi = {
    getUserDataPath() {
      return USER_DATA_PATH
    },
    ensureDir(dirPath) {
      calls.push({ op: 'ensureDir', dirPath })
      try {
        maybeFail('ensureDir')
      } catch (e) {
        return Promise.reject(e)
      }
      if (dirs.has(dirPath)) return Promise.resolve()
      dirs.add(dirPath)
      return Promise.resolve()
    },
    access(path) {
      calls.push({ op: 'access', path })
      try {
        maybeFail('access')
      } catch (e) {
        return Promise.resolve(false)
      }
      return Promise.resolve(files.has(path) || dirs.has(path))
    },
    stat(path) {
      calls.push({ op: 'stat', path })
      try {
        maybeFail('stat')
      } catch (e) {
        return Promise.reject(e)
      }
      if (dirs.has(path)) return Promise.resolve({ size: 0, isDirectory: true, isFile: false })
      if (files.has(path)) return Promise.resolve({ size: files.get(path).size, isDirectory: false, isFile: true })
      return Promise.reject(err(1300002, 'no such file or directory ' + path))
    },
    saveFile(o) {
      calls.push({ op: 'saveFile', tempFilePath: o.tempFilePath, filePath: o.filePath })
      try {
        maybeFail('saveFile')
      } catch (e) {
        return Promise.reject(e)
      }
      if (!files.has(o.tempFilePath)) {
        return Promise.reject(err(1301112, 'tempFilePath file not exist'))
      }
      if (files.has(o.filePath)) {
        return Promise.reject(err(1301005, 'file already exists ' + o.filePath))
      }
      const size = files.get(o.tempFilePath).size
      const bytes = files.get(o.tempFilePath).bytes
      files.delete(o.tempFilePath) // 官方语义：saveFile 会移动临时文件
      files.set(o.filePath, { size, bytes })
      return Promise.resolve({ savedFilePath: o.filePath })
    },
    unlink(o) {
      calls.push({ op: 'unlink', filePath: o.filePath })
      try {
        maybeFail('unlink')
      } catch (e) {
        return Promise.reject(e)
      }
      if (!files.has(o.filePath)) {
        return Promise.reject(err(1300002, 'no such file or directory ' + o.filePath))
      }
      files.delete(o.filePath)
      return Promise.resolve()
    },
    readdir(dirPath) {
      calls.push({ op: 'readdir', dirPath })
      try {
        maybeFail('readdir')
      } catch (e) {
        return Promise.reject(e)
      }
      if (!dirs.has(dirPath)) return Promise.reject(err(1300002, 'no such file or directory ' + dirPath))
      const out = []
      for (const p of files.keys()) {
        if (dirname(p) === dirPath) out.push(String(p).slice(dirPath.length + 1))
      }
      return Promise.resolve(out)
    },
    readFile(o) {
      const opts0 = o || {}
      calls.push({ op: 'readFile', filePath: opts0.filePath, position: opts0.position, length: opts0.length, encoding: opts0.encoding })
      try {
        maybeFail('readFile')
      } catch (e) {
        return Promise.reject(e)
      }
      const rec = files.get(opts0.filePath)
      if (!rec) return Promise.reject(err(1300002, 'no such file or directory ' + opts0.filePath))
      return Promise.resolve({ data: sliceBytes(rec, opts0.position, opts0.length, opts0.encoding) })
    }
  }

  return {
    fs: fsApi,
    files,
    dirs,
    calls,
    userDataPath: USER_DATA_PATH,
    seedTemp(path, size, bytes) {
      files.set(path, { size, bytes: normalizeBytes(bytes) })
      return path
    },
    seedFile(path, size, bytes) {
      files.set(path, { size, bytes: normalizeBytes(bytes) })
      dirs.add(dirname(path))
      return path
    },
    // 以真实字节播种：size 自动等于字节长度（TXT 阅读测试用）
    seedFileBytes(path, bytes) {
      const buf = normalizeBytes(bytes)
      files.set(path, { size: buf ? buf.length : 0, bytes: buf })
      dirs.add(dirname(path))
      return path
    },
    bytesOf(path) {
      return files.has(path) ? files.get(path).bytes : null
    },
    hasFile(path) {
      return files.has(path)
    },
    sizeOf(path) {
      return files.has(path) ? files.get(path).size : null
    },
    deleteFileRaw(path) {
      files.delete(path)
    },
    listFiles() {
      return Array.from(files.keys())
    },
    fileCount() {
      return files.size
    },
    setFailNext
  }
}

function createMockStorage(initial) {
  const map = new Map(Object.entries(initial || {}))
  const failKeys = new Set()
  let failAll = false
  return {
    read(key) {
      return map.has(key) ? map.get(key) : ''
    },
    write(key, value) {
      if (failAll || failKeys.has(key)) {
        throw Object.assign(new Error('setStorageSync:fail mock write failure'), { errMsg: 'setStorageSync:fail mock write failure' })
      }
      map.set(key, value)
    },
    remove(key) {
      map.delete(key)
    },
    raw: map,
    failWriteFor(key) {
      failKeys.add(key)
    },
    allowWriteFor(key) {
      failKeys.delete(key)
    },
    failWriteAll(on) {
      failAll = on !== false
    }
  }
}

function createMockEnv(options) {
  const opts = options || {}
  const mockFs = createMockFs({ userDataPath: opts.userDataPath })
  const storage = createMockStorage(opts.storage)
  let clock = Number.isFinite(opts.startTime) ? opts.startTime : 1700000000000
  let seq = 0
  const env = {
    fs: mockFs.fs,
    storage,
    now() {
      const step = Number.isFinite(opts.timeStep) ? opts.timeStep : 1000
      const v = clock
      clock += step
      return v
    },
    random() {
      seq += 1
      return ((seq * 37) % 997) / 997
    }
  }
  return { env, fs: mockFs, storage, calls: mockFs.calls }
}

function dirNameOf(p) {
  const i = String(p).lastIndexOf('/')
  return i <= 0 ? '' : String(p).slice(0, i)
}

function rawErr(errCode, errMsg) {
  return Object.assign(new Error(errMsg), { errCode, errMsg })
}

// ============================================================
// createMockWx · 页面级测试替身
// 供 pages/reading/reading.js 在 Node 下真实执行：
//   - 回调式 FileSystemManager（与线上 createWxEnv 的入参一致）
//   - 同步 storage
//   - chooseMessageFile / showToast / showModal 记录器
//   - cloud.database()/uploadFile/deleteFile/getTempFileURL 计数器
//     （上传/删除一律 reject，任何误用都会立刻暴露）
// ============================================================
function createMockWx(options) {
  const opts = options || {}
  const mockFs = createMockFs({ userDataPath: opts.userDataPath })
  const storage = createMockStorage(opts.storage)
  const calls = {
    chooseMessageFile: 0,
    uploadFile: 0,
    deleteFile: 0,
    getTempFileURL: 0,
    callFunction: 0,
    callFunctionData: [],
    booksAdd: 0,
    booksAddData: [],
    booksQuery: 0,
    booksWhere: 0,
    booksWhereData: [],
    booksRemove: 0,
    booksRemoveData: [],
    booksUpdate: [],
    downloadFile: 0,
    downloadFileData: [],
    openDocument: 0,
    openDocumentData: [],
    unlink: 0,
    // S5：按字节区间读取与页面导航都必须可观测
    readFile: 0,
    readFileLog: [],
    navigateTo: 0,
    navigateToData: [],
    navigateBack: 0,
    switchTab: 0
  }
  const toasts = []
  const modals = []
  const consoleErrors = []

  const queued = Array.isArray(opts.files) ? opts.files.slice() : (opts.files ? [opts.files] : [])
  let chooseFails = opts.chooseMessageFileFails === true
  // 云函数可注入「前 N 次失败」：真实网络抖动/超时的确定性替身，
  // 用于验证「失败必须落地待补报 → 下次安全重放」这条链路。
  let callFunctionFailsLeft = opts.callFunctionFails === true
    ? Infinity
    : (Number.isFinite(Number(opts.callFunctionFailTimes)) ? Number(opts.callFunctionFailTimes) : 0)
  const cloudBooks = Array.isArray(opts.cloudBooks) ? opts.cloudBooks.slice() : []

  // S4：可按 op 注入文件系统失败（例如 unlink 失败），用于验证「文件删除失败不得删元数据」
  const fsFailOps = new Set(
    Array.isArray(opts.fsFails) ? opts.fsFails.slice() : (opts.fsFails ? [opts.fsFails] : [])
  )
  function fsFail(op) {
    if (!fsFailOps.has(op)) return null
    return rawErr(1300001, op + ':fail injected error')
  }

  const fsManager = {
    access(o) {
      mockFs.calls.push({ op: 'access', path: o.path })
      const injected = fsFail('access')
      if (injected) return o.fail && o.fail(injected)
      const ok = mockFs.files.has(o.path) || mockFs.dirs.has(o.path)
      if (ok) return o.success && o.success({})
      if (o.fail) o.fail(rawErr(1300002, 'access:fail no such file or directory ' + o.path))
    },
    stat(o) {
      mockFs.calls.push({ op: 'stat', path: o.path })
      const injected = fsFail('stat')
      if (injected) return o.fail && o.fail(injected)
      if (mockFs.dirs.has(o.path)) {
        return o.success && o.success({ stats: { size: 0, isDirectory: () => true, isFile: () => false } })
      }
      if (mockFs.files.has(o.path)) {
        const size = mockFs.files.get(o.path).size
        return o.success && o.success({ stats: { size, isDirectory: () => false, isFile: () => true } })
      }
      if (o.fail) o.fail(rawErr(1300002, 'stat:fail no such file or directory ' + o.path))
    },
    mkdir(o) {
      mockFs.calls.push({ op: 'mkdir', dirPath: o.dirPath })
      const injected = fsFail('mkdir')
      if (injected) return o.fail && o.fail(injected)
      if (mockFs.dirs.has(o.dirPath)) return o.fail && o.fail(rawErr(1301005, 'mkdir:fail file already exists'))
      mockFs.dirs.add(o.dirPath)
      return o.success && o.success({})
    },
    readdir(o) {
      const injected = fsFail('readdir')
      if (injected) return o.fail && o.fail(injected)
      if (!mockFs.dirs.has(o.dirPath)) return o.fail && o.fail(rawErr(1300002, 'readdir:fail no such file or directory'))
      const out = []
      for (const p of mockFs.files.keys()) {
        if (dirNameOf(p) === o.dirPath) out.push(String(p).slice(o.dirPath.length + 1))
      }
      return o.success && o.success({ files: out })
    },
    saveFile(o) {
      mockFs.calls.push({ op: 'saveFile', tempFilePath: o.tempFilePath, filePath: o.filePath })
      const injected = fsFail('saveFile')
      if (injected) return o.fail && o.fail(injected)
      if (!mockFs.files.has(o.tempFilePath)) {
        return o.fail && o.fail(rawErr(1301112, 'saveFile:fail tempFilePath file not exist'))
      }
      const size = mockFs.files.get(o.tempFilePath).size
      const bytes = mockFs.files.get(o.tempFilePath).bytes
      mockFs.files.delete(o.tempFilePath)
      mockFs.files.set(o.filePath, { size, bytes })
      return o.success && o.success({ savedFilePath: o.filePath })
    },
    readFile(o) {
      const opts0 = o || {}
      mockFs.calls.push({ op: 'readFile', filePath: opts0.filePath, position: opts0.position, length: opts0.length, encoding: opts0.encoding })
      calls.readFile += 1
      calls.readFileLog.push({
        filePath: opts0.filePath,
        position: opts0.position,
        length: opts0.length,
        encoding: opts0.encoding
      })
      // rangeReadFails：模拟「真机不支持 position/length 分段读取」——
      // 只要带了 length 就失败，不带 length 的整读仍然可用。
      // 这样「有界兜底」这条路径才能被真实覆盖，而不是靠猜。
      const rangeFail = opts.rangeReadFails && Number.isFinite(Number(opts0.length))
        ? rawErr(1300001, 'readFile:fail position/length not supported')
        : null
      const injected = fsFail('readFile') || rangeFail
      if (injected) return o.fail && o.fail(injected)
      const rec = mockFs.files.get(opts0.filePath)
      if (!rec) return o.fail && o.fail(rawErr(1300002, 'readFile:fail no such file or directory ' + opts0.filePath))
      return o.success && o.success({ data: sliceBytes(rec, opts0.position, opts0.length, opts0.encoding) })
    },
    unlink(o) {
      mockFs.calls.push({ op: 'unlink', filePath: o.filePath })
      calls.unlink += 1
      const injected = fsFail('unlink')
      if (injected) return o.fail && o.fail(injected)
      if (!mockFs.files.has(o.filePath)) {
        return o.fail && o.fail(rawErr(1300002, 'unlink:fail no such file or directory ' + o.filePath))
      }
      mockFs.files.delete(o.filePath)
      return o.success && o.success({})
    }
  }

  const dbMock = {
    collection() {
      return {
        orderBy() {
          return {
            get() {
              calls.booksQuery += 1
              return Promise.resolve({ data: cloudBooks.slice() })
            }
          }
        },
        // 删除前的记录复核走 where（避免依赖 throwOnNotFound / 猜错误码）
        where(q) {
          return {
            get() {
              calls.booksWhere += 1
              calls.booksWhereData.push(q)
              if (opts.booksWhereFails) {
                return Promise.reject(rawErr(-1, 'books.where:fail mock'))
              }
              const cond = q || {}
              const rows = cloudBooks.filter(b => Object.keys(cond).every(k => b[k] === cond[k]))
              return Promise.resolve({ data: rows.map(r => Object.assign({}, r)) })
            }
          }
        },
        doc(id) {
          return {
            update(payload) {
              calls.booksUpdate.push({ id, data: payload && payload.data })
              if (opts.booksUpdateFails) {
                return Promise.reject(rawErr(-1, 'books.update:fail mock'))
              }
              return Promise.resolve({ stats: { updated: 1 } })
            },
            // 唯一被允许的云端删除动作（doc(_id).remove()，一次只影响一条）
            remove() {
              calls.booksRemove += 1
              calls.booksRemoveData.push({ id })
              if (opts.booksRemoveFails) {
                return Promise.reject(rawErr(-1, 'books.remove:fail mock'))
              }
              const i = cloudBooks.findIndex(b => String(b._id) === String(id))
              if (opts.booksRemoveNoop) {
                // 「谎报成功」的替身：返回 removed:1 但一条都没删 ——
                // 客户端必须靠刷新后的列表核验，绝不轻信返回值
                return Promise.resolve({ stats: { removed: 1 } })
              }
              if (i === -1) return Promise.resolve({ stats: { removed: 0 } })
              cloudBooks.splice(i, 1)
              if (opts.booksRemoveOpaque) {
                // 返回结构不含 stats（不同 SDK 版本可能如此）：
                // 客户端不得据此臆造「删失败」
                return Promise.resolve({})
              }
              return Promise.resolve({ stats: { removed: 1 } })
            }
          }
        },
        add(payload) {
          calls.booksAdd += 1
          calls.booksAddData.push(payload && payload.data)
          return Promise.resolve({ _id: 'cloud_new' })
        }
      }
    },
    command: { inc: n => ({ $inc: n }) }
  }

  const wxMock = {
    env: { USER_DATA_PATH: mockFs.userDataPath },
    getFileSystemManager() { return fsManager },
    getStorageSync(key) { return storage.read(key) },
    setStorageSync(key, value) { return storage.write(key, value) },
    removeStorageSync(key) { return storage.remove(key) },
    chooseMessageFile() {
      calls.chooseMessageFile += 1
      if (chooseFails) return Promise.reject(rawErr(-1, 'chooseMessageFile:fail cancel'))
      const f = queued.shift() || null
      return Promise.resolve({ tempFiles: f ? [f] : [] })
    },
    showToast(o) { toasts.push(o || {}); return undefined },
    showModal(o) {
      modals.push(o || {})
      const confirm = opts.modalConfirm !== false
      if (o && o.success) o.success({ confirm, cancel: !confirm })
      return undefined
    },
    openDocument(o) {
      calls.openDocument += 1
      calls.openDocumentData.push({
        filePath: o && o.filePath,
        fileType: o && o.fileType,
        showMenu: o && o.showMenu
      })
      if (opts.openDocumentFails) {
        return o && o.fail && o.fail(rawErr(-1, 'openDocument:fail mock'))
      }
      if (o && o.success) o.success({})
      return undefined
    },
    downloadFile(o) {
      calls.downloadFile += 1
      calls.downloadFileData.push({ url: o && o.url })
      if (opts.downloadFails) return o && o.fail && o.fail(rawErr(1, 'downloadFile:fail'))
      const status = Number.isFinite(Number(opts.downloadStatusCode)) ? Number(opts.downloadStatusCode) : 200
      const tmp = mockFs.userDataPath + '/tmp/download_' + calls.downloadFile + '.bin'
      if (status === 200) {
        if (opts.downloadBytes !== undefined && opts.downloadBytes !== null) {
          const buf = Buffer.isBuffer(opts.downloadBytes)
            ? Buffer.from(opts.downloadBytes)
            : Buffer.from(String(opts.downloadBytes), 'utf8')
          mockFs.seedTemp(tmp, buf.length, buf)
        } else {
          // 显式允许 downloadSize === 0（「云端文件是空的」这一分支必须可被真实覆盖）
          const declared = Number.isFinite(Number(opts.downloadSize)) ? Number(opts.downloadSize) : 1024
          mockFs.seedTemp(tmp, declared)
        }
      }
      return o && o.success && o.success({ statusCode: status, tempFilePath: status === 200 ? tmp : '' })
    },
    navigateTo(o) {
      calls.navigateTo += 1
      calls.navigateToData.push({ url: o && o.url })
      if (opts.navigateToFails) return o && o.fail && o.fail(rawErr(-1, 'navigateTo:fail mock'))
      return o && o.success && o.success({})
    },
    navigateBack(o) {
      calls.navigateBack += 1
      if (opts.navigateBackFails) return o && o.fail && o.fail(rawErr(-1, 'navigateBack:fail mock'))
      return o && o.success && o.success({})
    },
    switchTab(o) {
      calls.switchTab += 1
      return o && o.success && o.success({})
    },
    cloud: {
      database() { return dbMock },
      init() { return undefined },
      uploadFile() {
        calls.uploadFile += 1
        return Promise.reject(rawErr(-1, 'uploadFile must not be called in local mode'))
      },
      deleteFile() {
        calls.deleteFile += 1
        return Promise.reject(rawErr(-1, 'deleteFile must not be called in local mode'))
      },
      getTempFileURL() {
        calls.getTempFileURL += 1
        if (opts.tempUrlFails) {
          return Promise.resolve({ fileList: [{ fileID: 'cloud://x', status: -1, errMsg: 'file not exist' }] })
        }
        if (opts.tempUrlRejects) {
          return Promise.reject(rawErr(-1, 'getTempFileURL:fail network'))
        }
        return Promise.resolve({ fileList: [{ fileID: 'cloud://x', status: 0, tempFileURL: opts.tempUrl || 'https://example.invalid/cloud.pdf' }] })
      },
      callFunction(o) {
        calls.callFunction += 1
        calls.callFunctionData.push(o && o.data)
        if (callFunctionFailsLeft > 0) {
          callFunctionFailsLeft -= 1
          return Promise.reject(rawErr(-1, 'callFunction:fail mock network'))
        }
        if (typeof opts.callFunctionHandler === 'function') {
          // 真实云函数路由（测试注入）：把 dailyRecord 交给真正跑起来的云函数代码，
          // 而不是回一个 {ok:true} 的空壳 —— 否则「重放不会重复累计」这类断言
          // 只验证了客户端自己的账本，验证不到服务端幂等。
          return Promise.resolve()
            .then(() => opts.callFunctionHandler(o || {}))
            .then(res => (res && res.result !== undefined ? res : { result: res }))
        }
        if (opts.callFunctionResult !== undefined) {
          return Promise.resolve({ result: opts.callFunctionResult })
        }
        return Promise.resolve({ result: { ok: true } })
      }
    }
  }

  return {
    wx: wxMock,
    fs: mockFs,
    storage,
    calls,
    toasts,
    modals,
    consoleErrors,
    // 让测试能直接看到云端 books 夹具的当前内容（删除是否真的只影响目标一条）
    cloudBooksNow() { return cloudBooks.map(b => Object.assign({}, b)) },
    failChoose(on) { chooseFails = on !== false },
    pushFile(file) { queued.push(file) },
    // 让接下来的 n 次 callFunction 失败（n 缺省 = 1），用于验证重放链路
    failNextCallFunctions(n) {
      callFunctionFailsLeft = Number.isFinite(Number(n)) ? Number(n) : 1
    }
  }
}

module.exports = { createMockFs, createMockStorage, createMockEnv, createMockWx }
