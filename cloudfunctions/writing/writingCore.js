const TYPES = new Set(['free', 'life', 'observation', 'story', 'future_self', 'prompt', 'book_thought'])
const STATUSES = new Set(['draft', 'finished'])
const MAX_TITLE = 100
const MAX_CONTENT = 50000

function countWords(content) { return Array.from(content.trim()).length }
function fail(code) { const e = new Error(code); e.code = code; throw e }
function stringField(v, name) { if (typeof v !== 'string') fail(`INVALID_${name.toUpperCase()}`); return v }
function validateInput(input = {}, { partial = false } = {}) {
  const out = {}
  if (!partial || input.title !== undefined) { out.title = stringField(input.title === undefined ? '' : input.title, 'title'); if (Array.from(out.title).length > MAX_TITLE) fail('TITLE_TOO_LONG') }
  if (!partial || input.content !== undefined) { out.content = stringField(input.content === undefined ? '' : input.content, 'content'); if (Array.from(out.content).length > MAX_CONTENT) fail('CONTENT_TOO_LONG') }
  if (!partial || input.type !== undefined) { out.type = input.type === undefined ? 'free' : stringField(input.type, 'type'); if (!TYPES.has(out.type)) fail('INVALID_TYPE') }
  if (!partial || input.status !== undefined) { out.status = input.status === undefined ? 'draft' : stringField(input.status, 'status'); if (!STATUSES.has(out.status)) fail('INVALID_STATUS') }
  if (input.bookId !== undefined && input.bookId !== null) { if (typeof input.bookId !== 'string' || input.bookId.length > 128) fail('INVALID_BOOK_ID'); out.bookId = input.bookId }
  else if (input.bookId === null) out.bookId = null
  return out
}
function publicRecord(r) { return { ...r } }
async function create({ repo, ownerOpenid, input, now = Date.now() }) {
  const data = validateInput(input)
  if (data.status === 'finished' && !data.content.trim()) fail('FINISHED_CONTENT_REQUIRED')
  data.bookId = null
  return publicRecord(await repo.create({ ...data, ownerOpenid, wordCount: countWords(data.content), createdAt: now, updatedAt: now }))
}
async function list({ repo, ownerOpenid, status }) { if (status !== undefined && !STATUSES.has(status)) fail('INVALID_STATUS'); return (await repo.listByOwner(ownerOpenid, status)).map(publicRecord) }
async function get({ repo, ownerOpenid, writingId }) { const r = await repo.findByIdAndOwner(writingId, ownerOpenid); if (!r) fail('WRITING_NOT_FOUND'); return publicRecord(r) }
async function update({ repo, ownerOpenid, writingId, input, now = Date.now() }) {
  const existing = await repo.findByIdAndOwner(writingId, ownerOpenid); if (!existing) fail('WRITING_NOT_FOUND')
  const data = validateInput(input, { partial: true }); if (data.status === 'finished' && !String(data.content === undefined ? existing.content : data.content).trim()) fail('FINISHED_CONTENT_REQUIRED')
  if (data.bookId !== undefined) data.bookId = null
  if (data.content !== undefined) data.wordCount = countWords(data.content)
  const patch = { ...data, updatedAt: now }; if (data.content === undefined) patch.wordCount = existing.wordCount
  await repo.updateByIdAndOwner(writingId, ownerOpenid, patch); return get({ repo, ownerOpenid, writingId })
}
async function remove({ repo, ownerOpenid, writingId }) { if (!(await repo.deleteByIdAndOwner(writingId, ownerOpenid))) fail('WRITING_NOT_FOUND'); return { deleted: true } }
module.exports = { TYPES, STATUSES, MAX_TITLE, MAX_CONTENT, countWords, create, list, get, update, remove }
