#!/usr/bin/env node
// ============================================================
// scripts/init-local-config.js · 生成本地私有配置
//
// 作用：把仓库里的模板 config.local.example.js 复制成 config.local.js
//      （后者已被 .gitignore 忽略，不会进入版本管理）。
//
// 用法：
//   node scripts/init-local-config.js          创建（已存在则不动）
//   node scripts/init-local-config.js --force  覆盖重建（会提示已丢失内容）
//   node scripts/init-local-config.js --check  只体检，不写文件
//
// 退出码：
//   0 成功 / 体检完成   1 参数错误   2 写文件失败
//
// 设计约束：
//   · 幂等：默认绝不覆盖已存在的 config.local.js（真实配置只在本机，覆盖即丢）。
//   · 不写任何真实值：只做复制，真实值由用户自己填。
//   · 不联网、不读云环境、不接触生产数据。
// ============================================================
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const EXAMPLE = path.join(ROOT, 'config.local.example.js')
const TARGET = path.join(ROOT, 'config.local.js')

function main() {
  const argv = process.argv.slice(2)
  const force = argv.includes('--force')
  const checkOnly = argv.includes('--check')

  if (!fs.existsSync(EXAMPLE)) {
    console.error('[init-local-config] 缺少模板 config.local.example.js，仓库可能不完整。')
    return 2
  }

  const exists = fs.existsSync(TARGET)

  if (checkOnly) {
    console.log('模板      : ' + (fs.existsSync(EXAMPLE) ? '存在' : '缺失'))
    console.log('本地配置  : ' + (exists ? '存在' : '缺失'))
    if (exists) {
      // 只检查是否还是占位符，不回显任何真实值
      const src = fs.readFileSync(TARGET, 'utf8')
      const placeholder = src.includes("CLOUD_ENV: 'YOUR_CLOUD_ENV_ID'")
      console.log('CLOUD_ENV : ' + (placeholder ? '仍是占位符（未配置）' : '已填写'))
    } else {
      console.log('→ 执行 `node scripts/init-local-config.js` 创建。')
    }
    return 0
  }

  if (exists && !force) {
    console.log('[init-local-config] config.local.js 已存在，未改动。')
    console.log('  如需重建（会丢弃现有内容）：node scripts/init-local-config.js --force')
    return 0
  }

  if (exists && force) {
    console.log('[init-local-config] --force：将覆盖现有 config.local.js。')
  }

  try {
    fs.copyFileSync(EXAMPLE, TARGET)
  } catch (e) {
    console.error('[init-local-config] 写入失败：' + e.message)
    return 2
  }

  console.log('[init-local-config] 已生成 config.local.js（该文件被 .gitignore 忽略，不会入库）')
  console.log('  下一步：打开 config.local.js，把 CLOUD_ENV 换成你自己的云开发环境 ID。')
  console.log('  校验：node scripts/init-local-config.js --check')
  return 0
}

process.exitCode = main()
