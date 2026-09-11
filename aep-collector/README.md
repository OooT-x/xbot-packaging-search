# X.bot AEP 收集工具

这是替代原 AE ScriptUI 面板方向的 Windows AEP 收集工具。Eagle 插件通过无界面的 `XbotAepWorker.exe` 调用本目录的收集核心；带 Tkinter 界面的 `XbotAepCollector.exe` 仍作为兼容和离线验收入口保留。它参考 BHY Collect Pro 的离线工作方式，但不修改、不复制也不重新分发 BHY 的闭源 EXE；AEP 读取与写入使用 MIT 许可的公开项目 `py-aep`。

## 当前能力

- 不启动 After Effects，直接打开 `.aep`。
- 显示工程内全部合成，而不是只显示外部素材。
- 对每个合成显示尺寸、时长、帧率、父级使用关系和内部预合成。
- 选中一个合成后可一键查看直属预合成；也可将这些直属预合成逐个独立收集、渲染预览并打包为 ZIP。
- 预合成导出只处理直接作为图层源的 `CompItem`，每个子合成的 ZIP 会继续递归包含它自己的下层预合成和素材，不会把上层包装合成一起导出。
- 每个合成默认选择第 2 秒代表帧；短于 2 秒时自动取最后一个有效帧。
- 单选合成后可打开预览窗口，通过时间轴、秒数输入或前后逐帧调整，透明画面用棋盘格显示。
- 视频框、横屏框和竖屏框会优先把唯一合适的上层“包装/展示合成”作为预览来源，从而把框体叠在背景上展示；默认取父级中视频框图层出现后的第 2 秒，预览窗口仍可切换为自身或其他直接父合成，实际收集目标不会改变。
- 收集视频框合成时，若依赖中存在视频素材，先用本机 ffmpeg 提取视频第 0 帧为 PNG，并在精简工程中替换原视频引用；`素材/Video` 不再复制原视频，manifest 的 `video_frame_replacements` 记录替换事实。找不到 ffmpeg 或提取失败会阻止本次收集，避免生成仍依赖视频的交付包。
- 可选安装 AE 快速预览桥接。AE 已打开同一个 AEP 时，调帧通过常驻 AE 的 `saveFrameToPng` 快速刷新；未连接时自动回退 `aerender`。后台渲染优先使用 `Xbot PNG with Alpha` 输出模块直接生成 PNG，模板不存在或失败时自动回退 TIFF+Alpha 中转；最终入库 PNG 始终只额外执行一次高质量 `aerender`。
- 支持多选合成；每个合成生成独立的收集目录和同名 ZIP。
- 递归保留选中合成的嵌套合成和直接图层素材。
- 复制素材并把收集工程重链接到新素材目录。
- 输出新的 `.aep`、`素材/` 和 `manifest.json`，并自动压缩成可交给 Eagle 的 ZIP；不覆盖原工程。
- ZIP 使用独立顶层文件夹封装，生成后自动执行 CRC、自检 AEP 和 manifest 完整性校验。
- manifest 标记为 `xbot-collection` 收集记录，供 Eagle 插件读取合成名、对应 ZIP 和依赖状态，不冒充已经补齐 PNG、类型和版本的正式入库清单。
- 收集时通过本机 `aerender` 后台渲染已确认或默认帧，输出与 ZIP 同名的 PNG，并将 `preview_file`、时间和 AE 帧号写回 manifest 及 ZIP 内的 manifest。
- 收集前先解析全部素材路径；工程搬迁后可由唯一 `(素材)`/`素材`/`Footage` 锚点恢复的路径自动重定位并重链接。无法恢复的素材写入 manifest 的 `missing_files`，并在插件配对预检中按素材组显示；用户可显式接受风险入库，后续通过维护流程替换 ZIP 修复。

## 运行

在 PowerShell 中执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\aep-collector\run.ps1
```

首次运行会在 `aep-collector/.venv` 安装固定版本依赖。

## Eagle 插件集成

在 Eagle 中打开 `eagle-plugin` 后，从顶部进入“AEP 收集”。选择 AEP、读取结构并勾选合成，插件会调用本机 Worker 生成 PNG、ZIP 和 manifest，随后自动进入现有配对预检与正式入库流程。原始工程始终只读。

构建脚本会把 Worker 同时放入 `aep-collector/dist/XbotAepWorker.exe` 和未纳入 Git 的 `eagle-plugin/workers/XbotAepWorker.exe`；分发插件时需保留后者。若使用便携目录，可设置 `XBOT_AEP_WORKER` 指向 Worker 的绝对路径。

## 命令行验证

```powershell
& .\aep-collector\.venv\Scripts\python.exe -m xbot_aep_collector.cli inspect "E:\项目\example.aep"

# 按 inspect 返回的合成 ID 查看直属预合成
& .\aep-collector\.venv\Scripts\python.exe -m xbot_aep_collector.cli list-precomps "E:\项目\example.aep" --comp-id 17

# 将指定合成的直属预合成分别输出为独立收集目录和 ZIP
& .\aep-collector\.venv\Scripts\python.exe -m xbot_aep_collector.cli collect-precomps "E:\项目\example.aep" --comp-id 17 --output "E:\项目\Xbot_Collected_Projects"
```

需要先把当前目录切换到 `aep-collector`，或者将该目录加入 `PYTHONPATH`。

## 构建 EXE

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\aep-collector\build.ps1
```

产物位于 `aep-collector/dist/XbotAepCollector.exe` 和 `aep-collector/dist/XbotAepWorker.exe`。构建产物不提交 Git。

构建目录还会生成 `dist/AE-Preview-Bridge/`。快速桥接是可选组件，不影响离线查看与收集。

## 安装快速预览桥接（可选）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\aep-collector\install-preview-bridge.ps1
```

脚本会按需弹出 Windows UAC。重启 After Effects，打开与收集器相同的 AEP，然后在 `窗口` 菜单打开 `XbotPreviewBridge.jsx` 并保持面板运行。收集器解析工程后会在日志中显示“快速预览已连接”；FX Console 无需安装，也不会被调用。

桥接只在本机 `%APPDATA%\XbotAepPreviewBridge` 交换请求、状态和临时路径，不上传工程或画面。若 AE 没打开当前工程、桥接停止或请求超时，收集器会自动走原有高质量后台渲染。

## 创建后台直接 PNG 模板

在 AE 中打开 `编辑 > 模板 > 输出模块`，新建一个格式为 `PNG 序列`、通道为 `RGB + Alpha`、颜色为 `Straight / Unmatted` 的输出模块，并严格命名为 `Xbot PNG with Alpha`。收集器在 AE 未打开时会优先通过该模板直接输出 PNG；如果其他 AE 版本未安装该模板，会自动回退，不会因此中断收集。

可用环境变量 `XBOT_AERENDER_PNG_TEMPLATE` 指定其他直接 PNG 模板名；原 `XBOT_AERENDER_STILL_TEMPLATE` 仍只用于 TIFF 回退模板。

## 安全边界

- 永远从原 AEP 重新解析，在新目录中保存收集结果。
- 不删除、重命名、覆盖原 AEP 或原素材。
- 压缩失败或交付文件缺失时不保留半成品 ZIP，也不会把该次收集报告为成功。
- 不把工程、素材或预览上传到外部服务。
- 收集结果仍需在 After Effects 中打开，核对表达式、字体、第三方效果、序列素材和最终画面。
- 离线查看和收集不启动 AE；只有生成真实预览画面时才会在后台启动 `aerender`，不打开 AE 主界面。
- 快速预览只在用户主动打开同一 AEP 和桥接面板后工作，不会切换或覆盖 AE 当前工程。

## 当前限制

- 跨合成表达式可能引用没有作为图层嵌套的其他合成；第一版不能保证自动发现所有此类引用。
- 字体和第三方效果不会复制到收集目录。
- 少数专有媒体格式或目录型素材可能已复制但无法由 `py-aep` 自动重链接，manifest 会保留警告。
- 输出 AEP 必须经过真实 AE 打开验证后才能正式入库。
- 预览生成需要本机安装且已授权 After Effects；默认后台渲染超时为 180 秒。预览失败不删除已成功的收集 ZIP，但 Eagle 会等待补齐 PNG。
- `saveFrameToPng` 快速快照仅用于交互选帧；最终 PNG 不直接复用该快照，而是使用高质量 `aerender` 结果。直接 PNG 模板不存在时会多执行一次快速失败尝试，随后回退 TIFF 中转。
