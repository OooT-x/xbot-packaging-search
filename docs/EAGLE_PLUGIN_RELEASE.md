# Eagle 插件发布与客户端更新流程

2026-10-28：稳定版 1.9.14 已公开发布，标签与安装包均来自通过 CI 的主分支提交 `1a059cd3c33e5f3651dba5c07880a1de87817ee6`。安装包 25,216,431 字节，SHA-256 `2feb5307a3d72a4bbaf559a5a20f4d22630a067a6138e8896f9c55392bee9c53`；四个附件的远端 digest/大小逐一核对，latest 的 update.json 已回读为 1.9.14。真实 Eagle/双终端验收仍待现场进行；见 STATUS RELEASE-01。

2026-10-23：本机安装1.9.5限流冷却/状态反馈评审包（含前轮下拉菜单），22文件摘要一致，包SHA-256 `01f9b83c46784bff34c2e6c63d0c82df7332026a125c538fe3d3b74100e40874`；worktree_review_only=true，未公开发布。D-073规定限流冷却优先于正常启动/手动查询。详见STATUS UPDATE-12，以下为阶段快照。

更新日期：2026-10-09。产品规则见核心文档 11.5 与 D-056、D-059。

## 当前落地状态

2026-10-23本机部署补充：1.9.4经Eagle官方入口安装，实际安装目录22文件摘要与 `dist/audit-1.9.4/xbot-eagle-plugin-v1.9.4.json` 一致；包SHA-256 `ecf9f7d9722f00af0114663414cd026de13e6f35c495512ed327518ea500a181`。服务已重启加载，009迁移和49组中央同步状态核验完成。该包来自未提交工作区（worktree_review_only=true），未公开发布；窗口捕获超时，打开中的宿主页面加载与双终端验收仍待确认。完整证据见 STATUS 顶部。下表及旧版本记录保留为历史阶段快照。

| 环节 | 状态 |
| --- | --- |
| 可重复打包脚本 | 已实现 scripts/package-eagle-plugin.py；Git ref 源码、Worker SHA-256、固定 ZIP 元数据、CRC 和文件清单校验 |
| 本地构建 Worker、制作安装包 | 1.8.7 包由 7272d6f 生成并由 Eagle 安装；16 文件 SHA-256 与包一致，Worker 启动通过 |
| GitHub Actions | 现有 CI 仅测试与静态检查；自动发布流水线尚未实现 |
| 客户端版本查询、下载校验与 Eagle 接管 | 1.8.7 已实现并安装失败静默和宿主请求兼容；真实页面交互待复核 |
| 真实 Release → 另一端下载 → Eagle 安装 | 待验收；不得把本地测试通过写成线上闭环完成 |

## 1.8.14 本地安装记录（2026-10-13）

- UI-07：素材库排序和首页拖放修复打包安装，保留 1.8.13 NAS 修复、LB5UL2P0Q9FFF 和原 Worker。
- 本地评审包 dist/local-1.8.14/xbot-eagle-plugin-v1.8.14.eagleplugin：18 文件，25,197,320 字节，SHA-256 006da40c2f93a8a7e24107c7da80b9ba663b6b8c1d7518052bc4341098e69ddc；worktree_review_only=true，基线 d701c4b，包含工作区未提交插件修改。
- 190 JS、34 Python、静态和 diff 检查通过；Worker 哈希 9fa0d77087e1c0abfb2b1a6e3a9167e6e740e71dd4f21c994ab0521732d12e1b，包 CRC/逐文件校验通过。
- Eagle 官方入口日志记录安装成功；实时安装清单为 1.8.14，全部 18 文件 SHA-256 与安装包一致。宿主缓存名称仍打印 1.8.13，真实排序与 Explorer 拖放待重开插件验证。
- 未提交、推送、创建标签或公开发布；此前公开版记录为 1.8.9。本包仅本机使用，公开发行需从已验证 Git ref 重建。

## 1.8.12 本地安装记录（2026-10-09）

- UI-04（P2，修复、测试及安装完成）：从 73bd09c07c6cad06acffee51bc30ddd6bce2f7ca 构建筛选计数修复，保留插件 ID 与原 Worker；Eagle 官方入口完成安装，实时 manifest 为 1.8.12。
- 安装包：dist/local-1.8.12/xbot-eagle-plugin-v1.8.12.eagleplugin；18 文件，25,196,143 字节；SHA-256 cd41023eb532026ea4cc1bda3efa15d9f2b60474851708c4b4be4b6acc45fb86。Git ref 构建，review_only=false；CRC、安装目录全部 18 文件逐字节及 SHA-256 一致。
- 验证：179 项 JS、34 项 Python、静态与 diff 检查通过；新增计数回归覆盖项目/类型/搜索/空结果/清空，浏览器生产筛选事件核对通过。类型数量按项目及搜索范围统计；当前版本数量按显示结果统计。
- 偏差/债务/下一步：浏览器空结果沿用生产入口已有保护；预览独立页面的空检查器问题不扩展到本轮。重新打开插件核对真实界面，Eagle→bot 验收继续保留；未推送或公开发布，公开版仍为 1.8.9。

## 1.8.11 本地安装记录（2026-10-09）

- UI-03（P2，打包安装完成）：从 7b7032427154934d2e15edfb4629377ce3ad7523 构建紧凑项目菜单版本，保留 ID LB5UL2P0Q9FFF 和原 Worker；通过 Eagle 官方入口安装，实时 manifest 为 1.8.11。
- 安装包：dist/local-1.8.11/xbot-eagle-plugin-v1.8.11.eagleplugin；18 文件，25,195,995 字节；SHA-256 2649c5744250f5226e68d5263364ef71866492b2d892a536fbcc85c078e0f142。Git ref 构建，review_only=false；CRC、逐文件字节和安装目录 18 文件 SHA-256 全部通过。
- 验证：178 项 JS、34 项 Python、静态及 diff 检查通过；UI-02 浏览器覆盖搜索、选中、键盘、外部关闭、选项刷新、深浅主题和窄窗口。Worker 摘要仍为 9fa0d77087e1c0abfb2b1a6e3a9167e6e740e71dd4f21c994ab0521732d12e1b。
- 偏差/债务/下一步：安装结果已核对，实际宿主页面交互和 Eagle→bot 现场验收仍单独保留；请重开插件加载新版。仅本机安装，未推送或公开发布；公开版仍为 1.8.9。

## 1.8.10 本地安装记录（2026-10-09）

- COPY-02（P2，打包与安装完成）：文案更新安装包由源码提交 d6c5ca0 构建，保留 ID LB5UL2P0Q9FFF；Eagle 官方安装入口已完成安装，实时 manifest 为 1.8.10，显示名“包装助手”。
- 安装包：dist/local-1.8.10/xbot-eagle-plugin-v1.8.10.eagleplugin；17 文件，25,193,730 字节，SHA-256 e738779af30482a65bae31aa8b58c59e3efb24a3f18ba99894cb386ee15c945d。Git ref 构建，worktree_review_only=false，CRC、逐文件内容和安装目录全部 17 文件 SHA-256 一致。
- 验证：178 项 JavaScript、34 项 Python 和静态检查通过；Worker 未变更，摘要 9fa0d77087e1c0abfb2b1a6e3a9167e6e740e71dd4f21c994ab0521732d12e1b，与包和安装目录一致。
- 本轮仅本机安装，未推送、创建标签或公开 Release；公开版仍为 1.8.9。请重新打开插件加载新界面，真实 Eagle 文案/窗口与 Eagle→bot 现场流程继续单独验收。
- 偏差与下一步：本次实时确认安装前已为 1.8.9，修正旧“已安装 1.8.8”快照；本轮完成本机 1.8.10，保留预览类型管理已有问题和真实宿主验收债务。

## 1.8.9 正式发行记录（2026-10-09）

- [稳定公开 Release](https://github.com/OooT-x/xbot-packaging-search/releases/tag/eagle-plugin-v1.8.9)，draft=false、prerelease=false。
- 标题栏分支已快进合入并推送 main；标签 eagle-plugin-v1.8.9 固定指向发行提交 14b2e5d5ac25cd6e224cb530c781e448c786c729，[Windows CI](https://github.com/OooT-x/xbot-packaging-search/actions/runs/37890928520) 已通过，178 项 JS、34 项 Python 与静态检查通过。
- 正式包 dist/release-1.8.9/xbot-eagle-plugin-v1.8.9.eagleplugin：17 文件，25,195,933 字节，SHA-256 84ffd7a27603e36b62547c987d9421b2e146139526b74c849d53af03ed34e5d1；从 Git ref 重新构建，worktree_review_only=false，ZIP CRC/逐文件内容通过。
- Worker 未变更，SHA-256 9fa0d77087e1c0abfb2b1a6e3a9167e6e740e71dd4f21c994ab0521732d12e1b；--help 启动通过。
- 安装包、sha256、逐文件 JSON 共 3 份资产，公开发布前后均核对 GitHub API 大小/digest 与本地一致。
- 本机仍为 1.8.8；1.8.9 原生拖动/双击最大化/边缘缩放及另一端自动下载安装仍待现场验收。自动发布流水线仍未实现。

## 1.8.8 正式发行记录（2026-10-09）

- [稳定公开 Release](https://github.com/OooT-x/xbot-packaging-search/releases/tag/eagle-plugin-v1.8.8)；不是草稿或预发布。
- 标签 `eagle-plugin-v1.8.8` 指向已通过主分支 CI 的 `6d977353973f87aefdb82d529d54dd3046e4a781`，不随后续文档提交移动。
- 正式包 `dist/release-1.8.8/xbot-eagle-plugin-v1.8.8.eagleplugin`：16 文件，25,194,338 字节，SHA-256 `19e9ce6fdc6ff2141d1fbbdcc982e3d93bb7d87178cc3c60d505e76f5c89a439`。
- 使用 Git ref 重新构建，worktree_review_only=false；复用未变更且已验证的 Worker（SHA-256 `9fa0d77087e1c0abfb2b1a6e3a9167e6e740e71dd4f21c994ab0521732d12e1b`），Worker --help、ZIP CRC、逐文件内容校验通过。
- 与已安装评审包仅 index.html、js/v5-runtime.js、manifest.json 的换行不同，业务内容一致；摘要/字节数因此不同，评审包记录保留。
- 安装包、sha256、逐文件 JSON 共 3 个资产，GitHub API 的大小与 digest 全部与本地一致；发布后确认 draft=false、prerelease=false。
- 另一端旧版插件下载/确认安装及真实 Eagle→bot 现场闭环仍待验收；自动发布流水线仍未实现。

## 1.8.8 本地评审包（2026-10-09）

- 本轮源码 1.8.8，修复入库事件失败反馈与重试；已通过 Eagle 官方入口安装 1.8.8，安装目录 16 文件哈希与包一致；真实页面和现场闭环仍需验收。
- 评审包：dist/stability-review/xbot-eagle-plugin-v1.8.8.eagleplugin，16 文件，25,194,367 字节，SHA-256 bef114696cf4c88833934f8dc3e2f116c5e677627ea5f6fdc93b68458fb9cc2b。
- Worker 未变更，SHA-256 9fa0d77087e1c0abfb2b1a6e3a9167e6e740e71dd4f21c994ab0521732d12e1b；包、CRC、逐文件内容均通过。
- worktree_review_only=true 是明确的本地评审快照，不能作为已提交的公开发布物。修复代码已提交并推送至 `codex/single-machine-stability`（最新代码 `f94eda3`）；此评审包不作为发行资产，正式包记录见上；自动发布流水线继续暂缓。

## 已安装 1.8.7 基线记录（2026-10-09）

- 正式源码提交：`7272d6f`；安装包：`dist/xbot-eagle-plugin-v1.8.7.eagleplugin`。
- 16 文件、25,206,671 字节；SHA-256：`939920776B1857183C792F34F0468940BAE959AE36BE0FEEFB0DC764C8FCF3DC`。
- ZIP CRC 和全部文件内容校验通过；系统关联调用 Eagle 官方安装入口，用户确认后实际安装 manifest 为 1.8.7，16 文件 SHA-256 与包一致；Worker `--help` 启动检查通过。
- 原生窗口工具启动失败，真实页面交互仍待复核；实时 GitHub API 返回 HTTP 403 限流，不能将本机安装视为公开 Release 下载闭环完成。
- 未启用的旧 UI 草稿保存在 `codex/archive-legacy-v5-draft` / `3587e0f`，不在正式包内；尚未推送或公开发布。

## 版本与产物约定

- 公开发布仓库：`OooT-x/xbot-packaging-search`。
- 版本唯一来源：`eagle-plugin/manifest.json` 的 `version`；插件 ID 固定为 `LB5UL2P0Q9FFF`。
- 标签：`eagle-plugin-vX.Y.Z`；安装包：`xbot-eagle-plugin-vX.Y.Z.eagleplugin`。
- 标签、manifest 与安装包名称必须为同一稳定语义版本；不使用根项目的 `vX.Y.Z` 标签。
- 安装包必须包含 `workers/XbotAepWorker.exe`；构建产物放在忽略的 `dist/`，不提交二进制、素材、运行库、日志或密钥。
- 发布新的补丁版本修正已发布版本，不覆盖同一版本的安装包或移动已发布标签。

## 当前可执行的手动发布

1. 在工作分支完成代码、manifest 版本、变更说明及项目状态更新，保留无关的已有修改。
2. 执行 `npm test`、`npm run check` 与 `git diff --check`；把已验证的发布提交合入主分支。
3. 在 Windows 上运行 `aep-collector/build.ps1`，生成随插件分发的 Worker。当前脚本同时构建外部 GUI；运行环境需具备其 Python、Tcl/Tk 与打包依赖。
4. 使用 Eagle“打包插件”导出安装包，或使用经 Eagle 验证兼容的 ZIP 打包流程。安装包只包含发布提交中的插件文件与本次构建 Worker，使用标准正斜杠路径，根目录含 manifest；按约定命名。
5. 检查 ZIP CRC、插件 ID、版本、必需文件及 Worker；计算安装包 SHA-256，保留本地验收记录。
6. 从主分支的已验证发布提交创建并推送版本标签。以未来首次发布 1.8.6 为例（先完成上述准备，不直接在含无关改动的当前工作分支上执行）：

   ```powershell
   git tag eagle-plugin-v1.8.6
   git push origin eagle-plugin-v1.8.6
   ```

7. 在 GitHub Releases 创建该标签的**草稿**，填写本版说明，上传 `xbot-eagle-plugin-v1.8.6.eagleplugin`。
8. 核对上传附件名称、大小及 Release API 返回的 `digest`（`sha256:...`）与本地摘要一致，确认附件完整后发布为稳定版。客户端不会展示草稿与预发布版本；单纯推送代码或标签不会自动生成 Release 附件。
9. 在另一端旧版插件执行下文的真实验收，记录版本、下载摘要、安装结果与遗留问题。

## 可重复打包命令

```powershell
$workerSha = (Get-FileHash -LiteralPath 'eagle-plugin/workers/XbotAepWorker.exe' -Algorithm SHA256).Hash
python scripts/package-eagle-plugin.py --ref <已验证提交或标签> --worker eagle-plugin/workers/XbotAepWorker.exe --worker-sha256 $workerSha --output dist/release
```

脚本从该 Git ref 取插件源码，不混入本地修改；Worker 是独立构建输入，必须核对预期摘要。输出包、逐文件记录 JSON 和 sha256。元数据固定，内容相同的输入在同一工具环境中输出相同字节；拒绝覆盖已有包。仅本地评审可显式使用 --worktree，记录 review_only；正式发布始终从已验证提交/标签重新生成。

## 自动发布流水线设计（待实现）

拟新增 `.github/workflows/release-eagle-plugin.yml` 和可复用打包脚本。先将流水线合入主分支，再从包含它的已验证主分支提交推送标签。

触发条件为 `eagle-plugin-v*` 标签；任务使用 Windows runner，按以下顺序执行：

1. 检出标签对应提交，校验 tag 与 manifest 完全一致，禁止从不确定的本地工作区混入文件。
2. 安装 Node/Python 与构建依赖；运行测试和静态检查，失败停止。
3. 构建 `XbotAepWorker.exe`，打包插件并检查 CRC、插件 ID、版本、必需文件与 SHA-256。
4. 使用 GitHub CLI/API 创建草稿 Release，上传同版本安装包与版本说明。
5. 读取上传资产信息，核对大小和 GitHub SHA-256，再将草稿发布为稳定版；任一步失败保留失败状态，不发布残缺更新。
6. 输出 Release 地址与安装包摘要，供远端安装验收。

发布任务使用仓库内置 `GITHUB_TOKEN` 并配置 `contents: write`；客户端匿名访问公开 Releases，不携带此令牌。仓库或组织权限策略仍需在首次运行确认。发布流水线应先合入默认分支，避免发布目标包含默认分支尚未接受的 workflow 变更。

重复执行同一版本先核对已有 Release/附件；不静默覆盖已经公开的发布物。此设计尚未实施，当前推送标签仅创建标签，自动构建与上传不会发生。

## 客户端检查规则（D-059）

- 每次插件窗口打开、生产控制器初始化完成后，自动向 GitHub 查询一次最新稳定插件 Release；即使有 24 小时内缓存，也查询本次最新信息。
- 点击“检查更新”按钮时再查询一次，不用缓存代替此次请求。正在检查或下载时按钮禁用，避免重复请求。
- 进入版本页、切换页面及点击下载只使用已有查询结果；没有后台定时轮询。
- 缓存用于展示历史结果及查询失败后的回退，读取时按当前 manifest 重新比较；缓存有效期不再跳过上述两个检查入口。
- 请求失败只在版本页显示原因，不弹出提示，并保留上次结果，等待用户点击按钮或下次重新打开插件重试，不自动循环重试。
- 发现新版后提示说明与下载入口；用户主动下载，先校验大小和有效 SHA-256，再交给 Eagle 确认安装。
- 打开安装包成功只代表安装接管；用户确认后重开插件，读取新 manifest 才能核对安装版本。

## 真实发布验收

- [ ] Release 为稳定公开版本，tag、manifest、资产名一致，Worker 完整，API 摘要与本地一致。
- [ ] 另一端安装了含更新器的旧版插件，打开后自动查询一次并显示正确的新版本信息。
- [ ] 缓存仍新鲜时重新打开插件，仍能获取刚发布的新版本。
- [ ] 多次进入/离开版本页不产生新的版本查询；点击“检查更新”才再次查询。
- [ ] 下载得到同版本安装包，大小与 SHA-256 一致；失败或缺少摘要不打开安装包。
- [ ] Eagle 完成用户确认安装；重新打开后 manifest 版本正确且 Worker 可用。
- [ ] 网络/限流失败保留旧结果和重试入口，不误报已完成安装。

不含更新器的早期版本需先手动安装一次含更新器的插件，才能进入后续插件内更新流程。

## 官方参考

- [GitHub Release 创建命令](https://cli.github.com/manual/gh_release_create)
- [Release 资产字段与 SHA-256](https://docs.github.com/en/rest/releases/assets)
- [GitHub Actions 内置令牌与权限](https://docs.github.com/en/actions/tutorials/authenticate-with-github_token)

## 1.9.0 团队候选（2026-10-16）

本轮把中央连接、配对核实回执、写入锁、统一类型、首次配置及诊断纳入1.9.0。完整使用及真实验收见[团队分发](TEAM_DISTRIBUTION.md)。源码、固定提交包、已安装和公开发布分开记录，TEAM-07现场验收前不公开稳定版。必须包含team-client/team-sync/environment-check模块和原Worker；连接密钥独立保管，不进入插件包。实时读取的此前本机安装manifest已为1.8.15，修正旧未复核记录。


### 1.9.0 固定提交包与本机安装（2026-10-16 16:06，北京时间）

- 源码提交：`549ade6a07a371934eb0e7d4b3eb3d44daf119b0`，分支`codex/team-distribution`；无关bot互动及原有文档历史修改仍保留在工作区，未混入发行提交，工作区不宣称干净。
- 包：`dist/team-1.9.0/xbot-eagle-plugin-v1.9.0.eagleplugin`，21文件、25205819字节，Git ref构建、review_only=false；CRC/清单/逐文件摘要通过，两次真实Worker构建字节完全一致。SHA-256：`f80252e096ddee33b61a1772da0625658aaddcac5c1d650afb659b77eccd4e0d`。
- 安装：经Eagle官方文件关联打开安装；安装目录manifest=1.9.0，全部21文件SHA-256与包一致；本机私密团队配置已保存并从中央同步类型。Eagle当前活动库实时为`E:\Eagle资源库\参考.library`，未对该库写素材；试用前需在Eagle打开配置中的UNC包装库，错误库会被团队闸门阻止。
- 最终运行：16:05:40启动唯一监听器PID8340；16:05:41同步10项目/49包装/errors=0并启动中央接口；16:05:43事件ready。事件服务running=true/active_consumers=1；中央鉴权health=ready/writeLocked=false。23完成/1uncertain交付、19已完成入库事件保持；最终维护前无进行中交付，backup为`data/pre-team-final-deploy-1792137938448.sqlite`。
- 主机连接地址`http://192.168.31.69:41596`；私密连接文件为忽略的`data/team-connection.local.json`，未随包分发或替用户发送。防火墙管理员脚本返回configured（仅Private/指定网卡地址/LocalSubnet/Node）；远端连通仍待同事电脑核对。
- 使用材料：`docs/TEAM_DISTRIBUTION.md`及`dist/team-1.9.0/同事安装说明.md`；核心文档v1.51与飞书外部工作副本哈希核对后另记。
- 未推送/公开发布1.9.0；两台真实电脑安装/更新/回退、NAS并发/断线、飞书原查询人确认交付和AE实际渲染仍待现场验收；自动发布流水线未实施。

## 静态更新清单（D-074，1.9.6起）

客户端先读 `https://github.com/OooT-x/xbot-packaging-search/releases/latest/download/update.json`，失败再从最新Release页面最终地址核对版本，不默认请求REST API。页面只能发现版本；没有可信大小/摘要时只提供官方版本页入口，不启用插件内下载。网页渠道有独立冷却，旧API冷却不会阻止网页查询。

正式包经固定Git ref构建、核验并与稳定Release对应后，生成清单：

```powershell
python scripts/create-update-manifest.py --record dist/release/xbot-eagle-plugin-v1.9.7.json --notes dist/release/release-notes.md --published-at 2026-10-23T08:00:00Z --output dist/release/update.json
```

版本与日期应替换为实际Release事实，不能照抄示例。工具拒绝worktree评审包、摘要/大小/身份/文件清单不一致和覆盖已有清单。生成后核对schemaVersion=1、pluginId=LB5UL2P0Q9FFF、channel=stable、版本/URL/文件名、大小、SHA-256、说明及时间。将update.json随对应稳定Release上传，确保仓库latest指向该插件版本；不上传源代码工作区配置或Token。

```powershell
gh release upload eagle-plugin-v1.9.7 dist/release/update.json --repo OooT-x/xbot-packaging-search
```

此命令会修改公开Release，执行前核对目标标签及正式包；首次上线也可以给既有稳定Release补齐清单，不必把本机评审版本公开发布。上传后读取上述latest/download/update.json，核对返回版本、大小/摘要，验证有新版/同版/本机领先和清单缺失的页面兜底。

2026-10-23准备：`dist/static-update-review-1.8.9/update.json`由既有1.8.9正式包生成，原安装包CRC、17文件摘要及包摘要核验通过；尚未上传，GitHub CLI登录失效。当前远端走Release页面兜底已实测成功，公开版仍为1.8.9；不能把准备好的本地清单视为已上线。
