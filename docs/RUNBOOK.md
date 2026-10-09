# 单机运行、恢复与现场验收

适用：S1 单机稳定性，2026-10-09。现状以 STATUS 顶部为准；D-060/D-061 定义交付与入库恢复规则。

## 在线标准

在项目根目录执行以下只读检查：

```powershell
lark-cli.cmd event status --json
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*lark-bot-listener.js*' } |
  Select-Object ProcessId, CreationDate
Get-ScheduledTask -TaskName FeishuBot
```

必须同时满足：唯一监听器、事件服务 running=true、active_consumers=1，以及运行根 logs/bot.log 有本次 ready、目录同步记录。复用已有健康事件总线时，不要求重复出现 websocket connected 行；检查消费者就绪和服务状态。PID 文件或计划任务 Running 单独不能证明在线。

## 运行与保活

- 现有运行根：`C:\Users\ADMIN\Documents\飞书`。回复规则、语音、事件队列和日志继续复用。
- 已注册任务以隐藏窗口运行，登录启动，5 分钟保活，异常退出尝试每分钟重启、最多 5 次；不设执行时间上限，任务 IgnoreNew，启动器和 Node 再做单实例保护。
- Windows 注销/关机不承诺常驻；服务器部署属于后续范围。
- 首次配置或入口变更后运行 `scripts/install-feishu-bot-autostart.ps1`，正常启动用 `Start-ScheduledTask -TaskName FeishuBot`。
- 维护前先核对没有正在处理的交付，并备份 SQLite（用 SQLite backup API，不只复制 WAL 主文件）；必要时停止任务再启动，启动会恢复中断状态。不要同时运行多个 Force 启动器。
- 10:27 后停止只知道退出码 0xC000013A；当时任务事件日志未启用，不能确定关闭窗口、任务终止或其他来源。隐藏启动/保活是防护，不能当作根因已证明。

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

1. 通过 Eagle 官方安装入口安装评审包 1.8.8，重新打开插件；核对安装 manifest 和包内 16 文件哈希一致。
2. 用户在 Eagle 包装库选择一个可用于验收的项目交付文件夹，按实际 PNG/ZIP/manifest 配对，确认命名与风险后入库。记录 batch_id/package_id。
3. 完成页分别显示 Eagle 写入与事件入队；bot 日志出现该批次 synced，数据库事件 completed，查询索引存在新包装。
4. 原查询人在飞书明确 @X.bot 查询该项目类型，核对候选 PNG；回复候选确认后 ZIP/云盘链接落在最初查询下。
5. 同一候选重复确认不重复交付；同查询第二个候选独立发送。其他人确认、无 reply_to、过期候选不发送。
6. 记录实际结果、消息 ID 和未完成项到 STATUS。本轮不由 Codex 代替原查询人确认发送，也不通过模拟测试标记现场闭环完成。

## 回滚入口

- 本轮分支 codex/single-machine-stability，基线 01b4ad1；变更未提交。回滚前先保存变更，恢复对应基线源码并重启既有任务，不执行破坏性 reset。
- 006 是追加列迁移，旧代码可读取；不手工删除生产数据。对账信息与备份保留在忽略的运行目录。
- 插件可从原 1.8.7 安装包通过 Eagle 官方确认恢复；不直接覆盖运行中的插件目录，不改 Eagle 内部 metadata.json。
