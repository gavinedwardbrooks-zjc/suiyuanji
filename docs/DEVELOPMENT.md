# 开发环境与运行指南 · 碎愿集（Suiyuanji）

> 目标：从零把仓库跑起来，并知道出错时该看哪里。
> 所有命令都在本仓库实测过（Windows + PowerShell）。架构见 [ARCHITECTURE.md](./ARCHITECTURE.md)。

---

## 1. 需要什么

| 用途 | 需要 | 实测版本 | 说明 |
|---|---|---|---|
| 跑测试 | Node.js | v22.22.2 | 根目录**没有 `package.json`**，测试零依赖，`node tests/x.test.js` 直接跑 |
| 改小程序 | 微信开发者工具 | 稳定版 | 必须，预览与云函数部署都在里面 |
| 跑桌面端 | Node.js + Rust 工具链 | Rust 1.95.0 | 需要 `cargo`；首次编译会拉 Tauri 依赖，耗时较长 |
| 云能力 | 自己的微信小程序 AppID + 云开发环境 | — | 没有也能读代码、跑绝大多数测试 |

> 仓库**没有**声明 `engines`，也没有在其他 Node 版本上验证过。若遇到语法或 API 报错，
> 先用当前 LTS 试，再考虑是否是版本问题。

Windows 之外的平台：**小程序端与云函数是平台无关的**；桌面端只在 Windows 上验证过
（窗口透明度与置顶走 Win32 API，其他平台是占位实现）。

---

## 2. 克隆

```powershell
git clone https://github.com/gavinedwardbrooks-zjc/suiyuanji.git
cd suiyuanji
```

当前文档对应的冻结基线：`aee3995`（`git log -1` 可核对）。

---

## 3. 小程序端

### 3.1 导入

微信开发者工具 → **导入项目** → 选择仓库根目录 → 填入**你自己的** AppID。

- 工具会把 AppID 写进 `project.private.config.json`（已被 `.gitignore` 忽略，也不会打进包）。
- 仓库里的 `project.config.json` 始终是占位符 `wxYOUR_APPID`，**不要改它**。

### 3.2 生成本地私有配置（必做）

`config.js` 只有占位符。真实云环境 ID 放在**本机私有**的 `config.local.js`：

```powershell
node scripts\init-local-config.js          # 从模板复制一份
node scripts\init-local-config.js --check  # 体检：文件在不在、是否还是占位符
```

然后编辑 `config.local.js`，把 `CLOUD_ENV` 换成年你自己的云开发环境 ID。

> 缺这个文件时小程序**起不来**：`app.js` 会 fail-closed 拒绝 `wx.cloud.init()`，
> 并在控制台打印配置指引。这是有意设计 —— 绝不让微信回落到默认环境
> （那可能连上不属于你的线上环境）。

### 3.3 部署云函数（要真跑业务时才需要）

见 [DEPLOYMENT.md](./DEPLOYMENT.md)。只想读代码或跑测试的话，跳过这一步。

---

## 4. 桌面端

### 4.1 依赖安装与启动

```powershell
cd desktop
npm install

# 指向你自己的云环境（没部署过云函数时，登录会失败，但界面能起来）
$env:DESKTOP_AUTH_BASE_URL = "https://<你的云环境地址>"

npm run tauri dev
```

| 变量 | 作用 |
|---|---|
| `DESKTOP_AUTH_BASE_URL` | 服务基址，**必须是域名根**（Rust 自己拼 `/desktop-auth`、`/desktop-daily`），生产环境必须 `https://` |
| `DESKTOP_AUTH_PRODUCTION` | 默认 `true`（只允许 https）；设成 `0` 才允许 `http://localhost` 本地联调 |

基址解析优先级：环境变量 → exe 同目录 `desktop.config.json` 的 `authBaseUrl` → 空。
**都没有时所有联网命令返回 `AUTH_SERVICE_UNAVAILABLE`（fail-closed），不会静默连到某个内置地址。**

### 4.2 构建

```powershell
cd desktop
npm run build          # tsc + vite build → desktop/dist
npm run tauri build    # 打包（产物在 src-tauri/target/release/bundle）
```

> 仓库**不提供**安装包产物，也不会自动签名。想分发 exe 需自行构建并处理签名。

### 4.3 Rust 测试

```powershell
cd desktop\src-tauri
cargo test --lib       # 当前 3 个用例：endpoint 校验、生产环境拒绝 http、错误码映射
```

编译缓存默认落在 `desktop/src-tauri/target`（数 GB）。想挪到别的盘：
把 `src-tauri/.cargo/config.example.toml` 复制成 `config.toml` 并改 `target-dir`
（`config.toml` 已被 gitignore）。

---

## 5. 测试

```powershell
# 全量：83 个文件，逐个跑，列出失败项
$failed = @()
Get-ChildItem tests\*.test.js | ForEach-Object {
  node $_.FullName *> $null
  if ($LASTEXITCODE -ne 0) { $failed += $_.Name }
}
if ($failed.Count) { "FAIL($($failed.Count)): $($failed -join ', ')" } else { "83/83 PASS" }
```

```powershell
# 单个文件（带完整输出）
node tests\desktop-login-e2e.test.js

# 与共享模块/部署相关的三条必跑守卫
node tests\cloudfunction-shared-modules.test.js
node tests\core-consistency.test.js
node tests\deploy-isolation.test.js
```

测试**没有用任何框架**：每个文件自带断言与汇总，失败时以非零码退出。
它们驱动的是**真实云函数代码**，只把 `wx-server-sdk` 换成内存 Mock（`tests/mock-db.js`）。

### 5.1 测试覆盖什么、不覆盖什么

| 覆盖 | 不覆盖 |
|---|---|
| 云函数的协议与权限逻辑 | 真实 SDK 行为（返回形状、错误码） |
| 幂等 / 乐观锁 / 并发状态机 | 真实数据库索引与事务语义 |
| 页面静态契约（DOM 结构、文案、类名） | 真机渲染与交互 |
| 共享模块副本一致性、部署隔离、包体积 | 微信扫码真实交互、云函数真实部署与路由 |

---

## 6. 构建与包体积

小程序主包有 2MB 硬限制（微信只在**上传**时校验，编译阶段不报错）。
`project.config.json` 的 `packOptions.ignore` 决定了哪些目录不进包 ——
漏掉 `desktop/` 会让整包从 ~400KB 涨到 2.7MB，上传直接报 `80051`。

```powershell
node tests\package-size.test.js   # 按 ignore 规则模拟打包，主包必须 < 2MB 且留 25% 余量
node scripts\check-package-size.js
```

---

## 7. 常见问题与排查

| 现象 | 原因 | 处理 |
|---|---|---|
| 小程序白屏 / 控制台提示未配置云环境 | 缺 `config.local.js` 或 `CLOUD_ENV` 仍是占位符 | `node scripts\init-local-config.js`，填好后重新编译 |
| 上传报 `80051` / 包体积超限 | `packOptions.ignore` 漏了 `desktop/` 等目录 | 跑 `node tests\package-size.test.js` 看它报哪个目录 |
| 云函数日志 `MODULE_NOT_FOUND` | 函数目录内缺副本，或跨目录 `require('../…')` | 按 [ARCHITECTURE.md](./ARCHITECTURE.md) §6.3 同步副本，跑 `cloudfunction-shared-modules.test.js` |
| 测试全绿但线上行为是旧的 | 只改了根级共享模块，忘了同步目录副本 | 同上；这是本项目最经典的坑 |
| 桌面端提示「登录服务尚未配置」 | 没配 `DESKTOP_AUTH_BASE_URL` / `desktop.config.json` | 配基址（域名根，不带 `/desktop-auth`） |
| 桌面端 `AUTH_SERVICE_UNAVAILABLE` | 基址为空、非 https（生产模式）、或 HTTP 路由没建 | 检查基址与云开发控制台的两条 HTTP 路径 |
| 桌面端启动后整窗全黑 | 历史问题，已修（`WS_EX_LAYERED` 与 WebView2 合成冲突） | 若复现，先看终端里有没有 `native opacity: 100% → 普通窗口` 一行；没有说明被改回去了 |
| `npm run tauri dev` 白屏、Vite 报端口占用 | 1420 被占（`strictPort: true` 会直接失败） | 关掉占用进程，或确认没有第二个 dev 实例 |
| 全新克隆时 `config-local.test.js` 红一条 | 见 §8 | 正常现象，不是你的环境问题 |
| `cargo` 编译把 C 盘塞满 | target 目录数 GB | 用 `.cargo/config.example.toml` 重定向 `target-dir` |

---

## 8. 已知的「新克隆会红一条」

`tests/config-local.test.js` 的 **C8** 断言要求
`docs/OPEN_SOURCE_RELEASE_REPORT.md` **存在于本地**。该文件是作者内部的发布审计报告，
被 `.gitignore` 精确排除（`/docs/OPEN_SOURCE_RELEASE_REPORT.md`），**不在仓库里**。

| 环境 | 预期结果 |
|---|---|
| 作者本机 | 83/83 PASS |
| 全新克隆 | **82/83 PASS**，`config-local.test.js` 因 C8 判红，其余断言正常 |

这是测试对私有文件的依赖，不是你的配置问题。修它需要改测试代码（把 C8 改成
「存在则校验、不存在则跳过」），属代码变更，本次文档整理不涉及。

---

## 9. 下一步

- 想改代码 → [ARCHITECTURE.md](./ARCHITECTURE.md) 看边界，[DATA_MODEL.md](./DATA_MODEL.md) 看字段
- 想部署 → [DEPLOYMENT.md](./DEPLOYMENT.md)
- 想碰桌面版 → [DESKTOP_HANDOVER.md](./DESKTOP_HANDOVER.md)（**先读「未完成事项」**）
- 想提 PR → [CONTRIBUTING.md](../CONTRIBUTING.md)
