# 项目代码审查（2026-10-23）

> 后续修复状态：五项均已加入源码及针对性回归，分支`codex/audit-safety-fixes`，规则D-072、迁移009。以下保留最初审查快照，文中的“待修复”是发现时状态；当前测试、评审包和部署边界以STATUS顶部为准，未据此宣称线上已修复。

## 结论与范围

本轮确认5项缺陷：2项P1交付一致性问题、3项P2写入或索引可靠性问题。它们主要是业务逻辑与数据完整性缺陷，不代表已发现外部入侵或生产数据泄露。

审查对象为 `codex/library-sync-status`、HEAD `11f1c40` 的当前工作区，包含既有未提交和未跟踪实现。没有修复业务代码、提交、推送、重启服务、修改真实Eagle素材或发送飞书消息。原有工作区改动保留。

采用直接源码审查、现有完整测试集与临时SQLite/文件/模拟transport验证，未继续使用Codex Security扫描。重点追踪候选确认、交付状态、索引刷新、入库事件、团队接口/锁、更新器和Worker/AE桥接入口；这是按风险定位的代码审查，不是每行代码穷尽证明。

## AUDIT-01 / P1：确认时会发送候选展示后替换的新ZIP

- 位置：`bot/lib/package-database.js:491`、`:582`；`bot/lib/packaging-service.js:542`。
- 原因：候选表仅记录package_id，读取候选时JOIN当前packages；没有冻结展示时的PNG/ZIP ID、修订或内容身份。插件替换素材会沿用package_id。
- 触发：用户取得候选A；维护者替换同一包装ZIP并同步；原用户在有效期内回复旧候选“确认”。
- 实测：临时数据库把source从old.zip/zip-old更新为replacement.zip/zip-new，模拟发送读取到 `replacement.zip`、内容 `REPLACED`。用户没有预览或重新确认这一配对。
- 影响：确认语义与实际交付脱节，可能错发工程；若之前失败的交付已缓存云盘资源，资源身份也需一并绑定，避免旧URL与新索引混用。
- 修复方向：持久化候选展示时的版本、修订及PNG/ZIP身份，交付claim时核对当前身份；发生变化要求重查。已上传资源必须绑定同一快照。文件在原路径被覆盖的情况需由不可变资源或内容校验覆盖。
- 验收：旧候选+新ZIP拒绝；旧候选+未变配对正常；上传后重试配对变化不能复用错误资源。

## AUDIT-02 / P1：归档或撤下的包装仍可从旧候选交付

- 位置：`bot/lib/package-database.js:140`、`:582`、`:614`；`bot/lib/packaging-service.js:550`。
- 原因：replaceCatalog将未收录包装标archived并保留路径；候选JOIN未限制active，发送只检查路径存在，claim不校验包装启用状态。
- 触发：发出候选后，包装被归档、停用或因配对校验失败移出活动索引；旧ZIP仍在磁盘；用户确认旧候选。
- 实测：临时数据库执行replaceCatalog([], [])后状态为archived，旧候选仍成功调用模拟replyFile发送old.zip。
- 影响：撤下不能及时撤销已有候选，可能继续交付已知有问题或不应再使用的工程。即使修复AUDIT-01，仅冻结旧快照也不能解决撤下问题。
- 修复方向：在交付claim阶段独立检查当前包装/项目启用状态及有效配对；归档时使未交付候选失效。定义刷新失败时的交付策略，避免长期依赖过期索引。
- 验收：停用、归档、缺失配对均不得交付；恢复后要求重新查询；已完成记录保留。

## AUDIT-03 / P2：映射共享盘可绕过团队写入锁

- 位置：`eagle-plugin/lib/team-client.js:79`、`:87`。
- 原因：单机模式仅以字符串是否以UNC前缀开头判断共享库，映射盘Z:等不满足该条件。
- 触发：共享库通过映射盘打开，同时插件选择单机模式。
- 实测：向withTeamWrite传入library.path=`Z:\\packaging.library`、config.mode=local，action执行成功，未请求中央写锁。此测试证明路径门控可绕过；未在真实映射盘上制造并发写入。
- 影响：两端可绕开全库串行写入保护，产生冲突或部分配对。
- 修复方向：解析Windows驱动器的真实共享来源，或基于库身份/团队登记判定；识别为共享库时强制团队模式。明确旧客户端/手工Eagle修改仍在锁范围之外。
- 验收：真实SMB映射盘与UNC均拒绝单机写入，本地盘正常；两端争锁只能一个写入。

## AUDIT-04 / P2：单机队列断尾后，新事件会被吞掉却显示已入队

- 位置：`eagle-plugin/lib/ingest-bridge.js:100`、`:122`；`eagle-plugin/lib/team-sync.js`单机retryPackage分支；`bot/lib/ingest-sync.js:6`。
- 原因：单机发布及重试直接append JSON行，没有检查原文件末尾是否换行。中央appendDurably已处理这一边界，但单机路径未复用。
- 触发：异常退出留下半行JSON，下一次单机入库/重试追加新事件。
- 实测：预置队列内容 `{"unfinished":` 后调用publishIngestEvent，返回queued；readIngestEvents只返回一条_invalid，新event_id完全不可见，正常发布路径不产生outbox。
- 影响：Eagle已保存而索引事件丢失；单机重试路径还可能删除恢复文件，界面显示已入队却无法完成索引。
- 修复方向：所有JSONL写入统一为断尾隔离、完整行追加和必要fsync；只有持久化成功才清理outbox。保留损坏行用于诊断。
- 验收：发布、自动重试、单包装重试三条单机路径，断尾后新事件均可解析且可被消费者处理。

## AUDIT-05 / P2：PNG与ZIP元数据冲突仍被收录为有效配对

- 位置：`bot/lib/eagle-sync.js:144`、`:184`。
- 原因：按相同package_id分组后，用PNG字段覆盖ZIP字段，没有先检查项目、名称、类型、版本及声明配对ID是否一致。
- 触发：人工维护、旧客户端或部分写入造成同一package_id的两侧元数据冲突。
- 实测：PNG声明项目Public、ZIP声明OtherProject，相同package_id；buildCatalog返回errors=[]，并把OtherProject的ZIP收录到Public项目。
- 影响：损坏的稳定映射被默认为正确，可能跨项目错发源文件。不是仅靠文件名形成配对的问题，而是稳定ID存在时仍未校验冲突。
- 修复方向：入索引前核对两侧关键字段和配对引用；冲突时隔离该包装并输出具体诊断。兼容旧记录时区分“缺失字段”与“存在且冲突”。
- 验收：项目/版本/类型/配对ID冲突拒绝；完整一致配对、合法单图背景和允许的旧格式仍正常。

## 验证证据与限制

- `npm test`：222 JS + 34 Python通过，失败0。
- `npm run check`通过；`git diff --check`通过，Git提示部分既有文件的CRLF规范化。
- AUDIT-01/02使用真实PackageDatabase与PackagingService、临时SQLite及模拟transport；AUDIT-03使用真实withTeamWrite函数和模拟库路径；AUDIT-04/05使用真实发布/解析/构建目录函数与临时文件。
- 临时复现实验目录：`C:\Users\ADMIN\AppData\Local\Temp\xbot-audit-wXNoIf`、`C:\Users\ADMIN\AppData\Local\Temp\xbot-audit-more-WMnRpC`。这些目录可能被系统清理，结论和操作步骤以上文记录为准。
- 本轮查看Git受管文件名，未发现受管的运行SQLite、AEP、ZIP、日志或.env文件；这不是Git完整历史密钥扫描，也不证明所有代码字符串无密钥。
- 现有测试覆盖原查询人、reply_to、过期、防重复、uncertain恢复、团队鉴权及更新器摘要校验；通过并不覆盖上列新增复现场景。
- 未执行真实飞书取件、生产数据库写入、Eagle/NAS并发故障注入、安装/更新/回退或在线依赖漏洞数据库扫描；没有根据旧STATUS宣称当前服务健康。
- 已知架构债务另列：D-068允许可信局域网HTTP共享密钥，跨不可信网络需要HTTPS/受控隧道；旧客户端/手工写入不受团队锁约束。它们属于已声明边界，不作为新发现重复计数。

## 修复顺序

先修AUDIT-01与02，建立候选身份和当前可交付状态的联合闸门；再修AUDIT-05，避免坏配对进入索引；随后统一AUDIT-04的队列写入；团队扩大使用前修AUDIT-03并完成真实双终端验收。全部状态为“已复现、待修复”，本轮没有关闭缺陷。
