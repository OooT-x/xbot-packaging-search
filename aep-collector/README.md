# X.bot AEP 收集工具

这是替代原 AE ScriptUI 面板方向的 Windows 外部收集工具原型。它参考 BHY Collect Pro 的离线工作方式，但不修改、不复制也不重新分发 BHY 的闭源 EXE；AEP 读取与写入使用 MIT 许可的公开项目 `py-aep`。

## 当前能力

- 不启动 After Effects，直接打开 `.aep`。
- 显示工程内全部合成，而不是只显示外部素材。
- 对每个合成显示尺寸、时长、帧率、父级使用关系和内部预合成。
- 每个合成默认选择第 2 秒代表帧；短于 2 秒时自动取最后一个有效帧。
- 单选合成后可打开预览窗口，通过时间轴、秒数输入或前后逐帧调整，透明画面用棋盘格显示。
- 支持多选合成；每个合成生成独立的收集目录和同名 ZIP。
- 递归保留选中合成的嵌套合成和直接图层素材。
- 复制素材并把收集工程重链接到新素材目录。
- 输出新的 `.aep`、`素材/` 和 `manifest.json`，并自动压缩成可交给 Eagle 的 ZIP；不覆盖原工程。
- ZIP 使用独立顶层文件夹封装，生成后自动执行 CRC、自检 AEP 和 manifest 完整性校验。
- manifest 标记为 `xbot-collection` 收集记录，供 Eagle 插件读取合成名、对应 ZIP 和依赖状态，不冒充已经补齐 PNG、类型和版本的正式入库清单。
- 收集时通过本机 `aerender` 后台渲染已确认或默认帧，输出与 ZIP 同名的 PNG，并将 `preview_file`、时间和 AE 帧号写回 manifest 及 ZIP 内的 manifest。
- 缺失素材写入 manifest，并标记为“阻止入库”。

## 运行

在 PowerShell 中执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\aep-collector\run.ps1
```

首次运行会在 `aep-collector/.venv` 安装固定版本依赖。

## 命令行验证

```powershell
& .\aep-collector\.venv\Scripts\python.exe -m xbot_aep_collector.cli inspect "E:\项目\example.aep"
```

需要先把当前目录切换到 `aep-collector`，或者将该目录加入 `PYTHONPATH`。

## 构建 EXE

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\aep-collector\build.ps1
```

产物位于 `aep-collector/dist/XbotAepCollector.exe`。构建产物不提交 Git。

## 安全边界

- 永远从原 AEP 重新解析，在新目录中保存收集结果。
- 不删除、重命名、覆盖原 AEP 或原素材。
- 压缩失败或交付文件缺失时不保留半成品 ZIP，也不会把该次收集报告为成功。
- 不把工程、素材或预览上传到外部服务。
- 收集结果仍需在 After Effects 中打开，核对表达式、字体、第三方效果、序列素材和最终画面。
- 离线查看和收集不启动 AE；只有生成真实预览画面时才会在后台启动 `aerender`，不打开 AE 主界面。

## 当前限制

- 跨合成表达式可能引用没有作为图层嵌套的其他合成；第一版不能保证自动发现所有此类引用。
- 字体和第三方效果不会复制到收集目录。
- 少数专有媒体格式或目录型素材可能已复制但无法由 `py-aep` 自动重链接，manifest 会保留警告。
- 输出 AEP 必须经过真实 AE 打开验证后才能正式入库。
- 预览生成需要本机安装且已授权 After Effects；默认后台渲染超时为 180 秒。预览失败不删除已成功的收集 ZIP，但 Eagle 会等待补齐 PNG。
