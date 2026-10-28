/* Production controller for the v5 preview-native Eagle workbench. */
const prodFs = require("fs");
const prodPath = require("path");
const { pathToFileURL: prodPathToFileURL } = require("url");
const prodManifest = require("../manifest.json");
const prodWorker = require("../lib/aep-worker.js");
const prodScan = require("../lib/scan.js");
const prodTypes = require("../lib/package-types.js");
const prodUpdater = require("../lib/updater.js");
const prodIngest = require("../lib/team-sync.js");
const prodTeam = require("../lib/team-client.js");
const prodEnvironment = require("../lib/environment-check.js");
const prodManagedApi = require("../lib/managed-assets.js");
const prodEagle = require("../lib/eagle-api.js");

let prodProject = "";
let prodSourceDir = "";
let prodScanResult = null;
let prodAepPath = "";
let prodAepProject = null;
let prodAepOutput = "";
let prodActiveId = null;
let prodActiveOccurrence = "";
let prodAepSelectedOccurrences = new Set();
let prodAepOccurrenceMap = new Map();
let prodCollapsedTreeOccurrences = new Set();
let prodCollectionAbort = null;
let prodManagedCards = [];
let prodManagedRecords = [];
let prodLatestRelease = null;
const prodUpdateState = { checking: false, downloading: false, checkedAt: 0, error: "", progress: "", file: null };
let prodTypeFile = "";
let prodPairRenderer = null;
let prodManageRenderer = null;
let prodOutputNames = {};
let prodPendingManagedTypeId = "";
let prodPendingPairTypeId = "";
let prodManageProjectFilter = "";
let prodManageTypeFilter = "";
let prodManageSearch = "";
let prodManageSyncFilter = "";
let prodManagedSyncBusy = false;
const prodManagedSyncRetrying = new Set();
let prodManageSort = "time";
let prodManageSortDirection = "desc";
const prodManageSortOptions = ["time", "name", "project", "type"];
const prodEsc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const prodToast = (title, message, kind = "normal") => toast(title, message, kind);
const prodAdapter = () => {
  if (!window.eagle?.item || !window.eagle?.folder) throw new Error("打开插件");
  return new prodEagle.EaglePluginAdapter(window.eagle);
};
const prodAllComps = () => prodAepProject?.compositions || [];
const prodComp = id => prodAllComps().find(item => String(item.id) === String(id));
const prodPair = id => pairs.find(item => String(item.id) === String(id));
const prodName = pkg => pkg.packageName || pkg.compName || pkg.name || "未命名包装";
const prodImageUrl = value => value ? prodPathToFileURL(String(value)).href : "";
function prodSetApiStatus(state) {
  const indicator = document.querySelector(".api"), label = indicator?.querySelector("span");
  if (!indicator || !label) return;
  indicator.classList.toggle("ready", state === "ready");
  indicator.classList.toggle("error", state === "error" || state === "unavailable");
  label.textContent = state === "ready" ? "已连接" : state === "error" ? "读取失败" : state === "unavailable" ? "无法连接" : "连接中";
}
const prodManageCardSizeOptions = ["small", "medium", "large"];
function prodSetManageCardSize(value, persist = false) {
  const size = prodManageCardSizeOptions.includes(value) ? value : "medium";
  const input = document.querySelector("#manageCardSize");
  const grid = document.querySelector("#manageGrid");
  const labels = { small: "小", medium: "中", large: "大" };
  if (grid) grid.dataset.cardSize = size;
  if (input) {
    input.value = String(prodManageCardSizeOptions.indexOf(size));
    input.setAttribute("aria-valuetext", labels[size]);
  }
  if (persist) {
    try { localStorage.setItem("xbot.manage-card-size.v1", size); } catch {}
  }
}

function prodRefreshTypes() {
  prodTypes.refreshPackageTypes();
  packageTypes.splice(0, packageTypes.length, ...prodTypes.PACKAGE_TYPES);
  for (const type of Object.keys(packageTypeAliases)) delete packageTypeAliases[type];
  for (const [type, aliases] of prodTypes.PACKAGE_TYPE_ALIASES) packageTypeAliases[type] = [...aliases];
  prodTypeFile = prodTypes.registryPath();
}

function prodSetScreen(next) {
  if (next === "aep") workflowDraft = { ...(workflowDraft || {}), kind: workflowDraft?.kind || "new-package", project: prodProject, sourceKind: "aep", stage: "aep" };
  if (next === "pair") workflowDraft = { ...(workflowDraft || {}), kind: workflowDraft?.kind || "new-package", project: prodProject, sourceKind: workflowDraft?.sourceKind || "folder", stage: "pair" };
  setScreen(next);
}

function prodMapPackage(pkg, index) {
  const preview = pkg.previewPath || pkg.preview?.path || "";
  const source = pkg.sourcePath || pkg.source?.path || "";
  const missingFiles = pkg.missingFiles || pkg.missingFootage || [];
  return {
    id: String(pkg.packageId || pkg.id || `pair-${index + 1}`), name: prodName(pkg), type: pkg.packageType || "",
    version: pkg.version || "v01", comp: pkg.aeCompName || pkg.compName || prodName(pkg),
    preview: preview ? prodPath.basename(preview) : "", source: source ? prodPath.basename(source) : "",
    previewPath: preview, sourcePath: source, state: pkg.state === "ready" ? "ready" : "review",
    selected: pkg.selectedForImport !== false && (pkg.state === "ready" || pkg.riskAccepted),
    tone: "", risk: Boolean(pkg.riskOverrideEligible || missingFiles.length), riskAccepted: Boolean(pkg.riskAccepted),
    missing: !preview || (!source && !prodTypes.isBackgroundType(pkg.packageType)), conflict: Boolean(pkg.conflict || pkg.ambiguous),
    packageId: pkg.packageId || "", basePackageId: pkg.basePackageId || "", note: (pkg.errors || []).join("；") || (pkg.warnings || []).join("；") || "图片和工程包已检查",
    missingFiles, _package: pkg,
  };
}

function prodRefreshPairState(pair) {
  const pkg = pair._package;
  if (!pkg) return;
  pkg.packageName = pair.name;
  pkg.packageType = prodTypes.normalizePackageType(pair.type) || pair.type;
  pair.type = pkg.packageType;
  pkg.version = pair.version || "v01";
  pkg.selectedForImport = Boolean(pair.selected);
  pkg.riskAccepted = Boolean(pair.riskAccepted);
  if (pair.previewPath) pkg.previewPath = pair.previewPath;
  else pkg.previewPath = "";
  if (pair.sourcePath) pkg.sourcePath = pair.sourcePath;
  else pkg.sourcePath = "";
  const hard = !pkg.previewPath || (!pkg.sourcePath && !prodTypes.isBackgroundType(pkg.packageType)) || !prodTypes.isPackageTypeActive(pkg.packageType) || pair.conflict;
  const riskPending = Boolean((pkg.missingFiles || pkg.missingFootage || []).length && !pkg.riskAccepted);
  pkg.state = hard || riskPending ? "blocked" : "ready";
  pkg.riskOverrideEligible = Boolean((pkg.missingFiles || pkg.missingFootage || []).length);
  pkg.errors = hard ? [!pkg.previewPath ? "缺少图片" : !pkg.sourcePath && !prodTypes.isBackgroundType(pkg.packageType) ? "缺少工程包" : !prodTypes.isPackageTypeActive(pkg.packageType) ? (prodTypes.normalizePackageType(pkg.packageType) ? "类型已停用，请更换或恢复" : "请先在设置中保存此类型") : "图片和工程包无法唯一对应"] : riskPending ? ["有素材缺失，确认影响后可保存"] : [];
  pkg.matchError = pkg.errors[0] || "";
  pair.state = pkg.state === "ready" ? "ready" : "review";
  pair.note = pair.state === "ready" ? (pkg.riskAccepted ? `风险已确认 · ${pkg.missingFiles?.join("、") || pkg.missingFootage?.join("、") || "素材缺失"}` : "文件已检查，可以保存") : pkg.errors.join("；");
}

function prodRenderPairs() {
  prodRefreshTypes();
  pairs.forEach(prodRefreshPairState);
  prodPairRenderer?.();
  const visible = pairs.filter(p => pairFilter === "all" || (pairFilter === "ready" && p.state === "ready") || (pairFilter === "review" && p.state !== "ready") || (pairFilter === "risk" && p.risk) || (pairFilter === "conflict" && p.conflict));
  visible.forEach(p => {
    const card = document.querySelector(`[data-pair="${CSS.escape(p.id)}"]`);
    if (!card) return;
    const previewButton = card.querySelector(".row-preview");
    previewButton?.classList.toggle("has-actual-preview", Boolean(p.previewPath));
    if (previewButton && p.previewPath) {
      previewButton.replaceChildren(Object.assign(document.createElement("img"), { src: prodImageUrl(p.previewPath), alt: `${p.name} PNG 预览` }));
      previewButton.querySelector("img")?.classList.add("frame-art", "actual-preview-image");
    } else if (previewButton) previewButton.innerHTML = '<span class="preview-empty">暂无图片</span>';
    card.querySelector(".row-meta")?.replaceChildren(document.createTextNode(`${prodProject} · ${p.type || "选择类型"} · ${p.version}`));
    const chips = card.querySelector(".row-chips");
    if (chips) chips.innerHTML = [["preview", "预览图", p.preview], ["source", "工程包", p.source]].map(([kind, label, file]) => `<button type="button" class="tiny-pill asset-chip-button${file ? "" : " is-missing"}" data-card-asset="${kind}" data-pair="${prodEsc(p.id)}" title="${prodEsc(file || `${label} 缺失`)}" aria-label="更换 ${prodEsc(p.name)} 的 ${label}：${prodEsc(file || "缺失")}"><span class="asset-chip-label">${label}</span><span class="asset-chip-name">${prodEsc(file || "缺失")}</span></button>`).join("");
    const note = card.querySelector(".pair-note");
    if (note) note.textContent = p.note;
  });
}

function prodOpenPairFileDrawer(id, kind) {
  const pair = prodPair(id); if (!pair || !prodScanResult) return;
  const candidates = (prodScanResult.files || []).filter(file => file.kind === (kind === "preview" ? "png" : "zip") && file.status !== "ignore").slice();
  let selected = kind === "preview" ? pair.previewPath || "" : pair.sourcePath || "";
  const includeExternal = filePath => {
    if (!candidates.some(file => file.path === filePath)) candidates.push({ path: filePath, name: prodPath.basename(filePath), relative: filePath });
  };
  if (selected) includeExternal(selected);
  openDrawer(`<div class="drawer-head"><div><h2>更换${kind === "preview" ? "图片" : "工程"}</h2><p>${prodEsc(pair.name)} · 从已找到的文件中选择</p></div><button class="icon-btn" data-drawer-close>×</button></div><div class="drawer-body file-picker-body"><div class="candidate-list file-candidate-list"></div><button class="quiet" type="button" data-prod-pick-external>另选文件</button></div><div class="drawer-footer"><button class="ghost-btn" data-drawer-close>取消</button><button class="primary-btn" data-prod-apply-file="${prodEsc(pair.id)}" data-kind="${kind}" disabled>确认选择</button></div>`);
  const renderCandidates = () => {
    const list = document.querySelector(".file-candidate-list");
    list.innerHTML = candidates.map(file => `<div class="candidate${file.path === selected ? " selected" : ""}">${kind === "preview" ? `<button class="candidate-thumb candidate-preview has-actual-preview" type="button" data-prod-preview-file="${prodEsc(file.path)}" data-name="${prodEsc(file.name)}" aria-label="查看 ${prodEsc(file.name)} 大图"><img class="frame-art actual-preview-image" src="${prodImageUrl(file.path)}" alt=""></button>` : '<span class="candidate-thumb">ZIP</span>'}<button class="candidate-choice" type="button" data-prod-select-file="${prodEsc(file.path)}" aria-pressed="${file.path === selected}"><span class="candidate-copy"><strong>${prodEsc(file.name)}</strong>${file.relative && file.relative !== file.name ? `<small>${prodEsc(file.relative)}</small>` : ""}</span><span class="check">${file.path === selected ? "✓" : ""}</span></button></div>`).join("") || '<p>没有可选文件，请另选文件</p>';
    list.querySelectorAll("[data-prod-preview-file]").forEach(button => button.addEventListener("click", () => prodOpenImage(button.dataset.name, button.dataset.prodPreviewFile)));
    list.querySelectorAll("[data-prod-select-file]").forEach(button => button.addEventListener("click", () => { selected = button.dataset.prodSelectFile; renderCandidates(); }));
    const apply = document.querySelector("[data-prod-apply-file]"); if (apply) apply.disabled = !selected;
  };
  renderCandidates();
  document.querySelector("[data-prod-pick-external]")?.addEventListener("click", async () => {
    try {
      const paths = await prodSelectPaths(`选择${kind === "preview" ? "PNG" : "ZIP"}`, ["openFile"], [{ name: kind === "preview" ? "PNG" : "ZIP", extensions: [kind === "preview" ? "png" : "zip"] }]);
      if (!paths.length) return;
      selected = paths[0]; includeExternal(selected); renderCandidates();
      [...document.querySelectorAll("[data-prod-select-file]")].find(row => row.dataset.prodSelectFile === selected)?.scrollIntoView?.({ block: "nearest" });
    } catch (error) { prodToast("选择失败", error.message, "error"); }
  });
  document.querySelector("[data-prod-apply-file]")?.addEventListener("click", () => { if (!selected) return; if (kind === "preview") { pair.previewPath = selected; pair.preview = prodPath.basename(selected); } else { pair.sourcePath = selected; pair.source = prodPath.basename(selected); } closeDrawer(); prodRenderPairs(); prodToast("配对更新", `${pair.name} · ${kind === "preview" ? "PNG" : "ZIP"}`, "success"); });
  document.querySelectorAll("[data-drawer-close]").forEach(button => button.addEventListener("click", closeDrawer));
}

function prodOpenStatus(id) {
  const pair = prodPair(id); if (!pair) return;
  const missing = pair.missingFiles || [];
  openDrawer(`<div class="drawer-head"><div><h2>${pair.state === "ready" ? "配对完成" : "检查配对"}</h2><p>${prodEsc(pair.name)} · ${prodEsc(pair.type || "选择类型")}</p></div><button class="icon-btn" data-drawer-close>×</button></div><div class="drawer-body">${pair.note ? `<p>${prodEsc(pair.note)}</p>` : ""}<div class="detail-grid"><div><span>预览图</span><strong>${prodEsc(pair.previewPath || "缺失")}</strong></div><div><span>工程包</span><strong>${prodEsc(pair.sourcePath || "背景可只保存图片")}</strong></div><div><span>保存位置</span><strong>01_预览图 / ${prodEsc(pair.type || "选择类型")}</strong></div></div>${missing.length ? `<div class="warning-box"><strong>素材缺失</strong>${missing.map(file => `<div>${prodEsc(file)}</div>`).join("")}<label><input type="checkbox" data-prod-risk="${prodEsc(id)}" ${pair.riskAccepted ? "checked" : ""}>我了解缺失影响，仍要保存</label></div>` : ""}</div><div class="drawer-footer"><button class="ghost-btn" data-drawer-close>关闭</button></div>`);
  document.querySelectorAll("[data-drawer-close]").forEach(button => button.addEventListener("click", closeDrawer));
  document.querySelector("[data-prod-risk]")?.addEventListener("change", event => { pair.riskAccepted = event.target.checked; pair.selected = event.target.checked; closeDrawer(); prodRenderPairs(); });
}

async function prodSelectPaths(title, properties = ["openFile", "openDirectory", "multiSelections"], filters = []) {
  const result = await window.eagle.dialog.showOpenDialog({ title, properties, filters });
  return result?.canceled ? [] : (result?.filePaths || []);
}

function prodDroppedPaths(dataTransfer) {
  let files = [...(dataTransfer?.files || [])];
  if (!files.length) files = [...(dataTransfer?.items || [])].filter(item => item.kind === "file").map(item => item.getAsFile()).filter(Boolean);
  if (!files.length) throw new Error("请拖入本地工程文件、PNG / ZIP 或文件夹。");
  const paths = files.map(file => {
    let value = typeof file.path === "string" ? file.path : "";
    if (!value) {
      try { value = require("electron").webUtils?.getPathForFile(file) || ""; } catch {}
    }
    if (!value || !prodPath.isAbsolute(value)) throw new Error("无法读取拖入文件的位置，请使用选择工程或选文件夹。");
    return prodPath.normalize(value);
  });
  return [...new Set(paths)];
}

function prodBindHomeDropZone() {
  const zone = document.querySelector("#homeDropZone");
  if (!zone || zone.dataset.prodDropBound) return;
  zone.dataset.prodDropBound = "1";
  ["dragenter", "dragover"].forEach(type => zone.addEventListener(type, event => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    zone.classList.add("is-dragover");
  }));
  zone.addEventListener("dragleave", event => {
    if (!zone.contains(event.relatedTarget)) zone.classList.remove("is-dragover");
  });
  zone.addEventListener("drop", async event => {
    event.preventDefault(); event.stopImmediatePropagation();
    zone.classList.remove("is-dragover");
    try { await prodRouteSelection(prodDroppedPaths(event.dataTransfer)); }
    catch (error) { prodToast("读取失败", error.message, "error"); }
  }, true);
}

async function prodRouteSelection(paths, options = {}) {
  const selected = (paths || []).filter(Boolean);
  if (!selected.length) return;
  const dirs = selected.filter(value => prodFs.statSync(value).isDirectory());
  const aeps = selected.filter(value => /\.aep$/i.test(value));
  if (aeps.length && (options.kind === "new-version" || workflowDraft?.kind === "new-version")) throw new Error("请选择只含一组图片和工程包的文件夹");
  if ((dirs.length && (dirs.length !== 1 || selected.length !== 1)) || (aeps.length && (aeps.length !== 1 || selected.length !== 1))) throw new Error("请单独选择一个文件夹、一个 AEP，或一组 PNG / ZIP 文件。");
  if (dirs.length || selected.some(value => /\.(png|zip|json|txt)$/i.test(value))) {
    const root = dirs[0] || prodPath.dirname(selected[0]);
    const scan = prodScan.scanDirectory(root, { projectName: options.projectName || prodScan.inferProjectName(root), selectedPaths: dirs.length ? undefined : selected });
    prodProject = options.projectName || scan.projectName || prodScan.inferProjectName(root);
    prodSourceDir = root; prodScanResult = scan;
    prodSetWorkflow(options.kind || "new-package", options.base, options.projectName || prodProject);
    prodLoadPairs(scan);
    prodSetPairSource(dirs.length ? prodPath.basename(root) : "已选择文件");
    prodSetScreen("pair");
    prodToast("检查完成", `${pairs.length} 组候选 · ${scan.errors?.length || 0} 个扫描错误`, "success");
    return;
  }
  if (aeps.length) {
    prodAepPath = aeps[0]; prodProject = options.projectName || prodPath.basename(prodAepPath, prodPath.extname(prodAepPath));
    prodAepOutput = prodPath.join(prodPath.dirname(prodAepPath), `${prodPath.basename(prodAepPath, prodPath.extname(prodAepPath))}_包装收集`);
    const output = document.querySelector("#aepOutputPath"); if (output) output.value = prodAepOutput;
    prodSetWorkflow(options.kind || "new-package", options.base, options.projectName || prodProject);
    prodSetScreen("aep"); await prodInspectAep();
    return;
  }
  throw new Error("仅支持 AEP、文件夹或 PNG / ZIP 文件。");
}

function prodSetWorkflow(kind = "new-package", base = null, project = prodProject) {
  workflowDraft = { kind, project, sourceKind: "folder", stage: "pair", version: base ? nextVersion(base.version) : "v01", basePackageId: base?.packageId || "", baseManagedId: base?.id || "" };
  prodProject = project;
  const projectInput = document.querySelector("#pairProjectName"); if (projectInput) { projectInput.value = project; projectInput.readOnly = Boolean(base); }
}

function prodSetPairSource(source) {
  const name = document.querySelector("#pairSourceName"), meta = document.querySelector("#pairSourceMeta");
  if (name) name.textContent = `${prodProject} · ${workflowDraft?.kind === "new-version" ? "新增版本" : "添加包装配对"}`;
  if (meta) meta.textContent = `${pairs.length} 组候选 · ${source} · ${workflowDraft?.version || "v01"}`;
}

function prodLoadPairs(scan) {
  if (workflowDraft?.kind === "new-version") {
    if ((scan.packages || []).length !== 1) throw new Error("新版本只支持一组包装，请重新选择");
    const source = scan.packages[0];
    const base = prodManagedRecords.find(item => item.packageId === workflowDraft.basePackageId);
    if (!base) throw new Error("找不到当前包装，请刷新素材库重试");
    source.packageId = prodScan.stableId("pkg-version", base.packageId, source.packageId, workflowDraft.version);
    source.basePackageId = base.packageId; source.projectName = base.projectName;
    source.packageName = base.packageName; source.packageType = base.packageType;
    source.aeCompName = base.aeCompName || source.aeCompName; source.version = workflowDraft.version;
    scan.projectName = base.projectName;
  }
  pairs.splice(0, pairs.length, ...(scan.packages || []).map(prodMapPackage));
  selectedPair = pairs[0]?.id || ""; pairFilter = "all"; pairQuery = "";
  document.querySelectorAll("#pairTabs [data-pair-filter]").forEach(tab => tab.classList.toggle("active", tab.dataset.pairFilter === "all"));
  prodRenderPairs();
}

async function prodInspectAep() {
  const status = document.querySelector("#aepSourceMeta"); if (status) status.textContent = "正在读取工程内容";
  try {
    prodAepProject = await prodWorker.inspectAep(prodAepPath);
    const comps = prodAllComps(); prodActiveId = comps.find(item => !(item.parent_ids || []).length)?.id ?? comps[0]?.id ?? null;
    prodAepSelectedOccurrences.clear(); prodAepOccurrenceMap.clear(); prodActiveOccurrence = "";
    comps.forEach(item => { item.collectImage = true; item.collectFile = true; item.previewTime = Math.min(2, Math.max(0, Number(item.duration || 0) - 1 / Math.max(1, Number(item.frame_rate || 25)))); });
    prodRenderAep();
    if (status) status.textContent = `${prodAepProject.composition_count || comps.length} 个合成 · 读取完成`;
    prodToast("读取完成", "勾选要导出的合成", "success");
  } catch (error) { if (status) status.textContent = "读取失败"; prodToast("读取失败", error.message, "error"); }
}


function prodAepReviewReasons(c) {
  const reasons = [], name = String(c.name || ""), parents = [...new Set((c.parent_ids || []).map(String))];
  if (/(视频框|横屏框|竖屏框)/u.test(name)) reasons.push({ title: "检查画面", detail: "名称像视频框，建议核对画面", advice: "核对预览；视频会替换为首帧图片" });
  if (parents.length > 1) reasons.push({ title: "核对用途", detail: "被 " + parents.length + " 个父合成引用：" + parents.map(id => prodComp(id)?.name || ("合成 ID " + id)).join("、"), advice: "核对用途；同一合成只导出一份" });
  if (/(测试|临时)/u.test(name)) reasons.push({ title: "核对内容", detail: "名称含测试或临时，建议核对", advice: "不用就取消勾选，需要则继续导出" });
  return reasons;
}

function prodOpenAepReview(c) {
  if (!c) return;
  const reasons = prodAepReviewReasons(c);
  openDrawer('<div class="drawer-head"><div><h2>检查建议</h2><p>' + prodEsc(c.name) + '</p></div><button class="icon-btn" data-drawer-close aria-label="关闭建议">×</button></div><div class="drawer-body aep-review-body"><p>这些是检查建议，不影响导出</p>' + reasons.map(reason => '<section class="review-reason"><h3>' + prodEsc(reason.title) + '</h3><p>' + prodEsc(reason.detail) + '</p><strong>建议操作</strong><p>' + prodEsc(reason.advice) + '</p></section>').join('') + '</div><div class="drawer-footer"><button class="ghost-btn" data-drawer-close>返回列表</button><button class="primary-btn" data-review-preview ' + (c.prodPreviewRendering ? 'disabled' : '') + '>' + (c.prodPreviewPath ? '查看预览' : '生成预览') + '</button></div>');
  document.querySelectorAll('[data-drawer-close]').forEach(button => button.addEventListener('click', closeDrawer));
  document.querySelector('[data-review-preview]')?.addEventListener('click', () => { closeDrawer(); if (c.prodPreviewPath) prodOpenAepPreview(c); else prodRenderPreview(c); });
}

function prodRenderAep() {
  const comps = prodAllComps(), list = document.querySelector("#treeList"); if (!list) return;
  const query = String(document.querySelector("#aepSearch")?.value || "").trim().toLocaleLowerCase();
  const activeFilter = document.querySelector("#aepFilters .active")?.dataset.filter || "candidate";
  const children = new Map();
  comps.forEach(c => (c.parent_ids || []).forEach(parent => { if (!children.has(String(parent))) children.set(String(parent), []); children.get(String(parent)).push(c); }));
  const roots = comps.filter(c => !(c.parent_ids || []).length);
  const isCandidate = c => /(包装|背景|视频框|竖屏框|横屏框|信息条|人名条|标注|分镜)/u.test(String(c.name || ""));
  const hasWarning = c => prodAepReviewReasons(c).length > 0;
  const matchesCategory = c => activeFilter === "all"
    || activeFilter === "candidate" && isCandidate(c)
    || activeFilter === "root" && !(c.parent_ids || []).length
    || activeFilter === "child" && (c.parent_ids || []).length > 0
    || activeFilter === "warning" && hasWarning(c);
  const counts = {
    all: comps.length,
    candidate: comps.filter(isCandidate).length,
    root: roots.length,
    child: comps.filter(c => (c.parent_ids || []).length > 0).length,
    warning: comps.filter(hasWarning).length,
  };
  Object.entries(counts).forEach(([filter, count]) => {
    const badge = document.querySelector(`#aepFilters [data-filter="${filter}"] em`);
    if (badge) badge.textContent = String(count);
  });
  const matches = c => (!query || `${c.name} ${c.width}x${c.height} ${c.role || ""}`.toLocaleLowerCase().includes(query)) && matchesCategory(c);
  const activeComp = prodComp(prodActiveId);
  if (activeComp && !matches(activeComp)) {
    const nextActive = comps.find(matches);
    prodActiveId = nextActive?.id ?? null;
    prodActiveOccurrence = "";
  }
  const expanded = window.prodTreeExpanded !== false;
  const hasVisible = (c, trail = new Set()) => { const id = String(c.id); if (trail.has(id)) return matches(c); const next = new Set(trail); next.add(id); return matches(c) || (children.get(id) || []).some(item => hasVisible(item, next)); };
  const row = (c, depth, kind, key, nodeExpanded) => {
    const needsReview = hasWarning(c);
    const status = needsReview ? "建议检查" : (c.parent_ids || []).length ? "子合成" : "顶层合成";
    const checked = prodAepSelectedOccurrences.has(key) ? "checked" : "";
    const active = key === prodActiveOccurrence || (!prodActiveOccurrence && String(c.id) === String(prodActiveId));
    const hasChildren = children.has(String(c.id));
    return `<div class="tree-row ${active ? "active" : ""}" data-comp="${prodEsc(c.id)}" data-occurrence="${prodEsc(key)}" role="treeitem" tabindex="${active ? 0 : -1}" aria-level="${depth}" ${hasChildren ? `aria-expanded="${nodeExpanded}"` : ""}><button class="tree-disclosure" data-prod-toggle-tree aria-label="${nodeExpanded ? "收起" : "展开"} ${prodEsc(c.name)}" aria-expanded="${nodeExpanded}" ${hasChildren ? "" : "disabled"}>${hasChildren ? nodeExpanded ? "⌄" : "›" : ""}</button><input type="checkbox" data-comp-check="${prodEsc(key)}" ${checked} aria-label="选择 ${prodEsc(c.name)}"><span class="kind ${kind}">${kind === "root" ? "顶层" : kind === "link" ? "共用" : "子级"}</span><div class="tree-name"><strong>${prodEsc(c.name)}</strong><small>${prodEsc(status)}</small></div><span class="tree-meta">${Number(c.width || 0)} × ${Number(c.height || 0)}</span><span class="tree-meta">${Number(c.duration || 0).toFixed(2)}s</span>${needsReview ? `<button type="button" class="status-chip warn aep-review-button" data-prod-aep-review="${prodEsc(c.id)}" aria-label="查看 ${prodEsc(c.name)} 的复核原因和建议">建议检查 ↗</button>` : '<span class="status-chip ok">可导出</span>'}</div>`;
  };
  const renderNode = (c, depth, ancestors = [], trail = new Set()) => {
    const id = String(c.id), key = [...ancestors, id].join("/");
    prodAepOccurrenceMap.set(key, c);
    const next = new Set(trail); next.add(id);
    const kind = depth === 1 ? "root" : (c.parent_ids || []).length > 1 ? "link" : "pre";
    const descendants = (children.get(id) || []).filter(item => !next.has(String(item.id)) && hasVisible(item));
    const nodeExpanded = !matches(c) && descendants.length > 0 || expanded && !prodCollapsedTreeOccurrences.has(key);
    return `<div class="tree-node">${matches(c) ? row(c, depth, kind, key, nodeExpanded) : ""}${nodeExpanded && descendants.length ? `<div class="tree-node-children" role="group">${descendants.map(child => renderNode(child, depth + 1, [...ancestors, id], next)).join("")}</div>` : ""}</div>`;
  };
  const visibleRoots = roots.filter(item => hasVisible(item));
  list.setAttribute("role", "tree"); list.setAttribute("aria-label", "AEP 合成结构");
  const head = document.querySelector(".tree-head"); if (head && head.children.length === 6) head.insertBefore(document.createElement("span"), head.firstElementChild);
  list.innerHTML = visibleRoots.map(root => renderNode(root, 1, new Set())).join("") || '<div class="bottom-sheet-empty">没有找到符合条件的合成</div>';
  const expandButton = document.querySelector('[data-action="expand"]'); if (expandButton) { expandButton.textContent = expanded ? "收起全部" : "展开全部"; expandButton.setAttribute("aria-pressed", String(expanded)); }
  const search = document.querySelector("#aepSearch"); if (search && !search.dataset.prodBound) { search.dataset.prodBound = "1"; search.addEventListener("input", prodRenderAep); }
  document.querySelectorAll("#aepFilters [data-filter]").forEach(button => { if (button.dataset.prodBound) return; button.dataset.prodBound = "1"; button.addEventListener("click", () => { document.querySelectorAll("#aepFilters [data-filter]").forEach(item => item.classList.toggle("active", item === button)); prodRenderAep(); }); });
  document.querySelectorAll("[data-comp]").forEach(item => {
    item.addEventListener("click", event => { if (event.target.matches("input,button")) return; prodActiveId = item.dataset.comp; prodActiveOccurrence = item.dataset.occurrence; prodRenderAep(); });
    item.addEventListener("keydown", event => {
      if (event.target !== item) return;
      const rows = [...document.querySelectorAll("#treeList [data-comp]")], index = rows.indexOf(item), key = item.dataset.occurrence;
      if (event.key === " ") { event.preventDefault(); item.querySelector("[data-comp-check]")?.click(); return; }
      if (event.key === "Enter") { prodActiveId = item.dataset.comp; prodActiveOccurrence = key; prodRenderAep(); return; }
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const next = event.key === "Home" ? rows[0] : event.key === "End" ? rows.at(-1) : rows[Math.max(0, Math.min(rows.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))];
        next?.focus(); return;
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        if (!window.prodTreeExpanded || prodCollapsedTreeOccurrences.has(key)) { window.prodTreeExpanded = true; prodCollapsedTreeOccurrences.delete(key); prodRenderAep(); document.querySelector(`[data-occurrence="${CSS.escape(key)}"]`)?.focus(); }
        else { const next = rows[index + 1]; if (next && Number(next.getAttribute("aria-level")) > Number(item.getAttribute("aria-level"))) next.focus(); }
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        if (window.prodTreeExpanded && (children.get(String(item.dataset.comp)) || []).length && !prodCollapsedTreeOccurrences.has(key)) { prodCollapsedTreeOccurrences.add(key); prodRenderAep(); document.querySelector(`[data-occurrence="${CSS.escape(key)}"]`)?.focus(); }
        else { const parentKey = key.split("/").slice(0, -1).join("/"); if (parentKey) document.querySelector(`[data-occurrence="${CSS.escape(parentKey)}"]`)?.focus(); }
      }
    });
  });
  document.querySelectorAll("[data-comp-check]").forEach(input => input.addEventListener("change", () => { if (input.checked) prodAepSelectedOccurrences.add(input.dataset.compCheck); else prodAepSelectedOccurrences.delete(input.dataset.compCheck); prodActiveOccurrence = input.dataset.compCheck; prodActiveId = prodAepOccurrenceMap.get(input.dataset.compCheck)?.id ?? prodActiveId; prodRenderCollectionSheet(); prodRenderAep(); }));
  document.querySelectorAll("[data-prod-toggle-tree]").forEach(button => button.addEventListener("click", () => { const key = button.closest("[data-occurrence]")?.dataset.occurrence; if (!key) return; if (prodCollapsedTreeOccurrences.has(key)) prodCollapsedTreeOccurrences.delete(key); else prodCollapsedTreeOccurrences.add(key); prodRenderAep(); document.querySelector(`[data-occurrence="${CSS.escape(key)}"]`)?.focus(); }));
  const c = prodComp(prodActiveId); const inspector = document.querySelector("#aepInspector");
  if (c && inspector) { const size = `${c.width} × ${c.height}`, duration = Number(c.duration || 0), time = Number(c.previewTime || 0).toFixed(2), needsReview = hasWarning(c); inspector.innerHTML = `<div class="inspector-head"><div><strong>${prodEsc(c.name)}</strong><small>${prodEsc(c.role || "AE 合成")}</small></div>${needsReview ? `<button type="button" class="status-chip warn aep-review-button" data-prod-aep-review="${prodEsc(c.id)}" aria-label="查看 ${prodEsc(c.name)} 的复核原因和建议">建议检查 ↗</button>` : '<span class="status-chip ok">可导出</span>'}</div><button type="button" class="preview-frame ${c.prodPreviewPath ? "has-actual-preview" : "is-empty"} ${c.prodPreviewRendering ? "is-rendering" : ""}" aria-busy="${Boolean(c.prodPreviewRendering)}" aria-label="查看 ${prodEsc(c.name)} 的查看大图">${c.prodPreviewPath ? `<img class="frame-art actual-preview-image" src="${prodImageUrl(c.prodPreviewPath)}" alt="${prodEsc(c.name)} 画面时间">` : '<span class="preview-empty">暂无图片</span>'}${c.prodPreviewRendering ? '<span class="preview-rendering-overlay" role="status"><i class="preview-rendering-spinner"></i><span>生成中</span></span>' : ''}</button><div class="preview-actions"><label class="preview-time"><span>画面时间</span><input data-prod-preview-time type="number" min="0" max="${duration}" step="0.01" value="${time}"><span>秒</span></label><button class="primary-btn" data-prod-render-preview ${c.prodPreviewRendering ? "disabled" : ""}>${c.prodPreviewRendering ? "生成中" : c.prodPreviewPath ? "重新生成" : "生成预览"}</button></div><div class="detail-block"><div class="detail-grid"><div><span>尺寸</span><strong>${size}</strong></div><div><span>时长</span><strong>${duration.toFixed(2)} 秒 · ${Number(c.frame_rate || 0)} fps</strong></div><div><span>画面来源</span><strong>${prodEsc(c.prodPreviewSourceName || c.name)}</strong></div><div><span>画面时间</span><strong data-prod-time-label>${time} 秒</strong></div></div></div><div class="detail-block"><h4>选择状态</h4><p>${prodActiveOccurrence && prodAepSelectedOccurrences.has(prodActiveOccurrence) ? "已选中" : "未选中"} · 重复选择只导出一份</p></div>`;
    inspector.querySelector("[data-prod-preview-time]").addEventListener("change", event => { c.previewTime = Math.min(duration, Math.max(0, Number(event.target.value) || 0)); event.target.value = c.previewTime.toFixed(2); inspector.querySelector("[data-prod-time-label]").textContent = `${c.previewTime.toFixed(2)} 秒`; });
    inspector.querySelector("[data-prod-render-preview]").addEventListener("click", () => prodRenderPreview(c));
    inspector.querySelector(".preview-frame")?.addEventListener("click", () => prodOpenAepPreview(c));
  } else if (inspector) {
    inspector.innerHTML = '<div class="bottom-sheet-empty">没有找到符合条件的合成</div>';
  }
  document.querySelectorAll("[data-prod-aep-review]").forEach(button => button.addEventListener("click", event => { event.stopPropagation(); prodOpenAepReview(prodComp(button.dataset.prodAepReview)); }));
  const selectedComps = [...new Set([...prodAepSelectedOccurrences].map(key => prodAepOccurrenceMap.get(key)?.id).filter(value => value !== undefined).map(String))].map(prodComp).filter(Boolean);
  const count = prodAepSelectedOccurrences.size;
  document.querySelector("#aepSelectionText").textContent = `已选 ${count} 处`;
  document.querySelector("#aepSelectionHint").textContent = `${selectedComps.length} 个合成 · 图片 ${selectedComps.filter(item => item.collectImage !== false).length} · 文件 ${selectedComps.filter(item => item.collectFile !== false).length}`;
  const toolbar = document.querySelector(".tree-toolbar p"); if (toolbar) toolbar.textContent = `${prodPath.basename(prodAepPath)} · ${comps.length} 个合成 · ${comps.filter(item => !(item.parent_ids || []).length).length} 个顶层合成`;
  const source = document.querySelector("#aepSourceName"); if (source) source.textContent = prodPath.basename(prodAepPath);
  prodRenderCollectionSheet();
}

function prodRenderCollectionSheet() {
  const selected = [...prodAepSelectedOccurrences].map(key => ({ key, comp: prodAepOccurrenceMap.get(key) })).filter(entry => entry.comp), list = document.querySelector("#aepCollectionList"); if (!list) return;
  list.innerHTML = selected.length ? selected.map(({ key, comp: c }) => `<article class="bottom-sheet-row"><div class="bottom-sheet-row-copy"><strong>${prodEsc(c.name)}</strong><small>${prodEsc(key.split("/").slice(0, -1).map(id => prodComp(id)?.name).filter(Boolean).join(" / ") || "顶层合成")} · ${Number(c.width || 0)} × ${Number(c.height || 0)} · ${Number(c.duration || 0).toFixed(2)}s · PNG ${c.collectImage === false ? "关闭" : "开启"} · ZIP ${c.collectFile === false ? "关闭" : "开启"}</small></div><div class="collection-rule-actions"><button class="collection-rule" data-prod-output="image" data-comp="${prodEsc(c.id)}" aria-pressed="${c.collectImage !== false}">导出图片</button><button class="collection-rule" data-prod-output="file" data-comp="${prodEsc(c.id)}" aria-pressed="${c.collectFile !== false}">打包工程</button></div></article>`).join("") : '<div class="bottom-sheet-empty">还未选择合成，请先勾选</div>';
  list.querySelectorAll("[data-prod-output]").forEach(button => button.addEventListener("click", () => { const c = prodComp(button.dataset.comp); if (c) c[button.dataset.prodOutput === "image" ? "collectImage" : "collectFile"] = !c[button.dataset.prodOutput === "image" ? "collectImage" : "collectFile"]; prodRenderCollectionSheet(); prodRenderAep(); }));
}

async function prodRenderPreview(comp) {
  if (!comp || comp.prodPreviewRendering) return;
  comp.prodPreviewRendering = true;
  prodRenderAep();
  try {
    const result = await prodWorker.previewAep(prodAepPath, comp.id, { time: comp.previewTime });
    const previewPath = result.preview_file || result.output_file || result.output || result.preview_path || result.path;
    if (!previewPath) throw new Error("AEP Worker 没有返回预览图路径。");
    comp.prodPreviewPath = previewPath;
    comp.prodPreviewSourceName = result.preview_source_name || comp.name;
    comp.previewTime = Number(result.preview_time ?? comp.previewTime);
    comp.prodPreviewRendering = false;
    prodRenderAep();
    prodToast("预览生成", `${comp.name} · ${Number(result.preview_time ?? comp.previewTime).toFixed(2)} 秒`, "success");
  } catch (error) {
    comp.prodPreviewRendering = false;
    prodRenderAep();
    prodToast("预览失败", error.message, "error");
  }
}

async function prodCollectAep(confirmDuplicates = false) {
  const selectedOccurrences = [...prodAepSelectedOccurrences].map(key => ({ key, comp: prodAepOccurrenceMap.get(key) })).filter(entry => entry.comp && (entry.comp.collectImage !== false || entry.comp.collectFile !== false));
  const unique = new Map(selectedOccurrences.map(entry => [String(entry.comp.id), entry.comp]));
  const chosen = [...unique.values()];
  if (!chosen.length) return prodToast("选择合成", "至少选择一个合成和一种输出。", "error");
  if (selectedOccurrences.length > chosen.length && !confirmDuplicates) {
    const duplicateRows = selectedOccurrences.filter((entry, index) => selectedOccurrences.findIndex(item => String(item.comp.id) === String(entry.comp.id)) !== index).map(entry => `<div class="duplicate-choice"><div><strong>${prodEsc(entry.comp.name)}</strong><span>${prodEsc(entry.key.split("/").slice(0, -1).map(id => prodComp(id)?.name).filter(Boolean).join(" / "))}</span></div><span class="status-chip warn">保留一份</span></div>`).join("");
    openModal(`<div class="modal-head"><div><h2>重复选择</h2><p>同一合成只导出一份</p></div><button class="icon-btn" data-close>×</button></div><div class="modal-body"><div class="duplicate-options">${duplicateRows}</div><div class="drawer-footer"><button class="ghost-btn" data-close>返回调整</button><button class="primary-btn" data-prod-confirm-duplicates>继续导出</button></div></div>`);
    document.querySelectorAll("[data-close]").forEach(button => button.addEventListener("click", closeModal));
    document.querySelector("[data-prod-confirm-duplicates]")?.addEventListener("click", () => { closeModal(); prodCollectAep(true); });
    return;
  }
  const output = String(document.querySelector("#aepOutputPath")?.value || prodAepOutput).trim(); if (!output) return prodToast("选择位置", "导出的文件会放在新文件夹", "error");
  const ids = [...new Set(chosen.map(c => Number(c.id)))];
  const collectionRules = Object.fromEntries(chosen.map(c => [c.id, { image: c.collectImage !== false, file: c.collectFile !== false }]));
  const previewTimes = Object.fromEntries(chosen.map(c => [c.id, Number(c.previewTime || 0)]));
  const button = document.querySelector("#collectButton"); if (button) { button.disabled = false; button.dataset.action = "stop-collect"; button.textContent = "停止导出"; }
  prodCollectionAbort = new AbortController();
  try {
    await prodFs.promises.mkdir(output, { recursive: true });
    const result = await prodWorker.collectAep(prodAepPath, ids, output, { collectionRules, previewTimes, signal: prodCollectionAbort.signal, onProgress: update => { const label = document.querySelector("#aepSelectionHint"); if (label && update.event === "progress") label.textContent = `${update.completed || 0} / ${update.total || ids.length} · ${update.phase || "收集中"}`; } });
    const missing = result.some(item => item.missing_files?.length);
    prodProject = document.querySelector("#pairProjectName")?.value.trim() || prodProject;
    prodSourceDir = output; prodScanResult = prodScan.scanDirectory(output, { projectName: prodProject });
    prodSetWorkflow(workflowDraft?.kind || "new-package", workflowDraft?.basePackageId ? { packageId: workflowDraft.basePackageId, version: workflowDraft.version } : null, prodProject);
    workflowDraft.sourceKind = "aep";
    prodLoadPairs(prodScanResult); prodSetPairSource(`${result.length} 个 AEP 收集包`); prodSetScreen("pair");
    prodToast(missing ? "导出完成" : "导出完成", `${result.length} 组文件，请核对配对`, missing ? "normal" : "success");
  } catch (error) { if (error.code === "ABORT_ERR") prodToast("已停止", "已生成的文件会保留", "normal"); else prodToast("导出失败", error.message, "error"); }
  finally { prodCollectionAbort = null; if (button) { button.disabled = false; button.dataset.action = "collect"; button.textContent = "开始导出"; } }
}

function prodOpenRename() {
  pairs.forEach(prodRefreshPairState);
  const selected = pairs.filter(p => p.selected && p.state === "ready");
  openModal(`<div class="modal-head"><div><h2>检查名称</h2><p>${prodEsc(prodProject)}</p></div><button class="icon-btn" data-close>×</button></div><div class="modal-body"><div class="form-grid"><div class="form-group"><label>图片命名</label><input class="input" data-prod-template="preview" value="{项目}_{包装类型}_{包装名称}_{版本}.png"></div><div class="form-group"><label>工程命名</label><input class="input" data-prod-template="source" value="{项目}_{包装名称}_{版本}.zip"></div></div><p class="form-help">可用字段：{项目}、{包装类型}、{包装名称}、{版本}</p><div class="rename-output-list">${selected.map(p => `<div class="rename-output-row"><strong>${prodEsc(p.name)} · ${prodEsc(p.type)} · ${prodEsc(p.version)}</strong><small>${prodEsc(p.previewPath)}<br>${prodEsc(p.sourcePath || "仅有图片")}</small><div class="rename-output-grid"><label>图片名称<input class="input" data-prod-name="preview" data-id="${prodEsc(p.id)}" value="${prodEsc(`${prodProject}_${p.type}_${p.name}_${p.version}.png`)}"></label><label>工程名称<input class="input" data-prod-name="source" data-id="${prodEsc(p.id)}" value="${prodEsc(`${prodProject}_${p.name}_${p.version}.zip`)}" ${p.sourcePath ? "" : "disabled"}></label></div></div>`).join("")}</div><div class="drawer-footer"><button class="ghost-btn" data-close>返回检查</button><button class="primary-btn" data-prod-confirm-import ${selected.length ? "" : "disabled"}>确认保存</button></div></div>`);
  document.querySelectorAll("[data-close]").forEach(button => button.addEventListener("click", closeModal));
  const previewTemplate = document.querySelector('[data-prod-template="preview"]');
  const sourceTemplate = document.querySelector('[data-prod-template="source"]');
  const updateGenerated = () => document.querySelectorAll(".rename-output-row").forEach(row => {
    const strong = row.querySelector("strong")?.textContent || "", id = row.querySelector("[data-prod-name]")?.dataset.id, pair = prodPair(id); if (!pair) return;
    const values = { "{项目}": prodProject, "{包装类型}": pair.type || "", "{包装名称}": pair.name, "{版本}": pair.version };
    const fill = template => Object.entries(values).reduce((text, [token, value]) => text.replaceAll(token, value), template);
    for (const kind of ["preview", "source"]) { const input = row.querySelector(`[data-prod-name="${kind}"]`); if (input && !input.dataset.manual) input.value = fill(kind === "preview" ? previewTemplate.value : sourceTemplate.value); }
  });
  [previewTemplate, sourceTemplate].filter(Boolean).forEach(input => input.addEventListener("input", updateGenerated));
  document.querySelectorAll("[data-prod-name]").forEach(input => input.addEventListener("input", () => { input.dataset.manual = "true"; }));
  document.querySelector("[data-prod-confirm-import]")?.addEventListener("click", () => {
    prodOutputNames = {};
    document.querySelectorAll("[data-prod-name]").forEach(input => { const pair = prodPair(input.dataset.id); if (pair) prodOutputNames[pair.packageId || pair.id] ||= {}; if (pair) prodOutputNames[pair.packageId || pair.id][input.dataset.prodName] = input.value; });
    prodRunImport("prompt");
  });
}

async function prodSubmitIngest(result) {
  try { return await prodIngest.publish(result); }
  catch (error) { return { state: "pending", error: error.message, result }; }
}

async function prodRetryIngest(sync) {
  if (sync.result) return prodSubmitIngest(sync.result);
  try {
    const results = await prodIngest.retry();
    return results.find(item => (sync.recoveryPath && item.recoveryPath === sync.recoveryPath) || (sync.event?.event_id && item.event?.event_id === sync.event.event_id))
      || { ...sync, error: "未找到待同步记录，请维护者核对事件队列。" };
  } catch (error) { return { ...sync, state: "pending", error: error.message }; }
}

function prodRenderIngestBoundary(sync, options = {}, selector = "#successBoundary") {
  const boundary = document.querySelector(selector); if (!boundary) return;
  const action = selector === "#successBoundary" ? document.querySelector("#successSyncAction") : null;
  if (action) { action.hidden = true; action.onclick = null; }
  const queued = sync.state === "queued";
  const text = sync.state === "completed" ? "机器人已完成索引同步" : queued ? "已提交同步，机器人能否查到待核对"
    : sync.skipped ? "使用已有记录，无需再次同步"
    : "同步失败，请重试，不要重复保存";
  boundary.textContent = `包装已保存到 Eagle。${options.archivedBase ? "旧版已保留。" : ""}${text}${options.archiveError ? "旧版待处理：" + options.archiveError : ""}`;
  if (sync.state !== "completed" && !sync.skipped) {
    const button = action || document.createElement("button");
    button.type = "button"; button.className = "ghost-btn"; button.textContent = queued ? "检查同步" : "重试同步";
    button.hidden = false;
    button.onclick = async () => { button.disabled = true; prodRenderIngestBoundary(await prodRetryIngest(sync), options, selector); button.disabled = false; };
    if (!action) boundary.appendChild(button);
    const detail = document.createElement("small");
    detail.textContent = sync.recoveryPath ? `待同步记录：${sync.recoveryPath}。${sync.error || ""}`
      : `同步记录未保存，请保持窗口打开重试${sync.error || ""}`;
    boundary.appendChild(detail);
  }
}

function prodShowIngestRetry(sync) {
  openModal('<div class="modal-head"><h2>同步失败</h2><button class="icon-btn" data-close>×</button></div><div class="modal-body"><p id="prodIngestBoundary"></p></div>');
  bindClose(); prodRenderIngestBoundary(sync, {}, "#prodIngestBoundary");
}

function prodInstallTeamSettings() {
  if (document.querySelector('[data-action="team-settings"]')) return;
  const button = document.createElement("button"); button.className = "settings-update";
  button.type = "button"; button.dataset.action = "team-settings";
  button.textContent = "团队连接 · 配置与检查";
  document.querySelector("#tweaks")?.appendChild(button);
  const diagnostics = document.createElement("button"); diagnostics.className = "settings-update"; diagnostics.type = "button"; diagnostics.textContent = "诊断信息 · 检查与导出";
  diagnostics.addEventListener("click", prodOpenDiagnostics); document.querySelector("#tweaks")?.appendChild(diagnostics);
  const status = document.querySelector(".top-actions .api span");
  if (status) { try { const config = prodTeam.readConfig(); status.textContent = config.unconfigured ? "请配置使用模式" : config.mode === "team" ? "团队模式" : "单机模式"; } catch { status.textContent = "连接配置有误"; } }
}

function prodOpenDiagnostics() {
  let config; try { const saved = prodTeam.readConfig(); config = { mode: saved.mode, configured: !saved.unconfigured, service: saved.url || "" }; } catch { config = { error: "连接配置有误" }; }
  const report = { version: prodManifest.version, platform: process.platform, createdAt: new Date().toISOString(), connection: config, dependencies: prodEnvironment.dependencies() };
  const text = JSON.stringify(report, null, 2);
  openModal(`<div class="modal-head"><h2>诊断信息</h2><button class="icon-btn" data-close>×</button></div><div class="modal-body"><p>不包含密钥、素材和聊天内容</p><pre style="white-space:pre-wrap">${prodEsc(text)}</pre><div class="drawer-footer"><button class="primary-btn" data-save-diagnostics>保存报告</button></div></div>`); bindClose();
  document.querySelector("[data-save-diagnostics]").onclick = async () => {
    const directories = await prodSelectPaths("选择报告保存目录", ["openDirectory"]);
    if (!directories.length) return;
    try { const file = prodPath.join(directories[0], `xbot-diagnostics-${Date.now()}.json`); prodFs.writeFileSync(file, text, { flag: "wx" }); prodToast("报告已保存", file, "success"); }
    catch (error) { prodToast("保存失败", error.message, "error"); }
  };
}

function prodOpenTeamSettings() {
  let config; try { config = prodTeam.readConfig(); } catch { config = { mode: "team" }; }
  openModal(`<div class="modal-head"><h2>团队连接</h2><button class="icon-btn" data-close>×</button></div><div class="modal-body"><div class="form-group"><label for="teamMode">使用模式</label><select id="teamMode" class="select"><option value="team" ${config.mode === "team" || config.unconfigured ? "selected" : ""}>团队入库</option><option value="local" ${config.mode === "local" && !config.unconfigured ? "selected" : ""}>单机使用</option></select></div><div class="form-group"><label for="teamUrl">服务地址</label><input id="teamUrl" class="input" placeholder="http://主机:41596" value="${prodEsc(config.url || "")}"></div><div class="form-group"><label for="teamToken">连接密钥</label><input id="teamToken" class="input" type="password" autocomplete="off" placeholder="留空保留已保存密钥"></div><div class="form-group"><label for="teamLibrary">团队库路径</label><input id="teamLibrary" class="input" placeholder="\\\\主机\\共享\\包装.library" value="${prodEsc(config.libraryPath || "")}"></div><button class="ghost-btn" data-team-import>导入配置</button><p id="teamCheckResult" role="status" aria-live="polite">团队库使用 UNC 路径打开</p><div class="drawer-footer"><button class="ghost-btn" data-team-check>检查连接</button><button class="primary-btn" data-team-save>保存配置</button></div></div>`);
  bindClose();
  const draft = () => prodTeam.validateConfig({ mode: document.querySelector("#teamMode").value, url: document.querySelector("#teamUrl").value.trim(), token: document.querySelector("#teamToken").value || config.token, libraryPath: document.querySelector("#teamLibrary").value.trim() });
  document.querySelector("[data-team-import]").onclick = async () => {
    const files = await prodSelectPaths("选择团队连接文件", ["openFile"], [{ name: "团队连接", extensions: ["json"] }]);
    if (!files.length) return;
    try {
      const imported = prodTeam.validateConfig(JSON.parse(prodFs.readFileSync(files[0], "utf8").replace(/^\uFEFF/u, "")));
      document.querySelector("#teamMode").value = imported.mode;
      document.querySelector("#teamUrl").value = imported.url || "";
      document.querySelector("#teamToken").value = imported.token || "";
      document.querySelector("#teamLibrary").value = imported.libraryPath || "";
      document.querySelector("#teamCheckResult").textContent = "配置已读入，检查连接后保存";
    } catch (error) { document.querySelector("#teamCheckResult").textContent = error.message; }
  };
  const check = document.querySelector("[data-team-check]");
  check.onclick = async () => {
    check.disabled = true; const text = document.querySelector("#teamCheckResult");
    try {
      const candidate = draft(), dependencies = prodEnvironment.dependencies();
      const health = await prodTeam.preflight(candidate, window.eagle);
      text.textContent = `${candidate.mode === "team" ? "团队库与服务连接正常" : "单机模式"}。Worker：${dependencies.worker ? "已找到" : "缺失，请重装完整包"}；AE 渲染器：${dependencies.aerender ? "已找到，授权待实测" : "未找到"}；FFmpeg：${dependencies.ffmpeg ? "已找到" : "未找到"}${health?.writeLocked ? "。写入锁被占用，请维护者核对" : ""}`;
    } catch (error) { text.textContent = error.message; }
    finally { check.disabled = false; }
  };
  document.querySelector("[data-team-save]").onclick = async () => {
    const button = document.querySelector("[data-team-save]"); button.disabled = true;
    try { const saved = prodTeam.saveConfig(draft()); await prodTeam.refreshTypes(saved); prodRefreshTypes(); closeModal(); prodToast("配置已保存", "请重开插件加载配置", "success"); }
    catch (error) { document.querySelector("#teamCheckResult").textContent = error.message; button.disabled = false; }
  };
}

async function prodRunImport(mode = "prompt") {
  const selected = pairs.filter(p => p.selected); selected.forEach(prodRefreshPairState);
  if (!selected.length || selected.some(p => p.state !== "ready")) return prodToast("待处理", "补齐文件和类型，确认缺失影响", "error");
  if (!prodProject.trim()) return prodToast("填写项目", "请先填写项目名称。", "error");
  if (prodScanResult?.errors?.length) return prodToast("检查失败", prodScanResult.errors[0], "error");
  const names = prodOutputNames;
  pairs.forEach(p => { p._package.previewPath = p.previewPath; p._package.sourcePath = p.sourcePath; p._package.projectName = prodProject; p._package.packageName = p.name; p._package.packageType = p.type; p._package.version = p.version; p._package.aeCompName = p.comp; p._package.selectedForImport = Boolean(p.selected); });
  prodScanResult.projectName = prodProject; const button = document.querySelector("[data-prod-confirm-import]"); if (button) { button.disabled = true; button.textContent = "保存中"; }
  try {
    const adapter = prodAdapter();
    const versionPair = selected.find(p => p.basePackageId || workflowDraft?.basePackageId);
    if (versionPair && (pairs.length !== 1 || selected.length !== 1)) throw new Error("新版本只支持一组图片和工程包");
    let archiveError = ""; let archivedBase = null;
    const result = await prodTeam.withTeamWrite(window.eagle, async () => {
      const imported = await prodEagle.importFormalBatch(adapter, prodScanResult, { mode, nameOverrides: names, basePackageId: workflowDraft?.basePackageId || "" });
      if (imported.state !== "duplicate" && versionPair && workflowDraft?.basePackageId) {
        const base = prodManagedRecords.find(item => item.packageId === workflowDraft.basePackageId);
        const completed = [...(imported.filed || []), ...(imported.reused || [])].find(item => item.basePackageId === workflowDraft.basePackageId || item.packageId === versionPair.packageId);
        if (!base || !completed) archiveError = "新版本已写入，旧版待维护者核对";
        else try { archivedBase = await prodManagedApi.archiveFormalPackageVersion(adapter, base, completed.packageId); } catch (error) { archiveError = error.message; }
      }
      return imported;
    });
    if (result.state === "duplicate") {
      const matches = result.matches.map(match => `<div class="detail-grid"><div><span>包装编号</span><strong>${prodEsc(match.packageId || "—")}</strong></div><div><span>已有版本</span><strong>${prodEsc(match.version || "—")}</strong></div><div><span>判断依据</span><strong>${prodEsc((match.matchedBy || []).join("、") || "稳定身份")}</strong></div></div>`).join("");
      openModal(`<div class="modal-head"><div><h2>已有包装</h2><p>选择如何处理重复内容</p></div><button class="icon-btn" data-close>×</button></div><div class="modal-body">${matches}<div class="drawer-footer"><button class="ghost-btn" data-close>返回检查</button><button class="quiet" data-prod-duplicate="reuse">使用已有</button><button class="quiet" data-prod-duplicate="update">替换已有</button><button class="primary-btn" data-prod-duplicate="new">另存包装</button></div></div>`);
      document.querySelectorAll("[data-close]").forEach(button => button.addEventListener("click", closeModal));
      document.querySelectorAll("[data-prod-duplicate]").forEach(button => button.addEventListener("click", () => { const nextMode = button.dataset.prodDuplicate; closeModal(); prodRunImport(nextMode); }));
      return;
    }
    const sync = await prodSubmitIngest(result);
    const completed = [...(result.filed || []), ...(result.reused || [])];
    const count = completed.length;
    lastPreviewImport = { kind: workflowDraft?.kind, project: prodProject, filedCount: count, packages: completed.map(item => ({ name: item.packageName, version: item.version, packageId: item.packageId, preview: item.previewName, source: item.sourceName })) };
    closeModal(); prodSetScreen("success");
    document.querySelector("#successTitle").textContent = `已保存 · ${count} 组`;
    document.querySelector("#successSummary").textContent = `所选包装已保存到 Eagle`;
    prodRenderIngestBoundary(sync, { archiveError: [archiveError, result.teamLockWarning].filter(Boolean).join("。"), archivedBase });
    document.querySelector("#successRecords").innerHTML = completed.map(item => `<div class="success-record"><div><strong>${prodEsc(item.packageName)} · ${prodEsc(item.version)}</strong><code>包装编号: ${prodEsc(item.packageId)}<br>预览图: ${prodEsc(item.previewName)}<br>工程包: ${prodEsc(item.sourceName || "—")}</code></div><span class="status-chip ok">已保存</span></div>`).join(""); document.querySelector("#successRecords").hidden = false;
  } catch (error) { prodToast("保存失败", error.message, "error"); if (button) { button.disabled = false; button.textContent = "确认保存"; } }
}

// Use Eagle's import timestamp, never the source file's modified time.
function prodManagedImportTime(record) {
  const times = [record.preview?.importedAt, record.source?.importedAt]
    .map(Number).filter(value => Number.isFinite(value) && value > 0);
  return times.length ? Math.min(...times) : 0;
}

function prodSetManageSort(value, persist = false, direction) {
  const next = prodManageSortOptions.includes(value) ? value : "time";
  prodManageSortDirection = ["asc", "desc"].includes(direction) ? direction : next !== prodManageSort ? (next === "time" ? "desc" : "asc") : prodManageSortDirection;
  prodManageSort = next;
  const select = document.querySelector("#manageSort");
  if (select) { select.value = prodManageSort; select.dispatchEvent(new Event("xbot-select-sync")); }
  const button = document.querySelector("#manageSortDirection");
  if (button) {
    button.textContent = prodManageSortDirection === "asc" ? "↑" : "↓";
    const label = prodManageSort === "time" ? (prodManageSortDirection === "asc" ? "最早入库优先" : "最近入库优先") : (prodManageSortDirection === "asc" ? "正序" : "倒序");
    button.title = `${label}，点击切换`;
    button.setAttribute("aria-label", button.title);
  }
  if (persist) { try { localStorage.setItem("xbot.manage-sort.v2", JSON.stringify({ by: prodManageSort, direction: prodManageSortDirection })); } catch {} }
  prodApplyManageFilters(); renderManage();
}

function prodRestoreManageSort() {
  let by = "time", direction = "desc";
  try {
    const saved = JSON.parse(localStorage.getItem("xbot.manage-sort.v2") || "null");
    if (saved && prodManageSortOptions.includes(saved.by) && ["asc", "desc"].includes(saved.direction)) { by = saved.by; direction = saved.direction; }
    else {
      const legacy = localStorage.getItem("xbot.manage-sort.v1");
      if (legacy === "oldest") direction = "asc";
      if (["name", "project"].includes(legacy)) { by = legacy; direction = "asc"; }
    }
  } catch {}
  prodSetManageSort(by, false, direction);
}

function prodAssignBatchTimes(cards) {
  const times = new Map();
  cards.forEach(item => {
    if (!item.batchId || !item.importedAt) return;
    const key = `${item.project}\u0000${item.batchId}`;
    times.set(key, Math.min(times.get(key) || Infinity, item.importedAt));
  });
  cards.forEach(item => { item.batchImportedAt = item.batchId ? times.get(`${item.project}\u0000${item.batchId}`) || 0 : item.importedAt; });
}

async function prodRefreshManaged() {
  try {
    const result = await prodManagedApi.listFormalPackages(prodAdapter());
    prodSetApiStatus("ready");
    prodManagedRecords = result.packages || [];
    prodManagedCards.splice(0, prodManagedCards.length, ...prodManagedRecords.map((p, index) => ({ id: `${p.packageId}-${index}`, packageId: p.packageId, batchId: p.batchId || "", basePackageId: p.basePackageId, name: p.packageName, importedAt: prodManagedImportTime(p), project: p.projectName, type: p.packageType, version: p.version, comp: p.aeCompName, preview: p.preview?.name || "", source: p.source?.name || "", previewPath: p.preview?.filePath || p.preview?.filepath || "", sourcePath: p.source?.filePath || p.source?.filepath || "", isCurrent: !/^(已取代|已归档|停用)/u.test(p.meta?.["状态"] || ""), risk: /警告|缺失|风险/u.test(p.meta?.["状态"] || ""), revision: p.meta?.revision_id || "" })));
    prodAssignBatchTimes(prodManagedCards);
    prodRenderManageFilters(); prodApplyManageFilters(); renderManage();
    await prodRefreshManagedSync();
    prodToast("已刷新", `${managed.length} 组正式包装`, "success");
  }
  catch (error) { prodSetApiStatus("error"); prodToast("读取失败", error.message, "error"); }
}

async function prodRefreshManagedSync() {
  if (prodManagedSyncBusy) return;
  prodManagedSyncBusy = true;
  const records = prodManagedRecords, cards = prodManagedCards.slice();
  try {
    const statuses = await prodIngest.listStatus(records, { libraryPath: window.eagle?.library?.path });
    if (records !== prodManagedRecords) return;
    for (const card of cards) card.sync = statuses.find(item => item.packageId === card.packageId) || { state: "unknown" };
  } catch (error) {
    if (records === prodManagedRecords) for (const card of cards) card.sync = { state: "unavailable", error: error.message };
  } finally {
    prodManagedSyncBusy = false;
    prodApplyManageFilters(); renderManage();
    if (records !== prodManagedRecords) await prodRefreshManagedSync();
  }
}

function prodManagedSyncView(item) {
  const state = item.sync?.state || "checking";
  const labels = { checking: "核对中", queued: "待同步", failed: "同步失败", completed: "已同步", unavailable: "连接失败" };
  const detail = item.sync?.error || ({ checking: "正在查询同步状态", queued: "文件已在 Eagle，等待机器人核对信息", completed: "当前配对已与机器人索引核对一致", unavailable: "暂时无法获取同步状态，请检查团队连接" })[state] || "";
  return { state, label: labels[state] || "", detail, visible: Boolean(labels[state]) };
}

function prodDecorateManagedSync() {
  document.querySelectorAll("#manageGrid .manage-card").forEach(card => {
    const item = managed.find(value => value.id === card.dataset.managedCard); if (!item) return;
    const view = prodManagedSyncView(item); if (!view.visible) return;
    const button = document.createElement("button");
    const retryable = item.isCurrent && ["queued", "failed"].includes(view.state);
    const retrying = prodManagedSyncRetrying.has(item.packageId);
    button.type = "button";
    button.className = "manage-sync-button";
    button.dataset.syncState = view.state;
    button.textContent = retrying ? "重试中…" : view.label;
    button.title = `${view.detail}${retryable ? "；点击重试同步" : ""}`;
    button.setAttribute("aria-label", `${view.label}${retryable ? "，点击重试同步" : ""}`);
    if (retryable) button.dataset.retryPackageSync = item.packageId;
    else button.setAttribute("aria-disabled", "true");
    if (retrying) button.disabled = true;
    card.appendChild(button);
  });
  const selected = managed.find(item => item.id === managedId), inspector = document.querySelector("#manageInspector");
  if (selected && inspector) {
    const view = prodManagedSyncView(selected); if (!view.visible) return;
    const info = document.createElement("section");
    info.className = "manage-sync-detail";
    info.innerHTML = `<strong>信息同步 · ${prodEsc(view.label)}</strong><p>${prodEsc(view.detail)}</p><small>重试只提交信息，不重新导入文件。同批包装会一起核对。</small>`;
    inspector.querySelector(".inspector-head")?.after(info);
  }
}

async function prodRetryManagedSync(packageId) {
  if (prodManagedSyncRetrying.has(packageId)) return;
  const record = prodManagedRecords.find(item => item.packageId === packageId); if (!record) return;
  prodManagedSyncRetrying.add(packageId); renderManage();
  try {
    const latest = (await prodManagedApi.listFormalPackages(prodAdapter())).packages.find(item => item.packageId === packageId);
    const status = await prodIngest.retryPackage(prodTeam.assertUnchanged(record, latest), { libraryPath: window.eagle?.library?.path });
    for (const card of prodManagedCards) if (card.packageId === packageId) card.sync = status;
    prodToast(status.state === "completed" ? "同步完成" : status.state === "failed" ? "同步失败" : "同步待核对", status.error || (status.state === "completed" ? "当前包装信息已核实" : "请稍后刷新同步状态"), status.state === "completed" ? "success" : "normal");
  } catch (error) {
    for (const card of prodManagedCards) if (card.packageId === packageId) card.sync = { state: "failed", error: error.message };
    prodToast("同步失败", error.message, "error");
  } finally {
    prodManagedSyncRetrying.delete(packageId);
    await prodRefreshManagedSync();
    renderManage();
  }
}

function prodRenderManageFilters() {
  const project = document.querySelector(".manage-side select");
  if (project) {
    const values = [...new Set(prodManagedCards.map(item => item.project).filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh-CN"));
    project.innerHTML = `<option value="">全部项目</option>${values.map(value => `<option value="${prodEsc(value)}">${prodEsc(value)}</option>`).join("")}`;
    project.value = prodManageProjectFilter;
    if (!project.dataset.prodBound) { project.dataset.prodBound = "1"; project.addEventListener("change", () => { prodManageProjectFilter = project.value; prodApplyManageFilters(); renderManage(); }); }
  }
  const filterList = document.querySelector(".manage-side .filter-list");
  if (filterList) {
    const types = [...new Set(prodManagedCards.map(item => item.type).filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh-CN"));
    const counts = new Map(types.map(type => [type, prodManagedCards.filter(item => item.type === type).length]));
    filterList.innerHTML = `<button type="button" data-prod-manage-type="">全部类型 <em>${prodManagedCards.length}</em></button>${types.map(type => `<button type="button" data-prod-manage-type="${prodEsc(type)}">${prodEsc(type)} <em>${counts.get(type)}</em></button>`).join("")}`;
    filterList.querySelectorAll("[data-prod-manage-type]").forEach(button => { button.classList.toggle("active", button.dataset.prodManageType === prodManageTypeFilter); button.addEventListener("click", () => { prodManageTypeFilter = button.dataset.prodManageType; filterList.querySelectorAll("button").forEach(item => item.classList.toggle("active", item === button)); prodApplyManageFilters(); renderManage(); }); });
  }
  const currentChip = [...document.querySelectorAll(".manage-side .status-chip")].find(item => item.textContent.includes("当前版本"));
  if (currentChip) currentChip.textContent = `当前版本 ${prodManagedCards.filter(item => item.isCurrent).length}`;
  const search = document.querySelector(".manage-toolbar .search");
  if (search) { search.value = prodManageSearch; if (!search.dataset.prodBound) { search.dataset.prodBound = "1"; search.addEventListener("input", () => { prodManageSearch = search.value.trim().toLocaleLowerCase(); prodApplyManageFilters(); renderManage(); }); } }
  const count = document.querySelector(".manage-toolbar h2 span"); if (count) count.textContent = `${prodManagedCards.length} 条`;
  const side = document.querySelector(".manage-side");
  if (side && !side.querySelector("#manageSyncFilter")) {
    side.insertAdjacentHTML("beforeend", '<label class="field-label" for="manageSyncFilter">信息同步</label><select id="manageSyncFilter" class="select"><option value="">全部状态</option><option value="queued">待同步</option><option value="failed">同步失败</option><option value="completed">已同步</option><option value="unavailable">连接失败</option></select>');
    side.querySelector("#manageSyncFilter").addEventListener("change", event => { prodManageSyncFilter = event.target.value; prodApplyManageFilters(); renderManage(); });
  }
  window.xbotEnhanceSelect?.(side?.querySelector("#manageSyncFilter"), false, "信息同步");
}

function prodApplyManageFilters() {
  const query = prodManageSearch;
  const matching = prodManagedCards.filter(item => (!prodManageProjectFilter || item.project === prodManageProjectFilter) && (!query || `${item.project} ${item.name} ${item.type} ${item.comp} ${item.version}`.toLocaleLowerCase().includes(query)));
  const visible = matching.filter(item => (!prodManageTypeFilter || item.type === prodManageTypeFilter) && (!prodManageSyncFilter || item.sync?.state === prodManageSyncFilter));
  // Type counts describe the choices within the current project/search scope.
  const typeCounts = new Map();
  matching.forEach(item => typeCounts.set(item.type, (typeCounts.get(item.type) || 0) + 1));
  document.querySelectorAll(".manage-side [data-prod-manage-type]").forEach(button => {
    const count = button.querySelector("em");
    if (count) count.textContent = String(button.dataset.prodManageType ? typeCounts.get(button.dataset.prodManageType) || 0 : matching.length);
  });
  const currentChip = [...document.querySelectorAll(".manage-side .status-chip")].find(item => item.textContent.includes("当前版本"));
  if (currentChip) currentChip.textContent = `当前版本 ${visible.filter(item => item.isCurrent).length}`;
  visible.sort(prodCompareManagedCards);
  managed.splice(0, managed.length, ...visible);
  if (!managed.some(item => item.id === managedId)) managedId = managed[0]?.id || "";
  const count = document.querySelector(".manage-toolbar h2 span"); if (count) count.textContent = `${visible.length} 条`;
}

function prodCompareManagedCards(left, right) {
  const compare = (a, b) => String(a || "").localeCompare(String(b || ""), "zh-CN", { numeric: true });
  const sign = prodManageSortDirection === "asc" ? 1 : -1;
  const byName = () => compare(left.name, right.name) || compare(left.project, right.project) || compare(left.type, right.type) || compare(left.version, right.version) || compare(left.packageId || left.id, right.packageId || right.id);
  if (prodManageSort === "name") return sign * compare(left.name, right.name) || byName();
  if (prodManageSort === "project") return sign * compare(left.project, right.project) || compare(left.type, right.type) || byName();
  if (prodManageSort === "type") return sign * compare(left.type, right.type) || compare(left.project, right.project) || byName();
  const a = left.batchImportedAt ?? left.importedAt ?? 0, b = right.batchImportedAt ?? right.importedAt ?? 0;
  if (!a || !b) return a ? -1 : b ? 1 : byName();
  return sign * (a - b) || compare(left.batchId, right.batchId) || byName();
}

async function prodReplaceManaged(packageId, kind) {
  const record = prodManagedRecords.find(item => item.packageId === packageId); if (!record) return;
  try {
    const paths = await prodSelectPaths(`选择${kind === "preview" ? "预览图" : "工程包"}`, ["openFile"], [{ name: kind === "preview" ? "PNG" : "ZIP", extensions: [kind === "preview" ? "png" : "zip"] }]);
    if (!paths.length) return;
    const accepted = await new Promise(resolve => { openModal(`<div class="modal-head"><div><h2>确认替换</h2><p>${prodEsc(record.packageName)} · ${prodEsc(record.packageId)}</p></div><button class="icon-btn" data-close>×</button></div><div class="modal-body"><p>新文件替换旧文件，旧文件保留</p><div class="warning-box">${prodEsc(paths[0])}</div><div class="drawer-footer"><button class="ghost-btn" data-prod-cancel>取消</button><button class="primary-btn" data-prod-accept>确认替换</button></div></div>`); document.querySelector("[data-prod-cancel]").onclick = () => { closeModal(); resolve(false); }; document.querySelector("[data-prod-accept]").onclick = () => { closeModal(); resolve(true); }; });
    if (!accepted) return;
    const result = await prodTeam.withTeamWrite(window.eagle, async () => {
      const latest = (await prodManagedApi.listFormalPackages(prodAdapter())).packages.find(item => item.packageId === record.packageId);
      return prodManagedApi.replaceFormalAsset(prodAdapter(), prodTeam.assertUnchanged(record, latest), kind, paths[0]);
    });
    const sync = await prodSubmitIngest({ batchId: result.batchId, projectName: result.projectName, sourcePath: result.sourcePath, importMode: "update", filed: [result] });
    await prodRefreshManaged();
    if (sync.state === "pending") prodShowIngestRetry(sync);
    else prodToast("替换完成", `${record.packageName} · ${kind === "preview" ? "PNG" : "ZIP"}。已提交同步，查询结果待核对${result.teamLockWarning ? "。" + result.teamLockWarning : ""}`, "success");
  } catch (error) { prodToast("替换失败", error.message, "error"); }
}

function prodOpenRepairChoice(item) {
  openModal(`<div class="modal-head"><div><h2>替换文件</h2><p>${prodEsc(item.name)}</p></div><button class="icon-btn" data-close>×</button></div><div class="modal-body"><div class="decision-list"><button class="decision-card" data-prod-repair="preview"><i>PNG</i><span><strong>更换图片</strong><small>${prodEsc(item.preview || "当前 PNG")}</small></span><b>→</b></button><button class="decision-card" data-prod-repair="source"><i>ZIP</i><span><strong>更换工程</strong><small>${prodEsc(item.source || "当前 ZIP")}</small></span><b>→</b></button></div><div class="drawer-footer"><button class="ghost-btn" data-close>取消</button></div></div>`);
  document.querySelectorAll("[data-close]").forEach(button => button.addEventListener("click", closeModal));
  document.querySelectorAll("[data-prod-repair]").forEach(button => button.addEventListener("click", () => { const kind = button.dataset.prodRepair; closeModal(); prodReplaceManaged(item.packageId, kind); }));
}

function prodOpenImage(name, file) {
  openModal(`<div class="modal-head"><div><h2>${prodEsc(name)} · 查看大图</h2><p>${prodEsc(file)}</p></div><button class="icon-btn" data-close>×</button></div><div class="modal-body"><div class="viewer has-actual-preview"><img class="frame-art actual-preview-image" src="${prodImageUrl(file)}" alt="${prodEsc(name)}"></div><div class="viewer-tools"><small>滚轮缩放，拖动查看，双击切换</small><div class="tool-group"><button class="tool-btn" aria-label="缩小">−</button><button class="tool-btn">适合窗口</button><button class="tool-btn" aria-label="放大">＋</button></div></div></div>`); bindClose(); bindPreviewViewer();
}

function prodOpenEmptyImage(name) {
  openModal(`<div class="modal-head"><div><h2>${prodEsc(name)} · 查看大图</h2><p>还没有可查看的图片</p></div><button class="icon-btn" data-close>×</button></div><div class="modal-body"><div class="viewer is-empty"><span class="preview-empty">暂无图片</span></div></div>`);
  bindClose();
}

function prodOpenAepPreview(comp) {
  if (comp.prodPreviewPath) { prodOpenImage(comp.name, comp.prodPreviewPath); return; }
  openModal(`<div class="modal-head"><div><h2>${prodEsc(comp.name)} · 查看大图</h2><p>还没有生成预览图</p></div><button class="icon-btn" data-close>×</button></div><div class="modal-body"><div class="viewer is-empty"><span class="preview-empty">暂无图片</span></div><div class="drawer-footer"><button class="primary-btn" type="button" data-prod-render-empty-preview>生成预览</button></div></div>`);
  bindClose();
  document.querySelector("[data-prod-render-empty-preview]")?.addEventListener("click", () => { closeModal(); prodRenderPreview(comp); });
}

async function prodCheckUpdates(force = false) {
  if (prodUpdateState.checking || prodUpdateState.downloading) return prodLatestRelease;
  const cached = prodUpdater.readUpdateCache(window.localStorage, prodManifest.version);
  if (cached) { prodLatestRelease = cached.info; prodUpdateState.checkedAt = cached.checkedAt; }
  prodUpdateState.retryAt = Math.max(prodUpdateState.retryAt || 0,
    prodUpdater.readUpdateCooldown(window.localStorage));
  if (prodUpdateState.retryAt > Date.now()) {
    prodUpdateState.error = "GitHub 暂时限制了更新查询频率。";
    prodUpdateState.errorStage = "check";
    prodRenderUpdates(); return prodLatestRelease;
  }
  if (!force && cached?.fresh) { prodRenderUpdates(); return prodLatestRelease; }
  prodUpdateState.checking = true; prodUpdateState.error = ""; prodUpdateState.errorStage = "check"; prodRenderUpdates();
  try {
    prodLatestRelease = await prodUpdater.checkForUpdate(prodManifest.version);
    prodUpdateState.checkedAt = Date.now();
    // Storage failures must not turn a successful network check into an error.
    try { localStorage.setItem("xbot.pluginUpdate.cache.v1", JSON.stringify({ checkedAt: prodUpdateState.checkedAt, info: prodLatestRelease })); } catch (_) {}
    return prodLatestRelease;
  } catch (error) {
    prodUpdateState.error = error.message;
    if (error.rateLimited && Number.isFinite(error.retryAt)) {
      prodUpdateState.retryAt = error.retryAt;
      try { localStorage.setItem(prodUpdater.UPDATE_COOLDOWN_KEY, JSON.stringify({ retryAt: error.retryAt })); } catch (_) {}
    }
    return null;
  } finally { prodUpdateState.checking = false; prodRenderUpdates(); }
}

async function prodAddTypeFromMenu(menu, input) {
  const picker = menu._xbotPicker || menu.closest(".package-type-picker");
  const trigger = picker?.querySelector("[data-package-type-trigger]");
  const scope = trigger?.dataset.packageTypeScope || "card";
  try {
    const name = await prodTeam.mutateType({ action: "create", name: input.value.trim() });
    prodRefreshTypes();
    closePackageTypePickers();
    if (scope === "managed" || scope === "migration") {
      const item = trigger?._managedPackage || trigger?._migrationPackage;
      if (item) { prodChangeManagedType(item.id, name); return; }
    }
    const pair = prodPair(trigger?.dataset.packageTypeTrigger);
    if (pair) { pair.type = name; delete prodOutputNames[pair.id]; }
    prodRenderPairs();
    prodToast("类型保存", name + " · 插件和机器人共用此类型", "success");
  } catch (error) { prodToast("保存失败", error.message, "error"); }
}

function prodBindTypeRow(row, type, context) {
  const name = row.querySelector('[data-type-name]'), aliases = row.querySelector('[data-type-aliases]'), enabled = row.querySelector('[data-type-enabled]'), apply = row.querySelector('[data-type-apply]'), error = row.querySelector('[data-type-error]');
  const values = () => ({ name: name.value.trim(), aliases: aliases.value, enabled: enabled.checked });
  let baseline = JSON.stringify(values());
  const state = {
    type, busy: false,
    dirty: () => !state.type || JSON.stringify(values()) !== baseline,
    update: () => {
      const dirty = state.dirty();
      apply.disabled = context.busy || !name.value.trim();
      const label = dirty ? (state.type ? '更新' : '新增') : state.type.enabled ? '启用' : '停用';
      const changed = apply.textContent !== label;
      if (changed) apply.textContent = label;
      apply.dataset.state = dirty ? 'dirty' : state.type.enabled ? 'enabled' : 'disabled';
      apply.dataset.pending = String(state.busy);
      apply.setAttribute('aria-busy', String(state.busy));
      if (changed && typeof prefersReducedMotion === 'function' && !prefersReducedMotion()) apply.animate?.([{ opacity: .65 }, { opacity: 1 }], { duration: 140, easing: 'ease-out' });
      apply.title = dirty ? '保存本行修改，保持当前启停状态' : state.type.enabled ? '当前启用，点击停用；已有素材仍可查' : '当前停用，点击启用';
      apply.setAttribute('aria-label', name.value + '：' + apply.title);
      row.classList.toggle('is-dirty', dirty);
    },
  };
  const fit = () => [name, aliases].forEach(input => {
    const length = [...(input.value || input.placeholder || '')].reduce((sum, char) => sum + (/[^\x00-\x7f]/.test(char) ? 1 : .58), 0);
    input.style.width = Math.max(input === name ? 5 : 12, length + 2) + 'em';
  });
  [name, aliases, enabled].forEach(input => input.addEventListener('input', () => { fit(); state.update(); }));
  fit();
  apply.onclick = async () => {
    if (apply.disabled || context.busy) return;
    const toggleStatus = Boolean(state.type) && !state.dirty();
    context.busy = true; state.busy = true; context.update();
    [name, aliases, enabled].forEach(input => input.disabled = true);
    error.textContent = '';
    try {
      const draft = values();
      if (toggleStatus) draft.enabled = !state.type.enabled;
      const created = await prodTeam.mutateType({ action: state.type ? 'update' : 'create', name: draft.name, aliases: draft.aliases.split(/[,，、\n]/).map(value => value.trim()).filter(Boolean), enabled: draft.enabled, ...(state.type ? { currentName: state.type.name, expected: state.type } : {}) });
      prodRefreshTypes();
      state.type = prodTypes.listPackageTypes().find(item => item.name === created);
      name.value = state.type.name; aliases.value = state.type.aliases.filter(alias => alias !== state.type.name).join('、'); enabled.checked = state.type.enabled;
      row.dataset.typeRecord = state.type.name;
      baseline = JSON.stringify(values()); fit();
      pairs.forEach(pair => { pair.type = prodTypes.normalizePackageType(pair.type) || pair.type; delete prodOutputNames[pair.id]; });
      if (screen === 'pair') prodRenderPairs(); if (screen === 'manage') renderManage();
      // The row itself confirms success; avoid a second transient notification.
    } catch (cause) { error.textContent = cause.message; }
    finally {
      context.busy = false; state.busy = false; [name, aliases, enabled].forEach(input => input.disabled = false);
      context.update();
    }
  };
  state.update(); return state;
}

async function prodOpenTypeManager(query = "", showDisabled = false, scrollTop = 0) {
  try { await prodTeam.refreshTypes(); prodRefreshTypes(); }
  catch (error) { prodToast("读取失败", error.message, "error"); return; }
  const types = prodTypes.listPackageTypes();
  const rowHtml = type => `<article class="type-browse-row" data-type-record="${prodEsc(type?.name || '')}"><div class="type-inline-fields"><input class="type-inline-name" data-type-name aria-label="类型名称" placeholder="类型名称" value="${prodEsc(type?.name || '')}" ><input class="type-inline-aliases" data-type-aliases aria-label="别名" placeholder="添加别名，用逗号分隔" value="${prodEsc(type?.aliases.filter(alias => alias !== type.name).join('、') || '')}"><p data-type-error role="alert"></p></div><input type="checkbox" data-type-enabled hidden ${type?.enabled !== false ? 'checked' : ''}><button class="ghost-btn" data-type-apply disabled>应用</button></article>`;
  openModal(`<div class="modal-head"><h2>类型管理</h2><button class="icon-btn" data-close aria-label="关闭类型管理">×</button></div><div class="modal-body type-manager"><div class="type-manager-toolbar"><input class="input" data-type-search aria-label="搜索类型或别名" placeholder="搜索类型或别名" value="${prodEsc(query)}"><button class="primary-btn" data-type-add>新增类型</button></div><div class="type-browse-list">${types.map(rowHtml).join('')}<p data-type-empty hidden>没有匹配的类型</p></div></div>`);
  bindClose();
  const search = document.querySelector('[data-type-search]'), list = document.querySelector('.type-browse-list'), add = document.querySelector('[data-type-add]');
  const states = new Map();
  const context = { busy: false, update: () => { states.forEach(state => state.update()); add.disabled = context.busy; } };
  document.querySelectorAll('[data-type-record]').forEach((row, i) => states.set(row, prodBindTypeRow(row, types[i], context)));
  document.querySelector('#modal')._beforeClose = () => !context.busy && (![...states.values()].some(state => state.dirty()) || window.confirm('修改尚未应用，放弃修改？'));
  const filter = () => {
    let count = 0;
    states.forEach((state, row) => {
      const name = row.querySelector('[data-type-name]').value, aliases = row.querySelector('[data-type-aliases]').value;
      row.hidden = !state.dirty() && !(name + ' ' + aliases).toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase());
      if (!row.hidden) count++;
    });
    document.querySelector('[data-type-empty]').hidden = count > 0;
  };
  search.oninput = filter; filter(); list.scrollTop = scrollTop;
  add.onclick = () => {
    const pending = [...states].find(([, state]) => !state.type);
    if (pending) { pending[0].querySelector('[data-type-name]').focus(); return; }
    list.insertAdjacentHTML('afterbegin', rowHtml(null));
    const row = list.firstElementChild; states.set(row, prodBindTypeRow(row, null, context));
    filter(); list.scrollTop = 0; row.querySelector('[data-type-name]').focus();
  };
}

function prodOpenTypeEditor(type, back, afterSave) {
  const initial = { name: type?.name || '', aliases: type?.aliases.filter(alias => alias !== type.name).join('，') || '', enabled: type?.enabled !== false };
  openModal(`<div class="modal-head"><h2>${type ? '编辑类型' : '新增类型'}</h2><button class="icon-btn" data-close aria-label="关闭类型编辑">×</button></div><div class="modal-body type-editor"><label class="form-group">类型名称<input class="input" data-type-name value="${prodEsc(initial.name)}"  placeholder="例如：章节标题"></label><label class="form-group">别名<textarea class="input" data-type-aliases rows="3" placeholder="用逗号分隔，例如：章节名、章节页">${prodEsc(initial.aliases)}</textarea></label><label class="type-enabled-field" ${type ? '' : 'hidden'}><input type="checkbox" data-type-enabled ${initial.enabled ? 'checked' : ''}> 启用此类型</label>${type ? '<p class="form-help">停用后不能用于新入库，已有素材仍可查。</p>' : ''}<p data-type-error role="alert"></p></div><div class="type-manager-footer"><button class="ghost-btn" data-type-cancel>取消</button><button class="primary-btn" data-type-save>保存</button></div>`);
  const modal = document.querySelector('#modal'), name = document.querySelector('[data-type-name]'), aliases = document.querySelector('[data-type-aliases]'), enabled = document.querySelector('[data-type-enabled]'), save = document.querySelector('[data-type-save]'), error = document.querySelector('[data-type-error]');
  let busy = false, saved = false;
  const values = () => ({ name: name.value.trim(), aliases: aliases.value, enabled: enabled.checked });
  const dirty = () => JSON.stringify(values()) !== JSON.stringify(initial);
  const mayLeave = () => !busy && (saved || !dirty() || window.confirm('修改尚未保存，放弃修改？'));
  modal._beforeClose = mayLeave;
  const cancel = () => { if (!mayLeave()) return; modal._beforeClose = null; if (back) back(); else closeModal(); };
  document.querySelector('[data-type-cancel]').onclick = cancel;
  document.querySelector('[data-close]').onclick = cancel;
  const update = () => { save.disabled = busy || !name.value.trim() || (Boolean(type) && !dirty()); };
  [name, aliases, enabled].forEach(input => input.addEventListener('input', update)); update();
  save.onclick = async () => {
    if (save.disabled || busy) return;
    busy = true; [name, aliases, enabled].forEach(input => input.disabled = true); update(); save.textContent = '保存中…'; error.textContent = '';
    try {
      const change = { action: type ? 'update' : 'create', name: name.value.trim(), aliases: aliases.value.split(/[,，、\n]/).map(value => value.trim()).filter(Boolean), enabled: enabled.checked, ...(type ? { currentName: type.name, expected: type } : {}) };
      const created = await prodTeam.mutateType(change);
      prodRefreshTypes(); pairs.forEach(pair => { pair.type = prodTypes.normalizePackageType(pair.type) || pair.type; delete prodOutputNames[pair.id]; });
      if (screen === 'pair') prodRenderPairs(); if (screen === 'manage') renderManage();
      saved = true; modal._beforeClose = null;
      if (afterSave) afterSave(created);
      if (back) await back(); else closeModal();
      prodToast('已保存', created, 'success');
    } catch (cause) { error.textContent = cause.message; }
    finally { busy = false; [name, aliases, enabled].forEach(input => input.disabled = false); save.textContent = '保存'; update(); }
  };
}

function prodOpenAddType(returnToManager = false) {
  const managedId = prodPendingManagedTypeId, pairId = prodPendingPairTypeId;
  prodPendingManagedTypeId = ''; prodPendingPairTypeId = '';
  prodOpenTypeEditor(null, returnToManager ? () => prodOpenTypeManager() : null, created => {
    const pair = prodPair(pairId); if (pair) { pair.type = created; delete prodOutputNames[pair.id]; prodRenderPairs(); }
    if (managedId) prodChangeManagedType(managedId, created);
  });
}

async function prodChangeManagedType(managedIdValue, value) {
  const card = managed.find(item => item.id === managedIdValue);
  const record = prodManagedRecords.find(item => item.packageId === card?.packageId);
  if (!record) return prodToast("更改失败", "找不到包装，请刷新后重试", "error");
  try {
    const result = await prodTeam.withTeamWrite(window.eagle, async () => {
      const latest = (await prodManagedApi.listFormalPackages(prodAdapter())).packages.find(item => item.packageId === record.packageId);
      return prodManagedApi.changeFormalPackageType(prodAdapter(), prodTeam.assertUnchanged(record, latest), value);
    });
    const sync = await prodSubmitIngest({ batchId: result.batchId, projectName: result.projectName, sourcePath: result.sourcePath, importMode: "update", filed: [result] });
    await prodRefreshManaged();
    if (sync.state === "pending") prodShowIngestRetry(sync);
    else prodToast("类型更新", `${record.packageName} → ${value}。已提交同步，查询结果待核对${result.teamLockWarning ? "。" + result.teamLockWarning : ""}`, "success");
  }
  catch (error) { prodToast("更改失败", error.message, "error"); }
}
function prodRenderUpdates() {
  const update = prodLatestRelease || {};
  const state = prodUpdateState, busy = state.checking || state.downloading;
  const cooling = (state.retryAt || 0) > Date.now();
  const retryTime = cooling ? new Date(state.retryAt).toLocaleString("zh-CN", { hour12: false }) : "";
  const newer = Boolean(update.updateAvailable && update.version && prodUpdater.compareVersions(update.version, prodManifest.version) > 0);
  if (state.cooldownTimer) { window.clearTimeout?.(state.cooldownTimer); state.cooldownTimer = null; }
  if (cooling && typeof window.setTimeout === "function") {
    state.cooldownTimer = window.setTimeout(() => { state.cooldownTimer = null; prodRenderUpdates(); }, Math.min(state.retryAt - Date.now() + 50, 2147483647));
  }
  const title = state.checking ? "检查中" : state.downloading ? "下载中"
    : state.error ? (state.errorStage === "download" ? "下载失败" : "检查失败") : !prodLatestRelease ? "等待检查"
    : !update.releaseFound ? "暂无新版"
    : newer ? "有新版本"
    : prodUpdater.compareVersions(prodManifest.version, update.version) > 0 ? "版本较新" : "已是最新";
  const setText = (selector, value) => { const element = document.querySelector(selector); if (element) element.textContent = value; };
  const versions = [...document.querySelectorAll(".update-version-row strong")];
  if (versions[0]) versions[0].textContent = `v${prodManifest.version}`;
  if (versions[1]) versions[1].textContent = update.version ? `v${update.version}` : "暂无";
  setText("#updateStatusTitle", title);
  setText("#previewUpdateStatus", state.checking ? "正在查询最新版本"
    : state.downloading ? state.progress || "正在连接下载服务…"
    : state.error ? `${state.error}${cooling ? ` 可于 ${retryTime} 后重试，期间暂停查询。` : " 可重新检查。"}${prodLatestRelease ? " · 保留上次查询结果，尚未重新核实。" : ""}`
    : update.releaseFound ? `${update.title} · ${title}${update.warning ? " · " + update.warning : ""}` : prodLatestRelease ? "还没有可用的正式版本" : "检查后显示发布信息。");
  const check = document.querySelector('[data-action="check-plugin-updates"]');
  if (check) { check.disabled = busy || cooling; check.textContent = state.checking ? "检查中" : cooling ? "等待恢复" : "检查更新"; }
  const download = document.querySelector('[data-action="download-plugin-update"]');
  const hasDigest = /^[a-f\d]{64}$/i.test(update.asset?.digest || "");
  if (download) {
    download.disabled = busy || !newer || !hasDigest;
    download.textContent = state.downloading ? "下载中" : !newer ? "暂无可用更新" : "下载更新";
  }
  const latestLabel = document.querySelector(".update-version-row:nth-of-type(3) > span:first-child");
  if (latestLabel) latestLabel.textContent = state.error ? "上次查询版本" : "公开发布版本";
  const lastCheck = state.checkedAt ? `上次成功检查：${new Date(state.checkedAt).toLocaleString()}` : "尚未完成检查";
  const sourceLabel = !prodLatestRelease ? "GitHub 静态清单 / Release 页面" : update.source === "manifest" ? "GitHub 静态清单" : update.source === "release-page" ? "GitHub Release 页面" : "GitHub（历史API结果）";
  setText(".update-channel", `更新来源 · ${sourceLabel} · ${lastCheck}`);
  const published = update.publishedAt && Number.isFinite(Date.parse(update.publishedAt))
    ? new Date(update.publishedAt).toLocaleString() : "未提供日期";
  setText(".update-card:nth-of-type(2) .update-card-head p", update.releaseFound ? `v${update.version} · 发布于 ${published}` : "更新内容");
  document.querySelectorAll(".update-demo-tag").forEach(tag => { tag.textContent = title; });
  const releaseBadge = document.querySelector(".update-version-row .update-demo-tag");
  if (releaseBadge) releaseBadge.textContent = state.error ? "历史结果" : newer ? "可更新" : "无需更新";
  setText(".update-notes", update.releaseFound ? update.notes || "此版本没有更新说明" : "还没有可用的正式版本");
  setText(".update-install-hint", state.file ? `安装包已保存：${state.file.path}。在 Eagle 确认安装后重开插件`
    : !newer ? "当前没有比本机更新的安装包，无需下载或降级。"
    : newer && !hasDigest ? "已发现新版，但尚无完整校验信息；可查看公开版本页，暂不提供插件内下载。"
    : "文件检查通过后，在 Eagle 确认安装");
  const releaseLink = document.querySelector("#updateReleaseLink");
  if (releaseLink) {
    const validRelease = update.version && update.releaseUrl === "https://github.com/OooT-x/xbot-packaging-search/releases/tag/eagle-plugin-v" + update.version;
    releaseLink.hidden = !validRelease;
    releaseLink.href = validRelease ? update.releaseUrl : "#";
  }
  const settingsCopy = document.querySelector(".settings-update-copy small");
  if (settingsCopy) settingsCopy.textContent = update.updateAvailable ? `v${update.version} 可用 · 查看更新内容` : `当前版本 v${prodManifest.version} · 查看更新状态`;
  const settingsBadge = document.querySelector(".settings-update-badge"); if (settingsBadge) { settingsBadge.textContent = update.updateAvailable ? "新" : ""; settingsBadge.hidden = !update.updateAvailable; }
  const settingsTrigger = document.querySelector("#tweakBtn"); if (settingsTrigger) { settingsTrigger.dataset.updateAvailable = String(Boolean(update.updateAvailable)); settingsTrigger.setAttribute("aria-label", update.updateAvailable ? "设置，有新版本" : "设置"); }
}
async function prodDownloadUpdate() {
  if (prodUpdateState.checking || prodUpdateState.downloading) return;
  if (!prodLatestRelease) return;
  prodUpdateState.downloading = true; prodUpdateState.error = ""; prodUpdateState.errorStage = "download"; prodUpdateState.progress = "";
  prodUpdateState.file = null; prodRenderUpdates();
  try {
    const update = prodLatestRelease;
    if (!update?.updateAvailable || !update.asset || prodUpdater.compareVersions(update.version, prodManifest.version) <= 0) throw new Error("当前没有可下载的稳定版 Release 安装包。");
    const downloads = prodPath.join(require("os").homedir(), "Downloads", "Xbot Eagle Plugin Updates");
    const file = await prodUpdater.downloadPluginUpdate(update, downloads, { onProgress: ({ received, total }) => {
      const mb = value => (value / 1024 / 1024).toFixed(1);
      prodUpdateState.progress = `已下载 ${mb(received)} / ${mb(total)} MB · ${Math.min(100, Math.floor(received / total * 100))}%`;
      prodRenderUpdates();
    } });
    prodUpdateState.file = file;
    if (typeof window.eagle?.shell?.openPath !== "function") throw new Error("安装包已保存，请从上述路径手动打开。");
    const openError = await window.eagle.shell.openPath(file.path);
    if (typeof openError === "string" && openError) throw new Error(`安装包已保存，Eagle 打开失败：${openError}`);
    prodToast("文件已检查", "在 Eagle 确认安装后重开插件", "success");
  } catch (error) {
    prodUpdateState.error = error.message;
    prodToast(prodUpdateState.file ? "安装包打开失败" : "下载更新失败", error.message, "error");
  } finally { prodUpdateState.downloading = false; prodRenderUpdates(); }
}

async function prodAction(event) {
  const action = event.target.closest("[data-action]"); if (!action) return;
  const key = action.dataset.action;
  if (key === "team-settings") { event.preventDefault(); event.stopImmediatePropagation(); prodOpenTeamSettings(); return; }
  const handled = new Set(["open-manage", "refresh", "choose-aep", "start-from-aep", "open-folder", "replace-folder", "choose-output-path", "collect", "stop-collect", "open-rename", "import", "go-home", "new-version", "new-package", "repair-current", "managed-preview", "change-managed-type", "check-plugin-updates", "download-plugin-update", "resume", "clear-selection", "select-visible", "expand", "open-updates", "manage-types", "add-type"]);
  if (!handled.has(key)) return;
  event.preventDefault(); event.stopImmediatePropagation();
  try {
    if (key === "open-manage") { prodSetScreen("manage"); await prodRefreshManaged(); }
    else if (key === "refresh") await prodRefreshManaged();
    else if (["choose-aep", "start-from-aep"].includes(key)) { const paths = await prodSelectPaths("选择工程", ["openFile"], [{ name: "After Effects", extensions: ["aep"] }]); if (paths.length) await prodRouteSelection(paths); }
    else if (["open-folder", "replace-folder"].includes(key)) { const paths = await prodSelectPaths("选文件夹", ["openDirectory"]); if (paths.length) await prodRouteSelection(paths); }
    else if (key === "choose-output-path") { const paths = await prodSelectPaths("选择位置", ["openDirectory"]); if (paths.length) { prodAepOutput = paths[0]; document.querySelector("#aepOutputPath").value = paths[0]; } }
    else if (key === "collect") await prodCollectAep();
    else if (key === "stop-collect") prodCollectionAbort?.abort();
    else if (key === "open-rename") prodOpenRename();
    else if (key === "import") prodOpenRename();
    else if (key === "go-home") prodSetScreen("home");
    else if (key === "new-version" || key === "new-package") { const item = managed.find(p => p.id === managedId); if (!item) return; const base = key === "new-version" ? prodManagedRecords.find(p => p.packageId === item.packageId) : null; prodSetWorkflow(key === "new-version" ? "new-version" : "managed-add", base, item.project); const paths = await prodSelectPaths(key === "new-version" ? "选择文件" : `添加包装 · ${item.project}`, ["openFile", "openDirectory", "multiSelections"], [{ name: "包装文件", extensions: ["aep", "png", "zip", "json"] }]); if (paths.length) await prodRouteSelection(paths, { kind: key === "new-version" ? "new-version" : "managed-add", base, projectName: item.project }); }
    else if (key === "repair-current") { const item = managed.find(p => p.id === managedId); if (item) prodOpenRepairChoice(item); }
    else if (key === "managed-preview") { const item = managed.find(p => p.id === managedId); if (item) item.previewPath ? prodOpenImage(item.name, item.previewPath) : prodOpenEmptyImage(item.name); }
    else if (key === "change-managed-type") { const item = managed.find(p => p.id === managedId); if (item) prodOpenManagedTypeModal(item); }
    else if (key === "check-plugin-updates") await prodCheckUpdates(true);
    else if (key === "download-plugin-update") await prodDownloadUpdate();
    else if (key === "manage-types") { closeTweaks(); prodOpenTypeManager(); }
    else if (key === "add-type") prodOpenAddType();
    else if (key === "open-updates") { prodSetScreen("updates"); prodRenderUpdates(); }
    else if (key === "resume") { prodSetScreen(workflowDraft?.stage || "home"); }
    else if (key === "clear-selection") { prodAepSelectedOccurrences.clear(); prodRenderAep(); }
    else if (key === "select-visible") { const visible = [...document.querySelectorAll("#treeList [data-comp-check]")].map(input => input.dataset.compCheck); const all = visible.length && visible.every(keyValue => prodAepSelectedOccurrences.has(keyValue)); visible.forEach(keyValue => all ? prodAepSelectedOccurrences.delete(keyValue) : prodAepSelectedOccurrences.add(keyValue)); prodRenderAep(); }
    else if (key === "expand") { window.prodTreeExpanded = !window.prodTreeExpanded; if (window.prodTreeExpanded) prodCollapsedTreeOccurrences.clear(); prodRenderAep(); }
  } catch (error) { prodToast("操作失败", error.message, "error"); }
}

function prodInteraction(event) {
  const target = event.target instanceof Element ? event.target : null; if (!target) return;
  if (event.type === "click") {
    const row = target.closest("#pairList .pair-row");
    if (row) { selectedPair = row.dataset.pair; document.querySelectorAll("#pairList .pair-row").forEach(card => card.classList.toggle("selected", card === row)); }
    const thumb = target.closest("#manageGrid .manage-thumb");
    if (thumb) {
      const item = managed.find(card => card.id === thumb.closest("[data-managed-card]")?.dataset.managedCard);
      if (item) { event.preventDefault(); event.stopImmediatePropagation(); item.previewPath ? prodOpenImage(item.name, item.previewPath) : prodOpenEmptyImage(item.name); return; }
    }
  }
  const asset = target.closest("[data-card-asset]");
  if (asset) { event.preventDefault(); event.stopImmediatePropagation(); const pair = prodPair(asset.dataset.pair); if (pair) prodOpenPairFileDrawer(pair.id, asset.dataset.cardAsset); return; }
  const managedAsset = target.closest("[data-managed-asset]");
  if (managedAsset) { event.preventDefault(); event.stopImmediatePropagation(); const card = managed.find(item => item.id === managedAsset.dataset.managed); if (card?.isCurrent) prodReplaceManaged(card.packageId, managedAsset.dataset.managedAsset); return; }
  const typeOption = target.closest("[data-package-type-option]");
  if (event.type === "click" && typeOption && typeOption.dataset.packageTypeScope === "card") {
    event.preventDefault(); event.stopImmediatePropagation();
    const pair = prodPair(typeOption.dataset.packageTypeOption);
    if (!pair) return;
    closePackageTypePickers();
    if (typeOption.dataset.packageTypeValue === "__add_type__") { prodPendingPairTypeId = pair.id; prodOpenAddType(); }
    else { prodRefreshTypes(); pair.type = typeOption.dataset.packageTypeValue; delete prodOutputNames[pair.id]; prodRenderPairs(); }
    return;
  }
  if (typeOption && typeOption.dataset.packageTypeScope === "managed") {
    event.preventDefault(); event.stopImmediatePropagation();
    const menu = typeOption.closest("[data-package-type-menu]"), picker = menu?._xbotPicker || typeOption.closest(".package-type-picker"), cardId = picker?.dataset.managedTypeSplit;
    if (typeOption.dataset.packageTypeValue === "__add_type__") { prodPendingManagedTypeId = cardId || ""; closePackageTypePickers(); prodOpenAddType(); }
    else if (cardId) { closePackageTypePickers(); prodChangeManagedType(cardId, typeOption.dataset.packageTypeValue); }
    return;
  }
  const status = target.closest("[data-card-status]");
  if (status) { event.preventDefault(); event.stopImmediatePropagation(); prodOpenStatus(status.dataset.cardStatus); return; }
  const check = target.closest("[data-pair-select]");
  if (check) { event.stopImmediatePropagation(); if (event.type === "change") { const pair = prodPair(check.dataset.pairSelect); if (pair) { pair.selected = check.checked; prodRenderPairs(); } } return; }
  const name = target.closest("[data-card-name]");
  if (name) { event.stopImmediatePropagation(); if (event.type === "change") { const pair = prodPair(name.dataset.cardName); if (pair) { pair.name = name.value.trim() || pair.name; prodRenderPairs(); } } return; }
  const type = target.closest("[data-card-type]");
  if (type instanceof HTMLSelectElement) { event.stopImmediatePropagation(); if (event.type === "change") { const pair = prodPair(type.dataset.cardType); if (pair && type.value === "__add_type__") { type.value = pair.type || ""; prodPendingPairTypeId = pair.id; prodOpenAddType(); } else if (pair) { pair.type = type.value; prodRenderPairs(); } } return; }
  const preview = target.closest("[data-preview-pair]");
  if (preview) { event.preventDefault(); event.stopImmediatePropagation(); const pair = prodPair(preview.dataset.previewPair); if (pair) pair.previewPath ? prodOpenImage(pair.name, pair.previewPath) : prodOpenEmptyImage(pair.name); return; }
  const zip = target.closest("[data-zip-pair]");
  if (zip) { event.preventDefault(); event.stopImmediatePropagation(); const pair = prodPair(zip.dataset.zipPair); if (pair?.sourcePath) prodToast("工程包", pair.sourcePath); return; }
}

function prodOpenManagedTypeModal(item) {
  const options = prodTypes.PACKAGE_TYPES.map(type => `<option value="${prodEsc(type)}" ${type === item.type ? "selected" : ""}>${prodEsc(type)}</option>`).join("");
  openModal(`<div class="modal-head"><div><h2>更改类型</h2><p>${prodEsc(item.name)} · ${prodEsc(item.packageId)}</p></div><button class="icon-btn" data-close>×</button></div><div class="modal-body"><div class="form-group"><label for="managedTypeSelect">包装类型</label><select class="select" id="managedTypeSelect">${options}<option value="__add_type__">＋ 添加类型</option></select></div><div class="warning-box">更改后调整文件位置、名称和分类</div><div class="drawer-footer"><button class="ghost-btn" data-close>取消</button><button class="primary-btn" data-prod-save-managed-type>确认更改</button></div></div>`);
  document.querySelectorAll("[data-close]").forEach(button => button.addEventListener("click", closeModal));
  document.querySelector("[data-prod-save-managed-type]")?.addEventListener("click", () => {
    const value = document.querySelector("#managedTypeSelect").value;
    if (value === "__add_type__") { prodPendingManagedTypeId = item.id; closeModal(); prodOpenAddType(); return; }
    closeModal(); prodChangeManagedType(item.id, value);
  });
}

function prodInstallBottomSheetGrabbers() {
  const namespace = "http://www.w3.org/2000/svg";
  document.querySelectorAll(".bottom-sheet-peek").forEach(peek => {
    if (peek.querySelector(".bottom-sheet-grabber-svg")) return;
    const svg = document.createElementNS(namespace, "svg");
    svg.classList.add("bottom-sheet-grabber-svg");
    svg.setAttribute("viewBox", "0 0 18 8");
    svg.setAttribute("aria-hidden", "true");
    [["grabber-collapsed", "2,4 9,4 16,4"], ["grabber-expanded", "2,2 9,6 16,2"]].forEach(([className, points]) => {
      const line = document.createElementNS(namespace, "polyline");
      line.classList.add(className);
      line.setAttribute("points", points);
      svg.appendChild(line);
    });
    peek.appendChild(svg);
  });
}

async function initializeProductionWorkbench() {
  window.prodWorkbenchReady = true;
  try { await prodTeam.refreshTypes(); } catch (error) { prodToast("团队连接", error.message, "normal"); }
  try {
    const retry = (await prodIngest.retry()).find(item => item.state === "pending");
    if (retry) prodShowIngestRetry(retry);
  } catch (error) { prodToast("同步失败", error.message, "normal"); }
  prodInstallTeamSettings();
  prodInstallBottomSheetGrabbers();
  compositions.splice(0, compositions.length); pairs.splice(0, pairs.length); managed.splice(0, managed.length);
  prodPairRenderer = renderPairs; prodManageRenderer = renderManage;
  prodRefreshTypes(); packageTypes.splice(0, packageTypes.length, ...prodTypes.PACKAGE_TYPES);
  openAddType = prodOpenAddType;
  renderAep = prodRenderAep; renderPairs = prodRenderPairs;
  const baseManageRenderer = prodManageRenderer;
  renderManage = function() {
    baseManageRenderer();
    prodSetManageCardSize(document.querySelector("#manageCardSize")?.value != null ? prodManageCardSizeOptions[Number(document.querySelector("#manageCardSize").value)] : "medium");
    const count = document.querySelector(".manage-toolbar h2 span"); if (count) count.textContent = `${managed.length} 条`;
    if (!managed.length) { document.querySelector("#manageGrid").innerHTML = '<div class="bottom-sheet-empty">没有找到符合条件的包装</div>'; document.querySelector("#manageInspector").innerHTML = '<div class="bottom-sheet-empty">选择包装，查看详情和操作</div>'; return; }
    document.querySelectorAll("#manageGrid .manage-card").forEach(card => {
      const id = card.dataset.managedCard, item = managed.find(value => value.id === id); if (!item) return;
      const image = card.querySelector(".manage-thumb"); if (image && item.previewPath) { image.classList.add("has-actual-preview"); image.innerHTML = `<img class="frame-art actual-preview-image" src="${prodImageUrl(item.previewPath)}" alt="${prodEsc(item.name)}">`; }
      const pills = card.querySelector(".pill-row"); if (pills) pills.innerHTML = `<button type="button" class="tiny-pill asset-chip-button" data-managed-asset="preview" data-managed="${prodEsc(id)}" ${item.isCurrent ? "" : "disabled"}>预览图 ✓</button><button type="button" class="tiny-pill asset-chip-button" data-managed-asset="source" data-managed="${prodEsc(id)}" ${item.isCurrent ? "" : "disabled"}>工程包 ✓</button>`;
    });
    prodDecorateManagedSync();
  };
  managedArt = item => item?.previewPath ? `<img class="frame-art actual-preview-image" src="${prodImageUrl(item.previewPath)}" alt="${prodEsc(item.name)} 的 PNG 预览">` : '<span class="preview-empty">暂无图片</span>';
  document.addEventListener("click", prodInteraction, true);
  document.addEventListener("change", prodInteraction, true);
  document.addEventListener("click", prodAction, true);
  document.addEventListener("click", event => {
    const button = event.target.closest("[data-retry-package-sync]"); if (!button) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (!button.disabled) prodRetryManagedSync(button.dataset.retryPackageSync);
  }, true);
  document.querySelector("#pairProjectName")?.addEventListener("change", event => { const value = event.target.value.trim(); if (value) { prodProject = value; if (workflowDraft) workflowDraft.project = value; prodSetPairSource(prodPath.basename(prodSourceDir || "交付文件夹")); } else event.target.value = prodProject; });
  document.querySelector("#themeBtn")?.addEventListener("click", () => { localStorage.setItem("xbot.theme", document.body.dataset.theme); });
  const manageCardSizeInput = document.querySelector("#manageCardSize");
  let savedManageCardSize = "medium";
  try { savedManageCardSize = localStorage.getItem("xbot.manage-card-size.v1") || "medium"; } catch {}
  prodSetManageCardSize(savedManageCardSize);
  manageCardSizeInput?.addEventListener("input", () => prodSetManageCardSize(prodManageCardSizeOptions[Number(manageCardSizeInput.value)] || "medium", true));
  prodRestoreManageSort();
  document.querySelector("#manageSort")?.addEventListener("change", event => prodSetManageSort(event.target.value, true));
  document.querySelector("#manageSortDirection")?.addEventListener("click", () => prodSetManageSort(prodManageSort, true, prodManageSortDirection === "asc" ? "desc" : "asc"));
  prodBindHomeDropZone();
  document.querySelector("#homeDropZone")?.addEventListener("click", async event => { if (event.target.closest("button")) return; try { const paths = await prodSelectPaths("选择文件", ["openFile", "openDirectory", "multiSelections"], [{ name: "包装文件", extensions: ["aep", "png", "zip", "json"] }]); if (paths.length) await prodRouteSelection(paths); } catch (error) { prodToast("读取失败", error.message, "error"); } });
  document.querySelectorAll("[data-home-pick]").forEach(button => button.addEventListener("click", async event => { event.preventDefault(); event.stopImmediatePropagation(); try { const isAep = button.dataset.homePick === "aep"; const paths = await prodSelectPaths(isAep ? "选择工程" : "选文件夹", isAep ? ["openFile"] : ["openDirectory"], isAep ? [{ name: "After Effects", extensions: ["aep"] }] : []); if (paths.length) await prodRouteSelection(paths); } catch (error) { prodToast("选择失败", error.message, "error"); } }));
  document.querySelector("#pairTabs")?.addEventListener("click", event => { const tab = event.target.closest("[data-pair-filter]"); if (!tab) return; pairFilter = tab.dataset.pairFilter; document.querySelectorAll("#pairTabs [data-pair-filter]").forEach(item => item.classList.toggle("active", item === tab)); prodRenderPairs(); }, true);
  document.querySelector("#aepOutputPath")?.addEventListener("change", event => { prodAepOutput = event.target.value.trim(); });
  document.body.dataset.theme = localStorage.getItem("xbot.theme") || "light";
  prodSetApiStatus(window.eagle?.item && window.eagle?.folder ? "ready" : "unavailable");
  document.querySelector("#pairProjectName").value = "";
  document.querySelector("#aepOutputPath").value = "";
  document.querySelector("#pairSourceName").textContent = "未选文件";
  document.querySelector("#pairSourceMeta").textContent = "选择工程或文件夹";
  document.querySelector("#aepSourceName").textContent = "未选工程";
  document.querySelector("#aepSourceMeta").textContent = "选择后自动读取工程内容";
  document.querySelector("#treeList").innerHTML = '<div class="bottom-sheet-empty">先选择工程，再查看合成列表</div>';
  document.querySelector("#aepInspector").innerHTML = '<div class="bottom-sheet-empty">还未选择工程</div>';
  document.querySelector("#pairList").innerHTML = '<div class="bottom-sheet-empty">先选文件夹，再查看检查结果</div>';
  document.querySelector("#manageGrid").innerHTML = '<div class="bottom-sheet-empty">打开图库，查看已保存的包装</div>';
  prodRenderManageFilters(); prodApplyManageFilters();
  setScreen("home", { remember: false });
  const localVersion = document.querySelector(".update-version-row strong"); if (localVersion) localVersion.textContent = `v${prodManifest.version}`;
  const updateBadges = document.querySelectorAll(".update-demo-tag"); updateBadges.forEach((badge, index) => { badge.textContent = index ? "等待检查" : "检查中"; });
  document.querySelector("#updateStatusTitle").textContent = "检查中";
  document.querySelector("#previewUpdateStatus").textContent = "正在查询最新版本";
  document.querySelector("#updatesTitle")?.parentElement?.querySelector("p")?.replaceChildren(document.createTextNode("查看更新内容，下载后确认安装"));
  document.querySelector(".update-notes").style.whiteSpace = "pre-wrap";
  document.querySelector(".update-notes").style.overflowWrap = "anywhere";
  document.querySelector(".update-install-hint").style.overflowWrap = "anywhere";
  document.querySelector(".update-notes").textContent = "检查后显示更新内容";
  // Each plugin window queries once on initialization; the update page only renders this result.
  prodCheckUpdates(true);
  try { if (prodTeam.readConfig().unconfigured) prodOpenTeamSettings(); } catch { prodOpenTeamSettings(); }
}
