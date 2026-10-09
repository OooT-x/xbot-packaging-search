# Eagle 插件发布与客户端更新流程

更新日期：2026-10-09。产品规则见核心文档 11.5 与 D-056、D-059。

## 当前落地状态

| 环节 | 状态 |
| --- | --- |
| 可重复打包脚本 | 已实现 scripts/package-eagle-plugin.py；Git ref 源码、Worker SHA-256、固定 ZIP 元数据、CRC 和文件清单校验 |
| 本地构建 Worker、制作安装包 | 1.8.7 包由 7272d6f 生成并由 Eagle 安装；16 文件 SHA-256 与包一致，Worker 启动通过 |
| GitHub Actions | 现有 CI 仅测试与静态检查；自动发布流水线尚未实现 |
| 客户端版本查询、下载校验与 Eagle 接管 | 1.8.7 已实现并安装失败静默和宿主请求兼容；真实页面交互待复核 |
| 真实 Release → 另一端下载 → Eagle 安装 | 待验收；不得把本地测试通过写成线上闭环完成 |

## 1.8.8 本地评审包（2026-10-09）

- 本轮源码 1.8.8，修复入库事件失败反馈与重试；已通过 Eagle 官方入口安装 1.8.8，安装目录 16 文件哈希与包一致；真实页面和现场闭环仍需验收。
- 评审包：dist/stability-review/xbot-eagle-plugin-v1.8.8.eagleplugin，16 文件，25,194,367 字节，SHA-256 bef114696cf4c88833934f8dc3e2f116c5e677627ea5f6fdc93b68458fb9cc2b。
- Worker 未变更，SHA-256 9fa0d77087e1c0abfb2b1a6e3a9167e6e740e71dd4f21c994ab0521732d12e1b；包、CRC、逐文件内容均通过。
- worktree_review_only=true 是明确的本地评审快照，不能作为已提交的公开发布物。修复代码已提交并推送至 `codex/single-machine-stability`（最新代码 `f94eda3`）；未创建 Release；自动公开发布继续暂缓。

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
