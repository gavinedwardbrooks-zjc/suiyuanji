const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const lb = require('../utils/localBooks')
const { createMockEnv } = require('./mock-fs')

const SOURCE = fs.readFileSync(path.resolve(__dirname, '../utils/localBooks.js'), 'utf8')
const TEST_TMP = 'http://tmp/upload-1.pdf'

function seedIndex(storage, books) {
  storage.write(lb.STORAGE_KEY, JSON.stringify({ version: 1, updatedAt: 0, books }))
}

function parseIndex(storage) {
  const raw = storage.read(lb.STORAGE_KEY)
  return raw ? JSON.parse(raw) : null
}

async function expectFail(fn, predicate, label) {
  let err = null
  try {
    await fn()
  } catch (e) {
    err = e
  }
  assert.ok(err, label + ' 应当抛错但没有')
  if (predicate) {
    assert.ok(
      predicate(err),
      label + ' 错误不匹配 → ' + JSON.stringify({ stage: err.stage, code: err.code, errCode: err.errCode })
    )
  }
  return err
}

function newRepo(options) {
  const ctx = createMockEnv(options)
  return Object.assign({ repo: lb.createLocalBooks(ctx.env) }, ctx)
}

// ---------------- 静态边界 ----------------

test('MODULE_HAS_NO_CLOUD_APIS', () => {
  assert.doesNotMatch(SOURCE, /wx\.cloud/)
  assert.doesNotMatch(SOURCE, /cloud\.(uploadFile|getTempFileURL|downloadFile|deleteFile)\b/)
  assert.doesNotMatch(SOURCE, /\bfileID\b/)
})

test('MODULE_HAS_NO_HARDCODED_LOCAL_PROTOCOL', () => {
  assert.doesNotMatch(SOURCE, /wxfile:\/\//)
  assert.doesNotMatch(SOURCE, /https?:\/\//)
  assert.match(SOURCE, /USER_DATA_PATH/)
})

test('INDEX_KEY_IS_VERSIONED', () => {
  assert.match(lb.STORAGE_KEY, /_v\d+$/)
  assert.strictEqual(lb.INDEX_VERSION, 1)
  assert.strictEqual(lb.SUB_DIR, 'books')
})

test('LIMITS_MATCH_OFFICIAL_DOCS', () => {
  assert.strictEqual(lb.MAX_FILE_BYTES, 100 * 1024 * 1024)
  assert.strictEqual(lb.MAX_TOTAL_BYTES, 200 * 1024 * 1024)
  assert.ok(lb.SAFE_TOTAL_BYTES < lb.MAX_TOTAL_BYTES)
  assert.deepStrictEqual(lb.SUPPORTED_EXT, ['pdf', 'txt'])
})

// ---------------- 纯函数 ----------------

test('NORMALIZE_EXT_HANDLES_NAME_AND_EXT', () => {
  assert.strictEqual(lb.normalizeExt('PDF'), 'pdf')
  assert.strictEqual(lb.normalizeExt('人类的书.Pdf'), 'pdf')
  assert.strictEqual(lb.normalizeExt('  txt  '), 'txt')
  assert.strictEqual(lb.normalizeExt(''), '')
  assert.strictEqual(lb.normalizeExt('archive.tar.gz'), 'gz')
})

test('SANITIZE_NAME_STRIPS_EXT_AND_PATH_SEPARATORS', () => {
  assert.strictEqual(lb.sanitizeName('人类简史.pdf'), '人类简史')
  assert.strictEqual(lb.sanitizeName('a/b:c*.txt'), 'abc')
  assert.strictEqual(lb.sanitizeName('   '), '未命名')
})

test('MAKE_LOCAL_ID_AND_FILE_NAME', () => {
  const id = lb.makeLocalId(1700000000000, 0.5)
  assert.match(id, /^lb_[0-9a-z]+_[0-9a-z]+$/)
  assert.strictEqual(lb.makeFileName(id, 'PDF'), id + '.pdf')
  assert.strictEqual(lb.makeFileName('lb_x', ''), 'lb_x')
})

test('CLAMP_PERCENT_BOUNDS', () => {
  assert.strictEqual(lb.clampPercent(150), 100)
  assert.strictEqual(lb.clampPercent(-5), 0)
  assert.strictEqual(lb.clampPercent('abc'), 0)
  assert.strictEqual(lb.clampPercent(42.6), 43)
})

test('FORMAT_BYTES', () => {
  assert.strictEqual(lb.formatBytes(0), '0 B')
  assert.strictEqual(lb.formatBytes(512), '512 B')
  assert.strictEqual(lb.formatBytes(2048), '2.0 KB')
  assert.strictEqual(lb.formatBytes(5 * 1024 * 1024), '5.0 MB')
})

test('SORT_NEWEST_FIRST_WITH_STABLE_TIEBREAK', () => {
  const out = lb.sortBooks([
    { localId: 'b', createdAt: 10 },
    { localId: 'a', createdAt: 20 },
    { localId: 'c', createdAt: 20 }
  ])
  assert.deepStrictEqual(out.map(b => b.localId), ['a', 'c', 'b'])
})

test('COLLECT_ORPHANS_AND_APPLY_MISSING', () => {
  assert.deepStrictEqual(lb.collectOrphans(['a.pdf', 'b.pdf'], [{ fileName: 'a.pdf' }]), ['b.pdf'])
  const out = lb.applyMissing(
    [{ localId: '1', fileName: 'a.pdf' }, { localId: '2', fileName: null }],
    ['a.pdf']
  )
  assert.strictEqual(out[0].missing, true)
  assert.strictEqual(out[1].missing, false)
})

test('NORMALIZE_INDEX_TOLERATES_STRING_OBJECT_ARRAY_AND_GARBAGE', () => {
  assert.deepStrictEqual(lb.normalizeIndex('').books, [])
  assert.deepStrictEqual(lb.normalizeIndex('{bad json').books, [])
  assert.strictEqual(lb.normalizeIndex({ books: [{ localId: 'x' }] }).books.length, 1)
  assert.strictEqual(lb.normalizeIndex([{ localId: 'y' }]).books.length, 1)
  assert.deepStrictEqual(lb.normalizeIndex(null).books, [])
})

// ---------------- 校验 ----------------

test('VALIDATE_REJECTS_UNSUPPORTED_TYPE', () => {
  const r = lb.validateImport({ name: 'a.docx', ext: 'docx', size: 100 }, [])
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.code, 'UNSUPPORTED_TYPE')
  assert.strictEqual(r.stage, lb.STAGE.VALIDATE)
})

test('VALIDATE_REJECTS_EMPTY_FILE', () => {
  assert.strictEqual(lb.validateImport({ name: 'a.pdf', size: 0 }, []).code, 'EMPTY_FILE')
  assert.strictEqual(lb.validateImport({ name: 'a.pdf', size: undefined }, []).code, 'EMPTY_FILE')
})

test('VALIDATE_REJECTS_FILE_TOO_LARGE', () => {
  const r = lb.validateImport({ name: 'a.pdf', size: lb.MAX_FILE_BYTES + 1 }, [])
  assert.strictEqual(r.code, 'FILE_TOO_LARGE')
  assert.strictEqual(r.maxBytes, lb.MAX_FILE_BYTES)
})

test('VALIDATE_REJECTS_STORAGE_FULL', () => {
  const books = [{ localId: 'x', name: 'big', ext: 'pdf', fileName: 'x.pdf', size: 199 * 1024 * 1024 }]
  const r = lb.validateImport({ name: 'a.pdf', size: 2 * 1024 * 1024 }, books)
  assert.strictEqual(r.code, 'STORAGE_FULL')
  assert.strictEqual(r.limitBytes, lb.MAX_TOTAL_BYTES)
})

// ---------------- 导入 ----------------

test('IMPORT_SAVES_FILE_UNDER_USER_DATA_PATH', async () => {
  const { repo, fs: mfs } = newRepo()
  mfs.seedTemp(TEST_TMP, 2048)
  const { entry } = await repo.importFile({ tempFilePath: TEST_TMP, name: '人类简史.pdf', size: 2048 })
  assert.match(entry.localId, /^lb_/)
  assert.strictEqual(entry.ext, 'pdf')
  assert.strictEqual(entry.name, '人类简史')
  const expected = mfs.userDataPath + '/books/' + entry.fileName
  assert.ok(entry.fileName.endsWith('.pdf'))
  assert.strictEqual(entry.filePath, expected)
  assert.ok(mfs.hasFile(expected), '文件必须落在 USER_DATA_PATH/books 下')
  assert.strictEqual(mfs.sizeOf(expected), 2048)
})

test('IMPORT_MOVES_TEMP_FILE_AWAY', async () => {
  const { repo, fs: mfs } = newRepo()
  mfs.seedTemp(TEST_TMP, 1024)
  await repo.importFile({ tempFilePath: TEST_TMP, name: 'a.pdf', size: 1024 })
  assert.strictEqual(mfs.hasFile(TEST_TMP), false, 'saveFile 语义：临时文件被移动')
  assert.strictEqual(mfs.fileCount(), 1)
})

test('IMPORT_WRITES_METADATA', async () => {
  const { repo, fs: mfs, storage } = newRepo()
  mfs.seedTemp(TEST_TMP, 4096)
  const { entry } = await repo.importFile({ tempFilePath: TEST_TMP, name: 'b.txt', size: 4096 })
  const idx = parseIndex(storage)
  assert.ok(idx, '索引必须已落盘')
  assert.strictEqual(idx.version, 1)
  assert.strictEqual(idx.books.length, 1)
  assert.strictEqual(idx.books[0].localId, entry.localId)
})

test('IMPORT_ENTRY_SCHEMA_COMPLETE', async () => {
  const { repo, fs: mfs } = newRepo()
  mfs.seedTemp(TEST_TMP, 100)
  const { entry } = await repo.importFile({ tempFilePath: TEST_TMP, name: 'c.pdf', size: 100 })
  for (const key of ['localId', 'name', 'ext', 'source', 'fileName', 'filePath', 'size', 'author', 'status',
    'progressPercent', 'minutes', 'note', 'coverColor', 'migratedFrom', 'missing', 'createdAt', 'updatedAt']) {
    assert.ok(Object.prototype.hasOwnProperty.call(entry, key), '缺少字段 ' + key)
  }
  assert.strictEqual(entry.source, 'local')
  assert.strictEqual(lb.STATUS_SET.includes(entry.status), true)
})

test('IMPORT_ENTRY_HAS_NO_IDENTITY_FIELDS', async () => {
  const { repo, fs: mfs } = newRepo()
  mfs.seedTemp(TEST_TMP, 100)
  const { entry } = await repo.importFile({ tempFilePath: TEST_TMP, name: 'd.pdf', size: 100 })
  for (const f of lb.FORBIDDEN_FIELDS) {
    assert.strictEqual(Object.prototype.hasOwnProperty.call(entry, f), false, '不应出现身份字段 ' + f)
  }
})

test('IMPORT_REJECTS_DUPLICATE_BY_DEFAULT', async () => {
  const { repo, fs: mfs } = newRepo()
  mfs.seedTemp(TEST_TMP, 1500)
  const first = await repo.importFile({ tempFilePath: TEST_TMP, name: 'e.pdf', size: 1500 })
  mfs.seedTemp('http://tmp/upload-2.pdf', 1500)
  const err = await expectFail(
    () => repo.importFile({ tempFilePath: 'http://tmp/upload-2.pdf', name: 'e.pdf', size: 1500 }),
    e => e.code === 'DUPLICATE',
    'IMPORT_REJECTS_DUPLICATE_BY_DEFAULT'
  )
  assert.strictEqual(err.duplicateLocalId, first.entry.localId)
  const inBooksDir = mfs.listFiles().filter(p => p.indexOf('/books/') !== -1)
  assert.strictEqual(inBooksDir.length, 1, '被拒的重复导入不得在 books 目录留下第二个文件')
  assert.strictEqual(mfs.hasFile('http://tmp/upload-2.pdf'), true, '未落盘前被拒，临时文件保持原样')
})

test('DUPLICATE_REPLACE_KEEPS_LOCAL_ID_AND_PROGRESS', async () => {
  const { repo, fs: mfs } = newRepo()
  mfs.seedTemp(TEST_TMP, 1500)
  const first = await repo.importFile({ tempFilePath: TEST_TMP, name: 'e.pdf', size: 1500 })
  await repo.addMinutes(first.entry.localId, 30)
  mfs.seedTemp('http://tmp/upload-3.pdf', 1500)
  const again = await repo.importFile({ tempFilePath: 'http://tmp/upload-3.pdf', name: 'e.pdf', size: 1500 }, { onDuplicate: 'replace' })
  assert.strictEqual(again.entry.localId, first.entry.localId)
  assert.strictEqual(again.entry.minutes, 30, '替换导入必须保留阅读进度')
  assert.strictEqual(again.books.length, 1)
  assert.strictEqual(mfs.fileCount(), 1, '替换后不应残留旧文件')
})

test('IMPORT_ROLLBACK_ON_META_WRITE_FAILURE', async () => {
  const { repo, fs: mfs, storage } = newRepo()
  mfs.seedTemp(TEST_TMP, 2048)
  storage.failWriteFor(lb.STORAGE_KEY)
  const err = await expectFail(
    () => repo.importFile({ tempFilePath: TEST_TMP, name: 'f.pdf', size: 2048 }),
    e => e.stage === lb.STAGE.META && e.code === 'META_WRITE_FAILED_ROLLED_BACK',
    'IMPORT_ROLLBACK_ON_META_WRITE_FAILURE'
  )
  assert.ok(err)
  assert.strictEqual(mfs.fileCount(), 0, '元数据写失败必须回滚已落盘文件')
  assert.strictEqual(parseIndex(storage), null, '不得留下元数据')
})

test('IMPORT_REJECTS_MISSING_TEMP_PATH', async () => {
  const { repo } = newRepo()
  await expectFail(
    () => repo.importFile({ name: 'g.pdf', size: 100 }),
    e => e.code === 'MISSING_TEMP_PATH',
    'IMPORT_REJECTS_MISSING_TEMP_PATH'
  )
})

test('IMPORT_FAILS_WHEN_TEMP_FILE_GONE', async () => {
  const { repo, fs: mfs } = newRepo()
  await expectFail(
    () => repo.importFile({ tempFilePath: 'http://tmp/ghost.pdf', name: 'h.pdf', size: 100 }),
    e => e.stage === lb.STAGE.SAVE_FILE,
    'IMPORT_FAILS_WHEN_TEMP_FILE_GONE'
  )
  assert.strictEqual(mfs.fileCount(), 0)
})

test('IMPORT_VERIFY_EMPTY_ROLLS_BACK', async () => {
  const { repo, fs: mfs, storage } = newRepo()
  mfs.seedTemp(TEST_TMP, 0)
  await expectFail(
    () => repo.importFile({ tempFilePath: TEST_TMP, name: 'i.pdf', size: 123 }),
    e => e.stage === lb.STAGE.VERIFY && e.code === 'SAVED_FILE_EMPTY',
    'IMPORT_VERIFY_EMPTY_ROLLS_BACK'
  )
  assert.strictEqual(mfs.fileCount(), 0, '落盘校验失败不得留孤儿空文件')
  assert.strictEqual(parseIndex(storage), null)
})

test('DIR_ENSURE_FAILURE_HAS_STAGE', async () => {
  const { repo, fs: mfs } = newRepo()
  mfs.seedTemp(TEST_TMP, 100)
  mfs.setFailNext('ensureDir', Object.assign(new Error('permission denied'), { errCode: 1301000 }))
  await expectFail(
    () => repo.importFile({ tempFilePath: TEST_TMP, name: 'j.pdf', size: 100 }),
    e => e.stage === lb.STAGE.DIR,
    'DIR_ENSURE_FAILURE_HAS_STAGE'
  )
})

// ---------------- 列表与文件丢失 ----------------

test('LIST_MARKS_MISSING_FILE_AND_PERSISTS_FLAG', async () => {
  const { repo, fs: mfs, storage } = newRepo()
  mfs.seedTemp(TEST_TMP, 1024)
  const { entry } = await repo.importFile({ tempFilePath: TEST_TMP, name: 'k.pdf', size: 1024 })
  mfs.deleteFileRaw(mfs.userDataPath + '/books/' + entry.fileName)
  const { books } = await repo.list()
  assert.strictEqual(books[0].missing, true)
  assert.strictEqual(parseIndex(storage).books[0].missing, true, 'missing 标记应持久化')
})

test('LIST_NO_MISSING_WHEN_FILE_PRESENT', async () => {
  const { repo, fs: mfs } = newRepo()
  mfs.seedTemp(TEST_TMP, 1024)
  await repo.importFile({ tempFilePath: TEST_TMP, name: 'l.pdf', size: 1024 })
  const { books, warnings } = await repo.list()
  assert.strictEqual(books[0].missing, false)
  assert.deepStrictEqual(warnings, [])
})

test('LIST_SURVIVES_CORRUPT_INDEX', async () => {
  const ctx = createMockEnv({ storage: { [lb.STORAGE_KEY]: '{not json' } })
  const repo = lb.createLocalBooks(ctx.env)
  const { books } = await repo.list()
  assert.deepStrictEqual(books, [])
})

test('LIST_TOLERATES_OBJECT_INDEX', async () => {
  const ctx = createMockEnv({
    storage: { [lb.STORAGE_KEY]: { version: 1, books: [{ localId: 'lb_1', name: 'x', ext: 'pdf', fileName: 'lb_1.pdf', size: 10 }] } }
  })
  ctx.fs.seedFile(ctx.fs.userDataPath + '/books/lb_1.pdf', 10)
  const repo = lb.createLocalBooks(ctx.env)
  const { books } = await repo.list()
  assert.strictEqual(books.length, 1)
  assert.strictEqual(books[0].missing, false)
})

test('MANUAL_ENTRY_ALLOWED_WITHOUT_FILE', async () => {
  const ctx = createMockEnv()
  seedIndex(ctx.storage, [{ localId: 'lb_m1', name: '追忆似水年华', ext: '', fileName: null, size: 0, status: 'want', createdAt: 5 }])
  const repo = lb.createLocalBooks(ctx.env)
  const { books } = await repo.list()
  assert.strictEqual(books.length, 1)
  assert.strictEqual(lb.isFileEntry(books[0]), false)
})

test('MANUAL_ENTRY_NEVER_TOUCHES_FILE_SYSTEM', async () => {
  const ctx = createMockEnv()
  seedIndex(ctx.storage, [{ localId: 'lb_m1', name: 'x', ext: '', fileName: null, size: 0, createdAt: 5 }])
  const repo = lb.createLocalBooks(ctx.env)
  await repo.list()
  assert.strictEqual(ctx.fs.calls.filter(c => c.op === 'access').length, 0)
  assert.strictEqual(repo.resolvePath({ localId: 'lb_m1', fileName: null }), null)
})

// ---------------- 删除 ----------------

test('REMOVE_DELETES_FILE_AND_METADATA', async () => {
  const { repo, fs: mfs, storage } = newRepo()
  mfs.seedTemp(TEST_TMP, 2048)
  const { entry } = await repo.importFile({ tempFilePath: TEST_TMP, name: 'm.pdf', size: 2048 })
  const res = await repo.remove(entry.localId)
  assert.strictEqual(res.removed, true)
  assert.deepStrictEqual(res.books, [])
  assert.strictEqual(mfs.hasFile(mfs.userDataPath + '/books/' + entry.fileName), false)
  assert.deepStrictEqual(parseIndex(storage).books, [])
})

test('REMOVE_IS_IDEMPOTENT_WHEN_FILE_ALREADY_GONE', async () => {
  const { repo, fs: mfs, storage } = newRepo()
  mfs.seedTemp(TEST_TMP, 512)
  const { entry } = await repo.importFile({ tempFilePath: TEST_TMP, name: 'n.pdf', size: 512 })
  mfs.deleteFileRaw(mfs.userDataPath + '/books/' + entry.fileName)
  const res = await repo.remove(entry.localId)
  assert.strictEqual(res.removed, true, '文件已不存在不应阻塞记录清理')
  assert.deepStrictEqual(parseIndex(storage).books, [])
})

test('REMOVE_FILE_ERROR_KEEPS_METADATA', async () => {
  const { repo, fs: mfs, storage } = newRepo()
  mfs.seedTemp(TEST_TMP, 512)
  const { entry } = await repo.importFile({ tempFilePath: TEST_TMP, name: 'o.pdf', size: 512 })
  mfs.setFailNext('unlink', Object.assign(new Error('permission denied'), { errCode: 1300013 }))
  await expectFail(
    () => repo.remove(entry.localId),
    e => e.stage === lb.STAGE.DELETE_FILE,
    'REMOVE_FILE_ERROR_KEEPS_METADATA'
  )
  assert.strictEqual(parseIndex(storage).books.length, 1, '文件删除失败时不得丢元数据')
  assert.strictEqual(mfs.hasFile(mfs.userDataPath + '/books/' + entry.fileName), true)
})

test('REMOVE_META_FAILURE_LEAVES_NO_GHOST_ENTRY', async () => {
  const { repo, fs: mfs, storage } = newRepo()
  mfs.seedTemp(TEST_TMP, 512)
  const { entry } = await repo.importFile({ tempFilePath: TEST_TMP, name: 'p.pdf', size: 512 })
  storage.failWriteFor(lb.STORAGE_KEY)
  await expectFail(
    () => repo.remove(entry.localId),
    e => e.stage === lb.STAGE.DELETE_META,
    'REMOVE_META_FAILURE_LEAVES_NO_GHOST_ENTRY'
  )
  assert.strictEqual(mfs.hasFile(mfs.userDataPath + '/books/' + entry.fileName), false)
  storage.allowWriteFor(lb.STORAGE_KEY)
  const { books } = await repo.list()
  assert.strictEqual(books.length, 1)
  assert.strictEqual(books[0].missing, true, '残留条目必须可见为 missing，不得成为幽灵数据')
})

test('REMOVE_UNKNOWN_ID_IS_NOOP', async () => {
  const { repo } = newRepo()
  const res = await repo.remove('lb_not_exist')
  assert.strictEqual(res.removed, false)
  assert.strictEqual(res.reason, 'NOT_FOUND')
})

// ---------------- 进度 ----------------

test('ADD_MINUTES_ACCUMULATES_AND_PERSISTS', async () => {
  const { repo, fs: mfs, storage } = newRepo()
  mfs.seedTemp(TEST_TMP, 100)
  const { entry } = await repo.importFile({ tempFilePath: TEST_TMP, name: 'q.pdf', size: 100 })
  await repo.addMinutes(entry.localId, 12)
  const res = await repo.addMinutes(entry.localId, 8)
  assert.strictEqual(res.entry.minutes, 20)
  assert.strictEqual(res.buffered, false)
  assert.strictEqual(parseIndex(storage).books[0].minutes, 20)
})

test('ADD_MINUTES_PERSIST_FAILURE_BUFFERS_PENDING', async () => {
  const { repo, fs: mfs, storage } = newRepo()
  mfs.seedTemp(TEST_TMP, 100)
  const { entry } = await repo.importFile({ tempFilePath: TEST_TMP, name: 'r.pdf', size: 100 })
  storage.failWriteFor(lb.STORAGE_KEY)
  const res = await repo.addMinutes(entry.localId, 15)
  assert.strictEqual(res.buffered, true)
  assert.strictEqual(res.entry.minutes, 0, '主索引未持久化时不得假装成功')
  const pending = JSON.parse(storage.read(lb.PENDING_KEY))
  assert.strictEqual(pending[entry.localId], 15, '增量必须落待补写键，不得静默丢失')
})

test('FLUSH_PENDING_MERGES_AND_CLEARS', async () => {
  const { repo, fs: mfs, storage } = newRepo()
  mfs.seedTemp(TEST_TMP, 100)
  const { entry } = await repo.importFile({ tempFilePath: TEST_TMP, name: 's.pdf', size: 100 })
  storage.failWriteFor(lb.STORAGE_KEY)
  await repo.addMinutes(entry.localId, 15)
  storage.allowWriteFor(lb.STORAGE_KEY)
  const res = await repo.flushPending()
  assert.strictEqual(res.flushed, 1)
  assert.strictEqual(parseIndex(storage).books[0].minutes, 15)
  assert.deepStrictEqual(JSON.parse(storage.read(lb.PENDING_KEY) || '{}'), {})
})

test('ADD_MINUTES_REJECTS_NON_POSITIVE', async () => {
  const { repo, fs: mfs } = newRepo()
  mfs.seedTemp(TEST_TMP, 100)
  const { entry } = await repo.importFile({ tempFilePath: TEST_TMP, name: 't.pdf', size: 100 })
  await expectFail(() => repo.addMinutes(entry.localId, 0), e => e.code === 'BAD_MINUTES', 'zero')
  await expectFail(() => repo.addMinutes(entry.localId, -3), e => e.code === 'BAD_MINUTES', 'negative')
  await expectFail(() => repo.addMinutes('lb_ghost', 5), e => e.code === 'NOT_FOUND', 'unknown id')
})

// ---------------- 更新与容量 ----------------

test('UPDATE_APPLIES_WHITELIST_ONLY', async () => {
  const { repo, fs: mfs, storage } = newRepo()
  mfs.seedTemp(TEST_TMP, 100)
  const { entry } = await repo.importFile({ tempFilePath: TEST_TMP, name: 'u.pdf', size: 100 })
  const res = await repo.update(entry.localId, { status: 'finished', progressPercent: 130, author: '某人', hack: 'x' })
  assert.strictEqual(res.entry.status, 'finished')
  assert.strictEqual(res.entry.progressPercent, 100)
  assert.strictEqual(res.entry.author, '某人')
  assert.strictEqual(Object.prototype.hasOwnProperty.call(res.entry, 'hack'), false)
  assert.strictEqual(Object.prototype.hasOwnProperty.call(parseIndex(storage).books[0], 'hack'), false)
})

test('UPDATE_REJECTS_IDENTITY_FIELDS', async () => {
  const { repo, fs: mfs } = newRepo()
  mfs.seedTemp(TEST_TMP, 100)
  const { entry } = await repo.importFile({ tempFilePath: TEST_TMP, name: 'v.pdf', size: 100 })
  await expectFail(
    () => repo.update(entry.localId, { user_uid: 'x' }),
    e => e.code === 'FORBIDDEN_FIELD',
    'UPDATE_REJECTS_IDENTITY_FIELDS'
  )
  await expectFail(
    () => repo.update(entry.localId, { _openid: 'x' }),
    e => e.code === 'FORBIDDEN_FIELD',
    'UPDATE_REJECTS_OPENID'
  )
})

test('USAGE_SUMS_FILE_SIZES', async () => {
  const ctx = createMockEnv()
  seedIndex(ctx.storage, [
    { localId: 'a', name: 'a', ext: 'pdf', fileName: 'a.pdf', size: 1024 * 1024, createdAt: 1 },
    { localId: 'b', name: 'b', ext: 'txt', fileName: 'b.txt', size: 2 * 1024 * 1024, createdAt: 2 },
    { localId: 'c', name: 'c', ext: '', fileName: null, size: 0, createdAt: 3 }
  ])
  const repo = lb.createLocalBooks(ctx.env)
  const u = repo.usage()
  assert.strictEqual(u.bytes, 3 * 1024 * 1024)
  assert.strictEqual(u.fileCount, 2)
  assert.strictEqual(u.entryCount, 3)
  assert.strictEqual(u.warning, false)
})

test('USAGE_WARNS_ABOVE_SAFE_WATERMARK', async () => {
  const ctx = createMockEnv()
  seedIndex(ctx.storage, [{ localId: 'a', name: 'a', ext: 'pdf', fileName: 'a.pdf', size: 190 * 1024 * 1024, createdAt: 1 }])
  const repo = lb.createLocalBooks(ctx.env)
  const u = repo.usage()
  assert.strictEqual(u.warning, true)
  assert.ok(u.percent > 90)
})

test('SCAN_ORPHANS_FINDS_UNREFERENCED_FILES', async () => {
  const { repo, fs: mfs } = newRepo()
  mfs.seedTemp(TEST_TMP, 100)
  const { entry } = await repo.importFile({ tempFilePath: TEST_TMP, name: 'w.pdf', size: 100 })
  mfs.seedFile(mfs.userDataPath + '/books/lb_orphan.pdf', 10)
  const res = await repo.scanOrphans()
  assert.deepStrictEqual(res.orphans, ['lb_orphan.pdf'])
  assert.strictEqual(entry.fileName === 'lb_orphan.pdf', false)
})

// ============================================================
// S1 风险复核 ① 索引损坏：不得当成首次使用、不得删文件、必须可恢复
// ============================================================

const CORRUPT_RAW = '{not json'

function newCorruptRepo(raw) {
  const ctx = createMockEnv({ storage: { [lb.STORAGE_KEY]: raw === undefined ? CORRUPT_RAW : raw } })
  ctx.fs.seedFile(ctx.fs.userDataPath + '/books/lb_old.pdf', 4096)
  return Object.assign({ repo: lb.createLocalBooks(ctx.env) }, ctx)
}

test('INSPECT_INDEX_DISTINGUISHES_EMPTY_OK_CORRUPT', () => {
  assert.strictEqual(lb.inspectIndex('').status, 'empty')
  assert.strictEqual(lb.inspectIndex(undefined).status, 'empty')
  assert.strictEqual(lb.inspectIndex('{}').status, 'ok')
  assert.strictEqual(lb.inspectIndex(JSON.stringify({ books: [] })).status, 'ok')
  const bad = lb.inspectIndex('{not json')
  assert.strictEqual(bad.status, 'corrupt')
  assert.strictEqual(bad.reason, 'JSON_PARSE_FAILED')
  const notArr = lb.inspectIndex(JSON.stringify({ books: 'nope' }))
  assert.strictEqual(notArr.status, 'corrupt')
  assert.strictEqual(notArr.reason, 'BOOKS_NOT_ARRAY')
  assert.strictEqual(lb.inspectIndex('42').status, 'corrupt')
})

test('CORRUPT_INDEX_NOT_TREATED_AS_FIRST_USE', async () => {
  const { repo, storage, fs: mfs } = newCorruptRepo()
  mfs.seedTemp(TEST_TMP, 1024)
  const err = await expectFail(
    () => repo.importFile({ tempFilePath: TEST_TMP, name: 'z.pdf', size: 1024 }),
    e => e.code === 'INDEX_CORRUPT_LOCKED' && e.stage === lb.STAGE.CORRUPT,
    'CORRUPT_INDEX_NOT_TREATED_AS_FIRST_USE'
  )
  assert.ok(err)
  assert.strictEqual(storage.read(lb.STORAGE_KEY), CORRUPT_RAW, '损坏原文必须原样保留，不得被覆盖成空索引')
  assert.strictEqual(mfs.hasFile(mfs.userDataPath + '/books/lb_old.pdf'), true, '不得因索引损坏删任何本地文件')
  assert.strictEqual(mfs.hasFile(TEST_TMP), true, '损坏索引下不得落盘（临时文件保持原样）')
})

test('CORRUPT_INDEX_BLOCKS_ALL_MUTATIONS', async () => {
  const { repo } = newCorruptRepo()
  await expectFail(() => repo.update('lb_old', { status: 'finished' }), e => e.code === 'INDEX_CORRUPT_LOCKED', 'update')
  await expectFail(() => repo.addMinutes('lb_old', 5), e => e.code === 'INDEX_CORRUPT_LOCKED', 'addMinutes')
  await expectFail(() => repo.remove('lb_old'), e => e.code === 'INDEX_CORRUPT_LOCKED', 'remove')
})

test('CORRUPT_INDEX_REPORTED_AS_EXPLICIT_ERROR_STATE', async () => {
  const { repo, storage } = newCorruptRepo()
  const res = await repo.list()
  assert.strictEqual(res.corrupted, true)
  assert.strictEqual(res.indexStatus, 'corrupt')
  assert.deepStrictEqual(res.books, [])
  assert.strictEqual(res.warnings.length, 1)
  assert.strictEqual(res.warnings[0].code, 'INDEX_CORRUPT')
  assert.strictEqual(res.warnings[0].reason, 'JSON_PARSE_FAILED')
  assert.ok(res.backupKey)
  const backup = JSON.parse(storage.read(lb.CORRUPT_BACKUP_KEY))
  assert.strictEqual(backup.raw, CORRUPT_RAW, '损坏原文必须备份可恢复')
})

test('CORRUPT_BACKUP_IS_WRITE_ONCE_NEVER_OVERWRITTEN', async () => {
  const { repo, storage } = newCorruptRepo()
  await repo.list()
  const first = JSON.parse(storage.read(lb.CORRUPT_BACKUP_KEY)).raw
  storage.write(lb.STORAGE_KEY, '{different corrupt')
  await repo.list()
  assert.strictEqual(JSON.parse(storage.read(lb.CORRUPT_BACKUP_KEY)).raw, first, '备份只写一次，不被后续损坏覆盖')
})

test('CORRUPT_INDEX_NEVER_DELETES_LOCAL_FILES_ON_LIST_OR_SCAN', async () => {
  const { repo, fs: mfs } = newCorruptRepo()
  await repo.list()
  const scan = await repo.scanOrphans()
  assert.strictEqual(mfs.hasFile(mfs.userDataPath + '/books/lb_old.pdf'), true, 'list/scan 一律不得删文件')
  assert.deepStrictEqual(scan.orphans, ['lb_old.pdf'], '无索引时文件按孤儿上报，等人工决定')
})

test('REPAIR_INDEX_REQUIRES_EXPLICIT_CONFIRM', async () => {
  const { repo, storage, fs: mfs } = newCorruptRepo()
  await expectFail(() => repo.repairIndex(), e => e.code === 'REPAIR_REQUIRES_CONFIRM', 'no options')
  await expectFail(() => repo.repairIndex({ confirm: false }), e => e.code === 'REPAIR_REQUIRES_CONFIRM', 'confirm false')
  assert.strictEqual(storage.read(lb.STORAGE_KEY), CORRUPT_RAW, '未确认前不得动主索引')

  const res = await repo.repairIndex({ confirm: true })
  assert.strictEqual(res.repaired, true)
  assert.strictEqual(res.reason, 'JSON_PARSE_FAILED')
  assert.ok(res.backupKey)
  assert.strictEqual(JSON.parse(storage.read(lb.CORRUPT_BACKUP_KEY)).raw, CORRUPT_RAW, '修复前必须先备份原文')
  assert.strictEqual(mfs.hasFile(mfs.userDataPath + '/books/lb_old.pdf'), true, '修复不得删文件')

  const list = await repo.list()
  assert.strictEqual(list.corrupted, false)
  assert.deepStrictEqual(list.books, [])
  const again = await repo.repairIndex({ confirm: true })
  assert.strictEqual(again.repaired, false)
  assert.strictEqual(again.reason, 'ok')
})

test('REPAIR_INDEX_UNBLOCKS_IMPORT', async () => {
  const { repo, fs: mfs } = newCorruptRepo()
  await repo.repairIndex({ confirm: true })
  mfs.seedTemp(TEST_TMP, 512)
  const { entry } = await repo.importFile({ tempFilePath: TEST_TMP, name: 'after.pdf', size: 512 })
  assert.ok(entry.localId)
  const list = await repo.list()
  assert.strictEqual(list.books.length, 1)
})

// ============================================================
// S1 风险复核 ② pending 待补写：flush 必须幂等，可跨重启恢复
// ============================================================

test('FLUSH_PENDING_IS_IDEMPOTENT_WHEN_PENDING_CLEAR_FAILS', async () => {
  const { repo, fs: mfs, storage } = newRepo()
  mfs.seedTemp(TEST_TMP, 100)
  const { entry } = await repo.importFile({ tempFilePath: TEST_TMP, name: 'idem.pdf', size: 100 })

  storage.failWriteFor(lb.STORAGE_KEY)
  await repo.addMinutes(entry.localId, 15)

  // 索引可写，但待补写键清不掉 → 模拟「写成功、清理失败」的中途异常
  storage.allowWriteFor(lb.STORAGE_KEY)
  storage.failWriteFor(lb.PENDING_KEY)
  const first = await repo.flushPending()
  assert.strictEqual(first.flushed, 1)
  assert.strictEqual(first.cleared, false)
  assert.strictEqual(parseIndex(storage).books[0].minutes, 15)
  assert.strictEqual(JSON.parse(storage.read(lb.PENDING_KEY))[entry.localId], 15, '清理失败时 pending 应仍在')

  storage.allowWriteFor(lb.PENDING_KEY)
  const second = await repo.flushPending()
  assert.strictEqual(second.alreadyApplied, true, '第二次必须识别为已应用')
  assert.strictEqual(second.flushed, 0)
  assert.strictEqual(parseIndex(storage).books[0].minutes, 15, '重复 flush 不得重复累计')
  assert.deepStrictEqual(JSON.parse(storage.read(lb.PENDING_KEY) || '{}'), {}, '第二次必须把残留 pending 清干净')

  const third = await repo.flushPending()
  assert.strictEqual(third.flushed, 0)
  assert.strictEqual(parseIndex(storage).books[0].minutes, 15)
})

test('BUFFER_AFTER_UNCONFIRMED_FLUSH_DOES_NOT_DOUBLE_COUNT', async () => {
  const { repo, fs: mfs, storage } = newRepo()
  mfs.seedTemp(TEST_TMP, 100)
  const { entry } = await repo.importFile({ tempFilePath: TEST_TMP, name: 'seq.pdf', size: 100 })

  storage.failWriteFor(lb.STORAGE_KEY)
  await repo.addMinutes(entry.localId, 15)
  storage.allowWriteFor(lb.STORAGE_KEY)
  storage.failWriteFor(lb.PENDING_KEY)
  await repo.flushPending() // 已把 15 写进索引，但 pending 残留
  storage.allowWriteFor(lb.PENDING_KEY)

  storage.failWriteFor(lb.STORAGE_KEY)
  const res = await repo.addMinutes(entry.localId, 5)
  assert.strictEqual(res.buffered, true)
  assert.strictEqual(
    JSON.parse(storage.read(lb.PENDING_KEY))[entry.localId],
    5,
    '已应用快照必须先丢弃，只缓冲新增量'
  )

  storage.allowWriteFor(lb.STORAGE_KEY)
  const flushed = await repo.flushPending()
  assert.strictEqual(flushed.flushed, 1)
  assert.strictEqual(parseIndex(storage).books[0].minutes, 20, '15 + 5 = 20，不得变成 35')
})

test('FLUSH_PENDING_RECOVERS_AFTER_RESTART', async () => {
  const { repo, fs: mfs, storage } = newRepo()
  mfs.seedTemp(TEST_TMP, 100)
  const { entry } = await repo.importFile({ tempFilePath: TEST_TMP, name: 'boot.pdf', size: 100 })
  storage.failWriteFor(lb.STORAGE_KEY)
  await repo.addMinutes(entry.localId, 42)
  storage.allowWriteFor(lb.STORAGE_KEY) // 重启后写入能力恢复

  // 「重启」= 同一存储与同一文件系统上新建仓库实例
  const repo2 = lb.createLocalBooks({ fs: mfs.fs, storage })
  const res = await repo2.flushPending()
  assert.strictEqual(res.flushed, 1)
  assert.strictEqual(parseIndex(storage).books[0].minutes, 42)
  const again = await repo2.flushPending()
  assert.strictEqual(again.flushed, 0)
  assert.strictEqual(parseIndex(storage).books[0].minutes, 42, '重启后重复 flush 仍不得重复累计')
})

test('FLUSH_PENDING_IS_NOOP_ON_CORRUPT_INDEX_AND_KEEPS_PENDING', async () => {
  const ctx = createMockEnv({
    storage: {
      [lb.STORAGE_KEY]: CORRUPT_RAW,
      [lb.PENDING_KEY]: JSON.stringify({ lb_old: 30 })
    }
  })
  const repo = lb.createLocalBooks(ctx.env)
  const res = await repo.flushPending()
  assert.strictEqual(res.corrupted, true)
  assert.strictEqual(res.flushed, 0)
  assert.strictEqual(ctx.storage.read(lb.PENDING_KEY), JSON.stringify({ lb_old: 30 }), '索引不可用时不得消费 pending')
  assert.strictEqual(ctx.storage.read(lb.STORAGE_KEY), CORRUPT_RAW, '也不得覆盖损坏索引')
})

test('DELETE_REPORTS_DROPPED_PENDING_AND_LEAVES_NO_RESIDUE', async () => {
  // S4 起：删除该书时会主动清掉它的待补写增量并显式回报数量，
  // 不再留到 flush 阶段当作「已删除条目」丢弃 —— 两条路径都必须显式，不得静默。
  const { repo, fs: mfs, storage } = newRepo()
  mfs.seedTemp(TEST_TMP, 100)
  const { entry } = await repo.importFile({ tempFilePath: TEST_TMP, name: 'gone.pdf', size: 100 })
  storage.failWriteFor(lb.STORAGE_KEY)
  await repo.addMinutes(entry.localId, 25)
  storage.allowWriteFor(lb.STORAGE_KEY)

  const removed = await repo.remove(entry.localId)
  assert.strictEqual(removed.removed, true)
  assert.strictEqual(removed.droppedPendingMinutes, 25, '删除时必须显式回报被丢弃的待补写分钟')
  assert.strictEqual(removed.pendingCleared, true)
  assert.deepStrictEqual(JSON.parse(storage.read(lb.PENDING_KEY) || '{}'), {}, '不得留下永久残留')

  const res = await repo.flushPending()
  assert.strictEqual(res.flushed, 0)
  assert.strictEqual(res.dropped, 0, '删除已清理，flush 不应再有残留')
})

test('FLUSH_PENDING_DROPS_ENTRIES_FOR_DELETED_BOOK_WITH_REPORT', async () => {
  // 兜底路径：删除后方才出现的 pending（例如外部写入）仍必须在 flush 阶段显式上报
  const { repo, fs: mfs, storage } = newRepo()
  mfs.seedTemp(TEST_TMP, 100)
  const { entry } = await repo.importFile({ tempFilePath: TEST_TMP, name: 'gone2.pdf', size: 100 })
  storage.failWriteFor(lb.STORAGE_KEY)
  await repo.addMinutes(entry.localId, 25)
  storage.allowWriteFor(lb.STORAGE_KEY)
  await repo.remove(entry.localId)
  storage.write(lb.PENDING_KEY, JSON.stringify({ [entry.localId]: 25 }))

  const res = await repo.flushPending()
  assert.strictEqual(res.flushed, 0)
  assert.strictEqual(res.dropped, 1, '指向已删除条目的增量必须显式上报，不得静默')
  assert.deepStrictEqual(JSON.parse(storage.read(lb.PENDING_KEY) || '{}'), {}, '不得留下永久残留')
  const listed = await repo.list()
  assert.strictEqual(listed.books.length, 0, 'flush 不得把已删除的书复活')
})

test('PENDING_WRITE_FAILURE_IS_NOT_SILENT', async () => {
  const { repo, fs: mfs, storage } = newRepo()
  mfs.seedTemp(TEST_TMP, 100)
  const { entry } = await repo.importFile({ tempFilePath: TEST_TMP, name: 'loud.pdf', size: 100 })
  storage.failWriteFor(lb.STORAGE_KEY)
  storage.failWriteFor(lb.PENDING_KEY)
  const res = await repo.addMinutes(entry.localId, 9)
  assert.strictEqual(res.buffered, false, '连待补写都写不进去时必须显式报告')
  assert.strictEqual(res.pendingWriteFailed, true)
  assert.strictEqual(res.pendingReason, 'PENDING_WRITE_FAILED')
})


// ============================================================
// S5：TXT 阅读所需的读侧能力（statFile / readRange）
// 两条不可退让的约束：读取必须有界、失败必须不改数据
// ============================================================

async function importTextBook(repo, mfs, text, name) {
  const tmp = 'http://tmp/' + (name || 'read.txt')
  mfs.seedTemp(tmp, Buffer.byteLength(text, 'utf8'), text)
  const { entry } = await repo.importFile({ tempFilePath: tmp, name: name || 'read.txt', size: Buffer.byteLength(text, 'utf8') })
  return entry
}

test('STAT_FILE_RETURNS_RUNTIME_PATH_AND_SIZE', async () => {
  const { repo, fs: mfs } = newRepo()
  const entry = await importTextBook(repo, mfs, '你好世界')
  const st = await repo.statFile(entry.localId)
  assert.strictEqual(st.exists, true)
  assert.strictEqual(st.size, Buffer.byteLength('你好世界', 'utf8'))
  assert.strictEqual(st.path, mfs.userDataPath + '/books/' + entry.fileName, '路径必须运行时派生')
})

test('STAT_FILE_MISSING_AND_NOT_FOUND', async () => {
  const { repo, fs: mfs } = newRepo()
  const entry = await importTextBook(repo, mfs, '内容')
  mfs.deleteFileRaw(mfs.userDataPath + '/books/' + entry.fileName)
  const st = await repo.statFile(entry.localId)
  assert.strictEqual(st.exists, false)
  assert.strictEqual(st.reason, 'FILE_MISSING')
  const none = await repo.statFile('lb_nope')
  assert.strictEqual(none.reason, 'NOT_FOUND')
})

test('READ_RANGE_READS_EXACT_BYTE_WINDOW', async () => {
  const { repo, fs: mfs } = newRepo()
  const text = 'abc中文def'
  const entry = await importTextBook(repo, mfs, text)
  const bytes = Buffer.from(text, 'utf8')
  const res = await repo.readRange(entry.localId, { offset: 3, length: 6 })
  assert.strictEqual(res.ok, true)
  assert.strictEqual(res.data, bytes.subarray(3, 9).toString('utf8'))
  assert.strictEqual(res.encoding, 'utf8')
  const bin = await repo.readRange(entry.localId, { offset: 0, length: 2, encoding: 'binary' })
  assert.strictEqual(bin.data.length, 2)
  assert.strictEqual(bin.data.charCodeAt(0), bytes[0])
})

test('READ_RANGE_REQUIRES_BOUNDED_LENGTH', async () => {
  const { repo, fs: mfs } = newRepo()
  const entry = await importTextBook(repo, mfs, '内容')
  const noLen = await repo.readRange(entry.localId, { offset: 0 })
  assert.strictEqual(noLen.ok, false)
  assert.strictEqual(noLen.reason, 'BAD_RANGE', '不存在「不传 length 就读全文件」的退化路径')
  const zero = await repo.readRange(entry.localId, { offset: 0, length: 0 })
  assert.strictEqual(zero.reason, 'BAD_RANGE')
  const neg = await repo.readRange(entry.localId, { offset: -1, length: 10 })
  assert.strictEqual(neg.reason, 'BAD_RANGE')
  const huge = await repo.readRange(entry.localId, { offset: 0, length: lb.MAX_READ_BYTES + 1 })
  assert.strictEqual(huge.ok, false)
  assert.strictEqual(huge.reason, 'READ_TOO_LARGE', '单次读取必须有硬上限')
})

test('READ_RANGE_FAILURES_ARE_RESOLVED_AND_CHANGE_NOTHING', async () => {
  const { repo, fs: mfs } = newRepo()
  const text = '不可改动的内容'
  const entry = await importTextBook(repo, mfs, text)
  const filePath = mfs.userDataPath + '/books/' + entry.fileName
  const before = Buffer.from(mfs.bytesOf(filePath))

  mfs.deleteFileRaw(filePath)
  const missing = await repo.readRange(entry.localId, { offset: 0, length: 4 })
  assert.strictEqual(missing.ok, false)
  assert.strictEqual(missing.reason, 'FILE_MISSING')

  mfs.seedFileBytes(filePath, Buffer.from(text, 'utf8'))
  const none = await repo.readRange('lb_nope', { offset: 0, length: 4 })
  assert.strictEqual(none.reason, 'NOT_FOUND')

  const ok = await repo.readRange(entry.localId, { offset: 0, length: before.length })
  assert.strictEqual(ok.ok, true)
  assert.strictEqual(ok.data, text)
  assert.deepStrictEqual(Array.from(mfs.bytesOf(filePath)), Array.from(before), '读取绝不改动字节')
})

test('READ_SIDE_IS_LOCKED_WHEN_INDEX_CORRUPT', async () => {
  const { repo, fs: mfs, storage } = newRepo()
  const entry = await importTextBook(repo, mfs, '内容')
  const broken = '{"version":1,"books":[{'
  storage.write(lb.STORAGE_KEY, broken)
  storage.remove(lb.CORRUPT_BACKUP_KEY)

  const st = await repo.statFile(entry.localId)
  assert.strictEqual(st.reason, 'INDEX_CORRUPT')
  const rd = await repo.readRange(entry.localId, { offset: 0, length: 3 })
  assert.strictEqual(rd.ok, false)
  assert.strictEqual(rd.reason, 'INDEX_CORRUPT')
  assert.strictEqual(storage.read(lb.STORAGE_KEY), broken, '损坏索引一字不得改动')
  assert.strictEqual(mfs.fileCount(), 1, '绝不删除文件')
})

test('READ_RANGE_DOES_NOT_TOUCH_OTHER_BOOKS_OR_PENDING', async () => {
  const { repo, fs: mfs, storage } = newRepo()
  const a = await importTextBook(repo, mfs, 'AAA', 'a.txt')
  const b = await importTextBook(repo, mfs, 'BBB', 'b.txt')
  storage.write(lb.PENDING_KEY, JSON.stringify({ [b.localId]: 7 }))
  const snapshot = JSON.stringify(parseIndex(storage).books)

  await repo.readRange(a.localId, { offset: 0, length: 3 })
  await repo.statFile(a.localId)

  assert.strictEqual(JSON.stringify(parseIndex(storage).books), snapshot, '读操作不得改动任何元数据')
  assert.deepStrictEqual(JSON.parse(storage.read(lb.PENDING_KEY)), { [b.localId]: 7 })
})
