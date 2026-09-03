/* global eagle */
const path = require("path");
const { scanDirectory } = require("../lib/scan.js");
const {
  EaglePluginAdapter,
  fileBatch,
  folderId,
  importBatch,
  IMPORT_MODES,
  inspectBatch,
  parseAnnotation,
  planFormalFile,
  INGEST_ROOT_NAME,
  KNOWN_PACKAGE_TYPES,
} = require("../lib/eagle-api.js");
const { publishIngestEvent } = require("../lib/ingest-bridge.js");

const state = {
  activeView: "formal",
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
};

const elements = {
  apiState: document.getElementById("apiState"),
  apiDot: document.getElementById("apiDot"),
  diagApi: document.getElementById("diagApi"),
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
  contextTitle: document.getElementById("contextTitle"),
  contextSub: document.getElementById("contextSub"),
  duplicateModal: document.getElementById("duplicateModal"),
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
  const target = state.activeView === "import" ? elements.log : elements.logFormal;
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
function closeModals() { document.querySelectorAll(".modal-backdrop").forEach((modal) => modal.classList.remove("open")); }

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
  const text = `${pkg.packageType || ""}${pkg.packageName || ""}`;
  if (/视频/.test(text)) return "thumb-blue";
  if (/信息|人名|标注/.test(text)) return "thumb-amber";
  if (/背景/.test(text)) return "thumb-green";
  return "thumb-ink";
}

function packageCard(pkg) {
  const preview = pkg.preview?.path || "";
  const source = pkg.source?.path || "";
  const previewImage = preview
    ? `<img src="${escapeHtml(fileUrl(preview))}" alt="" onerror="this.style.display='none'" />`
    : "";
  return `<article class="package-card" data-package-id="${escapeHtml(pkg.packageId || "")}" data-status="${escapeHtml(pkg.state || "")}">
    <div class="package-thumb ${packageTone(pkg)}"><span class="thumb-tag">PNG</span>${previewImage}</div>
    <div class="card-copy"><div class="card-title-row"><span class="card-title">${escapeHtml(pkg.packageName || "未命名包装")}</span>${badge(pkg.state)}</div>
      <div class="card-meta">${escapeHtml(pkg.packageType || "待补充类型")} · ${escapeHtml(pkg.version || "v01")} · ${escapeHtml(pkg.aeCompName || "未记录合成")}</div>
      <div class="card-files"><span class="file-pill">${preview ? "PNG ✓" : "PNG —"}</span><span class="file-pill">${source ? "ZIP ✓" : "ZIP —"}</span><span class="file-pill">${pkg.manifestPath ? "META ✓" : "META —"}</span></div>
    </div></article>`;
}

function render(scan) {
  state.scan = scan;
  elements.statToImport.textContent = String(scan.stats?.toImport ?? 0);
  elements.statValidate.textContent = String(scan.stats?.validateOnly ?? 0);
  elements.statIgnore.textContent = String(scan.stats?.ignore ?? 0);
  elements.statConflict.textContent = String(scan.stats?.conflict ?? 0);
  elements.batchInfo.textContent = `batch_id：${scan.batchId || "待生成"}`;
  elements.projectName.value = scan.projectName || elements.projectName.value;
  const packages = scan.packages || [];
  elements.packageRows.innerHTML = packages.length
    ? packages.map(packageCard).join("")
    : `<div class="empty-card" style="grid-column:1/-1;border:1px dashed var(--line-strong);border-radius:9px;padding:24px;text-align:center;color:var(--ink-faint);">没有识别到可审核的包装记录。</div>`;
  elements.fileRows.innerHTML = (scan.files || []).map((file) => `<div class="file-detail-row"><span title="${escapeHtml(file.relative)}">${escapeHtml(file.relative)}</span><span>${escapeHtml(file.kind || "-")}</span>${badge(file.status)}<span title="${escapeHtml(file.note || "")}">${escapeHtml(file.note || "")}</span></div>`).join("") || `<div class="file-detail-row"><span>暂无扫描文件</span></div>`;
  const readyCount = packages.filter((pkg) => pkg.state === "ready").length;
  const blockedCount = packages.filter((pkg) => pkg.state === "blocked").length;
  elements.importBtn.disabled = readyCount === 0 || blockedCount > 0;
  log(`扫描完成：${scan.stats?.toImport || 0} 个文件将导入，${blockedCount} 条记录被阻止`);
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
      elements.formalCount.textContent = "0";
      log("Eagle 中还没有 00_待入库 目录");
      return;
    }
    const rootChildrenIds = new Set((root.children || []).map(folderId).filter(Boolean));
    state.batchFolders = folders.filter((folder) => folderId(folder.parent) === folderId(root) || rootChildrenIds.has(folderId(folder))).sort((a, b) => String(a.name).localeCompare(String(b.name), "zh-CN"));
    elements.batchCount.textContent = `${state.batchFolders.length} 项`;
    elements.formalCount.textContent = String(state.batchFolders.length);
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
    log("正在调用 Eagle API 导入…");
    const result = await importBatch(adapter, state.scan, { mode });
    if (result.state === "duplicate") {
      state.pendingImport = result;
      elements.importBtn.disabled = false;
      const matched = result.matches.map((match) => `${match.batchId || match.batchFolderId}（${match.matchedBy.join("、")}）`).join("；");
      elements.duplicateSub.textContent = `匹配依据：${matched || "已有同名批次"}`;
      openModal(elements.duplicateModal);
      log("检测到重复批次，等待选择处理策略");
      return;
    }
    log(`导入完成：批次 ${result.batchId}，${result.imported.length + result.reused.length + result.updated.length} 条记录`);
    elements.batchInfo.textContent = `batch_id：${result.batchId}（已导入）`;
    showToast("导入完成", `批次已写入 ${INGEST_ROOT_NAME}，可以切换到正式入库。`);
    setView("formal");
  } catch (error) {
    log(`导入失败：${error.message}`);
    elements.importBtn.disabled = false;
    showToast("导入失败", error.message, "error");
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

function setView(view) {
  const allowed = ["import", "formal", "history", "diagnostics"];
  if (!allowed.includes(view)) return;
  state.activeView = view;
  window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  document.querySelectorAll(".workspace-tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.view === view));
  document.querySelectorAll(".workspace-view").forEach((section) => section.classList.toggle("active", section.id === `view-${view}`));
  const context = { import: ["导入待入库", "把本地项目整理进 Eagle 待入库批次"], formal: ["正式入库", "检查配对、补全元数据，再归位到正式目录"], history: ["批次记录", "让每一次入库都可以追溯"], diagnostics: ["系统诊断", "在操作前确认 Eagle 和入库环境"] }[view];
  elements.contextTitle.textContent = context[0];
  elements.contextSub.textContent = context[1];
  if (view === "formal") refreshBatches();
}

function resolvePickedDirectory(files) {
  if (!files || files.length === 0) return null;
  const first = files[0];
  if (typeof first.path === "string" && first.path && first.webkitRelativePath) {
    const depth = first.webkitRelativePath.split("/").length - 1;
    let dir = first.path;
    for (let i = 0; i < depth; i += 1) dir = path.dirname(dir);
    return dir;
  }
  return null;
}

document.addEventListener("click", (event) => {
  const viewButton = event.target.closest("[data-view]");
  if (viewButton) { setView(viewButton.dataset.view); return; }
  const packageCard = event.target.closest(".package-card[data-package-id]");
  if (packageCard && state.scan) {
    document.querySelectorAll("#packageRows .package-card").forEach((card) => card.classList.remove("selected"));
    packageCard.classList.add("selected");
    const pkg = state.scan.packages.find((item) => String(item.packageId) === String(packageCard.dataset.packageId));
    if (pkg) showToast("已选择包装", `${pkg.packageName || "未命名包装"} · ${statusLabel(pkg.state)}`);
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

document.querySelectorAll("[data-close-modal]").forEach((button) => button.addEventListener("click", closeModals));
document.querySelectorAll(".modal-backdrop").forEach((backdrop) => backdrop.addEventListener("click", (event) => { if (event.target === backdrop) closeModals(); }));
elements.folderPicker.addEventListener("change", () => { const sourceDir = resolvePickedDirectory(elements.folderPicker.files); elements.scanBtn.disabled = !sourceDir; if (sourceDir) { state.sourceDir = sourceDir; elements.batchInfo.textContent = `已选择：${sourceDir}`; } });
elements.scanBtn.addEventListener("click", () => { if (!state.sourceDir) return; try { state.activeView = "import"; const scan = scanDirectory(state.sourceDir, { projectName: elements.projectName.value.trim() || undefined }); render(scan); } catch (error) { log(`扫描失败：${error.message}`); showToast("扫描失败", error.message, "error"); } });
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
    refreshBatches();
  } else {
    elements.apiState.textContent = "未检测到 Eagle API（浏览预览可用，导入需在 Eagle 内运行）";
    elements.diagApi.textContent = "未连接";
    elements.diagApi.className = "check-warn";
    elements.batchSelect.innerHTML = "<option>请在 Eagle 内运行</option>";
  }
})();
