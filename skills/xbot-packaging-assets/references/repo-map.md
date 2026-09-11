# 仓库定位与运行命令

## 实现地图

| 位置 | 职责 |
| --- | --- |
| `bot/lark-bot-listener.js` | 飞书事件、`text`/`post` 规范化、@ 门控、transport、AI 兜底与运行初始化 |
| `bot/lib/package-intent.js` | 项目、类型、动作词、目录询问、候选排序与确认语义 |
| `bot/lib/packaging-service.js` | 目录刷新、候选富文本、reply-only 确认、查询状态和 ZIP/云盘交付 |
| `bot/lib/package-database.js` | SQLite 项目、包装、查询、候选、批次、修订与交付状态 |
| `bot/lib/eagle-sync.js` | Eagle 正式素材只读同步与稳定配对 |
| `bot/lib/ingest-sync.js` | 插件 JSONL 入库事件的幂等消费与索引刷新 |
| `config/project-aliases.json` | 项目别名配置 |
| `eagle-plugin/lib/package-types.js` | 包装类型及别名的集中事实来源 |
| `migrations/` | 数据库迁移，禁止手工覆盖生产数据库 |
| `tests/package-intent.test.js` | 意图、类型、项目与排序 |
| `tests/packaging-service.test.js` | 候选、确认、权限、过期与交付 |
| `tests/lark-bot-listener.test.js` | 消息类型、@ 门控、路由与 transport |
| `tests/eagle-sync.test.js` | Eagle 索引和文件配对 |
| `tests/ingest-sync.test.js` | 入库事件幂等与失败重试 |

## 权威文档

- `docs/CONTEXT.md`：当前轻量状态和决策指针。
- `README.md`：运行入口、环境边界和当前闭环。
- `docs/STATUS.md`：已完成、未完成、风险和现场验收。
- `docs/DECISIONS.md`：长期有效产品/架构规则；重点检查 D-001、D-002、D-004、D-005、D-017、D-032、D-033、D-034、D-047、D-050、D-052。
- `docs/飞书机器人包装素材检索项目文档.md`：完整需求、消息流程、数据模型和验收。
- `docs/WORKFLOW.md`：分支、提交、版本和交付清单。

## Windows / PowerShell 验证

在项目根目录运行：

```powershell
$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
git status --short --branch
git log -5 --oneline

node --test tests/package-intent.test.js
node --test tests/packaging-service.test.js
node --test tests/lark-bot-listener.test.js
node --test tests/eagle-sync.test.js tests/package-database.test.js tests/ingest-sync.test.js

& "C:\Program Files\nodejs\npm.cmd" run check
& "C:\Program Files\nodejs\npm.cmd" test
git diff --check
```

只有在用户要求同步真实目录或验证当前素材时才运行以下命令；它会刷新本地运行索引：

```powershell
$env:LARK_BOT_EAGLE_LIBRARY_PATH = "E:\Eagle资源库\包装.library"
& "C:\Program Files\nodejs\npm.cmd" run sync:eagle
```

只有在用户要求启动或恢复服务时才运行现有脚本：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\start-feishu-bot.ps1 -Voice -AiProvider deepseek
```

规范运行根目录默认复用 `C:\Users\ADMIN\Documents\飞书`，可用 `LARK_BOT_RUNTIME_ROOT` 覆盖。检查现场状态时同时验证：

1. 只有一个命令行包含 `lark-bot-listener.js` 的 Node 进程。
2. `lark-cli.cmd event status --json` 显示事件消费者运行。
3. 规范运行根目录的 `logs\bot.log` 出现 AI 配置、包装目录同步和 `ready event_key=im.message.receive_v1`。
4. 包装目录行显示的项目/包装数量与本次真实同步一致，不复用旧快照。

## 常用环境变量

| 变量 | 用途 |
| --- | --- |
| `LARK_BOT_RUNTIME_ROOT` | 既有 X.bot 运行资源根目录 |
| `LARK_BOT_PACKAGING_SEARCH` | 设为 `off` 时禁用包装检索 |
| `LARK_BOT_PACKAGING_DB` | SQLite 运行库路径 |
| `LARK_BOT_PACKAGE_ALIASES` | 项目别名配置路径 |
| `LARK_BOT_EAGLE_LIBRARY_PATH` | 要只读同步的 Eagle 包装库 |
| `LARK_BOT_INGEST_EVENT_FILE` | 插件入库事件 JSONL 路径 |
| `LARK_BOT_PACKAGE_QUERY_TTL_MINUTES` | 候选有效期，默认 20 分钟 |
| `LARK_BOT_PACKAGE_SYNC_INTERVAL_MS` | 包装目录刷新间隔 |
| `LARK_BOT_PACKAGING_AI_JUDGE` | 设为 `off` 时禁用包装意图 AI 兜底 |

读取配置和日志时不要把凭据、Token 或完整敏感消息复制到交付内容。

## 当前需显式核对的差异

截至 2026-09-10，D-017 与核心文档要求超限文件的云盘链接回复到最初查询消息；当前 `packaging-service.js` 的大文件分支实际把链接回复到用户的确认消息，而小文件 ZIP 使用 `root_message_id`。诊断、说明或修改该链路时必须同时核对代码、测试与真实飞书行为，并把差异报告给用户；不要在无明确修复要求时静默改动生产行为。
