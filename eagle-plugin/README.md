# X.bot 包装素材收集与入库助手

这是 Eagle 窗口插件入口。它把 AEP 结构读取、合成选择、PNG/ZIP/manifest 收集、配对预检和 Eagle 正式入库串成一条流程。

## 本地构建

在仓库根目录执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\aep-collector\build.ps1
```

构建脚本会生成 `aep-collector/dist/XbotAepWorker.exe`，并复制一份到本插件的 `workers/XbotAepWorker.exe`。分发插件时必须保留 `workers` 目录；该二进制是构建产物，不提交 Git。便携部署也可以用环境变量 `XBOT_AEP_WORKER` 指定 Worker 的绝对路径。

## 使用

在 Eagle 开发者插件窗口中打开本目录，点击顶部“AEP 收集”：

1. 选择 AEP，读取合成结构。
2. 在结构树中通过 `ROOT` / `PRE` / `LINK` 标识、缩进和连接线查看根合成、直属预合成与共享引用，必要时生成单合成预览。
3. 每个层级位置都可以勾选独立交付对象；同一共享合成从多个层级被勾选时，收集前会提示并按合成 ID 自动去重。
4. 指定新输出目录，开始收集。
5. 收集完成后自动进入 PNG + ZIP 配对预检；确认项目、包装名称和重复策略后，才通过 Eagle 官方 Plugin API 写入正式目录。只有 PNG 的背景会显示为“仅图片背景”，只写入预览图，不创建源文件记录。
6. 点击顶部“已入库管理”可按项目查看正式包装。更新预览图或 ZIP 会先写入新 item，再切换配对并将旧素材保留到 `03_历史版本/<类型>`；“发布新版本”会把新文件夹按递增版本和 `base_package_id` 录入，“添加新包装”沿用入库工作台的配对校验。

正式包装维护遵循“修订”和“版本”分离：只换预览图或重新打包时保留 `package_id`/版本并生成 `revision_id`；动画、版式或内容变化时建立新 `package_id` 和版本链。当前首批可选包装类型包括信息条、视频框、背景、分镜排版、分Part板、报道和时间轴。

原始 AEP 不会被修改。生成预览仍需要本机已安装且已授权的 After Effects，收集 ZIP 即使预览失败也会保留，但配对预检会阻止缺少 PNG 的记录进入 Eagle。

历史 AE 原生 Collect Files 文件夹中的 Report 会在配对预检时读取正文。扫描器兼容 UTF-8、UTF-16LE/BE 和 GB18030 文本，识别项目、合成、收集文件、缺失素材、字体、效果/插件和备注章节；Report 及其依赖文件只用于校验，不会单独导入 Eagle。字体或效果/插件进入依赖警告，Report 检出的缺失素材会阻止该包装入库。
