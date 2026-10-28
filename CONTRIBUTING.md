# 贡献指南 · 碎愿集（Suiyuanji）

> 这是一个自用项目开源出来的代码，不是商业产品。维护者精力有限，
> 但**结构清晰、测试可跑的 PR 一定会被认真看**。

---

## 1. 提 Issue

先说清楚是哪一部分，再给复现路径：

| 建议包含 | 说明 |
|---|---|
| 范围 | 小程序 / 云函数 / 桌面版 / 文档 |
| 复现步骤 | 具体到页面或 `action`，例如「record 页保存 → 云函数日志报 …」 |
| 期望 vs 实际 | 一句话即可 |
| 环境 | 微信开发者工具版本 / Node 版本 / Windows 版本（桌面版） |
| 日志 | **贴之前先脱敏**：删掉 openid、user_uid、coupleId、云环境 ID、token |

**不要贴**：真实 AppID、云环境 ID、任何 token / `pollSecret`、用户日记内容、截图里的真实数据。

如果你不确定某个现象是 bug 还是已知限制，先读：

- [README 已知限制](README.md#已知限制)
- [docs/DESKTOP_HANDOVER.md](docs/DESKTOP_HANDOVER.md) §F（桌面版）
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §8（技术债）

---

## 2. 提 PR

### 2.1 分支与提交

```powershell
git checkout -b fix/record-save-conflict
# 改完、测试通过后
git add -- <具体文件>     # 不要用 git add .
git commit -m "fix(record): 冲突提示文案不再误导为网络问题"
```

提交信息建议「类型(范围): 说明」：
`feat` / `fix` / `docs` / `test` / `refactor` / `chore`。

### 2.2 范围要求

- **一个 PR 只做一件事**。修 bug 就别顺手重构，改文档就别改逻辑。
- 不要提交与主题无关的格式化改动（会产生巨量 diff，没法审）。
- 不要引入新的构建步骤或依赖，除非在 PR 里说明为什么必须。

### 2.3 测试要求（合并门槛）

改动代码的 PR，至少要让这两条保持全绿：

```powershell
$failed = @()
Get-ChildItem tests\*.test.js | ForEach-Object {
  node $_.FullName *> $null
  if ($LASTEXITCODE -ne 0) { $failed += $_.Name }
}
if ($failed.Count) { "FAIL: $($failed -join ', ')" } else { "全部 PASS" }
```

> 全新克隆时 `tests/config-local.test.js` 会红一条（它校验一份被 `.gitignore` 排除的本地报告，
> 见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) §8）。这一条不算你的问题。

动了 `cloudfunctions/` 的 PR，**必须**额外跑这三条：

```powershell
node tests\cloudfunction-shared-modules.test.js
node tests\core-consistency.test.js
node tests\deploy-isolation.test.js
```

动了 `desktop/` 的 PR：

```powershell
cd desktop; npm run build
cd src-tauri; cargo test --lib
```

新增行为请**同时加测试**。本项目的测试是纯 Node 脚本（无框架），
照着 `tests/desktop-login-e2e.test.js` 的写法加一个 `testCase('名字', fn)` 即可。

### 2.4 文档同步要求

| 你改了什么 | 必须同步的文档 |
|---|---|
| 新增/修改云函数或 action | [docs/CLOUD_FUNCTIONS.md](docs/CLOUD_FUNCTIONS.md) |
| 新增/修改集合、字段、索引 | [docs/DATA_MODEL.md](docs/DATA_MODEL.md) + [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) |
| 改桌面端协议或状态机 | [docs/DESKTOP_HANDOVER.md](docs/DESKTOP_HANDOVER.md) |
| 改目录结构、启动方式、依赖 | [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) + `README.md` |
| 改身份/权限判定 | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §5 |

文档写了但代码没做 = 不合入；代码做了但文档没写 = 不合入。

---

## 3. 共享模块修改后的同步检查（最容易出错的一处）

`cloudfunctions/` 根级的 6 个 `.js` 是共享源码，各云函数目录里存着**副本**
（云函数只能读自己目录内的文件）。**只改根级、忘了副本 → 测试全绿，线上跑旧代码。**

```powershell
cd cloudfunctions
Copy-Item loginSessionCore.js desktopAuthPublic\loginSessionCore.js -Force
Copy-Item loginSessionCore.js desktopAuthMiniapp\loginSessionCore.js -Force
Copy-Item loginSessionCore.js desktopDaily\loginSessionCore.js -Force
Copy-Item cloudLoginSessionRepository.js desktopAuthPublic\cloudLoginSessionRepository.js -Force
Copy-Item cloudLoginSessionRepository.js desktopAuthMiniapp\cloudLoginSessionRepository.js -Force
Copy-Item desktopSessionCore.js desktopAuthPublic\desktopSessionCore.js -Force
Copy-Item desktopSessionCore.js desktopDaily\desktopSessionCore.js -Force
Copy-Item cloudDesktopSessionRepository.js desktopAuthPublic\cloudDesktopSessionRepository.js -Force
Copy-Item cloudDesktopSessionRepository.js desktopDaily\cloudDesktopSessionRepository.js -Force

cd ..
node tests\cloudfunction-shared-modules.test.js
```

D1 会逐字节比对 9 份副本；不一致会直接把落单的文件名打出来。

**另外两条禁令**（`tests/deploy-isolation.test.js` 守着）：

- 运行时不得 `require('../其他函数/…')` —— 部署后目录不全，必然 `MODULE_NOT_FOUND`；
- 新增依赖要么放进该函数自己的 `package.json`，要么走根级共享模块 + 副本。

---

## 4. 不得提交的内容

| 禁止 | 原因 |
|---|---|
| `config.local.js` | 含真实云环境 ID（已 gitignore） |
| `project.private.config.json` | 含真实 AppID（已 gitignore） |
| `desktop.config.json` | 含真实服务基址（已 gitignore） |
| `.env` / 任何密钥 | 只能配在云函数环境变量（`.env.example` 是可提交模板） |
| `.local/` 下的任何报告 | 内部调试材料（整目录 gitignore） |
| 真实用户数据 | 日记、openid、user_uid、coupleId、token、`pollSecret` |
| 生产环境截图 | 容易连带泄露真实标识 |

提交前自查：

```powershell
git status --porcelain
git diff --cached --name-only
git diff --cached | Select-String -Pattern "cloud1-|wx[0-9a-f]{16}|sk-[A-Za-z0-9]{16,}|Bearer [A-Za-z0-9]"
```

最后一条应当**没有任何输出**。

---

## 5. 安全问题

**不要开公开 Issue。** 走 [SECURITY.md](SECURITY.md) 的私下渠道。

特别地，下面这些属于安全范畴，不是普通 bug：

- 能绕过 Bearer 校验 / 拿到别人的数据；
- 能伪造 `coupleId` / `role` / `reminded` / 分享开关；
- token 或 `pollSecret` 泄漏到前端、日志、数据库明文；
- 桌面认证接口被刷爆（`create` 无限流是**已知**问题，见 SECURITY.md §5）。

---

## 6. 代码风格

- 小程序端与云函数：**原生 JavaScript**，不引入构建；注释用中文，说明「为什么这么写」；
- 桌面端：TypeScript，`tsc` 必须无错（`npm run build` 会跑）；
- 测试：纯 Node 脚本，自带断言与汇总，失败以非零码退出；
- 不要为了「看起来更现代」而换框架 —— 这个项目的可维护性来自**没依赖**。
