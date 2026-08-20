# X.bot 包装素材检索

X.bot 包装素材检索项目用于在飞书中按项目、包装类型、标签或参考图片检索 Eagle 素材。机器人先回复静态 PNG 候选，原查询人确认后，再把对应的 AE 源文件 ZIP 回复到最初的查询消息下。

## 当前状态

- 核心方案版本：v1.9
- Eagle 资源库：已建立待入库、预览图和 AE 源文件目录，以及第一阶段基础标签组
- 当前开发阶段：第一阶段“文字检索闭环”已通过测试群端到端实测；M5 Eagle 入库助手插件支持插件导入和 Eagle 手动导入两种来源，正式入库可独立递归扫描待入库批次
- 后续规划：插件导入结果写入 SQLite 索引并与 bot 磁盘同步联调，再开发 AE 包装提取辅助工具

完整需求、数据模型、消息流程、实施阶段和验收标准见 [核心项目文档](docs/飞书机器人包装素材检索项目文档.md)。

## 项目管理入口

- [当前状态](docs/STATUS.md)：现在做到哪、下一步是什么、有哪些风险。
- [路线图](docs/ROADMAP.md)：M0 至 M5 的实施顺序和完成状态。
- [决策记录](docs/DECISIONS.md)：长期有效的架构和产品决策，以及后续取代关系。
- [开发流程](docs/WORKFLOW.md)：分支、提交、版本、反复修改和交付规则。
- [变更日志](CHANGELOG.md)：每次可交付变化。
- [协作规则](AGENTS.md)：任何参与者继续本项目时必须遵循的上下文恢复和安全边界。

## 核心原则

- 项目名优先，图片识别只作为辅助召回方式。
- 预览后必须由原查询人确认，不能直接发送源文件。
- Eagle 负责素材保存，SQLite 维护项目、包装、版本、预览和源文件的稳定映射。
- AE 包装提取在原工程副本上进行，输出标准化 PNG、ZIP 和 manifest 后再进入 Eagle 待入库流程。
- 本地项目包装文件夹按一个待入库批次导入 Eagle；插件递归扫描但不原样导入全部子目录和依赖素材。
- 源文件以包含 AE 工程及依赖素材的 ZIP 形式发送，不发送裸 `.aep`。
- 通过 Eagle API 读写数据，不直接修改资源库内部的 `metadata.json`。

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
├─ ae-tool/           AE 包装提取辅助工具（第五阶段）
├─ eagle-plugin/      Eagle 入库助手插件（第五阶段）
├─ migrations/        SQLite 数据库迁移
├─ tests/             自动化测试
├─ .gitignore
└─ README.md
```

## 本机运行资源

当前 Eagle 库位于 `E:\Eagle资源库\包装.library`。bot 默认以只读方式直接解析该库目录（不依赖 Eagle 当前活动库，也不修改库内数据），Eagle 界面可以停留在其他库；可用 `LARK_BOT_EAGLE_LIBRARY_PATH` 改写该路径。路径属于本机运行配置，只记录位置，不把库内容提交进 Git。

## 当前可运行闭环

当前代码复用既有 X.bot 的 Node 事件监听、群聊 `@mention` 门控和大模型能力，并增加包装素材专用流程：

1. 启动时通过 Eagle Web API V2 读取当前库和正式素材元数据。
2. 只读定位 Eagle item 对应的 PNG/ZIP 原文件，将稳定映射写入本地 SQLite。
3. 收到 `@X.bot 找变速箱项目的信息条` 后，最多回复 3 张 PNG 预览。
4. 只有原查询人回复候选消息后才能确认；确认状态保留 20 分钟。
5. 对应 ZIP 回复到最初查询消息；数据库和飞书 idempotency key 双重防止重复发送。
6. 超过飞书机器人单文件上限（约 30MB）的源文件自动上传到 bot 飞书云盘，回复下载链接；小文件仍直接发送。

先同步并验证当前素材：

```powershell
$env:LARK_BOT_EAGLE_LIBRARY_PATH = "E:\Eagle资源库\包装.library"
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
