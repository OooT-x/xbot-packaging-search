# 单机运行、恢复与现场验收

适用：单机/团队中央服务运行维护，2026-10-28。后文带日期的部署和回滚段落为历史快照，不作为当前版本操作指令。现状以 STATUS 顶部为准；D-060/D-061 定义交付与入库恢复规则。

## 在线标准

### 1.9.4安全修复升级（D-072，历史升级背景）

- 部署前核对无进行中交付，按既有SQLite backup流程备份并记录当前版本；不要从新代码临时打开生产数据库试运行，否则会直接触发迁移。
- 009迁移增加候选快照、修订及资源绑定列；旧pending/preparing候选的状态和有效期失效，用户需重新查询。completed/uncertain交付记录保留，不能清空sending或绕过对账。
- 服务与插件需一起更新：插件1.9.4必须包含`lib/durable-jsonl.js`；新服务需包含`bot/lib/candidate-snapshot.js`及009迁移。安装/启动后分别核验实际文件、唯一消费者、ready及真实目录结果。
- 刷新失败、撤下、修订或摘要变化均暂停交付；云盘上传后撤下可能留下未分享的上传资源，但不回复下载链接。不要通过补写快照绕过检查。
- 回退时先停止服务，保留迁移后的数据库及交付记录；备份恢复可能丢失升级后的真实发送记录，必须逐项对账后才能决定。不得自动降回旧交付逻辑继续发送。
- 临时副本在正常完成/异常返回后清理；进程强制终止可能留下系统临时目录`xbot-delivery-*`，维护时先确认无进行中上传，再按实际目录核对清理。大ZIP增加读取和临时空间，需现场量测NAS延迟。
- 必须现场补验：两端UNC/映射盘门控和争锁、真实NAS中断恢复、飞书原查询人正确ZIP、真实大文件上传及性能。自动测试不替代这些验收。

在项目根目录执行以下只读检查：

```powershell
lark-cli.cmd event status --json
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*lark-bot-listener.js*' } |
  Select-Object ProcessId, CreationDate
Get-ScheduledTask -TaskName FeishuBot
```

必须同时满足：唯一Node监听器、事件服务 running=true、消息im.message.receive_v1与卡片card.action.trigger各1个消费者（合计active_consumers=2），以及运行根 logs/bot.log 有本次两个事件键ready、目录同步记录。D-075升级前的单消费者标准只适用历史快照。复用已有健康事件总线时，不要求重复出现 websocket connected 行；检查消费者就绪和服务状态。PID 文件或计划任务 Running 单独不能证明在线。

## 运行与保活

- 现有运行根：`C:\Users\ADMIN\Documents\飞书`。回复规则、语音、事件队列和日志继续复用。
- 已注册任务以隐藏窗口运行，登录启动，5 分钟保活，异常退出尝试每分钟重启、最多 5 次；不设执行时间上限，任务 IgnoreNew，启动器和 Node 再做单实例保护。
- Windows 注销/关机不承诺常驻；服务器部署属于后续范围。
- 首次配置或入口变更后运行 `scripts/install-feishu-bot-autostart.ps1`，正常启动用 `Start-ScheduledTask -TaskName FeishuBot`。
- 维护前先核对没有正在处理的交付，并备份 SQLite（用 SQLite backup API，不只复制 WAL 主文件）；必要时停止任务再启动，启动会恢复中断状态。不要同时运行多个 Force 启动器。
- 10:27 后停止只知道退出码 0xC000013A；当时任务事件日志未启用，不能确定关闭窗口、任务终止或其他来源。隐藏启动/保活是防护，不能当作根因已证明。

## 包装库 NAS 路径与回退（2026-10-12）

- 当前库：`Z:\MOSS\后期知识库\包装库\包装.library`。本机 bot 的 `config/eagle-library.local.json` 使用 `\\192.168.31.100\共享盘\MOSS\后期知识库\包装库\包装.library`，该文件不提交 Git。监听器和手动索引同步均读取它；环境变量 `LARK_BOT_EAGLE_LIBRARY_PATH` 可优先覆盖。修改后重启 FeishuBot 并运行 `npm run sync:eagle`，核对日志、项目数、配对错误及实际文件可读性。
- 插件通过 Eagle Plugin API 使用当前库，不另存包装库绝对路径；需经 Eagle 官方切库入口切换到 NAS 包装库，重新打开“包装助手”核对素材管理页。更改路径不需要升级或重装插件。
- SQLite 继续位于本机 `data/packaging.sqlite`；运行根、包装类型配置、事件队列与 outbox 保留原本机位置。此部署只迁移 Eagle 存储，不代表中央索引服务或多终端事件同步已实现。
- 完整迁移保留 item/package ID，先复制到未存在的 `.library` 目标、校验逐文件 SHA-256，再切 Eagle 活动库并重新同步 bot 索引。不得手改库内元数据。迁移时没有 preparing/sending 查询，数据库通过 SQLite backup API 备份至 `data/pre-nas-migration-20261012.sqlite`。
- 回退：暂停 NAS 入库，先核对迁移后的新增/修改素材；旧库是切换前快照，不能直接覆盖 NAS。需要回退时将本机配置的 `libraryPath` 改回 `E:\Eagle资源库\包装.library`，通过 Eagle 切回原库，重启 bot 并同步索引。保留交付状态和事件历史，不清除 sending/uncertain；不要直接恢复旧数据库后重新发送文件。
- NAS 不可用时核对共享连接和权限，不静默回退旧库；本机登录账户需要能访问 UNC 共享。多终端并发和另一终端插件→bot 事件链继续按 D-041 的后续范围验收。

## 不明交付的对账

```powershell
npm run deliveries:review
```

列表只用于定位：按 request_id/package_id/root_message_id 检查最初查询的实际文件/云盘链接，并核对原候选。禁止凭“没有日志”认定没发送。
明确核实后，二选一执行：

```powershell
npm run deliveries:review -- --request-id <查询ID> --package-id <包装ID> --verified-message-id <已发送文件或链接消息ID>
npm run deliveries:review -- --request-id <查询ID> --package-id <包装ID> --verified-not-sent
```

这两个命令只更新该 uncertain 记录，不发送消息。核实未发送后，仍须原查询人回复原候选且未过期；不自动延长有效期。云盘资源已保存时复用原 URL/token。过期查询不恢复发送，必要的新查询仍由用户主动提出。历史失败记录同样保守对账，不能直接批量重试。

## 入库事件恢复

- Eagle 写入成功不表示事件已提交，也不表示 bot 索引完成。
- 队列失败会落在 `%APPDATA%\XbotPackaging\ingest-outbox`（可用 LARK_BOT_INGEST_OUTBOX_DIR 覆盖），保存同 event_id 和目标队列。
- 点击“重试索引同步”或重开插件只补事件，不重复写入 Eagle。若 outbox 也失败，界面明确“尚未保存”，保持窗口打开重试。
- bot 按 event_id 重放；catalog 强制刷新失败继续保留 failed，成功后才 completed。完成页“已入队”之后仍核对 bot.log 和 batch_sync_events。

## S1 真实现场验收（尚待完成）

1. 通过Eagle官方安装入口安装正式版1.9.18，重新打开插件；核对安装manifest、正式包记录与全部22文件摘要。评审包与正式包不能混为同一构建。
2. 用户在 Eagle 包装库选择一个可用于验收的项目交付文件夹，按实际 PNG/ZIP/manifest 配对，确认命名与风险后入库。记录 batch_id/package_id。
3. 完成页分别显示 Eagle 写入与事件入队；bot 日志出现该批次 synced，数据库事件 completed，查询索引存在新包装。
4. 原查询人在飞书明确 @X.bot 查询该项目类型，核对候选 PNG；回复候选确认后 ZIP/云盘链接落在最初查询下。
5. 同一候选重复确认不重复交付；同查询第二个候选独立发送。其他人确认、无 reply_to、过期候选不发送。
6. 记录实际结果、消息 ID 和未完成项到 STATUS。本轮不由 Codex 代替原查询人确认发送，也不通过模拟测试标记现场闭环完成。

## 回滚入口

- 本轮分支 codex/single-machine-stability，基线 01b4ad1；变更未提交。回滚前先保存变更，恢复对应基线源码并重启既有任务，不执行破坏性 reset。
- 006 是追加列迁移，旧代码可读取；不手工删除生产数据。对账信息与备份保留在忽略的运行目录。
- 插件可从原 1.8.7 安装包通过 Eagle 官方确认恢复；不直接覆盖运行中的插件目录，不改 Eagle 内部 metadata.json。


## 统一意图判断（D-065，2026-10-13）

按用户要求不接入 Jev，继续使用现有 DeepSeek/OpenAI/Ollama；无需新增密钥或服务。

- 默认开启统一语义分类，LARK_BOT_INTENT_PROVIDER=off 可关闭；包装 AI 开关仍为 LARK_BOT_PACKAGING_AI_JUDGE=off。分类请求最长 8 秒，失败返回普通聊天路径。
- 2026-10-13 10:53 已通过 FeishuBot 本机加载，唯一监听器/消费者与 ready 核对通过。后续维护仍先核对当前查询/交付状态，按 D-060 处理结果不明交付，再通过既有唯一监听器启动流程加载。
- 飞书验收覆盖情绪/工作/闲聊，@ 项目类型，自然表达与缺项目追问，“不要信息条，我要背景”；否定、疑问、多编号候选回复不得发送 ZIP，明确编号才发。
- 记录误触发及端到端时延，校准初始 0.8 阈值；自动测试只使用伪造模型响应和临时 SQLite，不能代替现场效果验证。


## 候选继续浏览（D-066，2026-10-13）

11:03 已加载007迁移与浏览修复。原查询人回复候选“看看其他的/换一批/更多”显示未见包装；回复澄清消息可沿真实reply_to最多6级继续同项目浏览，无需再次@。无引用仍不继承，间接回复不能确认ZIP。每页最多3项，已见ID持久化、看完明确提示；旧候选保持可确认。

截图两条真实消息与生产库隔离备份重放均召回“小标”“BG-02”，没有真实发送消息；现场验收需再次回复原候选并检查新预览及翻页终点。


## 包装复杂追问（D-067）

复用现有DeepSeek配置；规则识别明确翻页、类型与编号确认，复杂追问在实际候选回复链中才请求模型。启动日志 packaging semantic follow-up enabled=true 代表已加载；LARK_BOT_PACKAGING_AI_JUDGE=off 或 LARK_BOT_INTENT_PROVIDER=off 可关闭语义追问。

008追加保存筛选池，回退旧代码不需删列。维护重启前核对进行中交付并SQLite backup；真实验收用“我想要放人物名字的/有没有简洁一点的/这几个不合适/第二个有没有新版/这个怎么用”，核对实际目录结果与未绕过确认；无风格标签需追问，不能宣称看过图片。

## 团队中央接口（2026-10-16）

本机部署已启用同进程中央接口与专用局域网防火墙。使用、配置/密钥、事件回执、写锁对账和两终端验收统一见[团队分发](TEAM_DISTRIBUTION.md)。`node scripts/team-host.js status`检查鉴权接口；同时仍需唯一监听器、消息与卡片各1消费者（active_consumers=2）和两个事件键的fresh ready日志。新增服务不改变D-060的交付确认和不明结果对账规则。旧“中央服务暂缓”段落是此前单机快照，当前以STATUS为准。


## 包装交互卡片（D-075）

- 飞书开发者后台 → 应用 → 事件与回调 → 回调配置：使用长连接接收回调，添加新版“卡片回传交互”card.action.trigger。CLI ready不能证明此设置已启用。
- 新查询展示Card 2.0，点“领取源文件”即原查询人明确确认；也可直接回复卡片编号。逐项预览、换批、取消及提示均在包装流程内，普通聊天保持原入口。ZIP仍发送到最初查询。
- 现场验收：真实查询核对图片/编号；其他人点击不得交付；原查询人领取一次且重复点击不重发；换批不重复已展示项；取消或过期后不可领取；直接文字回复仍有效。后台未开启时可先使用文字确认。


## 持久卡片会话（D-076）

- 新查询进入项目/类型选择，候选、翻页、领取进度和关闭均更新同一张卡片；旧卡片继续走D-075兼容入口。新交互不需要新增事件键，仍为两个消费者各1个。
- 维护前用原生SQLite只读核对preparing/sending并通过backup备份；010由启动迁移追加，不提前用旧版reconcile命令触发迁移。重启后核对schema_migrations、card_sessions、两个ready、索引和health。
- queries.root_message_id/prompt_message_id在新会话中为内部每页唯一键；实际飞书查询根是source_root_message_id，card_sessions保留真实卡片消息；deliveries:review已兼容真实根，不使用内部键人工查找消息。
- 现场验收：缺项目/缺类型/明确条件三种入口；前后翻页、切换筛选返回；原查询人领取、重复点击、他人点击、旧页延迟点击；文字补条件；取消/过期；大文件链接；重启后页面恢复与uncertain禁止重发。不要把ready和自动化测试当作现场验收完成。


## 过期查询与历史交付维护（2026-10-28）

- 启动后及每30秒将到期的pending查询标记expired；不改变sending/preparing/completed/failed状态，不改候选有效期，也不改delivery或触发消息。领取入口的有效期校验继续作为最终闸门。
- 历史failed/uncertain必须对照真实原消息核实；没有thread_id、消息不可见或历史分页缺失不能证明未发送。证据不足继续保持隔离，用deliveries:review按确切消息ID逐条对账。
- 当前实际标准为Card 2.0与中央服务（D-068、D-075至D-084）；外部技能或旧日期段落中的富文本专用、中央暂缓和单消费者描述均已过时。
- 现场验收需记录两台真实电脑、实际共享库和原查询人操作。单机测试、API ready或模拟点击不能关闭现场项。
