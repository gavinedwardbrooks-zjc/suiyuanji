function call(action, data = {}) {
  return wx.cloud.callFunction({ name: 'writing', data: { action, ...data } }).then(res => {
    const result = res.result || {}
    if (!result.ok) return Promise.reject(Object.assign(new Error(result.code || 'WRITING_REQUEST_FAILED'), { code: result.code }))
    return result
  })
}
module.exports = {
  createWriting(data) { return call('create', data) },
  listWritings(status) { return call('list', status ? { status } : {}) },
  getWriting(writingId) { return call('get', { writingId }) },
  updateWriting(writingId, data) { return call('update', { writingId, ...data }) },
  deleteWriting(writingId) { return call('delete', { writingId }) }
}
