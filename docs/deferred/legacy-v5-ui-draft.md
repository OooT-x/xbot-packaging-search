# 旧控制器 v5 UI 重构草稿归档

归档日期：2026-10-09。

- 保存分支：`codex/archive-legacy-v5-draft`；保存提交：`3587e0f`。
- 完整保存原有 `eagle-plugin/js/plugin.js` 改动、`css/v5-workspace.css` 与 `js/v5-workspace.js`。
- 正式 `index.html` 加载 `workbench.js` 和 `v5-runtime.js`，未加载这组旧控制器适配文件。
- 草稿依赖旧 DOM 的 sheet、筛选与类型迁移节点，目前仅通过 JS 语法检查，未完成页面接入及真实交互验收。
- 正式 1.8.7 从已验证生产源码分支生成，排除草稿；草稿仍可从上述分支完整恢复。
- 后续继续此方向时，先对照正式页面明确迁移目标，再完成 DOM、服务、交互与回归验收。
