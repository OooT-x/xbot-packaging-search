const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const htmlPath = path.join(__dirname, "..", "eagle-plugin", "index.html");
const pluginJsPath = path.join(__dirname, "..", "eagle-plugin", "js", "plugin.js");

test("keeps the import and legacy workspace inside the app shell", () => {
  const html = fs.readFileSync(htmlPath, "utf8");

  assert.doesNotMatch(
    html,
    /<\/div>\s*<\/div><details class="log-drawer"[^>]*>\s*<summary>运行记录<\/summary><div id="log">/
  );
  assert.match(
    html,
    /<details class="log-drawer"><summary>运行记录<\/summary><div id="log">[\s\S]*?<\/details>\s*<\/section>\s*<section class="workspace-view" id="view-formal" hidden>/
  );
  assert.match(html, /<section class="workspace-view active" id="view-import">/);
  assert.match(html, /<section class="workspace-view" id="view-history" hidden>/);
  assert.match(html, /<section class="workspace-view" id="view-diagnostics" hidden>/);
  assert.match(html, /id="dropZone"/);
  assert.doesNotMatch(html, /class="top-context"/);
  assert.doesNotMatch(html, /选择一个项目包装文件夹后，插件会把 PNG 预览和 ZIP 打包文件按规则自动匹配/);
});

test("production import view exposes preview-first pairing and direct naming", () => {
  const html = fs.readFileSync(htmlPath, "utf8");
  const pluginJs = fs.readFileSync(pluginJsPath, "utf8");
  const manifest = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "..", "eagle-plugin", "manifest.json"),
      "utf8"
    )
  );

  assert.match(html, /class="workflow-steps"/);
  assert.match(html, /data-workflow-step="3"/);
  assert.match(html, /包装配对预检/);
  assert.match(html, /直接入库 Eagle/);
  assert.doesNotMatch(html, /写入 00_待入库/);
  assert.match(html, /id="assetModal"/);
  assert.match(html, /class="bottom-bar import-bottom"/);
  assert.match(html, /AE → Eagle 工作台 · v1\.6\.1/);
  assert.match(html, /@keyframes view-in \{ from \{ opacity: 0; \} to \{ opacity: 1; \} \}/);
  assert.match(html, /body\[data-active-view="import"\] #view-import \{ padding-bottom: 104px; \}/);
  assert.match(html, /body\[data-active-view="import"\] #view-import \.import-bottom \{ position: fixed/);
  assert.match(html, /body\[data-theme="dark"\]\[data-active-view="import"\] #view-import \.import-bottom/);
  assert.match(pluginJs, /data-package-name=/);
  assert.match(pluginJs, /data-package-type=/);
  assert.match(pluginJs, /function packageTypeEditor\(pkg\)/);
  assert.match(pluginJs, /const explicitType = String\(pkg\.packageType \|\| ""\)\.trim\(\);/);
  assert.match(pluginJs, /function sortPackages\(packages\)/);
  assert.match(pluginJs, /const packages = sortPackages\(scan\.packages \|\| \[\]\)/);
  assert.match(pluginJs, /包装类型已更新/);
  assert.match(pluginJs, /缺少包装类型，请先选择/);
  assert.match(pluginJs, /KNOWN_PACKAGE_TYPES\.includes\(String\(pkg\.packageType \|\| \"\"\)\.trim\(\)\)/);
  assert.match(pluginJs, /openAssetModal/);
  assert.match(pluginJs, /data-asset-action="preview"/);
  assert.match(pluginJs, /data-asset-action="source"/);
  assert.match(pluginJs, /data-asset-preview-stage/);
  assert.match(pluginJs, /data-asset-preview-zoom="reset"/);
  assert.match(pluginJs, /function bindPreviewStageInteractions\(stage, view, readout\)/);
  assert.match(pluginJs, /bindPreviewStageInteractions\(stage, state\.assetPreview, readout\)/);
  assert.match(pluginJs, /state\.assetPreview\.previewPanX/);
  assert.match(pluginJs, /data-package-edit-kind="preview"/);
  assert.match(pluginJs, /data-package-edit-kind="source"/);
  assert.match(pluginJs, /const fileKind = kind === "preview" \? "png" : "zip"/);
  assert.match(pluginJs, /if \(file\.kind !== fileKind\) return false/);
  assert.match(pluginJs, /pendingPackageEdit/);
  assert.match(pluginJs, /function resolveDroppedDirectory\(dataTransfer\)/);
  assert.match(pluginJs, /function commonDirectory\(filePaths\)/);
  assert.match(pluginJs, /elements\.dropZone\.addEventListener\("drop"/);
  assert.match(pluginJs, /setSourceDirectory\(sourceDir\)/);
  assert.match(pluginJs, /已即时显示/);
  assert.match(pluginJs, /data-package-edit-action="apply"/);
  assert.match(pluginJs, /<strong>预览图<\/strong>/);
  assert.match(pluginJs, /打包文件/);
  assert.match(html, /title="支持收集器输出的 PNG、ZIP、manifest/);
  assert.match(pluginJs, /title="点击预览图查看原图"/);
  assert.match(pluginJs, /点击打包文件查看 ZIP 信息/);
  assert.match(pluginJs, /title="\$\{escapeHtml\(reason\)\}"/);
  assert.doesNotMatch(pluginJs, /<span>点击查看原图<\/span>/);
  assert.doesNotMatch(pluginJs, /<span>点击查看文件信息<\/span>/);
  assert.match(pluginJs, /class="pair-targets"/);
  assert.match(pluginJs, /01_预览图 \/ .*packageType/);
  assert.match(pluginJs, /02_AE源文件 \/ .*packageType/);
  assert.match(html, /grid-template-columns: minmax\(500px, 1\.3fr\) minmax\(280px, \.7fr\)/);
  assert.match(pluginJs, /function applyPackageMatch\(packageId, panel, kind = "preview"\)/);
  assert.match(pluginJs, /function refreshScanDerivedState\(\)/);
  assert.match(pluginJs, /file\.status = pkg\.state === "ready" \? "to-import" : "conflict"/);
  assert.match(pluginJs, /importFormalBatch/);
  assert.match(pluginJs, /state\.importStage/);
  assert.equal(manifest.version, "1.6.1");
});

test("hosts the AEP collector inside the Eagle plugin and returns to pairing", () => {
  const html = fs.readFileSync(htmlPath, "utf8");
  const pluginJs = fs.readFileSync(pluginJsPath, "utf8");
  const header = html.match(/<header class="topbar">[\s\S]*?<\/header>/)?.[0] || "";

  assert.match(html, /<nav class="main-tabs"/);
  assert.match(html, /data-view="aep"[\s\S]*data-view="import"/);
  assert.match(html, /data-view="import"[^>]*><strong>入库工作台<\/strong>/);
  assert.match(html, /data-view="aep"[^>]*><strong>AEP 收集<\/strong>/);
  assert.match(html, /class="aep-import-shell"/);
  assert.match(html, /class="drop-card aep-drop-card"/);
  assert.match(html, /id="aepStatCompositions"/);
  assert.match(html, /id="aepStatCandidates"/);
  assert.match(html, /id="aepStatSelected"/);
  assert.match(html, /id="aepStatWarnings"/);
  assert.match(html, /body\[data-active-view="aep"\] #view-aep \.aep-bottom \{ position: fixed/);
  assert.doesNotMatch(html, /class="aep-note"/);
  assert.doesNotMatch(html, /<small>INSPECTOR<\/small>/);
  assert.doesNotMatch(header, /data-view="aep"/);
  assert.match(html, /id="view-aep"/);
  assert.match(html, /id="aepPicker"/);
  assert.match(html, /id="aepTree"/);
  assert.match(html, /id="aepCollectBtn"/);
  assert.match(html, /id="aepStopBtn"/);
  assert.match(html, /id="aepProgress"/);
  assert.match(html, /id="aepProgressBar"/);
  assert.match(html, /aria-label="AEP 收集进度"/);
  assert.match(html, /class="danger-btn" id="aepStopBtn"[^>]*>停止收集/);
  assert.match(html, /id="aepDeselectVisibleBtn"/);
  assert.match(html, /全选当前<\/button><button[^>]*id="aepDeselectVisibleBtn"[^>]*>取消选择/);
  assert.match(html, /收集并进入配对预检/);
  assert.match(html, /class="aep-toolbar-key root"/);
  assert.match(html, /ROOT[\s\S]*PRE[\s\S]*共享引用也可分别勾选[\s\S]*按合成 ID 去重/);
  assert.match(html, /var\(--aep-indent\)/);
  assert.match(html, /id="aepPreviewModal"/);
  assert.match(html, /id="aepPreviewStage"/);
  assert.match(html, /data-aep-preview-zoom="reset"/);
  assert.match(html, /touch-action: none/);
  assert.match(pluginJs, /class="aep-tree-kind \$\{levelClass\}"/);
  assert.match(pluginJs, /aria-level="\$\{depthValue \+ 1\}"/);
  assert.match(pluginJs, /--aep-guide-left:/);
  assert.match(pluginJs, /require\("\.\.\/lib\/aep-worker\.js"\)/);
  assert.match(pluginJs, /function inspectAepProject\(\)/);
  assert.match(pluginJs, /function collectAepSelection\(options = \{\}\)/);
  assert.match(pluginJs, /function stopAepCollection\(\)/);
  assert.match(pluginJs, /function handleAepCollectionProgress\(progress\)/);
  assert.match(pluginJs, /onProgress: handleAepCollectionProgress/);
  assert.match(pluginJs, /data-aep-queue-id=/);
  assert.match(pluginJs, /aepProgressBar\.style\.width/);
  assert.match(pluginJs, /new AbortController\(\)/);
  assert.match(pluginJs, /signal: controller\.signal/);
  assert.match(pluginJs, /controller\.abort\(\)/);
  assert.match(pluginJs, /scanDirectory\(outputRoot, \{ projectName \}\)/);
  assert.match(pluginJs, /setView\("import"\)/);
  assert.match(pluginJs, /const allowed = \["import", "aep", "formal", "history", "diagnostics", "managed"\]/);
  assert.match(pluginJs, /function resolveDroppedDirectory\(dataTransfer\)/);
  assert.match(pluginJs, /function normalizeDroppedPath\(value\)/);
  assert.match(pluginJs, /function droppedPathCandidates\(dataTransfer\)/);
  assert.match(pluginJs, /elements\.dropZone\.addEventListener\("drop"/);
  assert.match(pluginJs, /state\.dragDepth \+= 1/);
  assert.match(pluginJs, /松开鼠标后自动读取文件夹并开始扫描/);
  assert.match(pluginJs, /aepStatCompositions/);
  assert.match(pluginJs, /aepDeselectVisibleBtn\.disabled/);
  assert.match(pluginJs, /aepVisibleOccurrences\(\)\.forEach\(\(item\) => aepToggleOccurrence\(item\.compId, item\.occurrenceKey, false\)\)/);
  assert.match(pluginJs, /checkedOccurrences: new Map\(\)/);
  assert.match(pluginJs, /data-aep-occurrence=/);
  assert.match(pluginJs, /function aepSelectionSnapshot\(\)/);
  assert.match(pluginJs, /function openAepDuplicateSelectionModal\(selection\)/);
  assert.match(pluginJs, /confirmDuplicates/);
  assert.match(pluginJs, /const children = expanded\s+\?/);
  assert.doesNotMatch(pluginJs, /\$\{isReference \? "disabled" : ""\}/);
  assert.match(html, /id="aepDuplicateModal"/);
  assert.match(html, /data-aep-duplicate-action="continue"/);
  assert.match(pluginJs, /function scanSelectedDirectory\(\)/);
  assert.match(pluginJs, /elements\.scanBtn\.addEventListener\("click", scanSelectedDirectory\)/);
  assert.match(pluginJs, /function setAepPreviewZoom\(value, anchor = null\)/);
  assert.match(pluginJs, /function openAepPreviewModal\(\)/);
  assert.match(pluginJs, /data-aep-action="open-preview"/);
  assert.match(pluginJs, /addEventListener\("pointerdown"/);
  assert.match(pluginJs, /addEventListener\("pointermove"/);
  assert.match(pluginJs, /setPointerCapture\(event\.pointerId\)/);
  assert.match(pluginJs, /event\.stopPropagation\(\)/);
  assert.equal((pluginJs.match(/dropZone: document\.getElementById\("dropZone"\)/g) || []).length, 1);
});

test("exposes the formal packaging maintenance workspace", () => {
  const html = fs.readFileSync(htmlPath, "utf8");
  const pluginJs = fs.readFileSync(pluginJsPath, "utf8");
  assert.match(html, /data-view="managed"[^>]*><strong>已入库管理<\/strong>/);
  assert.match(html, /id="view-managed" hidden/);
  assert.match(html, /id="managedRows"/);
  assert.match(html, /id="managedPreviewPicker"/);
  assert.match(html, /id="managedSourcePicker"/);
  assert.match(html, /03_历史版本/);
  assert.match(pluginJs, /function refreshManagedPackages\(\)/);
  assert.match(pluginJs, /replaceFormalAsset/);
  assert.match(pluginJs, /state\.managedDraft/);
  assert.match(pluginJs, /basePackageId: pkg\.packageId/);
  assert.match(pluginJs, /if \(pkg\) elements\.projectName\.value = pkg\.projectName/);
  assert.match(pluginJs, /确认后会创建独立的 v01 包装记录/);
  assert.match(html, /id="managedPreviewModal"/);
  assert.match(html, /id="managedPreviewStage"/);
  assert.match(html, /data-managed-preview-zoom="reset"/);
  assert.match(pluginJs, /data-managed-preview=/);
  assert.match(pluginJs, /function openManagedPreviewModal\(packageId\)/);
  assert.match(pluginJs, /state\.managedPreview/);
  assert.match(pluginJs, /bindPreviewStageInteractions\(elements\.managedPreviewStage, state\.managedPreview, elements\.managedPreviewZoom\)/);
});

test("ships an interactive preview-first PNG and ZIP pairing prototype", () => {
  const previewPath = path.join(
    __dirname,
    "..",
    "ui-preview",
    "xbot-eagle-import-pairing.html"
  );
  const html = fs.readFileSync(previewPath, "utf8");

  assert.match(html, /确认 PNG 与 ZIP 的对应关系/);
  assert.doesNotMatch(html, /<nav class="workspace-tabs"/);
  assert.match(html, /预览图/);
  assert.match(html, /打包文件/);
  assert.match(html, /class="pair-name-input/);
  assert.match(html, /data-role="name"/);
  assert.match(html, /更换配对/);
  assert.match(html, /data-role="preview"/);
  assert.match(html, /data-role="source"/);
  assert.match(html, /id="importButton"/);
  assert.match(html, /还有 \$\{unresolved\} 组待处理/);
});
