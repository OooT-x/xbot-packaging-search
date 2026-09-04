/* global eagle */
const fs = require("fs");
const path = require("path");
const {
  collectAep,
  inspectAep,
  previewAep,
  resolveWorkerPath,
} = require("../lib/aep-worker.js");
const { scanDirectory } = require("../lib/scan.js");
const {
  EaglePluginAdapter,
  fileBatch,
  folderId,
  importFormalBatch,
  IMPORT_MODES,
  inspectBatch,
  parseAnnotation,
  planFormalFile,
  INGEST_ROOT_NAME,
  KNOWN_PACKAGE_TYPES,
} = require("../lib/eagle-api.js");
const { publishIngestEvent } = require("../lib/ingest-bridge.js");

const state = {
  activeView: "import",
  importStage: 1,
  sourceDir: null,
  scan: null,
  batchFolders: [],
  filePlan: null,
  fileInspection: null,
  fileOverrides: {},
  nameOverrides: {},
  selectedPair: null,
  planFilter: "all",
  pendingImport: null,
  pendingPackageEdit: null,
  editingPackageId: null,
  editingPackageKind: null,
  selectedPackageId: null,
  scanFileBaseline: null,
  scanPackageBaseline: null,
  assetPreview: {
    previewZoom: 1,
    previewPanX: 0,
    previewPanY: 0,
    previewDrag: null,
  },
  dragDepth: 0,
  aep: {
    aepPath: null,
    project: null,
    checkedIds: new Set(),
    expandedIds: new Set(),
    activeCompId: null,
    filter: "all",
    search: "",
    previewFiles: {},
    previewTimes: {},
    previewZoom: 1,
    previewPanX: 0,
    previewPanY: 0,
    previewDrag: null,
    previewBusy: false,
    collecting: false,
  },
};

const elements = {
  apiState: document.getElementById("apiState"),
  apiDot: document.getElementById("apiDot"),
  diagApi: document.getElementById("diagApi"),
  dropZone: document.getElementById("dropZone"),
  dropLabel: document.getElementById("dropLabel"),
  folderPicker: document.getElementById("folderPicker"),
  projectName: document.getElementById("projectName"),
  scanBtn: document.getElementById("scanBtn"),
  importBtn: document.getElementById("importBtn"),
  importMode: document.getElementById("importMode"),
  batchInfo: document.getElementById("batchInfo"),
  statToImport: document.getElementById("statToImport"),
  statValidate: document.getElementById("statValidate"),
  statIgnore: document.getElementById("statIgnore"),
  statConflict: document.getElementById("statConflict"),
  packageRows: document.getElementById("packageRows"),
  fileRows: document.getElementById("fileRows"),
  batchSelect: document.getElementById("batchSelect"),
  reloadBatchBtn: document.getElementById("reloadBatchBtn"),
  fileBtn: document.getElementById("fileBtn"),
  confirmFileBtn: document.getElementById("confirmFileBtn"),
  renameBtn: document.getElementById("renameBtn"),
  fileInfo: document.getElementById("fileInfo"),
  statFileReady: document.getElementById("statFileReady"),
  statFileBlocked: document.getElementById("statFileBlocked"),
  statFileAlready: document.getElementById("statFileAlready"),
  statFileRemaining: document.getElementById("statFileRemaining"),
  filePlanRows: document.getElementById("filePlanRows"),
  packageInspector: document.getElementById("packageInspector"),
  formalState: document.getElementById("formalState"),
  formalBottomCopy: document.getElementById("formalBottomCopy"),
  formalCount: document.getElementById("formalCount"),
  batchCount: document.getElementById("batchCount"),
  filterAllCount: document.getElementById("filterAllCount"),
  filterReadyCount: document.getElementById("filterReadyCount"),
  filterReviewCount: document.getElementById("filterReviewCount"),
  filterBlockedCount: document.getElementById("filterBlockedCount"),
  log: document.getElementById("log"),
  logFormal: document.getElementById("logFormal"),
  duplicateModal: document.getElementById("duplicateModal"),
  assetModal: document.getElementById("assetModal"),
  assetTitle: document.getElementById("assetTitle"),
  assetSub: document.getElementById("assetSub"),
  assetBody: document.getElementById("assetBody"),
  duplicateSub: document.getElementById("duplicateSub"),
  renameModal: document.getElementById("renameModal"),
  previewTemplate: document.getElementById("previewTemplate"),
  sourceTemplate: document.getElementById("sourceTemplate"),
  renameRows: document.getElementById("renameRows"),
  renameSummary: document.getElementById("renameSummary"),
  renameError: document.getElementById("renameError"),
  toast: document.getElementById("toast"),
  toastTitle: document.getElementById("toastTitle"),
  toastMessage: document.getElementById("toastMessage"),
  aepPicker: document.getElementById("aepPicker"),
  aepFileLabel: document.getElementById("aepFileLabel"),
  aepOutput: document.getElementById("aepOutput"),
  aepInspectBtn: document.getElementById("aepInspectBtn"),
  aepDefaultOutputBtn: document.getElementById("aepDefaultOutputBtn"),
  aepSearch: document.getElementById("aepSearch"),
  aepFilters: document.getElementById("aepFilters"),
  aepTree: document.getElementById("aepTree"),
  aepTreeSummary: document.getElementById("aepTreeSummary"),
  aepStatCompositions: document.getElementById("aepStatCompositions"),
  aepStatCandidates: document.getElementById("aepStatCandidates"),
  aepStatSelected: document.getElementById("aepStatSelected"),
  aepStatWarnings: document.getElementById("aepStatWarnings"),
  aepInspector: document.getElementById("aepInspector"),
  aepPreviewModal: document.getElementById("aepPreviewModal"),
  aepPreviewTitle: document.getElementById("aepPreviewTitle"),
  aepPreviewSub: document.getElementById("aepPreviewSub"),
  aepPreviewStage: document.getElementById("aepPreviewStage"),
  aepPreviewImage: document.getElementById("aepPreviewImage"),
  aepPreviewZoom: document.getElementById("aepPreviewZoom"),
  aepWorkerState: document.getElementById("aepWorkerState"),
  aepExpandBtn: document.getElementById("aepExpandBtn"),
  aepCollapseBtn: document.getElementById("aepCollapseBtn"),
  aepSelectVisibleBtn: document.getElementById("aepSelectVisibleBtn"),
  aepSelectionSummary: document.getElementById("aepSelectionSummary"),
  aepCollectionSummary: document.getElementById("aepCollectionSummary"),
  aepClearBtn: document.getElementById("aepClearBtn"),
  aepCollectBtn: document.getElementById("aepCollectBtn"),
  aepLog: document.getElementById("aepLog"),
};

let toastTimer = null;
let renameFocus = "preview";

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fileUrl(filePath) {
  const value = String(filePath || "");
  if (!value) return "";
  const normalized = value.replace(/\\/g, "/");
  return encodeURI(normalized.startsWith("/") ? `file://${normalized}` : `file:///${normalized}`);
}

function log(message) {
  const target = state.activeView === "aep"
    ? elements.aepLog
    : state.activeView === "import" ? elements.log : elements.logFormal;
  if (!target) return;
  const time = new Date().toLocaleTimeString();
  target.textContent = `${target.textContent}\n[${time}] ${message}`.trim();
  target.scrollTop = target.scrollHeight;
}

function showToast(title, message, kind = "normal") {
  elements.toastTitle.textContent = title;
  elements.toastMessage.textContent = message;
  elements.toast.style.borderColor = kind === "error" ? "var(--red)" : "var(--line)";
  elements.toast.style.display = "block";
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { elements.toast.style.display = "none"; }, 3000);
}

function openModal(element) { element.classList.add("open"); }
function closeModals() {
  document.querySelectorAll(".modal-backdrop").forEach((modal) => modal.classList.remove("open"));
  state.aep.previewDrag = null;
  state.assetPreview.previewDrag = null;
  elements.aepPreviewStage?.classList.remove("is-dragging");
  elements.assetBody?.querySelector("[data-asset-preview-stage]")?.classList.remove("is-dragging");
}

function statusClass(status) {
  if (status === "ready" || status === "to-import") return "status-ready";
  if (status === "review" || status === "validate-only" || status === "conflict") return "status-review";
  if (status === "blocked") return "status-blocked";
  return "status-muted";
}

function statusLabel(status) {
  return {
    ready: "可入库",
    "to-import": "将导入",
    review: "待补充",
    blocked: "阻止",
    conflict: "冲突",
    "validate-only": "仅校验",
    ignore: "忽略",
    already: "已入库",
  }[status] || status || "待处理";
}

function badge(status) {
  return `<span class="status-badge ${statusClass(status)}">${escapeHtml(statusLabel(status))}</span>`;
}

function packageTone(pkg) {
  const explicitType = String(pkg.packageType || "").trim();
  const text = explicitType || String(pkg.packageName || "");
  if (/视频/.test(text)) return "thumb-blue";
  if (/信息|人名|标注/.test(text)) return "thumb-amber";
  if (/背景/.test(text)) return "thumb-green";
  return "thumb-ink";
}

function pairCardTone(pkg) {
  return packageTone(pkg).replace("thumb-", "pair-tone-");
}

const PACKAGE_TYPE_ORDER = new Map(KNOWN_PACKAGE_TYPES.map((type, index) => [type, index]));

function packageTypeRank(pkg) {
  const type = String(pkg.packageType || "").trim();
  return PACKAGE_TYPE_ORDER.get(type) ?? KNOWN_PACKAGE_TYPES.length;
}

function sortPackages(packages) {
  return packages
    .map((pkg, index) => ({ pkg, index }))
    .sort((left, right) => packageTypeRank(left.pkg) - packageTypeRank(right.pkg) || left.index - right.index)
    .map(({ pkg }) => pkg);
}

function scanFileAt(scan, filePath) {
  if (!scan || !filePath) return null;
  const target = path.resolve(filePath);
  return (scan.files || []).find((file) => file.path && path.resolve(file.path) === target) || null;
}

function packagePath(pkg, kind) {
  return kind === "preview" ? pkg.preview?.path || "" : pkg.source?.path || "";
}

function displayPackagePath(pkg, kind) {
  const pending = state.pendingPackageEdit;
  if (
    pending &&
    String(pending.packageId) === String(pkg.packageId) &&
    pending.kind === kind
  ) {
    return pending.path || "";
  }
  return packagePath(pkg, kind);
}

function hasPendingPackageEdit(pkg) {
  return Boolean(
    state.pendingPackageEdit &&
    String(state.pendingPackageEdit.packageId) === String(pkg.packageId)
  );
}

function packageFileName(file) {
  if (!file) return "未选择";
  return file.relative || file.name || path.basename(file.path || "");
}

function packageTypeOptions(pkg) {
  const currentType = String(pkg.packageType || "").trim();
  const options = [`<option value=""${currentType ? "" : " selected"}>待补充类型</option>`];
  if (currentType && !KNOWN_PACKAGE_TYPES.includes(currentType)) {
    options.push(`<option value="${escapeHtml(currentType)}" selected>${escapeHtml(currentType)}（未知）</option>`);
  }
  KNOWN_PACKAGE_TYPES.forEach((type) => {
    options.push(`<option value="${escapeHtml(type)}"${type === currentType ? " selected" : ""}>${escapeHtml(type)}</option>`);
  });
  return options.join("");
}

function packageTypeEditor(pkg) {
  const currentType = String(pkg.packageType || "").trim();
  const isMissing = !KNOWN_PACKAGE_TYPES.includes(currentType);
  return `<label class="package-type-control"><span class="sr-only">包装类型</span><select class="package-type-select${isMissing ? " is-missing" : ""}" data-package-type="${escapeHtml(pkg.packageId || "")}" aria-label="修改包装类型">${packageTypeOptions(pkg)}</select></label>`;
}

function assetLabel(kind) {
  return kind === "preview" ? "预览图 PNG" : "打包文件 ZIP";
}

function fileStat(filePath) {
  if (!filePath) return null;
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function formatBytes(value) {
  const size = Number(value);
  if (!Number.isFinite(size) || size < 0) return "无法读取";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  return `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatDate(value) {
  if (!value) return "无法读取";
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(value);
  } catch {
    return String(value);
  }
}

function assetDetailRow(label, value, mono = false) {
  return `<div class="asset-detail-row"><span>${escapeHtml(label)}</span><strong class="${mono ? "mono" : ""}" title="${escapeHtml(value || "")}">${escapeHtml(value || "-" )}</strong></div>`;
}

function relativeScanPath(filePath) {
  if (!filePath) return "未记录";
  if (!state.scan?.sourceDir) return filePath;
  return path.relative(state.scan.sourceDir, filePath) || path.basename(filePath);
}

function openAssetModal(kind, packageId) {
  const pkg = packageById(packageId);
  if (!pkg || !state.scan || !elements.assetModal) return;
  const assetPath = displayPackagePath(pkg, kind);
  const file = scanFileAt(state.scan, assetPath) || pkg[kind];
  const stat = fileStat(assetPath);
  const label = assetLabel(kind);
  const fileName = packageFileName(file);
  const status = file?.status || pkg.state;
  const details = [
    assetDetailRow("文件名", fileName, true),
    assetDetailRow("相对路径", file?.relative || relativeScanPath(assetPath), true),
    assetDetailRow("文件大小", stat ? formatBytes(stat.size) : "无法读取"),
    assetDetailRow("修改时间", stat ? formatDate(stat.mtime) : "无法读取"),
    assetDetailRow("导入状态", statusLabel(status)),
    assetDetailRow("package_id", pkg.packageId, true),
    assetDetailRow("包装类型", pkg.packageType || "待补充"),
    assetDetailRow("版本", pkg.version || "v01"),
  ];
  if (kind === "source") {
    details.push(assetDetailRow("依赖状态", pkg.dependencyStatus === "blocked" ? "存在缺失素材，阻止入库" : pkg.dependencyStatus === "warning" ? "依赖存在警告" : "依赖完整"));
    details.push(assetDetailRow("manifest", relativeScanPath(pkg.manifestPath), true));
    details.push(assetDetailRow("AE Report", pkg.reportFiles?.join("、") || (pkg.reportStatus === "absent" ? "未提供" : "未能读取"), true));
    if (pkg.fonts?.length) details.push(assetDetailRow("Report 字体", pkg.fonts.join("、")));
    if (pkg.effects?.length) details.push(assetDetailRow("Report 效果/插件", pkg.effects.join("、")));
    if (pkg.missingFootage?.length) details.push(assetDetailRow("Report 缺失素材", pkg.missingFootage.join("、")));
  }
  elements.assetTitle.textContent = kind === "preview" ? "预览图原图" : "打包文件信息";
  elements.assetSub.textContent = `${pkg.projectName || "未命名项目"} · ${pkg.packageName || "未命名包装"} · ${label}`;
  const assetVisual = kind === "preview"
    ? assetPath
      ? `<div class="asset-preview-toolbar"><span class="aep-preview-toolbar-copy">滚轮缩放 · 左键拖拽平移</span><div class="aep-preview-zoom-actions"><button class="quiet-btn" type="button" data-asset-preview-zoom="out" aria-label="缩小预览图">−</button><span class="aep-preview-zoom-readout" data-asset-preview-zoom-readout>100%</span><button class="quiet-btn" type="button" data-asset-preview-zoom="reset">适应</button><button class="quiet-btn" type="button" data-asset-preview-zoom="in" aria-label="放大预览图">＋</button></div></div><div class="asset-preview-stage preview-interaction-stage" data-asset-preview-stage tabindex="0" aria-label="预览图原图，可用鼠标滚轮缩放"><img src="${escapeHtml(fileUrl(assetPath))}" alt="${escapeHtml(pkg.packageName || "包装预览")}" /></div>`
      : `<div class="asset-preview-stage asset-empty-state"><span>尚未配对 PNG</span></div>`
    : `<div class="asset-file-stage"><div class="zip-mark">ZIP</div><strong>ZIP 打包文件</strong><span>插件只读取文件信息，不会在这里解压或修改源包。</span></div>`;
  elements.assetBody.innerHTML = `<div class="asset-content"><div>${assetVisual}<div class="asset-path" title="${escapeHtml(assetPath || "")}">${escapeHtml(assetPath || "尚未选择文件")}</div></div><div class="asset-info-panel"><div class="asset-info-heading"><span>文件与配对事实</span><strong>${escapeHtml(fileName)}</strong></div><div class="asset-detail-list">${details.join("")}</div></div></div>`;
  openModal(elements.assetModal);
  if (kind === "preview" && assetPath) {
    state.assetPreview.previewZoom = 1;
    state.assetPreview.previewPanX = 0;
    state.assetPreview.previewPanY = 0;
    state.assetPreview.previewDrag = null;
    const stage = elements.assetBody.querySelector("[data-asset-preview-stage]");
    const readout = elements.assetBody.querySelector("[data-asset-preview-zoom-readout]");
    bindPreviewStageInteractions(stage, state.assetPreview, readout);
  }
}

function packageCandidates(scan, kind, currentPath = "") {
  const allowed = new Set(["candidate", "to-import", "conflict"]);
  const fileKind = kind === "preview" ? "png" : "zip";
  const candidates = (scan?.files || []).filter((file) => {
    if (file.kind !== fileKind) return false;
    if (file.path && currentPath && path.resolve(file.path) === path.resolve(currentPath)) return true;
    return allowed.has(file.status);
  });
  return candidates.sort((left, right) => String(left.relative || left.name).localeCompare(String(right.relative || right.name), "zh-CN"));
}

function packageEditOptions(scan, kind, selectedPath) {
  const emptyLabel = kind === "preview" ? "选择预览图 PNG" : "选择打包文件 ZIP";
  const options = [`<option value="">${emptyLabel}</option>`];
  packageCandidates(scan, kind, selectedPath).forEach((file) => {
    const selected = file.path && selectedPath && path.resolve(file.path) === path.resolve(selectedPath) ? " selected" : "";
    options.push(`<option value="${escapeHtml(file.path)}"${selected}>${escapeHtml(packageFileName(file))}</option>`);
  });
  return options.join("");
}

function beginScanState(scan) {
  state.scanFileBaseline = new Map(
    (scan.files || []).map((file) => [file.path, { ...file }])
  );
  state.scanPackageBaseline = new Map(
    (scan.packages || []).map((pkg) => [String(pkg.packageId), {
      preview: pkg.preview ? { ...pkg.preview } : null,
      source: pkg.source ? { ...pkg.source } : null,
      state: pkg.state,
      errors: [...(pkg.errors || [])],
      warnings: [...(pkg.warnings || [])],
    }])
  );
  state.editingPackageId = null;
  state.editingPackageKind = null;
  state.pendingPackageEdit = null;
  state.selectedPackageId = scan.packages?.[0]?.packageId || null;
}

function isHardBlockedPackage(pkg) {
  const baseline = state.scanPackageBaseline?.get(String(pkg.packageId));
  return Boolean(
    baseline?.warnings?.some((warning) => /阻止入库/.test(warning)) ||
    baseline?.errors?.some((error) => /manifest.*阻止入库/i.test(error))
  );
}

function refreshScanDerivedState() {
  if (!state.scan) return;
  const owners = new Map();
  const duplicatePaths = new Set();
  for (const pkg of state.scan.packages || []) {
    for (const kind of ["preview", "source"]) {
      const currentPath = packagePath(pkg, kind);
      if (!currentPath) continue;
      const key = `${kind}:${path.resolve(currentPath)}`;
      if (owners.has(key)) duplicatePaths.add(key);
      owners.set(key, pkg.packageId);
    }
  }

  for (const pkg of state.scan.packages || []) {
    const baseline = state.scanPackageBaseline?.get(String(pkg.packageId));
    if (baseline) {
      pkg.manualMatch = ["preview", "source"].some((kind) => {
        const current = packagePath(pkg, kind);
        const original = packagePath(baseline, kind);
        return Boolean(current || original) && path.resolve(current || "") !== path.resolve(original || "");
      });
    }
    const pairErrors = [];
    const previewPath = packagePath(pkg, "preview");
    const sourcePath = packagePath(pkg, "source");
    if (!previewPath) pairErrors.push("缺少配对 PNG");
    if (!sourcePath) pairErrors.push("缺少配对 ZIP");
    if (!KNOWN_PACKAGE_TYPES.includes(String(pkg.packageType || "").trim())) {
      pairErrors.push(pkg.packageType ? `未知包装类型“${pkg.packageType}”，请选择包装类型` : "缺少包装类型，请先选择");
    }
    for (const kind of ["preview", "source"]) {
      const currentPath = packagePath(pkg, kind);
      if (currentPath && duplicatePaths.has(`${kind}:${path.resolve(currentPath)}`)) {
        pairErrors.push(`${kind === "preview" ? "PNG" : "ZIP"} 被多个包装记录选择`);
      }
    }
    if (isHardBlockedPackage(pkg)) pairErrors.push("manifest 标记为阻止入库");
    pkg.matchError = pairErrors[0] || "";
    pkg.state = pairErrors.length > 0 ? "blocked" : "ready";
    pkg.errors = pairErrors;
  }

  for (const file of state.scan.files || []) {
    const baseline = state.scanFileBaseline?.get(file.path);
    if (baseline) Object.assign(file, baseline);
  }
  for (const pkg of state.scan.packages || []) {
    for (const kind of ["preview", "source"]) {
      const currentPath = packagePath(pkg, kind);
      const file = scanFileAt(state.scan, currentPath);
      if (!file) continue;
      file.packageId = pkg.packageId;
      file.status = pkg.state === "ready" ? "to-import" : "conflict";
      file.note = pkg.state === "ready" ? "" : pkg.matchError || "需要处理配对关系";
    }
  }
  state.scan.stats = {
    toImport: (state.scan.files || []).filter((file) => file.status === "to-import").length,
    validateOnly: (state.scan.files || []).filter((file) => file.status === "validate-only").length,
    ignore: (state.scan.files || []).filter((file) => file.status === "ignore").length,
    conflict: (state.scan.files || []).filter((file) => file.status === "conflict").length,
  };
}

function pairStatusBadge(pkg) {
  const stateBadge = badge(pkg.state);
  if (hasPendingPackageEdit(pkg)) {
    return `${stateBadge}<span class="match-badge match-pending">待应用</span>`;
  }
  if (pkg.state === "blocked") return stateBadge;
  const label = pkg.manualMatch ? "已修改" : "自动匹配";
  const className = pkg.manualMatch ? "match-badge match-manual" : "match-badge match-auto";
  return `${stateBadge}<span class="${className}">${label}</span>`;
}

function packageCard(pkg) {
  const previewPath = displayPackagePath(pkg, "preview");
  const sourcePath = displayPackagePath(pkg, "source");
  const packageType = pkg.packageType || "待补充类型";
  const previewFile = scanFileAt(state.scan, previewPath) || pkg.preview;
  const sourceFile = scanFileAt(state.scan, sourcePath) || pkg.source;
  const editing = String(state.editingPackageId || "") === String(pkg.packageId || "");
  const editingKind = state.editingPackageKind || "preview";
  const previewImage = previewPath
    ? `<img src="${escapeHtml(fileUrl(previewPath))}" alt="${escapeHtml(pkg.packageName || "包装预览")}" onerror="this.style.display='none'" />`
    : `<span class="empty-asset">等待 PNG</span>`;
  const reportFacts = [
    pkg.reportFiles?.length ? `AE Report：${pkg.reportFiles.join("、")}` : "",
    pkg.fonts?.length ? `字体：${pkg.fonts.join("、")}` : "",
    pkg.effects?.length ? `效果/插件：${pkg.effects.join("、")}` : "",
    pkg.missingFootage?.length ? `缺失素材：${pkg.missingFootage.join("、")}` : "",
  ].filter(Boolean).join("\n");
  const reason = [hasPendingPackageEdit(pkg)
    ? `已预览新的${state.pendingPackageEdit.kind === "preview" ? " PNG" : " ZIP"}，点击应用后生效`
    : pkg.matchError || (pkg.manualMatch ? "用户已覆盖自动匹配" : "manifest / 文件名规则自动匹配"), reportFacts].filter(Boolean).join("\n");
  const reportBadge = pkg.reportStatus === "parsed" ? "REPORT ✓" : pkg.reportStatus === "absent" ? "REPORT —" : "REPORT !";
  const editPanel = editing
    ? `<div class="pair-edit-panel" data-package-edit-panel="${escapeHtml(pkg.packageId || "")}">
        <div class="pair-edit-copy"><strong>更换${editingKind === "preview" ? "预览图 PNG" : "打包文件 ZIP"}</strong><span>选择后卡片会立即预览新文件，点击应用后正式写入这组配对。</span></div>
        <div class="pair-edit-fields"><label>${assetLabel(editingKind)}<select data-package-edit-field="${editingKind}">${packageEditOptions(state.scan, editingKind, editingKind === "preview" ? previewPath : sourcePath)}</select></label><div class="pair-edit-current"><span>另一侧保持当前文件</span><strong>${escapeHtml(packageFileName(editingKind === "preview" ? sourceFile : previewFile))}</strong></div></div>
        <div class="pair-edit-actions"><button class="quiet-btn" type="button" data-package-edit-action="restore" data-package-edit-kind="${editingKind}">恢复自动匹配</button><button class="primary-btn" type="button" data-package-edit-action="apply" data-package-edit-kind="${editingKind}">应用${editingKind === "preview" ? " PNG" : " ZIP"}配对</button></div>
      </div>`
    : "";
  const previewChangeLabel = editing && editingKind === "preview" ? "收起更换" : "更换 PNG";
  const sourceChangeLabel = editing && editingKind === "source" ? "收起更换" : "更换 ZIP";
  return `<article class="package-card pair-card ${pairCardTone(pkg)} ${state.selectedPackageId === pkg.packageId ? "selected" : ""}" data-package-id="${escapeHtml(pkg.packageId || "")}" data-status="${escapeHtml(pkg.state || "")}" data-package-card="true">
    <div class="pair-visual">
      <div class="pair-asset asset-card" title="点击预览图查看原图" data-asset-action="preview" data-package-id="${escapeHtml(pkg.packageId || "")}"><div class="pair-asset-head"><strong>预览图</strong><span>PNG</span></div><div class="package-thumb asset-preview-hit ${packageTone(pkg)}" role="button" tabindex="0" aria-label="查看${escapeHtml(pkg.packageName || "包装")}原图">${previewImage}</div><div class="pair-file-name" title="${escapeHtml(packageFileName(previewFile))}">${escapeHtml(packageFileName(previewFile))}</div><div class="asset-card-footer"><button class="asset-change-btn" type="button" data-package-edit-kind="preview">${previewChangeLabel}</button></div></div>
      <div class="pair-connector" aria-hidden="true">↔</div>
      <div class="pair-asset asset-card" title="点击打包文件查看 ZIP 信息" data-asset-action="source" data-package-id="${escapeHtml(pkg.packageId || "")}"><div class="pair-asset-head"><strong>打包文件</strong><span>ZIP</span></div><div class="source-asset ${sourcePath ? "" : "empty"}" role="button" tabindex="0" aria-label="查看${escapeHtml(pkg.packageName || "包装")}打包文件信息"><div class="zip-mark">ZIP</div></div><div class="pair-file-name" title="${escapeHtml(packageFileName(sourceFile))}">${escapeHtml(packageFileName(sourceFile))}</div><div class="asset-card-footer"><button class="asset-change-btn" type="button" data-package-edit-kind="source">${sourceChangeLabel}</button></div></div>
    </div>
    <div class="pair-copy" title="${escapeHtml(reason)}"><div class="card-title-row"><input class="package-name-input ${pkg.nameEdited ? "edited" : ""}" data-package-name="${escapeHtml(pkg.packageId || "")}" value="${escapeHtml(pkg.packageName || "")}" placeholder="包装名称" aria-label="${escapeHtml(pkg.packageName || "包装")} 名称" /> <div class="pair-badges">${pairStatusBadge(pkg)}</div></div>
      <div class="card-meta"><span>${escapeHtml(pkg.projectName || "未命名项目")}</span> · ${packageTypeEditor(pkg)} · ${escapeHtml(pkg.version || "v01")} · 合成 ${escapeHtml(pkg.aeCompName || "未记录合成")}</div>
      <div class="card-files"><span class="file-pill">${previewPath ? "PNG ✓" : "PNG —"}</span><span class="file-pill">${sourcePath ? "ZIP ✓" : "ZIP —"}</span><span class="file-pill">${pkg.manifestPath ? "META ✓" : "META —"}</span><span class="file-pill">${reportBadge}</span><span class="file-pill mono">${escapeHtml(pkg.packageId || "待生成")}</span></div>
      <div class="pair-targets"><div class="pair-target"><span>PNG 入库</span><strong>01_预览图 / ${escapeHtml(packageType)}</strong></div><div class="pair-target"><span>ZIP 入库</span><strong>02_AE源文件 / ${escapeHtml(packageType)}</strong></div></div>
    </div>
    <div class="pair-facts"><span>配对来源</span><strong>${hasPendingPackageEdit(pkg) ? "待应用" : pkg.manualMatch ? "用户选择" : "自动规则"}</strong><span>预览尺寸</span><strong>${escapeHtml(previewFile?.dimensions || pkg.preview?.dimensions || "PNG 文件")}</strong><span>导入状态</span><strong class="${pkg.state === "ready" ? "check-ok" : "check-bad"}">${escapeHtml(statusLabel(pkg.state))}</strong></div>
    ${editPanel}
  </article>`;
}

function render(scan) {
  if (state.scan !== scan) beginScanState(scan);
  state.scan = scan;
  state.importStage = 2;
  refreshScanDerivedState();
  elements.statToImport.textContent = String(scan.stats?.toImport ?? 0);
  elements.statValidate.textContent = String(scan.stats?.validateOnly ?? 0);
  elements.statIgnore.textContent = String(scan.stats?.ignore ?? 0);
  elements.statConflict.textContent = String(scan.stats?.conflict ?? 0);
  elements.batchInfo.textContent = `batch_id：${scan.batchId || "待生成"}`;
  elements.projectName.value = scan.projectName || elements.projectName.value;
  const packages = sortPackages(scan.packages || []);
  elements.packageRows.innerHTML = packages.length
    ? packages.map(packageCard).join("")
    : `<div class="empty-card" style="grid-column:1/-1;border:1px dashed var(--line-strong);border-radius:9px;padding:24px;text-align:center;color:var(--ink-faint);">没有识别到可审核的包装记录。</div>`;
  elements.fileRows.innerHTML = (scan.files || []).map((file) => `<div class="file-detail-row"><span title="${escapeHtml(file.relative)}">${escapeHtml(file.relative)}</span><span>${escapeHtml(file.kind || "-")}</span>${badge(file.status)}<span title="${escapeHtml(file.note || "")}">${escapeHtml(file.note || "")}</span></div>`).join("") || `<div class="file-detail-row"><span>暂无扫描文件</span></div>`;
  const readyCount = packages.filter((pkg) => pkg.state === "ready").length;
  const blockedCount = packages.filter((pkg) => pkg.state === "blocked").length;
  elements.importBtn.disabled = readyCount === 0 || blockedCount > 0;
  elements.importBtn.textContent = "直接入库 Eagle";
  log(`扫描完成：${scan.stats?.toImport || 0} 个文件将导入，${blockedCount} 条记录被阻止`);
}

function packageById(packageId) {
  return (state.scan?.packages || []).find(
    (pkg) => String(pkg.packageId) === String(packageId)
  ) || null;
}

function restorePackageMatch(packageId, kind = "preview") {
  const pkg = packageById(packageId);
  const baseline = state.scanPackageBaseline?.get(String(packageId));
  if (!pkg || !baseline) return;
  pkg[kind] = baseline[kind] ? { ...baseline[kind] } : null;
  state.editingPackageId = null;
  state.editingPackageKind = null;
  state.pendingPackageEdit = null;
  refreshScanDerivedState();
  render(state.scan);
  showToast("已恢复自动匹配", `${pkg.packageName || "当前包装"} 的${assetLabel(kind)}已恢复扫描器结果。`);
}

function applyPackageMatch(packageId, panel, kind = "preview") {
  const pkg = packageById(packageId);
  if (!pkg || !panel) return;
  const selectedPath = panel.querySelector(`[data-package-edit-field="${kind}"]`)?.value || "";
  const selectedFile = scanFileAt(state.scan, selectedPath);
  pkg[kind] = selectedFile ? { path: selectedFile.path, relative: selectedFile.relative } : null;
  state.selectedPackageId = pkg.packageId;
  state.editingPackageId = null;
  state.editingPackageKind = null;
  state.pendingPackageEdit = null;
  refreshScanDerivedState();
  render(state.scan);
  if (pkg.state === "ready") {
    showToast("配对已更新", `${pkg.packageName || "当前包装"} 已形成唯一 PNG + ZIP 配对。`);
  } else {
    showToast("配对仍需处理", pkg.matchError || "请继续选择缺少的一侧文件。", "error");
  }
}

function createAdapter() {
  if (!window.eagle || !window.eagle.item || !window.eagle.folder) {
    throw new Error("Eagle 插件 API 不可用，请在 Eagle 内运行");
  }
  return new EaglePluginAdapter(window.eagle);
}

function resetFormalState() {
  state.filePlan = null;
  state.fileInspection = null;
  state.fileOverrides = {};
  state.nameOverrides = {};
  state.selectedPair = null;
  state.planFilter = "all";
  elements.confirmFileBtn.hidden = true;
  elements.confirmFileBtn.disabled = true;
  elements.renameBtn.disabled = true;
  elements.fileInfo.textContent = "请选择一个待入库批次";
  elements.filePlanRows.innerHTML = `<div class="empty-card" style="border:1px dashed var(--line-strong);border-radius:9px;padding:24px;text-align:center;color:var(--ink-faint);">选择待入库批次后，这里会显示正式入库计划。</div>`;
  elements.packageInspector.innerHTML = `<div class="empty-card" style="border:1px dashed var(--line-strong);border-radius:9px;padding:24px;text-align:center;color:var(--ink-faint);">点击一条包装记录查看预览、配对关系和事实字段。</div>`;
  [elements.statFileReady, elements.statFileBlocked, elements.statFileAlready, elements.statFileRemaining].forEach((element) => { element.textContent = "0"; });
  elements.formalState.textContent = "等待批次";
  elements.formalState.className = "status-badge status-muted";
  elements.formalBottomCopy.textContent = "当前没有可入库记录。";
}

async function refreshBatches() {
  resetFormalState();
  elements.batchSelect.innerHTML = "<option>正在加载…</option>";
  elements.batchSelect.disabled = true;
  elements.fileBtn.disabled = true;
  try {
    const adapter = createAdapter();
    const folders = await adapter.getFolders();
    const root = folders.find((folder) => folder.name === INGEST_ROOT_NAME);
    if (!root) {
      elements.batchSelect.innerHTML = "<option>还没有 00_待入库</option>";
      elements.batchCount.textContent = "0 项";
      if (elements.formalCount) elements.formalCount.textContent = "0";
      log("Eagle 中还没有 00_待入库 目录");
      return;
    }
    const rootChildrenIds = new Set((root.children || []).map(folderId).filter(Boolean));
    state.batchFolders = folders.filter((folder) => folderId(folder.parent) === folderId(root) || rootChildrenIds.has(folderId(folder))).sort((a, b) => String(a.name).localeCompare(String(b.name), "zh-CN"));
    elements.batchCount.textContent = `${state.batchFolders.length} 项`;
    if (elements.formalCount) elements.formalCount.textContent = String(state.batchFolders.length);
    if (state.batchFolders.length === 0) {
      elements.batchSelect.innerHTML = "<option>还没有批次文件夹</option>";
      log("00_待入库 下还没有批次文件夹");
      return;
    }
    elements.batchSelect.innerHTML = state.batchFolders.map((folder) => `<option value="${escapeHtml(folderId(folder))}">${escapeHtml(folder.name)}</option>`).join("");
    elements.batchSelect.disabled = false;
    elements.fileBtn.disabled = false;
    log(`已加载 ${state.batchFolders.length} 个待入库批次`);
    await loadFilePlan();
  } catch (error) {
    elements.batchSelect.innerHTML = "<option>加载失败</option>";
    log(`加载批次失败：${error.message}`);
    showToast("批次加载失败", error.message, "error");
  }
}

function planTone(pair) { return packageTone(pair || {}); }

function planCard(pair, status, reason = "") {
  const previewPath = pair.preview?.filePath || pair.preview?.filepath || "";
  const previewSrc = previewPath ? `<img src="${escapeHtml(fileUrl(previewPath))}" alt="" onerror="this.style.display='none'" />` : "";
  const previewName = pair.preview?.name || pair.packageId || "预览图";
  const sourceName = pair.source?.name || pair.packageId || "源文件";
  return `<article class="plan-card" data-pair-id="${escapeHtml(pair.packageId || "")}" data-plan-status="${escapeHtml(status)}"><div class="plan-thumb package-thumb ${planTone(pair)}">${previewSrc}</div><div><div class="plan-name">${escapeHtml(pair.packageName || previewName)}</div><div class="plan-meta">${escapeHtml(pair.packageType || "待补充类型")} · ${escapeHtml(pair.version || "v01")} · ${escapeHtml(pair.batchId || "未记录批次")}</div><div class="plan-file-names" title="${escapeHtml(`${previewName} / ${sourceName}`)}">${escapeHtml(`${previewName} / ${sourceName}`)}</div></div>${reason ? `<div class="plan-reason">${escapeHtml(reason)}</div>` : badge(status)}</article>`;
}

function renderFilePlan(plan, remainingCount = 0) {
  const readyPairs = plan.readyPairs || [];
  const reviewPairs = plan.reviewPairs || [];
  const blocked = plan.blocked || [];
  const alreadyFiled = plan.alreadyFiled || [];
  elements.statFileReady.textContent = String(readyPairs.length);
  elements.statFileBlocked.textContent = String(blocked.length + reviewPairs.length);
  elements.statFileAlready.textContent = String(alreadyFiled.length);
  elements.statFileRemaining.textContent = String(remainingCount);
  elements.filterAllCount.textContent = String(readyPairs.length + reviewPairs.length + blocked.length + alreadyFiled.length);
  elements.filterReadyCount.textContent = String(readyPairs.length);
  elements.filterReviewCount.textContent = String(reviewPairs.length);
  elements.filterBlockedCount.textContent = String(blocked.length);
  const rows = [];
  readyPairs.forEach((pair) => rows.push(planCard(pair, "ready")));
  reviewPairs.forEach((pair) => rows.push(planCard(pair, "review", pair.reason)));
  blocked.forEach((entry) => rows.push(planCard({ packageId: entry.item?.id, packageName: entry.item?.name, preview: entry.item }, "blocked", entry.reason)));
  alreadyFiled.forEach((item) => rows.push(planCard({ packageId: item.id, packageName: item.name, preview: item }, "already", "已在正式目录")));
  elements.filePlanRows.innerHTML = rows.join("") || `<div class="empty-card" style="border:1px dashed var(--line-strong);border-radius:9px;padding:24px;text-align:center;color:var(--ink-faint);">当前批次没有可展示的记录。</div>`;
  elements.renameBtn.disabled = readyPairs.length === 0;
  elements.confirmFileBtn.hidden = readyPairs.length === 0;
  elements.confirmFileBtn.disabled = readyPairs.length === 0;
  elements.formalState.textContent = blocked.length || reviewPairs.length ? "需要处理" : readyPairs.length ? "可入库" : "已完成";
  elements.formalState.className = `status-badge ${blocked.length ? "status-blocked" : reviewPairs.length ? "status-review" : readyPairs.length ? "status-ready" : "status-muted"}`;
  elements.formalBottomCopy.innerHTML = readyPairs.length ? `已识别 <strong>${readyPairs.length} 对可入库素材</strong> · 可先批量规范命名，再确认正式归位。` : "当前没有可入库记录。";
  applyPlanFilter(state.planFilter);
  if (!state.selectedPair || ![...readyPairs, ...reviewPairs].some((pair) => pair.packageId === state.selectedPair.packageId)) state.selectedPair = readyPairs[0] || reviewPairs[0] || null;
  if (state.selectedPair) showPackageInspector(state.selectedPair);
}

function applyPlanFilter(filter) {
  state.planFilter = filter;
  document.querySelectorAll("#planFilters .filter-button").forEach((button) => button.classList.toggle("active", button.dataset.planFilter === filter));
  document.querySelectorAll("#filePlanRows .plan-card").forEach((card) => { card.style.display = filter === "all" || card.dataset.planStatus === filter ? "grid" : "none"; });
}

function showPackageInspector(pair) {
  if (!pair || !elements.packageInspector) return;
  state.selectedPair = pair;
  const metadata = pair.metadata || pair;
  const previewPath = pair.preview?.filePath || pair.preview?.filepath || "";
  const previewSrc = previewPath ? `<img src="${escapeHtml(fileUrl(previewPath))}" alt="" onerror="this.style.display='none'" />` : "";
  const status = pair.reason ? "review" : "ready";
  const typeOptions = ["", ...KNOWN_PACKAGE_TYPES].map((type) => `<option value="${escapeHtml(type)}" ${type === metadata.packageType ? "selected" : ""}>${escapeHtml(type || "请选择类型")}</option>`).join("");
  elements.packageInspector.innerHTML = `<div class="inspector-heading"><div><h2>${escapeHtml(metadata.packageName || pair.packageId || "未命名包装")}</h2><p>${escapeHtml(metadata.projectName || "未命名项目")} · ${escapeHtml(metadata.version || "v01")} · ${escapeHtml(metadata.aeCompName || "未记录合成")}</p></div>${badge(status)}</div>
    <div class="inspector-preview"><div class="package-thumb ${packageTone(metadata)}">${previewSrc}<span class="thumb-tag">${previewSrc ? "PNG PREVIEW" : "等待 PNG"}</span></div><div class="preview-caption"><div><strong>${escapeHtml(pair.preview?.name || "预览图未配对")}</strong><span>稳定关联：${escapeHtml(pair.packageId || "未记录 package_id")}</span></div><button class="preview-button" type="button" data-action="toast" data-title="预览" data-message="预览图查看会调用 Eagle 当前素材。">查看</button></div></div>
    <div class="inspector-section"><h3>素材信息</h3><div class="detail-grid"><div class="detail-item"><span>项目</span><strong>${escapeHtml(metadata.projectName || "-")}</strong></div><div class="detail-item"><span>包装类型</span><strong>${metadata.packageType ? escapeHtml(metadata.packageType) : `<select class="select-input" data-inspector-type="${escapeHtml(pair.packageId || "")}">${typeOptions}</select>`}</strong></div><div class="detail-item"><span>版本</span><strong>${escapeHtml(metadata.version || "v01")}</strong></div><div class="detail-item"><span>batch_id</span><strong class="mono">${escapeHtml(metadata.batchId || "-")}</strong></div></div></div>
    <div class="inspector-section"><h3>配对与检查</h3><div class="check-list"><div class="check-row"><span>PNG 预览</span><strong class="${pair.preview ? "check-ok" : "check-bad"}">${pair.preview ? "已配对" : "缺失"}</strong></div><div class="check-row"><span>源文件 ZIP</span><strong class="${pair.source ? "check-ok" : "check-bad"}">${pair.source ? "已配对" : "缺失"}</strong></div><div class="check-row"><span>manifest</span><strong class="${metadata.packageId ? "check-ok" : "check-warn"}">${metadata.packageId ? "已读取" : "待补充"}</strong></div><div class="check-row"><span>状态</span><strong class="${status === "ready" ? "check-ok" : "check-warn"}">${statusLabel(status)}</strong></div></div></div>
    <div class="inspector-section"><h3>下一步</h3><div class="inspector-actions"><button class="quiet-btn" type="button" data-action="show-rename">批量规范命名</button><button class="primary-btn" type="button" data-action="toast" data-title="已保留选择" data-message="该记录将在底部确认栏中继续处理。">保留选择</button></div></div>`;
}

async function loadFilePlan() {
  const batchId = elements.batchSelect.value;
  if (!batchId) { log("请先选择一个待入库批次"); return; }
  try {
    const adapter = createAdapter();
    const inspection = await inspectBatch(adapter, batchId, { overrides: state.fileOverrides });
    showFileInspection(inspection);
  } catch (error) {
    log(`入库预检失败：${error.message}`);
    showToast("入库预检失败", error.message, "error");
  }
}

function showFileInspection(inspection) {
  state.fileInspection = inspection;
  state.filePlan = planFormalFile(inspection.items, { ...inspection.planOptions, overrides: state.fileOverrides });
  renderFilePlan(state.filePlan, inspection.items.length);
  const logicalBatchIds = new Set([...state.filePlan.readyPairs, ...(state.filePlan.reviewPairs || [])].map((pair) => pair.batchId).filter(Boolean));
  elements.fileInfo.textContent = `递归读取 ${inspection.folderIds.length} 个目录、${inspection.items.length} 个关联文件；${state.filePlan.readyPairs.length} 对可入库，${state.filePlan.reviewPairs.length} 对待补充类型`;
  if (logicalBatchIds.size > 1) log(`检测到 ${logicalBatchIds.size} 个 batch_id，已按批次分别配对并保留重复保护`);
  log(`入库预检：${state.filePlan.readyPairs.length} 对可入库，${state.filePlan.reviewPairs.length} 对待补充，${state.filePlan.blocked.length} 条冲突，${state.filePlan.ignored.length} 个文件忽略`);
}

async function runImport() {
  if (!state.scan) return;
  try {
    const adapter = createAdapter();
    elements.importBtn.disabled = true;
    const mode = elements.importMode.value;
    if (!IMPORT_MODES.includes(mode)) throw new Error("请选择有效的重复批次处理方式");
    const projectName = elements.projectName.value.trim();
    if (!projectName) throw new Error("请先填写项目名称");
    if (state.pendingPackageEdit) throw new Error("请先点击对应卡片上的“应用”按钮，完成配对更换");
    state.scan.projectName = projectName;
    log("正在把配对文件直接写入 Eagle 正式目录…");
    const result = await importFormalBatch(adapter, state.scan, { mode });
    if (result.state === "duplicate") {
      state.pendingImport = result;
      elements.importBtn.disabled = false;
      const matched = result.matches.map((match) => `${match.batchId || match.batchFolderId}（${match.matchedBy.join("、")}）`).join("；");
      elements.duplicateSub.textContent = `匹配依据：${matched || "已有同名批次"}`;
      openModal(elements.duplicateModal);
      log("检测到已有正式素材，等待选择处理策略");
      return;
    }
    const filedCount = result.filed?.length || 0;
    const reusedCount = result.reused?.length || 0;
    state.importStage = 3;
    elements.batchInfo.textContent = `batch_id：${result.batchId}（已直接入库）`;
    log(`直接入库完成：批次 ${result.batchId}，${filedCount} 对素材已写入正式目录${reusedCount ? `，${reusedCount} 对复用已有记录` : ""}`);
    try {
      const published = publishIngestEvent(result);
      log(published.skipped ? "没有新的正式入库记录，无需同步 SQLite" : `已写入 bot 索引同步队列：${published.filePath}`);
    } catch (error) {
      log(`写入 bot 索引同步队列失败：${error.message}`);
    }
    elements.importBtn.textContent = "本批次已入库";
    setView("import");
    showToast("直接入库完成", `${filedCount} 对素材已写入 01_预览图 / 02_AE源文件。`);
  } catch (error) {
    log(`直接入库失败：${error.message}`);
    elements.importBtn.disabled = false;
    showToast("直接入库失败", error.message, "error");
  }
}

function templateValues(pair) {
  const metadata = pair.metadata || pair;
  return { "项目": metadata.projectName || "未命名项目", "包装": metadata.packageName || "未命名包装", "类型": metadata.packageType || "待补充类型", "版本": metadata.version || "v01", "合成": metadata.aeCompName || metadata.packageName || "未记录合成" };
}

function fillTemplate(template, pair) {
  const values = templateValues(pair);
  return String(template || "").replace(/\{(项目|包装|类型|版本|合成)\}/g, (_, token) => values[token] || "");
}

function renameValue(pair, kind) {
  const existing = state.nameOverrides[pair.packageId]?.[kind];
  if (existing) return existing;
  const template = kind === "preview" ? elements.previewTemplate.value : elements.sourceTemplate.value;
  const extension = kind === "preview" ? ".png" : ".zip";
  return `${fillTemplate(template, pair)}${extension}`;
}

function renderRenameRows() {
  const pairs = state.filePlan?.readyPairs || [];
  const rows = ["<div class=\"rename-head\">包装</div><div class=\"rename-head\">原始文件名</div><div class=\"rename-head\">规范预览图</div><div class=\"rename-head\">规范源文件</div><div class=\"rename-head\">状态</div>"];
  pairs.forEach((pair) => {
    const metadata = pair.metadata || pair;
    const previewName = pair.preview?.name || "预览图";
    const sourceName = pair.source?.name || "源文件";
    const manual = Boolean(state.nameOverrides[pair.packageId]);
    rows.push(`<div class="rename-cell rename-package"><span class="package-thumb ${packageTone(metadata)}"></span><div><strong>${escapeHtml(metadata.packageName || pair.packageId)}</strong><span>${escapeHtml(metadata.packageType || "待补充类型")} · ${escapeHtml(metadata.version || "v01")}</span></div></div>`);
    rows.push(`<div class="rename-cell old-name">${escapeHtml(previewName)}<br />${escapeHtml(sourceName)}</div>`);
    rows.push(`<div class="rename-cell"><input class="rename-input ${manual ? "manual" : ""}" data-rename-id="${escapeHtml(pair.packageId)}" data-rename-kind="preview" value="${escapeHtml(renameValue(pair, "preview"))}" aria-label="${escapeHtml(metadata.packageName || pair.packageId)} 预览图名称" /></div>`);
    rows.push(`<div class="rename-cell"><input class="rename-input ${manual ? "manual" : ""}" data-rename-id="${escapeHtml(pair.packageId)}" data-rename-kind="source" value="${escapeHtml(renameValue(pair, "source"))}" aria-label="${escapeHtml(metadata.packageName || pair.packageId)} 源文件名称" /></div>`);
    rows.push(`<div class="rename-cell"><span class="rename-status ${manual ? "manual" : "auto"}">${manual ? "手动修改" : "自动生成"}</span></div>`);
  });
  elements.renameRows.innerHTML = rows.join("") || `<div class="rename-cell" style="grid-column:1/-1;padding:24px;color:var(--ink-faint);text-align:center;">当前没有完整的 PNG + ZIP 配对。</div>`;
  validateRename(false);
}

function validateRename(showFeedback = true) {
  const invalidPattern = /[<>:"\/\\|?*\u0000-\u001F]/u;
  const seen = new Map();
  let invalidCount = 0;
  document.querySelectorAll(".rename-input").forEach((input) => {
    const value = input.value.trim();
    const key = `${input.dataset.renameKind}\u0000${value.toLocaleLowerCase()}`;
    const invalid = !value || invalidPattern.test(value) || /[. ]$/u.test(value) || seen.has(key);
    input.classList.toggle("invalid", invalid);
    if (invalid) invalidCount += 1;
    if (value) seen.set(key, input);
    const statusCell = input.dataset.renameKind === "preview" ? input.parentElement.nextElementSibling?.nextElementSibling : input.parentElement.nextElementSibling;
    const status = statusCell?.querySelector(".rename-status");
    if (status) {
      const manual = Boolean(state.nameOverrides[input.dataset.renameId]);
      status.className = `rename-status ${invalid ? "invalid" : manual ? "manual" : "auto"}`;
      status.textContent = invalid ? "需修正" : manual ? "手动修改" : "自动生成";
    }
  });
  if (invalidCount) {
    elements.renameSummary.innerHTML = `<strong>${invalidCount} 个名称需修正</strong> · 应用前请完成校验`;
    elements.renameError.textContent = "检查空名称、非法字符、结尾空格/句点或重复名称";
  } else {
    elements.renameSummary.innerHTML = `<strong>${state.filePlan?.readyPairs?.length || 0} 组</strong> · 预览图与源文件命名均可用`;
    elements.renameError.textContent = "";
  }
  if (showFeedback) showToast(invalidCount ? "命名校验未通过" : "命名校验通过", invalidCount ? "请处理标红的名称后再继续。" : "所有名称唯一，且符合 Windows 文件名规则。", invalidCount ? "error" : "normal");
  return invalidCount === 0;
}

function applyRenameRule(showFeedback = true) {
  state.nameOverrides = {};
  renderRenameRows();
  if (showFeedback) showToast("已按规则生成名称", "你仍可以直接修改任意一条预览图或源文件名称。");
}

function updateNameOverride(input) {
  const id = input.dataset.renameId;
  state.nameOverrides[id] = state.nameOverrides[id] || {};
  state.nameOverrides[id][input.dataset.renameKind] = input.value;
  input.classList.add("manual");
  const statusCell = input.dataset.renameKind === "preview" ? input.parentElement.nextElementSibling?.nextElementSibling : input.parentElement.nextElementSibling;
  const status = statusCell?.querySelector(".rename-status");
  if (status) { status.className = "rename-status manual"; status.textContent = "手动修改"; }
  validateRename(false);
}

function captureRenameValues() {
  const overrides = {};
  document.querySelectorAll(".rename-input").forEach((input) => {
    const id = input.dataset.renameId;
    if (!id) return;
    overrides[id] = overrides[id] || {};
    overrides[id][input.dataset.renameKind] = input.value;
  });
  state.nameOverrides = overrides;
}

function openRenameModal() {
  if (!state.filePlan?.readyPairs?.length) {
    showToast("暂无可命名记录", "需要先形成完整的 PNG + ZIP 配对。", "error");
    return;
  }
  renderRenameRows();
  openModal(elements.renameModal);
}

function confirmRename() {
  if (!validateRename()) return;
  captureRenameValues();
  closeModals();
  showToast("命名已确认", "正式入库时将写入这些名称，并保持 package_id / batch_id 不变。");
}

async function confirmFile() {
  const batchId = elements.batchSelect.value;
  if (!batchId || !state.filePlan) return;
  if (Object.keys(state.nameOverrides).length && !validateRename()) return;
  try {
    const adapter = createAdapter();
    elements.confirmFileBtn.disabled = true;
    log("正在把待入库批次移入正式目录…");
    const result = await fileBatch(adapter, batchId, { overrides: state.fileOverrides, nameOverrides: state.nameOverrides });
    const plan = { readyPairs: [], blocked: result.blocked, reviewPairs: result.reviewPairs, ignored: result.ignored, alreadyFiled: result.alreadyFiled, stats: { ready: result.filed.length, blocked: result.blocked.length + result.reviewPairs.length, ignored: result.ignored.length, alreadyFiled: result.alreadyFiled.length, files: result.remaining.length + result.filed.length * 2 } };
    renderFilePlan(plan, result.remaining.length);
    elements.fileInfo.textContent = result.batchEmpty ? "入库完成，批次已清空（可在 Eagle 界面删除空批次文件夹）" : `入库完成，批次还剩 ${result.remaining.length} 个文件`;
    elements.confirmFileBtn.hidden = true;
    log(`入库完成：${result.filed.length} 对进入正式目录`);
    result.failed.forEach((item) => log(`入库失败：${item.pair.packageId} - ${item.reason}`));
    try {
      const published = publishIngestEvent(result);
      log(published.skipped ? "没有新的正式入库记录，无需同步 SQLite" : `已写入 bot 索引同步队列：${published.filePath}`);
    } catch (error) {
      log(`写入 bot 索引同步队列失败：${error.message}`);
    }
    showToast("正式入库完成", `${result.filed.length} 对素材已归位，命名和 manifest 关系保持一致。`);
    await refreshBatches();
  } catch (error) {
    log(`入库失败：${error.message}`);
    elements.confirmFileBtn.disabled = false;
    showToast("正式入库失败", error.message, "error");
  }
}

function aepCompositions() {
  return state.aep.project?.compositions || [];
}

function aepComposition(compId) {
  return aepCompositions().find((item) => Number(item.id) === Number(compId)) || null;
}

function aepIsCandidate(comp) {
  return /(包装|背景|视频框|竖屏框|横屏框|信息条|人名条|标注|分镜)/u.test(String(comp?.name || ""));
}

function aepHasWarning(comp) {
  return (comp?.parent_ids || []).length > 1 || /(测试|临时|视频框|横屏框|竖屏框)/u.test(String(comp?.name || ""));
}

function aepStatus(comp, reference = false) {
  if (reference) return { label: "共享引用", tone: "" };
  if (/(测试|临时)/u.test(String(comp?.name || ""))) return { label: "阻止收集", tone: "blocked" };
  if (aepIsCandidate(comp)) return { label: "可收集", tone: "candidate" };
  if (aepHasWarning(comp)) return { label: "需要复核", tone: "" };
  return { label: "可查看", tone: "" };
}

function aepMatches(comp) {
  const filter = state.aep.filter;
  if (filter === "candidate" && !aepIsCandidate(comp)) return false;
  if (filter === "root" && (comp.parent_ids || []).length) return false;
  if (filter === "child" && !(comp.parent_ids || []).length) return false;
  if (filter === "warning" && !aepHasWarning(comp)) return false;
  const query = state.aep.search.trim().toLocaleLowerCase();
  if (!query) return true;
  return `${comp.name} ${comp.role || ""} ${comp.width}x${comp.height} ${comp.duration}`.toLocaleLowerCase().includes(query);
}

function aepHasVisibleDescendant(compId, trail = new Set()) {
  if (trail.has(Number(compId))) return false;
  const nextTrail = new Set(trail).add(Number(compId));
  const comp = aepComposition(compId);
  return Boolean(comp && (comp.child_ids || []).some((childId) => {
    const child = aepComposition(childId);
    return child && (aepMatches(child) || aepHasVisibleDescendant(child.id, nextTrail));
  }));
}

function aepPreviewRecommendation(comp) {
  return state.aep.project?.preview_recommendations?.[String(comp.id)] || {
    source_id: comp.id,
    source_name: comp.name,
    relation: "self",
    reason: "等待 Worker 返回预览来源",
    time_seconds: 2,
    frame: 0,
  };
}

function aepRenderFilters() {
  const items = {
    all: aepCompositions().length,
    candidate: aepCompositions().filter(aepIsCandidate).length,
    root: aepCompositions().filter((item) => !(item.parent_ids || []).length).length,
    child: aepCompositions().filter((item) => (item.parent_ids || []).length).length,
    warning: aepCompositions().filter(aepHasWarning).length,
  };
  document.querySelectorAll("[data-aep-filter]").forEach((button) => {
    const key = button.dataset.aepFilter;
    button.classList.toggle("active", key === state.aep.filter);
    const count = button.querySelector("span");
    if (count) count.textContent = String(items[key] || 0);
    button.title = `${button.textContent.trim()}：${items[key] || 0} 个`;
  });
}

function aepTreeBranch(comp, depth, trail, seen) {
  if (!aepMatches(comp) && !aepHasVisibleDescendant(comp.id, trail)) return "";
  const isReference = seen.has(comp.id) || trail.has(comp.id);
  const depthValue = Math.min(Number(depth) || 0, 8);
  const indent = depthValue * 30;
  const guideLeft = depthValue > 0 ? 16 + ((depthValue - 1) * 30) : 0;
  const nextTrail = new Set(trail).add(comp.id);
  seen.add(comp.id);
  const children = (comp.child_ids || [])
    .map((childId) => aepComposition(childId))
    .filter(Boolean)
    .map((child) => aepTreeBranch(child, depthValue + 1, nextTrail, seen))
    .join("");
  const hasChildren = Boolean(children) || (comp.child_ids || []).length > 0;
  const expanded = state.aep.expandedIds.has(comp.id) && !isReference;
  const status = aepStatus(comp, isReference);
  const selected = Number(state.aep.activeCompId) === Number(comp.id);
  const checked = state.aep.checkedIds.has(comp.id);
  const role = comp.role || ((comp.parent_ids || []).length ? "预合成" : "顶层合成");
  const levelLabel = depthValue === 0 ? "根合成" : isReference ? "共享引用" : "直属预合成";
  const levelKey = depthValue === 0 ? "ROOT" : isReference ? "LINK" : "PRE";
  const levelClass = depthValue === 0 ? "root" : isReference ? "shared" : "child";
  return `<div class="aep-tree-row ${selected ? "selected" : ""} ${isReference ? "reference" : ""}" data-aep-id="${escapeHtml(comp.id)}" data-depth="${depthValue}" role="treeitem" aria-level="${depthValue + 1}" style="--aep-depth:${depthValue};--aep-indent:${indent}px;--aep-guide-left:${guideLeft}px">
    <button class="aep-tree-expander" type="button" data-aep-expander="${escapeHtml(comp.id)}" aria-label="${expanded ? "收起" : "展开"}" ${hasChildren && !isReference ? "" : "disabled"}>${hasChildren && !isReference ? (expanded ? "⌄" : "›") : "·"}</button>
    <input class="aep-tree-check" type="checkbox" data-aep-check="${escapeHtml(comp.id)}" ${checked ? "checked" : ""} ${isReference ? "disabled" : ""} aria-label="选择 ${escapeHtml(comp.name)}" />
    <div class="aep-tree-name" data-aep-name="${escapeHtml(comp.id)}"><span class="aep-tree-name-line"><span class="aep-tree-kind ${levelClass}">${levelKey}</span><strong>${escapeHtml(comp.name)}</strong></span><small>${escapeHtml(isReference ? "共享引用" : `${levelLabel} · ${role}`)}</small></div>
    <span class="aep-tree-meta">${escapeHtml(`${comp.width}×${comp.height}`)}</span><span class="aep-tree-meta">${escapeHtml(`${Number(comp.duration || 0).toFixed(2)}s`)}</span><span class="aep-tree-status ${status.tone}">${escapeHtml(status.label)}</span>
  </div>${expanded ? children : ""}`;
}

function updateAepActions() {
  const hasProject = Boolean(state.aep.project);
  const compositions = aepCompositions();
  const checkedCount = state.aep.checkedIds.size;
  const candidateCount = compositions.filter(aepIsCandidate).length;
  const warningCount = compositions.filter(aepHasWarning).length;
  elements.aepInspectBtn.disabled = !state.aep.aepPath || state.aep.collecting;
  elements.aepDefaultOutputBtn.disabled = !state.aep.aepPath || state.aep.collecting;
  elements.aepExpandBtn.disabled = !hasProject || state.aep.collecting;
  elements.aepCollapseBtn.disabled = !hasProject || state.aep.collecting;
  elements.aepSelectVisibleBtn.disabled = !hasProject || state.aep.collecting;
  elements.aepClearBtn.disabled = !checkedCount || state.aep.collecting;
  elements.aepCollectBtn.disabled = !hasProject || !checkedCount || !String(elements.aepOutput.value || "").trim() || state.aep.collecting;
  elements.aepStatCompositions.textContent = String(compositions.length);
  elements.aepStatCandidates.textContent = String(candidateCount);
  elements.aepStatSelected.textContent = String(checkedCount);
  elements.aepStatWarnings.textContent = String(warningCount);
  elements.aepSelectionSummary.textContent = `已选 ${checkedCount} 个合成`;
  elements.aepCollectionSummary.textContent = hasProject ? ` · ${compositions.length} 个合成已载入` : "";
}

function renderAepTree() {
  aepRenderFilters();
  if (!state.aep.project) {
    elements.aepTree.innerHTML = `<div class="aep-empty">先选择一个 AEP 工程，再读取离线合成结构。</div>`;
    elements.aepTreeSummary.textContent = "选择 AEP 后显示 parent / child 关系";
    updateAepActions();
    return;
  }
  const roots = aepCompositions().filter((item) => !(item.parent_ids || []).length);
  const rootItems = roots.length ? roots : aepCompositions();
  const seen = new Set();
  const markup = rootItems
    .slice()
    .sort((left, right) => String(left.name).localeCompare(String(right.name), "zh-CN") || left.id - right.id)
    .map((comp) => aepTreeBranch(comp, 0, new Set(), seen))
    .join("");
  elements.aepTree.innerHTML = markup || `<div class="aep-empty">当前筛选条件下没有合成。</div>`;
  const visible = aepCompositions().filter(aepMatches).length;
  elements.aepTreeSummary.textContent = `${visible} 个合成可见 · 点击名称查看详情，勾选框加入收集队列`;
  updateAepActions();
}

function renderAepInspector() {
  const comp = aepComposition(state.aep.activeCompId);
  if (!comp) {
    elements.aepInspector.innerHTML = `<div class="aep-inspector-title">合成检查器</div><div class="aep-empty">点击左侧合成名称查看尺寸、父级、直属预合成和预览来源。</div>`;
    return;
  }
  const recommendation = aepPreviewRecommendation(comp);
  const preview = state.aep.previewFiles[comp.id];
  const previewTime = state.aep.previewTimes[comp.id] ?? recommendation.time_seconds ?? 2;
  const previewMarkup = preview?.preview_file
    ? `<button class="aep-preview-trigger" type="button" data-aep-action="open-preview" aria-label="打开${escapeHtml(comp.name)}预览大图"><img src="${escapeHtml(fileUrl(preview.preview_file))}" alt="${escapeHtml(comp.name)} 预览" /></button><span class="aep-preview-hint">点击查看大图 · 滚轮缩放</span>`
    : `<div class="aep-preview-empty">尚未生成预览<br /><span>默认取 ${escapeHtml(Number(recommendation.time_seconds || 0).toFixed(2))} 秒 · 帧 ${escapeHtml(recommendation.frame || 0)}</span></div>`;
  const parentNames = (comp.parent_names || []).join("、") || "无（顶层合成）";
  const childNames = (comp.child_names || []).join("、") || "无直属预合成";
  elements.aepInspector.innerHTML = `<div class="aep-inspector-title"><span>${escapeHtml(comp.name)}</span><small>${escapeHtml(comp.role || "合成")}</small></div>
    <div class="aep-inspector-card"><div class="aep-preview-box">${previewMarkup}</div><div class="aep-inspector-actions"><button class="quiet-btn" type="button" data-aep-action="preview" ${state.aep.previewBusy ? "disabled" : ""}>${state.aep.previewBusy ? "渲染中…" : "生成预览"}</button><button class="primary-btn" type="button" data-aep-action="toggle-check">${state.aep.checkedIds.has(comp.id) ? "移出队列" : "加入队列"}</button></div><label class="field-label" style="display:block;margin-top:9px;">代表帧秒数<input class="text-input" data-aep-preview-time="${escapeHtml(comp.id)}" type="number" min="0" step="0.01" value="${escapeHtml(Number(previewTime).toFixed(2))}" /></label></div>
    <div class="aep-inspector-card"><h3>Composition facts</h3><div class="aep-detail-grid"><div><span>尺寸</span><strong>${escapeHtml(`${comp.width} × ${comp.height}`)}</strong></div><div><span>时长 / 帧率</span><strong>${escapeHtml(`${Number(comp.duration || 0).toFixed(2)}s · ${comp.frame_rate}fps`)}</strong></div><div><span>合成 ID</span><strong>${escapeHtml(comp.id)}</strong></div><div><span>父级数量</span><strong>${escapeHtml((comp.parent_ids || []).length)}</strong></div></div></div>
    <div class="aep-inspector-card"><h3>关系与取景</h3><div class="aep-detail-grid"><div><span>父级合成</span><strong title="${escapeHtml(parentNames)}">${escapeHtml(parentNames)}</strong></div><div><span>直属预合成</span><strong title="${escapeHtml(childNames)}">${escapeHtml(childNames)}</strong></div><div><span>预览来源</span><strong title="${escapeHtml(recommendation.reason || "")}">${escapeHtml(recommendation.source_name || comp.name)}</strong></div><div><span>默认时间</span><strong>${escapeHtml(`${Number(recommendation.time_seconds || 0).toFixed(2)}s · 帧 ${recommendation.frame || 0}`)}</strong></div></div></div>
    <div class="aep-inspector-card"><h3>收集状态</h3><div class="aep-detail-grid"><div><span>独立交付</span><strong>${state.aep.checkedIds.has(comp.id) ? "已加入队列" : "未选择"}</strong></div><div><span>子合成</span><strong>${escapeHtml((comp.child_ids || []).length)} 个依赖</strong></div></div></div>`;
}

function setPreviewZoom(view, stage, readout, value, anchor = null) {
  const currentZoom = view.previewZoom || 1;
  const zoom = Math.min(8, Math.max(0.25, Number(value) || 1));
  if (anchor && stage && currentZoom > 0) {
    const rect = stage.getBoundingClientRect();
    if (rect.width && rect.height) {
      const anchorX = anchor.clientX - rect.left - rect.width / 2;
      const anchorY = anchor.clientY - rect.top - rect.height / 2;
      const ratio = zoom / currentZoom;
      view.previewPanX = anchorX - (anchorX - view.previewPanX) * ratio;
      view.previewPanY = anchorY - (anchorY - view.previewPanY) * ratio;
    }
  }
  if (zoom <= 1.01) {
    view.previewPanX = 0;
    view.previewPanY = 0;
  }
  view.previewZoom = zoom;
  if (stage) {
    stage.style.setProperty("--preview-scale", zoom.toFixed(3));
    stage.style.setProperty("--preview-pan-x", `${view.previewPanX.toFixed(1)}px`);
    stage.style.setProperty("--preview-pan-y", `${view.previewPanY.toFixed(1)}px`);
    stage.classList.toggle("is-zoomed", zoom > 1.01 || Math.abs(view.previewPanX) > 0.5 || Math.abs(view.previewPanY) > 0.5);
  }
  if (readout) readout.textContent = `${Math.round(zoom * 100)}%`;
}

function setAepPreviewZoom(value, anchor = null) {
  setPreviewZoom(state.aep, elements.aepPreviewStage, elements.aepPreviewZoom, value, anchor);
}

function bindPreviewStageInteractions(stage, view, readout) {
  if (!stage) return;
  const isOpen = () => stage.closest(".modal-backdrop")?.classList.contains("open");
  stage.classList.add("preview-interaction-stage");
  stage.addEventListener("wheel", (event) => {
    if (!isOpen()) return;
    event.preventDefault();
    event.stopPropagation();
    const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaMode === 2 ? event.deltaY * stage.clientHeight : event.deltaY;
    setPreviewZoom(view, stage, readout, view.previewZoom * Math.exp(-delta * 0.0015), event);
  }, { passive: false });
  stage.addEventListener("pointerdown", (event) => {
    if (!isOpen() || event.button !== 0 || view.previewZoom <= 1.01) return;
    event.preventDefault();
    stage.setPointerCapture(event.pointerId);
    view.previewDrag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      panX: view.previewPanX,
      panY: view.previewPanY,
    };
    stage.classList.add("is-dragging");
  });
  stage.addEventListener("pointermove", (event) => {
    const drag = view.previewDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    view.previewPanX = drag.panX + event.clientX - drag.startX;
    view.previewPanY = drag.panY + event.clientY - drag.startY;
    setPreviewZoom(view, stage, readout, view.previewZoom);
  });
  const endDrag = (event) => {
    const drag = view.previewDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId);
    view.previewDrag = null;
    stage.classList.remove("is-dragging");
  };
  stage.addEventListener("pointerup", endDrag);
  stage.addEventListener("pointercancel", endDrag);
  stage.addEventListener("dblclick", (event) => {
    if (!isOpen()) return;
    event.preventDefault();
    const nextZoom = view.previewZoom > 1.01 ? 1 : 2;
    setPreviewZoom(view, stage, readout, nextZoom, nextZoom > 1 ? event : null);
  });
  setPreviewZoom(view, stage, readout, view.previewZoom);
}

function openAepPreviewModal() {
  const comp = aepComposition(state.aep.activeCompId);
  const preview = comp && state.aep.previewFiles[comp.id];
  if (!comp || !preview?.preview_file) {
    showToast("暂无预览图", "请先点击“生成预览”，再打开预览大图。", "error");
    return;
  }
  elements.aepPreviewTitle.textContent = `${comp.name} · 预览大图`;
  elements.aepPreviewSub.textContent = `${comp.width} × ${comp.height} · ${Number(preview.preview_time || 0).toFixed(2)} 秒 · ${preview.preview_source_name || comp.name}`;
  elements.aepPreviewImage.src = fileUrl(preview.preview_file);
  elements.aepPreviewImage.alt = `${comp.name} 预览大图`;
  state.aep.previewPanX = 0;
  state.aep.previewPanY = 0;
  state.aep.previewDrag = null;
  elements.aepPreviewStage?.classList.remove("is-dragging");
  setAepPreviewZoom(1);
  openModal(elements.aepPreviewModal);
  elements.aepPreviewStage?.focus({ preventScroll: true });
}

function renderAepQueue() {
  const selected = aepCompositions().filter((item) => state.aep.checkedIds.has(item.id));
  const rows = selected.map((comp) => `<div class="aep-queue-row"><span>${escapeHtml(comp.name)}</span><small>${escapeHtml(`${comp.width}×${comp.height}`)} · 等待收集</small></div>`).join("");
  elements.aepInspector?.querySelector("[data-aep-queue]")?.remove();
  if (elements.aepInspector && selected.length) {
    elements.aepInspector.insertAdjacentHTML("beforeend", `<div class="aep-inspector-card" data-aep-queue><h3>Collection queue</h3><div class="aep-queue">${rows}</div></div>`);
  }
}

function setAepActive(compId) {
  state.aep.activeCompId = Number(compId);
  renderAepTree();
  renderAepInspector();
  renderAepQueue();
}

function defaultAepOutput() {
  if (!state.aep.aepPath) return "";
  const source = path.basename(state.aep.aepPath, path.extname(state.aep.aepPath));
  return path.join(path.dirname(state.aep.aepPath), `${source}_Xbot_Collected`);
}

function setAepBusy(busy, label = "Worker 待命") {
  state.aep.collecting = busy;
  elements.aepWorkerState.textContent = label;
  updateAepActions();
}

async function inspectAepProject() {
  if (!state.aep.aepPath) return;
  try {
    const workerPath = resolveWorkerPath();
    setAepBusy(true, `Worker · ${path.basename(workerPath)}`);
    log(`开始读取 AEP：${state.aep.aepPath}`);
    const project = await inspectAep(state.aep.aepPath);
    state.aep.project = project;
    state.aep.checkedIds.clear();
    state.aep.previewFiles = {};
    state.aep.previewTimes = {};
    state.aep.filter = "all";
    const roots = aepCompositions().filter((item) => !(item.parent_ids || []).length);
    state.aep.expandedIds = new Set(roots.map((item) => item.id));
    const candidate = aepCompositions().find(aepIsCandidate) || aepCompositions()[0];
    state.aep.activeCompId = candidate?.id || null;
    if (!elements.aepOutput.value.trim()) elements.aepOutput.value = defaultAepOutput();
    renderAepTree();
    renderAepInspector();
    renderAepQueue();
    log(`结构读取完成：${project.composition_count || aepCompositions().length} 个合成，${project.item_count || 0} 个项目项。`);
    showToast("AEP 结构已读取", "现在可以在结构树中勾选独立交付对象。", "normal");
  } catch (error) {
    log(`AEP 读取失败：${error.message}`);
    showToast("AEP 读取失败", error.message, "error");
  } finally {
    setAepBusy(false, state.aep.project ? "Worker 就绪" : "Worker 待命");
    renderAepInspector();
  }
}

async function previewAepComposition() {
  const comp = aepComposition(state.aep.activeCompId);
  if (!comp || !state.aep.aepPath || state.aep.previewBusy) return;
  try {
    state.aep.previewBusy = true;
    elements.aepWorkerState.textContent = "正在渲染预览…";
    renderAepInspector();
    const result = await previewAep(state.aep.aepPath, comp.id, {
      time: state.aep.previewTimes[comp.id],
    });
    state.aep.previewFiles[comp.id] = result;
    state.aep.previewTimes[comp.id] = result.preview_time;
    log(`预览完成：${comp.name} · ${result.preview_source_name || comp.name} · ${Number(result.preview_time || 0).toFixed(3)} 秒`);
    showToast("预览已生成", `${comp.name} 的代表帧已准备好。`);
  } catch (error) {
    log(`预览失败：${error.message}`);
    showToast("预览失败", error.message, "error");
  } finally {
    state.aep.previewBusy = false;
    elements.aepWorkerState.textContent = "Worker 就绪";
    renderAepInspector();
    renderAepQueue();
  }
}

async function collectAepSelection() {
  const selectedIds = aepCompositions().filter((item) => state.aep.checkedIds.has(item.id)).map((item) => item.id);
  const outputRoot = String(elements.aepOutput.value || "").trim() || defaultAepOutput();
  if (!state.aep.aepPath || !selectedIds.length || !outputRoot) {
    showToast("还不能开始收集", "请选择 AEP、至少一个合成，并填写输出目录。", "error");
    return;
  }
  try {
    setAepBusy(true, `正在收集 ${selectedIds.length} 个合成…`);
    elements.aepCollectBtn.textContent = "收集中…";
    log(`开始收集 ${selectedIds.length} 个合成，输出到：${outputRoot}`);
    const results = await collectAep(state.aep.aepPath, selectedIds, outputRoot, {
      previewTimes: state.aep.previewTimes,
    });
    const previewCount = results.filter((item) => item.preview_file).length;
    const missingCount = results.filter((item) => (item.missing_files || []).length).length;
    results.forEach((item) => log(`完成“${item.composition_name}”：${item.preview_file ? "PNG + " : ""}ZIP + manifest${item.preview_error ? `；预览失败：${item.preview_error}` : ""}`));
    state.sourceDir = outputRoot;
    const projectName = elements.projectName.value.trim() || path.basename(state.aep.aepPath, path.extname(state.aep.aepPath));
    elements.projectName.value = projectName;
    state.importStage = 1;
    const scan = scanDirectory(outputRoot, { projectName });
    render(scan);
    setView("import");
    showToast("AEP 收集完成", `${results.length} 个收集包已生成，${previewCount} 张 PNG 已配对；${missingCount ? `${missingCount} 项存在缺失素材，请在预检中处理。` : "现在进入 PNG + ZIP 配对预检。"}`);
  } catch (error) {
    log(`AEP 收集失败：${error.message}`);
    showToast("AEP 收集失败", error.message, "error");
  } finally {
    elements.aepCollectBtn.textContent = "收集并进入配对预检";
    setAepBusy(false, "Worker 就绪");
  }
}

function setView(view) {
  const allowed = ["import", "aep", "formal", "history", "diagnostics"];
  if (!allowed.includes(view)) return;
  state.activeView = view;
  document.body.dataset.activeView = view;
  window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  const workflowStage = view === "import" ? (state.importStage || 1) : view === "aep" ? 0 : 3;
  document.querySelectorAll(".workflow-step").forEach((step) => {
    const stage = Number(step.dataset.workflowStep || 0);
    step.classList.toggle("active", stage === workflowStage);
    step.classList.toggle("done", stage > 0 && stage < workflowStage);
  });
  document.querySelectorAll(".workspace-view").forEach((section) => {
    const active = section.id === `view-${view}`;
    section.hidden = !active;
    section.classList.toggle("active", active);
  });
  document.querySelectorAll(".main-tab[data-view]").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.view === view);
    tab.setAttribute("aria-selected", tab.dataset.view === view ? "true" : "false");
  });
  if (view === "formal") refreshBatches();
}

function resolvePickedDirectory(files) {
  if (!files || files.length === 0) return null;
  const first = files[0];
  const directPath = typeof first.path === "string" && first.path ? first.path : "";
  if (directPath && fileStat(directPath)?.isDirectory()) return path.resolve(directPath);
  if (directPath && first.webkitRelativePath) {
    const depth = first.webkitRelativePath.split("/").length - 1;
    let dir = directPath;
    for (let i = 0; i < depth; i += 1) dir = path.dirname(dir);
    return fileStat(dir)?.isDirectory() ? path.resolve(dir) : null;
  }
  return null;
}

function droppedFiles(dataTransfer) {
  const files = Array.from(dataTransfer?.files || []).filter(Boolean);
  if (files.length > 0) return files;
  return Array.from(dataTransfer?.items || [])
    .filter((item) => item.kind === "file" && typeof item.getAsFile === "function")
    .map((item) => {
      try {
        return item.getAsFile();
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function commonDirectory(filePaths) {
  if (filePaths.length === 0) return null;
  let candidate = path.dirname(filePaths[0]);
  for (const filePath of filePaths.slice(1)) {
    const directory = path.dirname(filePath);
    while (candidate) {
      const relative = path.relative(candidate, directory);
      if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) break;
      const parent = path.dirname(candidate);
      if (parent === candidate) return null;
      candidate = parent;
    }
  }
  return candidate;
}

function normalizeDroppedPath(value) {
  if (typeof value !== "string") return null;
  let raw = value.trim().replace(/^['"]|['"]$/g, "");
  if (!raw || raw.startsWith("#")) return null;
  if (raw.toLocaleLowerCase().startsWith("file://")) {
    try {
      const url = new URL(raw);
      raw = decodeURIComponent(url.pathname);
      if (/^\/[A-Za-z]:/.test(raw)) raw = raw.slice(1);
    } catch {
      return null;
    }
  }
  return raw.replaceAll("/", path.sep);
}

function droppedPathCandidates(dataTransfer) {
  const candidates = [];
  const add = (value) => {
    const normalized = normalizeDroppedPath(value);
    if (normalized && !candidates.includes(normalized)) candidates.push(normalized);
  };
  if (typeof dataTransfer?.getData === "function") {
    for (const type of ["text/uri-list", "text/plain"]) {
      let data = "";
      try {
        data = dataTransfer.getData(type);
      } catch {
        continue;
      }
      if (!data) continue;
      data.split(/\r?\n/).forEach(add);
    }
  }
  return candidates;
}

function directoryFromPath(candidate) {
  if (!candidate) return null;
  const resolved = path.resolve(candidate);
  const stat = fileStat(resolved);
  if (stat?.isDirectory()) return resolved;
  if (stat?.isFile()) {
    const parent = path.dirname(resolved);
    return fileStat(parent)?.isDirectory() ? parent : null;
  }
  return null;
}

function resolveDroppedDirectory(dataTransfer) {
  const files = droppedFiles(dataTransfer);
  const textPaths = droppedPathCandidates(dataTransfer);
  for (const candidate of textPaths) {
    if (fileStat(candidate)?.isDirectory()) return path.resolve(candidate);
  }

  for (const file of files) {
    const directPath = typeof file.path === "string" && file.path ? file.path : "";
    const directory = directoryFromPath(directPath);
    if (directory && fileStat(directPath)?.isDirectory()) return directory;
  }

  if (files.length === 0) return null;

  const pickedDirectory = resolvePickedDirectory(files);
  if (pickedDirectory) return pickedDirectory;

  const filePaths = files
    .map((file) => (typeof file.path === "string" && file.path ? path.resolve(file.path) : ""))
    .filter(Boolean);
  const directory = commonDirectory(filePaths);
  if (directory && fileStat(directory)?.isDirectory()) return directory;

  for (const candidate of textPaths) {
    const fallback = directoryFromPath(candidate);
    if (fallback) return fallback;
  }
  return null;
}

function setSourceDirectory(sourceDir) {
  if (!sourceDir) return false;
  const resolved = path.resolve(sourceDir);
  if (!fileStat(resolved)?.isDirectory()) return false;
  state.sourceDir = resolved;
  state.importStage = 1;
  elements.scanBtn.disabled = false;
  elements.batchInfo.textContent = `已选择：${state.sourceDir}`;
  elements.dropZone?.classList.add("has-folder");
  if (elements.dropLabel) elements.dropLabel.textContent = `已选择：${state.sourceDir}`;
  return true;
}

function isFileDrag(event) {
  return Array.from(event.dataTransfer?.items || []).some((item) => item.kind === "file")
    || Array.from(event.dataTransfer?.types || []).includes("Files");
}

function scanSelectedDirectory() {
  if (!state.sourceDir) return false;
  try {
    state.activeView = "import";
    state.importStage = 1;
    const scan = scanDirectory(state.sourceDir, { projectName: elements.projectName.value.trim() || undefined });
    render(scan);
    setView("import");
    return true;
  } catch (error) {
    log(`扫描失败：${error.message}`);
    showToast("扫描失败", error.message, "error");
    return false;
  }
}

document.addEventListener("click", (event) => {
  const viewButton = event.target.closest("[data-view]");
  if (viewButton) { setView(viewButton.dataset.view); return; }
  const aepFilter = event.target.closest("[data-aep-filter]");
  if (aepFilter) {
    state.aep.filter = aepFilter.dataset.aepFilter || "all";
    renderAepTree();
    renderAepInspector();
    renderAepQueue();
    return;
  }
  const aepExpander = event.target.closest("[data-aep-expander]");
  if (aepExpander) {
    const compId = Number(aepExpander.dataset.aepExpander);
    if (state.aep.expandedIds.has(compId)) state.aep.expandedIds.delete(compId);
    else state.aep.expandedIds.add(compId);
    renderAepTree();
    return;
  }
  const aepName = event.target.closest("[data-aep-name]");
  if (aepName) {
    setAepActive(aepName.dataset.aepName);
    renderAepQueue();
    return;
  }
  const aepAction = event.target.closest("[data-aep-action]");
  if (aepAction) {
    if (aepAction.dataset.aepAction === "preview") previewAepComposition();
    if (aepAction.dataset.aepAction === "open-preview") openAepPreviewModal();
    if (aepAction.dataset.aepAction === "toggle-check") {
      const comp = aepComposition(state.aep.activeCompId);
      if (comp) {
        if (state.aep.checkedIds.has(comp.id)) state.aep.checkedIds.delete(comp.id);
        else state.aep.checkedIds.add(comp.id);
        renderAepTree();
        renderAepInspector();
        renderAepQueue();
      }
    }
    return;
  }
  const aepPreviewZoomAction = event.target.closest("[data-aep-preview-zoom]");
  if (aepPreviewZoomAction) {
    const action = aepPreviewZoomAction.dataset.aepPreviewZoom;
    if (action === "in") setAepPreviewZoom(state.aep.previewZoom * 1.25);
    if (action === "out") setAepPreviewZoom(state.aep.previewZoom * 0.8);
    if (action === "reset") setAepPreviewZoom(1);
    return;
  }
  const assetPreviewZoomAction = event.target.closest("[data-asset-preview-zoom]");
  if (assetPreviewZoomAction) {
    const stage = elements.assetBody.querySelector("[data-asset-preview-stage]");
    const readout = elements.assetBody.querySelector("[data-asset-preview-zoom-readout]");
    if (stage) {
      const action = assetPreviewZoomAction.dataset.assetPreviewZoom;
      if (action === "in") setPreviewZoom(state.assetPreview, stage, readout, state.assetPreview.previewZoom * 1.25);
      if (action === "out") setPreviewZoom(state.assetPreview, stage, readout, state.assetPreview.previewZoom * 0.8);
      if (action === "reset") setPreviewZoom(state.assetPreview, stage, readout, 1);
    }
    return;
  }
  const packageCard = event.target.closest(".package-card[data-package-id]");
  if (packageCard && state.scan && !event.target.closest("input, select, button, [data-asset-action]")) {
    document.querySelectorAll("#packageRows .package-card").forEach((card) => card.classList.remove("selected"));
    packageCard.classList.add("selected");
    state.selectedPackageId = packageCard.dataset.packageId;
    const pkg = state.scan.packages.find((item) => String(item.packageId) === String(packageCard.dataset.packageId));
    if (pkg) showToast("已选择包装", `${pkg.packageName || "未命名包装"} · ${statusLabel(pkg.state)}`);
    return;
  }
  const assetAction = event.target.closest("[data-asset-action]");
  if (assetAction && state.scan && !event.target.closest("button")) {
    openAssetModal(assetAction.dataset.assetAction, assetAction.dataset.packageId);
    return;
  }
  const packageEditAction = event.target.closest("[data-package-edit-action]");
  if (packageEditAction && state.scan) {
    const panel = packageEditAction.closest("[data-package-edit-panel]");
    const packageId = panel?.dataset.packageEditPanel;
    const kind = packageEditAction.dataset.packageEditKind || state.editingPackageKind || "preview";
    if (packageEditAction.dataset.packageEditAction === "apply") {
      applyPackageMatch(packageId, panel, kind);
    } else if (packageEditAction.dataset.packageEditAction === "restore") {
      restorePackageMatch(packageId, kind);
    }
    return;
  }
  const assetChange = event.target.closest(".asset-change-btn[data-package-edit-kind]");
  if (assetChange && state.scan) {
    const card = assetChange.closest(".package-card[data-package-id]");
    state.selectedPackageId = card?.dataset.packageId || null;
    const kind = assetChange.dataset.packageEditKind;
    const sameEdit = state.editingPackageId === state.selectedPackageId && state.editingPackageKind === kind;
    if (!sameEdit) state.pendingPackageEdit = null;
    state.editingPackageKind = sameEdit ? null : kind;
    state.editingPackageId = state.editingPackageKind ? state.selectedPackageId : null;
    render(state.scan);
    return;
  }
  const planCardElement = event.target.closest(".plan-card[data-pair-id]");
  if (planCardElement && state.filePlan) {
    document.querySelectorAll("#filePlanRows .plan-card").forEach((card) => card.classList.remove("selected"));
    planCardElement.classList.add("selected");
    const pair = [...(state.filePlan.readyPairs || []), ...(state.filePlan.reviewPairs || [])].find((item) => String(item.packageId) === String(planCardElement.dataset.pairId));
    if (pair) showPackageInspector(pair);
    return;
  }
  const filter = event.target.closest("[data-plan-filter]");
  if (filter) { applyPlanFilter(filter.dataset.planFilter); return; }
  const duplicateChoice = event.target.closest("[data-duplicate-mode]");
  if (duplicateChoice && state.scan) {
    elements.importMode.value = duplicateChoice.dataset.duplicateMode;
    closeModals();
    runImport();
    return;
  }
  const token = event.target.closest("[data-token]");
  if (token) {
    const input = renameFocus === "source" ? elements.sourceTemplate : elements.previewTemplate;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    input.value = `${input.value.slice(0, start)}${token.dataset.token}${input.value.slice(end)}`;
    input.focus();
    input.setSelectionRange(start + token.dataset.token.length, start + token.dataset.token.length);
    applyRenameRule();
    return;
  }
  const action = event.target.closest("[data-action]");
  if (!action) return;
  const type = action.dataset.action;
  if (type === "show-rename") openRenameModal();
  if (type === "show-duplicate") openModal(elements.duplicateModal);
  if (type === "toggle-theme") { document.body.dataset.theme = document.body.dataset.theme === "dark" ? "light" : "dark"; }
  if (type === "reset-rename") { elements.previewTemplate.value = "{项目}_{类型}_{包装}_{版本}"; elements.sourceTemplate.value = "{项目}_{包装}_{版本}"; applyRenameRule(); }
  if (type === "apply-rename") applyRenameRule();
  if (type === "validate-rename") validateRename();
  if (type === "confirm-rename") confirmRename();
  if (type === "toast") showToast(action.dataset.title || "已完成", action.dataset.message || "操作已完成。");
});

document.addEventListener("input", (event) => {
  const aepTime = event.target.closest("[data-aep-preview-time]");
  if (aepTime) {
    const value = Number(aepTime.value);
    if (Number.isFinite(value) && value >= 0) {
      state.aep.previewTimes[Number(aepTime.dataset.aepPreviewTime)] = value;
    }
    return;
  }
  const input = event.target.closest("[data-package-name]");
  if (!input || !state.scan) return;
  const pkg = packageById(input.dataset.packageName);
  if (!pkg) return;
  pkg.packageName = input.value;
  pkg.nameEdited = true;
  state.selectedPackageId = pkg.packageId;
});

document.addEventListener("change", (event) => {
  const aepCheck = event.target.closest("[data-aep-check]");
  if (aepCheck) {
    const compId = Number(aepCheck.dataset.aepCheck);
    if (aepCheck.checked) state.aep.checkedIds.add(compId);
    else state.aep.checkedIds.delete(compId);
    setAepActive(compId);
    renderAepQueue();
    return;
  }
  const packageTypeSelect = event.target.closest("[data-package-type]");
  if (packageTypeSelect && state.scan) {
    const pkg = packageById(packageTypeSelect.dataset.packageType);
    if (!pkg) return;
    pkg.packageType = String(packageTypeSelect.value || "").trim() || null;
    state.selectedPackageId = pkg.packageId;
    refreshScanDerivedState();
    render(state.scan);
    if (pkg.packageType) {
      showToast("包装类型已更新", `${pkg.packageName || "当前包装"} 已归入“${pkg.packageType}”，可继续检查后入库。`);
    } else {
      showToast("仍待补充包装类型", "请选择信息条、视频框、背景或分镜排版后才能直接入库。", "error");
    }
    return;
  }
  const select = event.target.closest("[data-package-edit-field]");
  if (!select || !state.scan) return;
  const panel = select.closest("[data-package-edit-panel]");
  const packageId = panel?.dataset.packageEditPanel;
  const kind = select.dataset.packageEditField;
  const pkg = packageById(packageId);
  if (!pkg || !["preview", "source"].includes(kind)) return;
  const selectedFile = scanFileAt(state.scan, select.value || "");
  const selectedPath = selectedFile?.path || "";
  const currentPath = packagePath(pkg, kind);
  state.pendingPackageEdit = path.resolve(selectedPath || "") === path.resolve(currentPath || "")
    ? null
    : { packageId: pkg.packageId, kind, path: selectedPath, relative: selectedFile?.relative || "" };
  state.selectedPackageId = pkg.packageId;
  state.editingPackageId = pkg.packageId;
  state.editingPackageKind = kind;
  render(state.scan);
  showToast("已更新预览", state.pendingPackageEdit
    ? `新的${assetLabel(kind)}已即时显示，点击应用后正式写入配对。`
    : `已恢复当前${assetLabel(kind)}。`);
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeModals();
  const assetAction = event.target.closest("[data-asset-action]");
  if (assetAction && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    openAssetModal(assetAction.dataset.assetAction, assetAction.dataset.packageId);
  }
});

document.querySelectorAll("[data-close-modal]").forEach((button) => button.addEventListener("click", closeModals));
document.querySelectorAll(".modal-backdrop").forEach((backdrop) => backdrop.addEventListener("click", (event) => { if (event.target === backdrop) closeModals(); }));
elements.folderPicker.addEventListener("change", () => {
  const sourceDir = resolvePickedDirectory(elements.folderPicker.files);
  if (!setSourceDirectory(sourceDir)) {
    showToast("无法读取文件夹", "请在 Eagle 内选择本地项目包装文件夹。", "error");
  }
});
elements.dropZone.addEventListener("dragenter", (event) => {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  state.dragDepth += 1;
  elements.dropZone.classList.add("is-dragover");
  if (!state.sourceDir && elements.dropLabel) elements.dropLabel.textContent = "松开鼠标后自动读取文件夹并开始扫描";
});
elements.dropZone.addEventListener("dragover", (event) => {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
  elements.dropZone.classList.add("is-dragover");
});
elements.dropZone.addEventListener("dragleave", (event) => {
  state.dragDepth = Math.max(0, state.dragDepth - 1);
  if (state.dragDepth > 0) return;
  elements.dropZone.classList.remove("is-dragover");
  if (!state.sourceDir && elements.dropLabel) elements.dropLabel.textContent = "拖入文件夹后自动扫描；也支持收集器输出的 PNG、ZIP、manifest";
});
elements.dropZone.addEventListener("drop", (event) => {
  event.preventDefault();
  state.dragDepth = 0;
  elements.dropZone.classList.remove("is-dragover");
  const sourceDir = resolveDroppedDirectory(event.dataTransfer);
  if (!setSourceDirectory(sourceDir)) {
    if (elements.dropLabel) elements.dropLabel.textContent = "拖入文件夹后自动扫描；也支持收集器输出的 PNG、ZIP、manifest";
    showToast("拖入失败", "Eagle 未返回文件夹的本地路径，请改用“选择文件夹”或在 Eagle 内重新拖入。", "error");
    return;
  }
  if (scanSelectedDirectory()) showToast("已扫描文件夹", "已进入 PNG + ZIP 配对预检。", "success");
});
elements.scanBtn.addEventListener("click", scanSelectedDirectory);
elements.aepPicker.addEventListener("change", () => {
  const file = elements.aepPicker.files?.[0];
  const aepPath = file?.path || "";
  state.aep.aepPath = aepPath && path.extname(aepPath).toLocaleLowerCase() === ".aep" ? aepPath : null;
  state.aep.project = null;
  state.aep.checkedIds.clear();
  state.aep.previewFiles = {};
  state.aep.previewTimes = {};
  setAepPreviewZoom(1);
  elements.aepFileLabel.textContent = state.aep.aepPath ? path.basename(state.aep.aepPath) : "无法读取 AEP 本地路径";
  elements.aepOutput.value = defaultAepOutput();
  renderAepTree();
  renderAepInspector();
  renderAepQueue();
  updateAepActions();
  if (!state.aep.aepPath) showToast("AEP 路径不可用", "请在 Eagle 内选择本地 .aep 文件；当前浏览器预览无法提供本地路径。", "error");
});
elements.aepInspectBtn.addEventListener("click", inspectAepProject);
elements.aepDefaultOutputBtn.addEventListener("click", () => { elements.aepOutput.value = defaultAepOutput(); updateAepActions(); });
elements.aepOutput.addEventListener("input", updateAepActions);
elements.aepSearch.addEventListener("input", () => { state.aep.search = elements.aepSearch.value; renderAepTree(); });
elements.aepExpandBtn.addEventListener("click", () => { state.aep.expandedIds = new Set(aepCompositions().filter((item) => (item.child_ids || []).length).map((item) => item.id)); renderAepTree(); });
elements.aepCollapseBtn.addEventListener("click", () => { state.aep.expandedIds.clear(); renderAepTree(); });
elements.aepSelectVisibleBtn.addEventListener("click", () => { aepCompositions().filter(aepMatches).forEach((item) => state.aep.checkedIds.add(item.id)); renderAepTree(); renderAepInspector(); renderAepQueue(); });
elements.aepClearBtn.addEventListener("click", () => { state.aep.checkedIds.clear(); renderAepTree(); renderAepInspector(); renderAepQueue(); });
elements.aepCollectBtn.addEventListener("click", collectAepSelection);
bindPreviewStageInteractions(elements.aepPreviewStage, state.aep, elements.aepPreviewZoom);
elements.projectName.addEventListener("input", () => { if (state.scan && elements.projectName.value.trim()) state.scan.projectName = elements.projectName.value.trim(); });
elements.importBtn.addEventListener("click", runImport);
elements.reloadBatchBtn.addEventListener("click", refreshBatches);
elements.batchSelect.addEventListener("change", () => { state.fileOverrides = {}; state.nameOverrides = {}; state.selectedPair = null; loadFilePlan(); });
elements.fileBtn.addEventListener("click", loadFilePlan);
elements.confirmFileBtn.addEventListener("click", confirmFile);
elements.packageInspector.addEventListener("change", (event) => { const select = event.target.closest("[data-inspector-type]"); if (!select || !state.fileInspection) return; state.fileOverrides[select.dataset.inspectorType] = { packageType: select.value }; loadFilePlan(); });
elements.renameRows.addEventListener("focusin", (event) => { const input = event.target.closest(".rename-input"); if (input) renameFocus = input.dataset.renameKind; });
elements.renameRows.addEventListener("input", (event) => { const input = event.target.closest(".rename-input"); if (input) updateNameOverride(input); });
elements.previewTemplate.addEventListener("focus", () => { renameFocus = "preview"; });
elements.sourceTemplate.addEventListener("focus", () => { renameFocus = "source"; });
elements.previewTemplate.addEventListener("input", () => applyRenameRule(false));
elements.sourceTemplate.addEventListener("input", () => applyRenameRule(false));

(function detectEagle() {
  if (window.eagle && window.eagle.item && window.eagle.folder) {
    elements.apiState.textContent = "Eagle 插件 API 已连接";
    elements.apiDot.classList.add("ok");
    elements.diagApi.textContent = "已连接";
    elements.diagApi.className = "check-ok";
  } else {
    elements.apiState.textContent = "未检测到 Eagle API（浏览预览可用，导入需在 Eagle 内运行）";
    elements.diagApi.textContent = "未连接";
    elements.diagApi.className = "check-warn";
    elements.batchSelect.innerHTML = "<option>请在 Eagle 内运行</option>";
  }
})();
