# SOURCES.md · 插画来源登记（PRD v0.6 §6.4）

> 硬约束：**无来源记录不得入库、不得上线**（P2-01 来源验收）。
> 每张插画必须登记：文件名、用途、来源类型（本人手绘 / 授权素材）、来源凭证。

## 登记表

| 文件名 | 用途 | 位置（≥200px 油画 / <100px 几何） | 来源类型 | 来源凭证（链接/文件） | 状态 |
|---|---|---|---|---|---|
| home_empty（svg-icons 内 base64） | ~~首页空状态~~（2026-08-28 首页空状态紧凑化移除大插画，改轻量便签；资源保留备后续页面使用） | 油画大图（≥300px） | **开发占位（非正式）** | scripts/gen-svg-icons.js | **PLACEHOLDER** — 已无页面引用，保留资源 + 登记 |
| anniversary（svg-icons 内 base64） | 我们页纪念日 | 油画大图（≥200px） | **开发占位（非正式）** | scripts/gen-svg-icons.js | **PLACEHOLDER** — 正式油画待产出后替换；2026-08-28 M9 改为 4 完整圆形头像 + 爱心 |
| deco_flower（base64） | 装饰散落（首页 Hero / 便签角落） | 几何小图（64x64） | 本人手绘（Soul 原创） | scripts/gen-svg-icons.js（2026-08-28） | 治愈系装饰，手绘蜡笔感 |
| deco_cloud（base64） | 装饰散落（首页 Hero 角落） | 几何小图（64x64） | 本人手绘 | scripts/gen-svg-icons.js（2026-08-28） | 治愈系装饰 |
| deco_star（base64） | 装饰散落（首页状态/AI 小结卡） | 几何小图（64x64） | 本人手绘 | scripts/gen-svg-icons.js（2026-08-28） | 治愈系装饰 |
| deco_sprout（base64） | 装饰散落（首页 Hero 底部） | 几何小图（64x64） | 本人手绘 | scripts/gen-svg-icons.js（2026-08-28） | 治愈系装饰 |
| deco_heart_cute（base64） | 装饰散落（首页 AI 小结、我们页） | 几何小图（64x64） | 本人手绘 | scripts/gen-svg-icons.js（2026-08-28） | 治愈系装饰 |
| deco_cat_hero（base64） | 首页 Hero 主插画 / 旅行北京 | 几何大图（200x160） | 本人手绘 | scripts/gen-svg-icons.js（2026-08-28） | 治愈系 Hero 主插画 — 蓝小猫看书场景 |
| deco_plant（base64） | 阅读页导入装饰 / 旅行外地插画 | 几何小图（64x64） | 本人手绘 | scripts/gen-svg-icons.js（2026-08-28） | 治愈系植物盆栽 |
| deco_tape（base64） | 便签纸胶带（首页 Hero 角落预留） | 几何小图（64x64） | 本人手绘 | scripts/gen-svg-icons.js（2026-08-28） | 治愈系便签胶带 |
| （待补充） | 我们页纪念日 | 油画大图 | | | 待产出 |
| （待补充） | 心愿安排反馈 | 油画大图 | | | 待产出 |
| （待补充） | 绑定页双人牵手 | 油画大图 | | | 待产出 |
| （待补充） | 心情脸谱 ×5（mood_happy/calm/low/angry/tired） | 几何小图 | 本人手绘 | scripts/gen-svg-icons.js | 已在库；保留登记 |
| （待补充） | 天气图标 ×4（weather_sunny/cloudy/rain/snow） | 几何小图 | 本人手绘 | scripts/gen-svg-icons.js | 已在库；保留登记 |
| （待补充） | 心愿类型图标 ×2（wish_eat/wish_do） | 几何小图 | 本人手绘 | scripts/gen-svg-icons.js | 已在库；保留登记 |
| heart（base64） | 心情/AI 装饰 | 几何小图（48x48） | 本人手绘 | scripts/gen-svg-icons.js | 已在库；保留登记 |
| pencil（base64） | 记录页"留白"提示 | 几何小图（48x48） | 本人手绘 | scripts/gen-svg-icons.js | 已在库；保留登记 |

## 规则

1. 新增插画必须先登记本表，再入库 `assets/svg-icons.js` base64。
2. 来源类型只能是：`本人手绘` 或 `授权素材`；授权素材必须附来源链接。
3. 单文件 ≤ 50KB；字体 ≤ 100KB（base64 解码后大小约 1-3KB/图标）。
4. AI 生成图（含 AI 平台水印）禁止入库。
