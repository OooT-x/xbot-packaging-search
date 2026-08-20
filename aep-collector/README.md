# X.bot AEP 收集工具

这是替代原 AE ScriptUI 面板方向的 Windows 外部收集工具原型。它参考 BHY Collect Pro 的离线工作方式，但不修改、不复制也不重新分发 BHY 的闭源 EXE；AEP 读取与写入使用 MIT 许可的公开项目 `py-aep`。

## 当前能力

- 不启动 After Effects，直接打开 `.aep`。
- 显示工程内全部合成，而不是只显示外部素材。
- 对每个合成显示尺寸、时长、帧率、父级使用关系和内部预合成。
- 支持多选合成；每个合成生成独立的收集目录和同名 ZIP。
- 递归保留选中合成的嵌套合成和直接图层素材。
- 复制素材并把收集工程重链接到新素材目录。
- 输出新的 `.aep`、`素材/` 和 `manifest.json`，并自动压缩成可交给 Eagle 的 ZIP；不覆盖原工程。
- ZIP 使用独立顶层文件夹封装，生成后自动执行 CRC、自检 AEP 和 manifest 完整性校验。
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
- 当前不会渲染合成预览图；预览渲染仍需要 After Effects 或 `aerender`。

## 当前限制

- 跨合成表达式可能引用没有作为图层嵌套的其他合成；第一版不能保证自动发现所有此类引用。
- 字体和第三方效果不会复制到收集目录。
- 少数专有媒体格式或目录型素材可能已复制但无法由 `py-aep` 自动重链接，manifest 会保留警告。
- 输出 AEP 必须经过真实 AE 打开验证后才能正式入库。
