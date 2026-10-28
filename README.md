# X.bot 包装素材检索

X.bot 包装素材检索项目用于在飞书中按项目名、别名、包装类型和标签检索 Eagle 素材。机器人先回复静态 PNG 候选，原查询人确认后，再把对应的 AE 源文件 ZIP 回复到最初的查询消息下。

## 当前状态（2026-10-28，以 STATUS 为准）

- 插件源码与公开稳定版均为 **1.9.18**，包含命名字段选择/排序、配对反馈、大图、设置菜单与列表滚动修复；[正式发布](https://github.com/OooT-x/xbot-packaging-search/releases/tag/eagle-plugin-v1.9.18)来自固定提交 `d6f474f`，安装包、更新清单和远端摘要已核对，257 JS / 34 Python及CI通过。
- 本机此前安装的是1.9.18评审包，不能据此宣称与正式发行包字节一致或当前宿主已经重开加载。安装与加载证据分别见STATUS的PAIR-03、RELEASE-02。
- [飞书看图指南](https://zqyd2vqyqmy.feishu.cn/docx/BmQ3dJPzyoanBHxrfqLcBWhBnPd)已更新1.9.18，13节、11图；图片使用示例数据，版本来源见[手册维护入口](docs/plugin-guide/README.md)。
- 中央服务、团队类型共同编辑与Card 2.0已实现；2026-10-28维护重启后唯一监听器、两个消费者ready与49包装零同步错误已核验，过期状态清理已加载，历史交付已对账（STATUS OPS-01）。双终端Eagle/NAS、实际安装与飞书点击领取/交付仍待现场验收。
- 当前任务与证据见[STATUS](docs/STATUS.md)，历史记录仅代表对应日期，不能推断当前运行状态。

## 项目管理入口

- [上下文速览](docs/CONTEXT.md)：先读这份轻量速览掌握全局（状态、里程碑、模块、决策指针、边界、命令），避免每次重读长文档。
- [当前状态](docs/STATUS.md)：现在做到哪、下一步是什么、有哪些风险。
- [路线图](docs/ROADMAP.md)：S1 稳定性收尾优先，再进入 M2；逐项任务只在 STATUS 维护。
- [运行与恢复](docs/RUNBOOK.md)：常驻健康标准、交付对账、事件重试和真实现场验收。
- [决策记录](docs/DECISIONS.md)：长期有效的架构和产品决策，以及后续取代关系。
- [开发流程](docs/WORKFLOW.md)：分支、提交、版本、反复修改和交付规则。
- [变更日志](CHANGELOG.md)：每次可交付变化。
- [持续集成](.github/workflows/ci.yml)：在 push、pull request 和手动触发时使用 Windows、Node.js 24 与 Python 3.14 自动运行测试和静态检查。
- [协作规则](AGENTS.md)：任何参与者继续本项目时必须遵循的上下文恢复和安全边界。
- [X.bot 包装素材 skill](skills/xbot-packaging-assets/SKILL.md)：复用现有运行时维护、运行、诊断和验证包装查询、候选确认、源文件交付与入库事件联动。

## 核心原则

- 项目名优先，图片识别只作为辅助召回方式。
- 预览后必须由原查询人确认，不能直接发送源文件。
- 仅图片背景是受控例外：可登记 PNG 供查询，但明确没有工程 ZIP，不进入源文件确认或发送流程；其他包装类型仍必须具备 ZIP。
- Eagle 负责素材保存；单机兼容模式由本地 SQLite 维护稳定映射，多终端共享 NAS 模式由中央索引服务统一维护映射，终端不直接打开共享 SQLite 文件。
- 多终端场景下，Eagle 集成插件通过官方 Plugin API 直接把本地 AE 收集结果写入共享 Eagle Library，再向中央索引服务提交幂等入库事件；本地 outbox 仅用于事件重试。
- Eagle 标签按用途分组；项目名标签统一放入“项目”分组，便于浏览和筛选。
- AEP 收集链现在由 Eagle 插件内置的本机 `XbotAepWorker.exe` 承载：插件直接选择 AEP、读取真实合成结构、勾选交付对象并生成 PNG、ZIP 和 manifest，随后自动进入现有配对预检和正式入库；原始工程只读，所有副本只写入新目录。独立 `XbotAepCollector.exe` 仍保留作兼容和离线验收入口，直属预合成仍可逐个独立导出。
- 代表帧默认取预览来源第 2 秒；短于 2 秒时取最后一个有效帧。视频框优先从唯一合适的上层包装展示合成取景，并改为取该父级内视频框图层出现后的第 2 秒；收集目标仍保持视频框本身，用户可切换预览来源并调帧。
- 视频框收集若发现视频依赖，会先提取视频第 0 帧 PNG 替换精简工程中的视频引用，ZIP 只包含该 PNG，不复制原视频；manifest 记录 `video_frame_replacements`。ffmpeg 不可用或首帧提取失败时阻止收集，避免交付包继续依赖视频文件。
- 可选常驻 AE 快速桥接使用 `saveFrameToPng` 加速交互预览；不可用时回退 `aerender`。后台渲染优先调用 `Xbot PNG with Alpha` 输出模块直接写 PNG，模板不可用时自动回退 TIFF+Alpha 中转，最终入库 PNG 始终执行一次高质量后台渲染。
- manifest 明确区分 `xbot-collection` 收集记录和 `xbot-eagle-ingest` 正式入库清单；只有正式清单会限制插件仅导入明确引用的文件，收集记录用于读取合成、ZIP 和依赖状态并安全配对根目录 PNG。
- 本地项目包装文件夹在插件中完成扫描、配对和项目名称确认后直接写入 Eagle 正式目录；插件递归扫描但不原样导入全部子目录和依赖素材。历史 `00_待入库` 批次仍可走兼容入口处理。
- 源文件以包含 AE 工程及依赖素材的 ZIP 形式发送，不发送裸 `.aep`。
- 通过 Eagle API 读写数据，不直接修改资源库内部的 `metadata.json`。
- 测试遵循精简、精准原则：围绕新增行为、关键边界和回归风险保留最小有效用例，不为数量重复测试。

## 仓库边界

Git 管理以下内容：

- 项目文档与决策记录
- X.bot 检索服务源码
- AE 包装提取辅助工具源码
- Eagle 入库助手插件源码
- 数据库迁移、配置模板和测试

Git 不管理以下内容：

- Eagle `.library` 资源库本体
- PNG 预览、AE 工程和源文件 ZIP
- SQLite 运行数据、日志、缓存和构建产物
- 飞书密钥、Eagle API Token 或其他本机凭据

## 计划目录

```text
.
├─ docs/              核心文档与设计记录
├─ bot/               X.bot 监听器、Eagle 同步与包装检索服务
├─ ae-tool/           已取代的 AE ScriptUI 方案与仍可复用的预览/manifest 代码
├─ aep-collector/     AEP Worker 与兼容的外部合成浏览工具（第五阶段）
├─ eagle-plugin/      Eagle 收集与入库助手插件（第五阶段）
├─ skills/            可复用的 X.bot 包装功能 Codex skill
├─ migrations/        SQLite 数据库迁移
├─ tests/             自动化测试
├─ .gitignore
└─ README.md
```

## 本机运行资源

当前 Eagle 库位于 `Z:\MOSS\后期知识库\包装库\包装.library`；本机 bot 配置使用对应 UNC 路径 `\\192.168.31.100\共享盘\MOSS\后期知识库\包装库\包装.library`，避免自动启动依赖映射盘。bot 只读解析库目录，不依赖 Eagle 当前活动库；插件通过 Eagle API 读写当前打开的库，已切换至 NAS 包装库。

监听器与 `sync:eagle` 共用本机配置 `config/eagle-library.local.json`（不提交 Git），格式参考 `config/eagle-library.example.json`。`LARK_BOT_EAGLE_LIBRARY_PATH` 优先于该文件；未配置时监听器仍使用原本机库，手动同步仍使用 Eagle 当前库 API。SQLite、入库事件和运行目录留在本机。旧库 `E:\Eagle资源库\包装.library` 保留为迁移回退副本；详细验证与回退见 [运行手册](docs/RUNBOOK.md)。

## 当前可运行闭环

当前代码复用既有 X.bot 的 Node 事件监听、群聊 `@mention` 门控和大模型能力，并增加包装素材专用流程：

1. 按本机配置只读同步指定 Eagle 库；未配置库路径时兼容 Eagle 当前库 API。
2. 只读定位 Eagle item 对应的 PNG/ZIP 原文件，将稳定映射写入本地 SQLite。
3. 收到 `@X.bot 找变速箱项目的信息条` 后，通过Card 2.0展示最多3个PNG候选，可筛选项目/类型并原地翻页。
4. 原查询人点击“领取源文件”或回复候选消息确认；有效期、文件快照和幂等校验保持，其他人不能代领。
5. 对应 ZIP 回复到最初查询消息；数据库和飞书 idempotency key 双重防止重复发送。
6. 超过飞书机器人单文件上限（约 30MB）的源文件自动上传到 bot 飞书云盘，回复下载链接；小文件仍直接发送。

插件正式入库后会把批次事件追加到运行根目录的
`packaging-ingest-events.jsonl`（可用 `LARK_BOT_INGEST_EVENT_FILE` 指定路径）；bot
监听器消费该队列，唯一写入 SQLite 并强制刷新 Eagle 索引。事件按 `event_id` 幂等，刷新失败会在下一轮重试。

普通对话同时接受 `text` 和带文字的 `post` 富文本。`post` 中的 `@` 与文字会规范化后进入同一套路由；图片节点只保留为占位，不把图片二进制发送给 DeepSeek。纯图片消息会得到“不具备视觉识别”的明确回应：私聊直接处理，群聊仅在回复 X.bot 或事件带有效 `@X.bot` 时处理，避免对群内所有图片自动插话。

先同步并验证当前素材：

```powershell
# 使用 config/eagle-library.local.json 中的库路径；临时覆盖可设置 LARK_BOT_EAGLE_LIBRARY_PATH。
& "C:\Program Files\nodejs\npm.cmd" run sync:eagle
& "C:\Program Files\nodejs\npm.cmd" test
```

启动机器人：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\start-feishu-bot.ps1 -Voice -AiProvider deepseek
```

安装登录后自动启动：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-feishu-bot-autostart.ps1
```

运行时 SQLite、日志、PID 和素材文件均不提交 Git。默认继续复用
`C:\Users\ADMIN\Documents\飞书` 中已有的 X.bot 语音资源、回复规则和日志；可用
`LARK_BOT_RUNTIME_ROOT` 改写该位置。

Bot 身份至少需要消息事件、读取消息详情、发送消息和上传资源相关权限。确认阶段会读取用户回复消息的 `reply_to`，不能只依赖 compact 事件里的字段。
