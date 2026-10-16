# 团队分发与本机中央接口

当前为 1.9.0 团队试用候选。自动测试和本机部署不代替两台真实电脑的 Eagle/NAS 与飞书验收。

## 同事使用

逐步图文操作见[插件使用手册（飞书）](https://zqyd2vqyqmy.feishu.cn/docx/QoXpdOr9JoD6Gaxrk93cTa1cnle)，含11张编号操作图；本地源稿与图片见[手册维护入口](plugin-guide/README.md)。截图使用示例数据，不代替现场验收。

1. Windows 上安装 Eagle。需要生成 PNG 预览时安装并授权 After Effects；视频框静态化另需 FFmpeg。插件内含 Worker，不要求同事安装 Python、Node.js 或机器人。
2. 从维护者处获取同一版本 `.eagleplugin` 和私密的团队连接 JSON。安装包与连接文件分开保管，密钥不发到公开下载页。
3. 安装插件后重开，核对版本 1.9.0。在 Eagle 中通过完整 UNC 路径打开共享包装库；映射盘路径不能用来通过团队库校验。
4. 打开“设置 → 团队连接 → 导入配置”，检查连接后保存，重新打开插件。不要在共享库选择单机模式。
5. 先用允许测试的工程或交付文件夹，选择合成，检查 PNG/ZIP、名称、类型与依赖风险，再保存。
6. “包装已保存”是 Eagle 写入结果。“已提交同步”仍需点击“检查同步”；“机器人已完成索引同步”表示服务端已经核对当前配对。更换文件或类型后的提示仍需在飞书核对。
7. 在飞书 @X.bot 查询，核对预览，原查询人直接回复候选确认，收到 ZIP/云盘链接。重复确认不得重复交付。

团队模式的类型由维护者集中管理，同事端只读同步。项目正式名称和别名继续由维护者在既有配置中维护，不在各终端另建同名映射。

## 维护者部署

先在 bot 主机核对活动交付并通过 SQLite backup API 备份；本版本没有新增数据库迁移。中央 HTTP 接口嵌入既有监听器，共用 `IngestEventWatcher`、数据库对象及索引刷新，不创建第二个数据库写入进程。服务配置位于忽略的 `config/team-server.local.json`，环境变量 XBOT_TEAM_TOKEN/HOST/PORT 可覆盖。

```powershell
node scripts/team-host.js init --host <本机局域网IPv4>
node scripts/team-host.js export --output data/team-connection.local.json
# 按 RUNBOOK 维护重启唯一 FeishuBot 后：
node scripts/team-host.js status
```

`init` 和 `export` 拒绝覆盖既有文件。连接文件含密钥，只通过团队认可的私密方式交给使用者；本轮没有替用户发送给同事。密钥轮换需要维护者更新服务配置并重新交付连接文件。客户端配置在用户 `%APPDATA%\XbotPackaging\team.json`，可用 XBOT_TEAM_CONFIG 覆盖；不可放进 Eagle 插件公共安装目录。

服务使用随机长密钥鉴权，不接收浏览器跨域调用；直接 HTTP 仅用于可信专用局域网，不做公网端口映射。如需跨不可信网络使用，应先部署 HTTPS 或受控隧道。主机固定/预留局域网 IP，保持登录且避免休眠；关机或注销期间不能保证机器人和中央接口在线。

管理员执行以下脚本，只允许专用网卡、本机指定地址和端口、LocalSubnet、Node 程序入站，不开放公用网络；已有同名规则会要求先核对：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/enable-team-firewall.ps1 -LocalAddress <本机局域网IPv4>
```

结果记录于忽略的 `data/team-firewall-result.json`。撤销时由管理员删除唯一规则 `XbotTeamIngestLocalSubnet`；服务停用只移走本机 team-server 配置并按 RUNBOOK 重启，不清除数据库、事件或 outbox。

## 接口与持久化

全部 `/v1/*` 接口要求 Bearer 密钥，服务端不回显密钥。健康检查核对服务端库路径可读性；客户端核对自身 Eagle 库和服务端 UNC 路径相同。

| 接口 | 作用 |
| --- | --- |
| GET /v1/health | 库路径及写入锁状态；不代表全部素材完整 |
| GET /v1/types | 中央类型与历史别名，只读 |
| POST /v1/events | 校验摘要、结构、大小，持久化事件后应答；不接受客户端数据库路径 |
| GET /v1/events/ingest-… | 查询 queued/processing/failed/completed 状态；只有 completed 表示配对已核实 |
| POST /v1/write-lock | 保存前申请全库串行写入锁 |
| DELETE /v1/write-lock | 仅本次随机锁 ID 可以正常释放 |

服务端事件与本机旧队列兼容，由现有 watcher 单点消费。团队事件先只读刷新 Eagle，核对 package_id、项目、名称、类型、版本、PNG/ZIP item ID 和启用状态，采用服务端解析的文件路径后再记录批次/修订并标记 completed；不信任客户端盘符。队列按事件 ID 去重；尚未核实的事件保持失败并重试。

团队客户端先将事件落入 `%APPDATA%\XbotPackaging\ingest-outbox\team`，再请求接口；只有收到 completed 才移除记录。断网、重开和点击检查只补交同一事件，不重新入 Eagle。URL 或团队库不一致时保留记录，要求恢复原连接，不悄悄投递到其他团队。单机旧 outbox 继续独立兼容。

## 并发与中断

团队版新增、替换、改类型及新版本归档均受全库写入锁保护；替换和改类型取得锁后重新读取当前配对，拒绝覆盖已变更的版本。异常失败或锁释放结果不明时保留锁，服务重启不自动解锁，避免另一个终端继续覆盖半成品。

维护者先核对锁所属终端是否仍在操作，检查 Eagle 的实际 PNG/ZIP、配对注释和相关事件。补齐或通过官方 API 修复后，用锁文件内的准确 ID 执行：

```powershell
node scripts/team-host.js unlock --lock-id <本次锁ID> --verified yes
```

解锁会保留对账日志，不导入、不发送、不清除交付状态。该命令默认运行根为当前用户 Documents\飞书；如部署曾覆盖 LARK_BOT_RUNTIME_ROOT，执行时必须使用相同值。不得仅因为等待时间长就解锁。

锁只约束使用团队模式的新插件；旧插件、单机模式、Eagle 手工修改或其他客户端不在此锁内。所有入库者必须升级并配置团队模式。真实 NAS/Eagle 一致性仍须现场验证；本轮不能宣称 NAS 自身具备事务或跨客户端强一致性。

## 两台电脑验收记录

完成前保持未勾选，逐项记录版本、终端、batch_id/package_id、时间、实际文件和消息 ID；不用截图模拟替代。

- [ ] 干净电脑首次安装、重开版本正确、Worker 可执行；无开发环境也可完成提取。
- [ ] 本机实际 AE 渲染、视频框 FFmpeg、字体/效果缺失及中文/UNC 路径核对。
- [ ] 两终端同时新增、同一包装替换/改类型；第二个终端被锁阻止，刷新后正确继续。
- [ ] 中断网络、退出 Eagle、服务重启；不重复导入，outbox 可补交，写入锁可按实际结果对账恢复。
- [ ] A 终端入库后 B 终端可见；中央事件 completed，飞书能检索新包装。
- [ ] 原查询人确认拿到正确 ZIP，重复确认和其他人确认不重复/越权发送。
- [ ] 旧版→新版下载安装、失败保留旧版、回退原稳定包后核对素材与查询。

设置中的“诊断信息”只导出版本、连接模式/地址及依赖文件存在性，不含密钥、素材和聊天内容；“已找到 AE”不代表授权或实际渲染成功。

## 发布边界

1.9.0 在上述验收完成前仅供受控试用，不公开标记稳定更新。安装包保留原插件 ID 和 Worker，包含团队模块且不含私密连接文件。版本、打包来源、SHA-256、安装和公开 Release 分开记录。自动发布流水线仍为后续优化；本轮不创建公共 Release。
