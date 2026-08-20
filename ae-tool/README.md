# X.bot AE 包装整理

这是 X.bot 包装素材链路的 AE 上游辅助面板。它把制作人员明确选择的包装合成整理为 Eagle 入库助手可识别的 PNG、ZIP 和 `manifest.json`，同时保留 AE 原生 Collect Files 生成的工程副本、依赖与 Report。

## 当前第一版能力

- 从 Project（项目）面板读取一个或多个用户选择的合成。
- 逐条填写项目、包装名称、包装类型、版本、预览时间和透明通道要求。
- 递归扫描嵌套合成中的缺失素材、字体、效果、疑似第三方效果和跨合成表达式引用。
- 用 `CompItem.saveFrameToPng` 生成代表帧 PNG，并输出 Eagle 入库助手可读的标准 manifest。
- 为当前包装选中唯一目标合成，并打开 AE 原生 Collect Files（收集文件）流程。
- 在 Windows 上把用户确认的收集目录压缩为规范 ZIP，并刷新 manifest。
- 在交给 Eagle 前检查 PNG、ZIP、manifest 和阻止入库风险。

## 安装

1. 关闭 After Effects。
2. 用管理员 PowerShell 在本目录执行：

   ```powershell
   .\install.ps1
   ```

3. 重启 AE，从 Window（窗口）菜单打开 `XbotPackagingOrganizer`。
4. 如果面板无法写文件，在 Preferences > Scripting & Expressions（首选项 > 脚本和表达式）中启用脚本写文件权限。

本机已探测到 `C:\Program Files\Adobe\Adobe After Effects 2025`；也可以显式传入：

```powershell
.\install.ps1 -AfterEffectsRoot 'C:\Program Files\Adobe\Adobe After Effects 2025'
```

## 使用流程

1. 先保存原工程，不在原工程上执行精简或重命名。
2. 在 Project 面板选中用户明确确认可复用的包装合成。
3. 在面板中读取合成，补齐每条元数据，选择一个代表性的预览时间。
4. 执行风险扫描。缺失素材、跨合成表达式或扫描失败会标记为“阻止入库”；字体和疑似第三方效果标记为“警告”。
5. 选择交付目录，生成 PNG 和 manifest。ZIP 尚未生成时，manifest 会引用预期 ZIP 文件名，Eagle 会安全地阻止不完整记录。
6. 逐条选择包装，打开 Collect Files，选择 For Selected Comps（选中的合成），保留 Report。第一版默认不要启用 Reduce Project。
7. 回到面板，为当前包装选择刚生成的收集目录并压缩。
8. 全部包装完成后执行“检查交付”，再把整个交付目录交给 Eagle 入库助手。

## 安全边界

- 面板不会执行 `Reduce Project`，也不会删除、覆盖或重命名原工程中的项目项。
- Collect Files 仍由 AE 原生对话框完成；用户能看到目标合成、收集范围和输出位置。
- 表达式扫描是保守的静态检查，只能识别常见的 `comp("名称")` 和 `thisProject.item(...)` 引用。标记为完整也不能替代在收集副本中打开工程、检查字体/插件并预览动画。
- `saveFrameToPng` 生成后，透明叠加元素仍需在 Eagle 入库前肉眼确认 alpha。
- ZIP 中依赖是否必要由本上游流程负责；Eagle 只校验 ZIP 可读和唯一配对。
