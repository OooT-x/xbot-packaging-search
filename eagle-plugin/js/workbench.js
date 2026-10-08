/* Production controller for the v5 preview-native Eagle workbench. */
const prodFs = require("fs");
const prodPath = require("path");
const prodManifest = require("../manifest.json");
const prodWorker = require("../lib/aep-worker.js");
const prodScan = require("../lib/scan.js");
const prodTypes = require("../lib/package-types.js");
const prodUpdater = require("../lib/updater.js");
const prodIngest = require("../lib/ingest-bridge.js");
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
const prodEsc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const prodToast = (title, message, kind = "normal") => toast(title, message, kind);
const prodAdapter = () => {
  if (!window.eagle?.item || !window.eagle?.folder) throw new Error("请在 Eagle 插件窗口中操作");
  return new prodEagle.EaglePluginAdapter(window.eagle);
};
const prodAllComps = () => prodAepProject?.compositions || [];
const prodComp = id => prodAllComps().find(item => String(item.id) === String(id));
const prodPair = id => pairs.find(item => String(item.id) === String(id));
const prodName = pkg => pkg.packageName || pkg.compName || pkg.name || "未命名包装";
const prodImageUrl = value => value ? `file:///${String(value).replace(/\\/g, "/").replace(/^\/+/, "")}` : "";
function prodSetApiStatus(state) {
  const indicator = document.querySelector(".api"), label = indicator?.querySelector("span");
  if (!indicator || !label) return;
  indicator.classList.toggle("ready", state === "ready");
  indicator.classList.toggle("error", state === "error" || state === "unavailable");
  label.textContent = state === "ready" ? "Eagle API · 已就绪" : state === "error" ? "Eagle API · 读取失败" : state === "unavailable" ? "Eagle API · 不可用" : "Eagle API · 检查中";
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
    missing: !preview || (!source && pkg.packageType !== "背景"), conflict: Boolean(pkg.conflict || pkg.ambiguous),
    packageId: pkg.packageId || "", basePackageId: pkg.basePackageId || "", note: (pkg.errors || []).join("；") || (pkg.warnings || []).join("；") || "PNG、ZIP 与 manifest 已完成扫描",
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
  const hard = !pkg.previewPath || (!pkg.sourcePath && pkg.packageType !== "背景") || !prodTypes.isPackageTypeActive(pkg.packageType) || pair.conflict;
  const riskPending = Boolean((pkg.missingFiles || pkg.missingFootage || []).length && !pkg.riskAccepted);
  pkg.state = hard || riskPending ? "blocked" : "ready";
  pkg.riskOverrideEligible = Boolean((pkg.missingFiles || pkg.missingFootage || []).length);
  pkg.errors = hard ? [!pkg.previewPath ? "缺少配对 PNG" : !pkg.sourcePath && pkg.packageType !== "背景" ? "缺少配对 ZIP" : !prodTypes.isPackageTypeActive(pkg.packageType) ? (prodTypes.normalizePackageType(pkg.packageType) ? "该包装类型已停用，请更换类型或在设置中恢复" : "该类型尚未保存到共享配置，请在设置中新增包装类型") : "文件配对存在冲突"] : riskPending ? ["发现缺失素材，确认风险后可入库"] : [];
  pkg.matchError = pkg.errors[0] || "";
  pair.state = pkg.state === "ready" ? "ready" : "review";
  pair.note = pair.state === "ready" ? (pkg.riskAccepted ? `风险已确认 · ${pkg.missingFiles?.join("、") || pkg.missingFootage?.join("、") || "依赖缺失"}` : "扫描通过 · 可写入 Eagle 正式目录") : pkg.errors.join("；");
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
    } else if (previewButton) previewButton.innerHTML = '<span class="preview-empty">暂无预览图</span>';
    card.querySelector(".row-meta")?.replaceChildren(document.createTextNode(`${prodProject} · ${p.type || "待补充类型"} · ${p.version}`));
    const chips = card.querySelector(".row-chips");
    if (chips) chips.innerHTML = [["preview", "PNG", p.preview], ["source", "ZIP", p.source]].map(([kind, label, file]) => `<button type="button" class="tiny-pill asset-chip-button${file ? "" : " is-missing"}" data-card-asset="${kind}" data-pair="${prodEsc(p.id)}" title="${prodEsc(file || `${label} 缺失`)}" aria-label="更换 ${prodEsc(p.name)} 的 ${label}：${prodEsc(file || "缺失")}"><span class="asset-chip-label">${label}</span><span class="asset-chip-name">${prodEsc(file || "缺失")}</span></button>`).join("");
    const note = card.querySelector(".pair-note");
    if (note) note.textContent = p.note;
  });
}

function prodOpenPairFileDrawer(id, kind) {
  const pair = prodPair(id); if (!pair || !prodScanResult) return;
  const candidates = (prodScanResult.files || []).filter(file => file.kind === (kind === "preview" ? "png" : "zip") && file.status !== "ignore");
  const rows = candidates.map(file => `<button class="candidate" type="button" data-prod-select-file="${prodEsc(file.path)}" aria-pressed="false"><span class="candidate-thumb ${kind === "preview" ? "has-actual-preview" : ""}">${kind === "preview" ? `<img class="frame-art actual-preview-image" src="${prodImageUrl(file.path)}" alt="">` : "ZIP"}</span><span class="candidate-copy"><strong>${prodEsc(file.name)}</strong>${file.relative && file.relative !== file.name ? `<small>${prodEsc(file.relative)}</small>` : ""}</span><span class="check"></span></button>`).join("") || '<p>扫描结果中没有可选文件。</p>';
  openDrawer(`<div class="drawer-head"><div><h2>更换${kind === "preview" ? "PNG 预览图" : "ZIP 打包文件"}</h2><p>${prodEsc(pair.name)} · 从当前扫描结果选择</p></div><button class="icon-btn" data-drawer-close>×</button></div><div class="drawer-body file-picker-body"><div class="candidate-list file-candidate-list">${rows}</div><button class="quiet" type="button" data-prod-pick-external>从其他位置选择文件</button></div><div class="drawer-footer"><button class="ghost-btn" data-drawer-close>取消</button><button class="primary-btn" data-prod-apply-file="${prodEsc(pair.id)}" data-kind="${kind}" disabled>应用配对</button></div>`);
  let selected = "";
  document.querySelectorAll("[data-prod-select-file]").forEach(button => button.addEventListener("click", () => { selected = button.dataset.prodSelectFile; document.querySelectorAll("[data-prod-select-file]").forEach(row => { row.classList.toggle("selected", row === button); row.setAttribute("aria-pressed", String(row === button)); row.querySelector(".check").textContent = row === button ? "✓" : ""; }); const apply = document.querySelector("[data-prod-apply-file]"); if (apply) apply.disabled = false; }));
  document.querySelector("[data-prod-pick-external]")?.addEventListener("click", async () => { try { const paths = await prodSelectPaths(`选择${kind === "preview" ? "PNG" : "ZIP"}`, ["openFile"], [{ name: kind === "preview" ? "PNG" : "ZIP", extensions: [kind === "preview" ? "png" : "zip"] }]); if (paths.length) { selected = paths[0]; document.querySelectorAll("[data-prod-select-file]").forEach(row => { row.classList.remove("selected"); row.setAttribute("aria-pressed", "false"); row.querySelector(".check").textContent = ""; }); const apply = document.querySelector("[data-prod-apply-file]"); if (apply) apply.disabled = false; } } catch (error) { prodToast("选择文件失败", error.message, "error"); } });
  document.querySelector("[data-prod-apply-file]")?.addEventListener("click", () => { if (kind === "preview") { pair.previewPath = selected; pair.preview = prodPath.basename(selected); } else { pair.sourcePath = selected; pair.source = prodPath.basename(selected); } closeDrawer(); prodRenderPairs(); prodToast("配对已更新", `${pair.name} · ${kind === "preview" ? "PNG" : "ZIP"}`, "success"); });
  document.querySelectorAll("[data-drawer-close]").forEach(button => button.addEventListener("click", closeDrawer));
}

function prodOpenStatus(id) {
  const pair = prodPair(id); if (!pair) return;
  const missing = pair.missingFiles || [];
  openDrawer(`<div class="drawer-head"><div><h2>${pair.state === "ready" ? "配对已就绪" : "处理配对问题"}</h2><p>${prodEsc(pair.name)} · ${prodEsc(pair.type || "待补充类型")}</p></div><button class="icon-btn" data-drawer-close>×</button></div><div class="drawer-body">${pair.note ? `<p>${prodEsc(pair.note)}</p>` : ""}<div class="detail-grid"><div><span>PNG</span><strong>${prodEsc(pair.previewPath || "缺失")}</strong></div><div><span>ZIP</span><strong>${prodEsc(pair.sourcePath || "背景可仅图片入库")}</strong></div><div><span>目标目录</span><strong>01_预览图 / ${prodEsc(pair.type || "待选择类型")}</strong></div></div>${missing.length ? `<div class="warning-box"><strong>依赖缺失</strong>${missing.map(file => `<div>${prodEsc(file)}</div>`).join("")}<label><input type="checkbox" data-prod-risk="${prodEsc(id)}" ${pair.riskAccepted ? "checked" : ""}>我已了解风险，允许本组入库</label></div>` : ""}</div><div class="drawer-footer"><button class="ghost-btn" data-drawer-close>关闭</button></div>`);
  document.querySelectorAll("[data-drawer-close]").forEach(button => button.addEventListener("click", closeDrawer));
  document.querySelector("[data-prod-risk]")?.addEventListener("change", event => { pair.riskAccepted = event.target.checked; pair.selected = event.target.checked; closeDrawer(); prodRenderPairs(); });
}

async function prodSelectPaths(title, properties = ["openFile", "openDirectory", "multiSelections"], filters = []) {
  const result = await window.eagle.dialog.showOpenDialog({ title, properties, filters });
  return result?.canceled ? [] : (result?.filePaths || []);
}

async function prodRouteSelection(paths, options = {}) {
  const selected = (paths || []).filter(Boolean);
  if (!selected.length) return;
  const dirs = selected.filter(value => prodFs.statSync(value).isDirectory());
  const aeps = selected.filter(value => /\.aep$/i.test(value));
  if (aeps.length && (options.kind === "new-version" || workflowDraft?.kind === "new-version")) throw new Error("发布新版本需要选择只包含一组 PNG + ZIP 的交付文件夹。");
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
    prodToast("扫描完成", `${pairs.length} 组候选 · ${scan.errors?.length || 0} 个扫描错误`, "success");
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
  if (name) name.textContent = `${prodProject} · ${workflowDraft?.kind === "new-version" ? "发布新版本" : "新增包装配对"}`;
  if (meta) meta.textContent = `${pairs.length} 组候选 · ${source} · ${workflowDraft?.version || "v01"}`;
}

function prodLoadPairs(scan) {
  if (workflowDraft?.kind === "new-version") {
    if ((scan.packages || []).length !== 1) throw new Error("发布新版本必须只包含一组包装记录，请重新选择交付文件夹。");
    const source = scan.packages[0];
    const base = prodManagedRecords.find(item => item.packageId === workflowDraft.basePackageId);
    if (!base) throw new Error("找不到要继承的当前包装记录，请返回素材库刷新后重试。");
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
  const status = document.querySelector("#aepSourceMeta"); if (status) status.textContent = "Worker 正在读取合成结构…";
  try {
    prodAepProject = await prodWorker.inspectAep(prodAepPath);
    const comps = prodAllComps(); prodActiveId = comps.find(item => !(item.parent_ids || []).length)?.id ?? comps[0]?.id ?? null;
    prodAepSelectedOccurrences.clear(); prodAepOccurrenceMap.clear(); prodActiveOccurrence = "";
    comps.forEach(item => { item.collectImage = true; item.collectFile = true; item.previewTime = Math.min(2, Math.max(0, Number(item.duration || 0) - 1 / Math.max(1, Number(item.frame_rate || 25)))); });
    prodRenderAep();
    if (status) status.textContent = `${prodAepProject.composition_count || comps.length} 个合成 · ${prodAepProject.item_count || 0} 个项目项 · Worker 就绪`;
    prodToast("AEP 结构已读取", "选择需要独立收集的合成。", "success");
  } catch (error) { if (status) status.textContent = "AEP 读取失败"; prodToast("AEP 读取失败", error.message, "error"); }
}


function prodAepReviewReasons(c) {
  const reasons = [], name = String(c.name || ""), parents = [...new Set((c.parent_ids || []).map(String))];
  if (/(视频框|横屏框|竖屏框)/u.test(name)) reasons.push({ title: "确认视频框的预览取景", detail: "名称包含视频框类关键词。这是取景提示，尚未证明工程存在错误。", advice: "生成预览，检查框体是否完整、取帧时间是否合适。收集含视频依赖时会在副本中替换为首帧 PNG，请打开输出工程核对画面。" });
  if (parents.length > 1) reasons.push({ title: "确认共享合成的使用位置", detail: "被 " + parents.length + " 个父合成引用：" + parents.map(id => prodComp(id)?.name || ("合成 ID " + id)).join("、"), advice: "按需要勾选层级位置；同一合成会按 ID 去重，只输出一份独立收集包。检查当前预览来源是否符合要交付的使用场景。" });
  if (/(测试|临时)/u.test(name)) reasons.push({ title: "确认是否为正式交付内容", detail: "名称包含“测试”或“临时”，仅由命名规则触发。", advice: "核对内容是否需要交付；不需要时取消勾选，需要时可继续收集，并在配对页修改包装名称和类型。" });
  return reasons;
}

function prodOpenAepReview(c) {
  if (!c) return;
  const reasons = prodAepReviewReasons(c);
  openDrawer('<div class="drawer-head"><div><h2>合成复核建议</h2><p>' + prodEsc(c.name) + '</p></div><button class="icon-btn" data-drawer-close aria-label="关闭复核建议">×</button></div><div class="drawer-body aep-review-body"><p>以下提示来自合成名称和引用结构，不是工程错误检测结果；不会阻止收集。</p>' + reasons.map(reason => '<section class="review-reason"><h3>' + prodEsc(reason.title) + '</h3><p>' + prodEsc(reason.detail) + '</p><strong>处理建议</strong><p>' + prodEsc(reason.advice) + '</p></section>').join('') + '</div><div class="drawer-footer"><button class="ghost-btn" data-drawer-close>返回合成</button><button class="primary-btn" data-review-preview ' + (c.prodPreviewRendering ? 'disabled' : '') + '>' + (c.prodPreviewPath ? '查看预览' : '生成预览') + '</button></div>');
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
    const status = needsReview ? "需复核" : (c.parent_ids || []).length ? "直属预合成" : "顶层合成";
    const checked = prodAepSelectedOccurrences.has(key) ? "checked" : "";
    const active = key === prodActiveOccurrence || (!prodActiveOccurrence && String(c.id) === String(prodActiveId));
    const hasChildren = children.has(String(c.id));
    return `<div class="tree-row ${active ? "active" : ""}" data-comp="${prodEsc(c.id)}" data-occurrence="${prodEsc(key)}" role="treeitem" tabindex="${active ? 0 : -1}" aria-level="${depth}" ${hasChildren ? `aria-expanded="${nodeExpanded}"` : ""}><button class="tree-disclosure" data-prod-toggle-tree aria-label="${nodeExpanded ? "收起" : "展开"} ${prodEsc(c.name)}" aria-expanded="${nodeExpanded}" ${hasChildren ? "" : "disabled"}>${hasChildren ? nodeExpanded ? "⌄" : "›" : ""}</button><input type="checkbox" data-comp-check="${prodEsc(key)}" ${checked} aria-label="选择 ${prodEsc(c.name)}"><span class="kind ${kind}">${kind === "root" ? "ROOT" : kind === "link" ? "LINK" : "PRE"}</span><div class="tree-name"><strong>${prodEsc(c.name)}</strong><small>${prodEsc(status)}</small></div><span class="tree-meta">${Number(c.width || 0)} × ${Number(c.height || 0)}</span><span class="tree-meta">${Number(c.duration || 0).toFixed(2)}s</span>${needsReview ? `<button type="button" class="status-chip warn aep-review-button" data-prod-aep-review="${prodEsc(c.id)}" aria-label="查看 ${prodEsc(c.name)} 的复核原因和建议">需复核 ↗</button>` : '<span class="status-chip ok">可收集</span>'}</div>`;
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
  list.innerHTML = visibleRoots.map(root => renderNode(root, 1, new Set())).join("") || '<div class="bottom-sheet-empty">没有符合筛选条件的合成。</div>';
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
  if (c && inspector) { const size = `${c.width} × ${c.height}`, duration = Number(c.duration || 0), time = Number(c.previewTime || 0).toFixed(2), needsReview = hasWarning(c); inspector.innerHTML = `<div class="inspector-head"><div><strong>${prodEsc(c.name)}</strong><small>${prodEsc(c.role || "AE 合成")}</small></div>${needsReview ? `<button type="button" class="status-chip warn aep-review-button" data-prod-aep-review="${prodEsc(c.id)}" aria-label="查看 ${prodEsc(c.name)} 的复核原因和建议">需复核 ↗</button>` : '<span class="status-chip ok">可收集</span>'}</div><button type="button" class="preview-frame ${c.prodPreviewPath ? "has-actual-preview" : "is-empty"} ${c.prodPreviewRendering ? "is-rendering" : ""}" aria-busy="${Boolean(c.prodPreviewRendering)}" aria-label="查看 ${prodEsc(c.name)} 的预览大图">${c.prodPreviewPath ? `<img class="frame-art actual-preview-image" src="${prodImageUrl(c.prodPreviewPath)}" alt="${prodEsc(c.name)} 代表帧">` : '<span class="preview-empty">暂无预览图</span>'}${c.prodPreviewRendering ? '<span class="preview-rendering-overlay" role="status"><i class="preview-rendering-spinner"></i><span>正在生成预览…</span></span>' : ''}</button><div class="preview-actions"><label class="preview-time"><span>预览帧</span><input data-prod-preview-time type="number" min="0" max="${duration}" step="0.01" value="${time}"><span>秒</span></label><button class="primary-btn" data-prod-render-preview ${c.prodPreviewRendering ? "disabled" : ""}>${c.prodPreviewRendering ? "正在渲染…" : c.prodPreviewPath ? "重新生成" : "生成预览"}</button></div><div class="detail-block"><h4>Composition facts</h4><div class="detail-grid"><div><span>尺寸</span><strong>${size}</strong></div><div><span>时长</span><strong>${duration.toFixed(2)} 秒 · ${Number(c.frame_rate || 0)} fps</strong></div><div><span>预览来源</span><strong>${prodEsc(c.prodPreviewSourceName || c.name)}</strong></div><div><span>代表帧</span><strong data-prod-time-label>${time} 秒</strong></div></div></div><div class="detail-block"><h4>收集状态</h4><p>${prodActiveOccurrence && prodAepSelectedOccurrences.has(prodActiveOccurrence) ? "已加入当前层级的收集队列" : "尚未加入当前层级的收集队列"} · 重复引用将按合成 ID 去重</p></div>`;
    inspector.querySelector("[data-prod-preview-time]").addEventListener("change", event => { c.previewTime = Math.min(duration, Math.max(0, Number(event.target.value) || 0)); event.target.value = c.previewTime.toFixed(2); inspector.querySelector("[data-prod-time-label]").textContent = `${c.previewTime.toFixed(2)} 秒`; });
    inspector.querySelector("[data-prod-render-preview]").addEventListener("click", () => prodRenderPreview(c));
    inspector.querySelector(".preview-frame")?.addEventListener("click", () => prodOpenAepPreview(c));
  } else if (inspector) {
    inspector.innerHTML = '<div class="bottom-sheet-empty">没有符合当前筛选条件的合成。</div>';
  }
  document.querySelectorAll("[data-prod-aep-review]").forEach(button => button.addEventListener("click", event => { event.stopPropagation(); prodOpenAepReview(prodComp(button.dataset.prodAepReview)); }));
  const selectedComps = [...new Set([...prodAepSelectedOccurrences].map(key => prodAepOccurrenceMap.get(key)?.id).filter(value => value !== undefined).map(String))].map(prodComp).filter(Boolean);
  const count = prodAepSelectedOccurrences.size;
  document.querySelector("#aepSelectionText").textContent = `已选 ${count} 个层级位置`;
  document.querySelector("#aepSelectionHint").textContent = `${selectedComps.length} 个独立合成 · 图片 ${selectedComps.filter(item => item.collectImage !== false).length} · 文件 ${selectedComps.filter(item => item.collectFile !== false).length}`;
  const toolbar = document.querySelector(".tree-toolbar p"); if (toolbar) toolbar.textContent = `${prodPath.basename(prodAepPath)} · ${comps.length} 个合成 · ${comps.filter(item => !(item.parent_ids || []).length).length} 个顶层合成`;
  const source = document.querySelector("#aepSourceName"); if (source) source.textContent = prodPath.basename(prodAepPath);
  prodRenderCollectionSheet();
}

function prodRenderCollectionSheet() {
  const selected = [...prodAepSelectedOccurrences].map(key => ({ key, comp: prodAepOccurrenceMap.get(key) })).filter(entry => entry.comp), list = document.querySelector("#aepCollectionList"); if (!list) return;
  list.innerHTML = selected.length ? selected.map(({ key, comp: c }) => `<article class="bottom-sheet-row"><div class="bottom-sheet-row-copy"><strong>${prodEsc(c.name)}</strong><small>${prodEsc(key.split("/").slice(0, -1).map(id => prodComp(id)?.name).filter(Boolean).join(" / ") || "顶层合成")} · ${Number(c.width || 0)} × ${Number(c.height || 0)} · ${Number(c.duration || 0).toFixed(2)}s · PNG ${c.collectImage === false ? "关闭" : "开启"} · ZIP ${c.collectFile === false ? "关闭" : "开启"}</small></div><div class="collection-rule-actions"><button class="collection-rule" data-prod-output="image" data-comp="${prodEsc(c.id)}" aria-pressed="${c.collectImage !== false}">收集图片</button><button class="collection-rule" data-prod-output="file" data-comp="${prodEsc(c.id)}" aria-pressed="${c.collectFile !== false}">收集文件</button></div></article>`).join("") : '<div class="bottom-sheet-empty">尚未选择合成，请先在结构浏览器中勾选。</div>';
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
    prodToast("预览已生成", `${comp.name} · ${Number(result.preview_time ?? comp.previewTime).toFixed(2)} 秒`, "success");
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
  if (!chosen.length) return prodToast("请选择合成", "至少选择一个合成和一种输出。", "error");
  if (selectedOccurrences.length > chosen.length && !confirmDuplicates) {
    const duplicateRows = selectedOccurrences.filter((entry, index) => selectedOccurrences.findIndex(item => String(item.comp.id) === String(entry.comp.id)) !== index).map(entry => `<div class="duplicate-choice"><div><strong>${prodEsc(entry.comp.name)}</strong><span>${prodEsc(entry.key.split("/").slice(0, -1).map(id => prodComp(id)?.name).filter(Boolean).join(" / "))}</span></div><span class="status-chip warn">按 ID 去重</span></div>`).join("");
    openModal(`<div class="modal-head"><div><h2>共享引用将合并收集</h2><p>相同合成从多个层级选中，本次只生成一份独立收集包。</p></div><button class="icon-btn" data-close>×</button></div><div class="modal-body"><div class="duplicate-options">${duplicateRows}</div><div class="drawer-footer"><button class="ghost-btn" data-close>返回调整</button><button class="primary-btn" data-prod-confirm-duplicates>按合成 ID 去重并继续</button></div></div>`);
    document.querySelectorAll("[data-close]").forEach(button => button.addEventListener("click", closeModal));
    document.querySelector("[data-prod-confirm-duplicates]")?.addEventListener("click", () => { closeModal(); prodCollectAep(true); });
    return;
  }
  const output = String(document.querySelector("#aepOutputPath")?.value || prodAepOutput).trim(); if (!output) return prodToast("请选择输出目录", "收集结果会写入新的输出文件夹。", "error");
  const ids = [...new Set(chosen.map(c => Number(c.id)))];
  const collectionRules = Object.fromEntries(chosen.map(c => [c.id, { image: c.collectImage !== false, file: c.collectFile !== false }]));
  const previewTimes = Object.fromEntries(chosen.map(c => [c.id, Number(c.previewTime || 0)]));
  const button = document.querySelector("#collectButton"); if (button) { button.disabled = false; button.dataset.action = "stop-collect"; button.textContent = "停止收集"; }
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
    prodToast(missing ? "收集完成，发现依赖缺失" : "AEP 收集完成", `${result.length} 个收集包已进入配对预检`, missing ? "normal" : "success");
  } catch (error) { if (error.code === "ABORT_ERR") prodToast("收集已停止", "已生成文件保留在输出目录。", "normal"); else prodToast("AEP 收集失败", error.message, "error"); }
  finally { prodCollectionAbort = null; if (button) { button.disabled = false; button.dataset.action = "collect"; button.textContent = "收集所选合成并进入配对"; } }
}

function prodOpenRename() {
  pairs.forEach(prodRefreshPairState);
  const selected = pairs.filter(p => p.selected && p.state === "ready");
  openModal(`<div class="modal-head"><div><h2>规范命名与目标目录</h2><p>${prodEsc(prodProject)} · 确认后通过 Eagle Plugin API 正式入库</p></div><button class="icon-btn" data-close>×</button></div><div class="modal-body"><div class="form-grid"><div class="form-group"><label>PNG 命名模板</label><input class="input" data-prod-template="preview" value="{项目}_{包装类型}_{包装名称}_{版本}.png"></div><div class="form-group"><label>ZIP 命名模板</label><input class="input" data-prod-template="source" value="{项目}_{包装名称}_{版本}.zip"></div></div><p>可用字段：{项目}、{包装类型}、{包装名称}、{版本}。检查通过后会进行正式目录重名校验。</p><div class="rename-output-list">${selected.map(p => `<div class="rename-output-row"><strong>${prodEsc(p.name)} · ${prodEsc(p.type)} · ${prodEsc(p.version)}</strong><small>${prodEsc(p.previewPath)}<br>${prodEsc(p.sourcePath || "背景仅图片")}</small><div class="rename-output-grid"><label>PNG 名称<input class="input" data-prod-name="preview" data-id="${prodEsc(p.id)}" value="${prodEsc(`${prodProject}_${p.type}_${p.name}_${p.version}.png`)}"></label><label>ZIP 名称<input class="input" data-prod-name="source" data-id="${prodEsc(p.id)}" value="${prodEsc(`${prodProject}_${p.name}_${p.version}.zip`)}" ${p.sourcePath ? "" : "disabled"}></label></div></div>`).join("")}</div><div class="drawer-footer"><button class="ghost-btn" data-close>返回配对</button><button class="primary-btn" data-prod-confirm-import ${selected.length ? "" : "disabled"}>确认命名并写入 Eagle</button></div></div>`);
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

async function prodRunImport(mode = "prompt") {
  const selected = pairs.filter(p => p.selected); selected.forEach(prodRefreshPairState);
  if (!selected.length || selected.some(p => p.state !== "ready")) return prodToast("还有包装需要处理", "请补全类型、PNG / ZIP 配对并确认依赖风险。", "error");
  if (!prodProject.trim()) return prodToast("项目名称不能为空", "请先填写项目名称。", "error");
  if (prodScanResult?.errors?.length) return prodToast("扫描存在阻止项", prodScanResult.errors[0], "error");
  const names = prodOutputNames;
  pairs.forEach(p => { p._package.previewPath = p.previewPath; p._package.sourcePath = p.sourcePath; p._package.projectName = prodProject; p._package.packageName = p.name; p._package.packageType = p.type; p._package.version = p.version; p._package.aeCompName = p.comp; p._package.selectedForImport = Boolean(p.selected); });
  prodScanResult.projectName = prodProject; const button = document.querySelector("[data-prod-confirm-import]"); if (button) { button.disabled = true; button.textContent = "正在写入…"; }
  try {
    const adapter = prodAdapter();
    const versionPair = selected.find(p => p.basePackageId || workflowDraft?.basePackageId);
    if (versionPair && (pairs.length !== 1 || selected.length !== 1)) throw new Error("发布新版本必须只包含一组 PNG + ZIP 配对。");
    const result = await prodEagle.importFormalBatch(adapter, prodScanResult, { mode, nameOverrides: names, basePackageId: workflowDraft?.basePackageId || "" });
    if (result.state === "duplicate") {
      const matches = result.matches.map(match => `<div class="detail-grid"><div><span>包装 ID</span><strong>${prodEsc(match.packageId || "—")}</strong></div><div><span>已有版本</span><strong>${prodEsc(match.version || "—")}</strong></div><div><span>匹配依据</span><strong>${prodEsc((match.matchedBy || []).join("、") || "稳定身份")}</strong></div></div>`).join("");
      openModal(`<div class="modal-head"><div><h2>发现已有包装</h2><p>确认本次处理方式，插件会按所选策略继续入库。</p></div><button class="icon-btn" data-close>×</button></div><div class="modal-body">${matches}<div class="warning-box">复用保留已有素材；更新替换当前版本素材；新建会生成独立包装记录。</div><div class="drawer-footer"><button class="ghost-btn" data-close>返回检查</button><button class="quiet" data-prod-duplicate="reuse">复用已有包装</button><button class="quiet" data-prod-duplicate="update">更新已有包装</button><button class="primary-btn" data-prod-duplicate="new">新建独立批次</button></div></div>`);
      document.querySelectorAll("[data-close]").forEach(button => button.addEventListener("click", closeModal));
      document.querySelectorAll("[data-prod-duplicate]").forEach(button => button.addEventListener("click", () => { const nextMode = button.dataset.prodDuplicate; closeModal(); prodRunImport(nextMode); }));
      return;
    }
    let archiveError = ""; let archivedBase = null;
    if (versionPair && workflowDraft?.basePackageId) {
      const base = prodManagedRecords.find(item => item.packageId === workflowDraft.basePackageId);
      const completed = [...(result.filed || []), ...(result.reused || [])].find(item => item.basePackageId === workflowDraft.basePackageId || item.packageId === versionPair.packageId);
      if (!base || !completed) archiveError = "新版本已写入，但未找到旧版或新版本记录以完成归档。";
      else try { archivedBase = await prodManagedApi.archiveFormalPackageVersion(adapter, base, completed.packageId); } catch (error) { archiveError = error.message; }
    }
    try { prodIngest.publishIngestEvent(result); } catch (error) { prodToast("入库完成，索引同步待重试", error.message, "normal"); }
    const completed = [...(result.filed || []), ...(result.reused || [])];
    const count = completed.length;
    lastPreviewImport = { kind: workflowDraft?.kind, project: prodProject, filedCount: count, packages: completed.map(item => ({ name: item.packageName, version: item.version, packageId: item.packageId, preview: item.previewName, source: item.sourceName })) };
    closeModal(); prodSetScreen("success");
    document.querySelector("#successTitle").textContent = `入库完成 · ${count} 组包装`;
    document.querySelector("#successSummary").textContent = `项目 ${prodProject} 的包装记录已通过 Eagle API 写入正式目录。`;
    document.querySelector("#successBoundary").textContent = archiveError ? `旧版本归档未完成：${archiveError}` : `Eagle 已写入正式目录。${archivedBase ? "旧版本已归档。" : ""}入库事件已提交给 bot 同步队列。`;
    document.querySelector("#successRecords").innerHTML = completed.map(item => `<div class="success-record"><div><strong>${prodEsc(item.packageName)} · ${prodEsc(item.version)}</strong><code>package_id: ${prodEsc(item.packageId)}<br>PNG: ${prodEsc(item.previewName)}<br>ZIP: ${prodEsc(item.sourceName || "—")}</code></div><span class="status-chip ok">Eagle 正式目录</span></div>`).join(""); document.querySelector("#successRecords").hidden = false;
  } catch (error) { prodToast("入库失败", error.message, "error"); if (button) { button.disabled = false; button.textContent = "确认命名并写入 Eagle"; } }
}

async function prodRefreshManaged() {
  try {
    const result = await prodManagedApi.listFormalPackages(prodAdapter());
    prodSetApiStatus("ready");
    prodManagedRecords = result.packages || [];
    prodManagedCards.splice(0, prodManagedCards.length, ...prodManagedRecords.map((p, index) => ({ id: `${p.packageId}-${index}`, packageId: p.packageId, basePackageId: p.basePackageId, name: p.packageName, project: p.projectName, type: p.packageType, version: p.version, comp: p.aeCompName, preview: p.preview?.name || "", source: p.source?.name || "", previewPath: p.preview?.filePath || p.preview?.filepath || "", sourcePath: p.source?.filePath || p.source?.filepath || "", isCurrent: !/^(已取代|已归档|停用)/u.test(p.meta?.["状态"] || ""), risk: /警告|缺失|风险/u.test(p.meta?.["状态"] || ""), revision: p.meta?.revision_id || "" })));
    prodRenderManageFilters(); prodApplyManageFilters(); renderManage();
    prodToast("素材库已刷新", `${managed.length} 组正式包装`, "success");
  }
  catch (error) { prodSetApiStatus("error"); prodToast("读取素材库失败", error.message, "error"); }
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
}

function prodApplyManageFilters() {
  const query = prodManageSearch;
  const visible = prodManagedCards.filter(item => (!prodManageProjectFilter || item.project === prodManageProjectFilter) && (!prodManageTypeFilter || item.type === prodManageTypeFilter) && (!query || `${item.project} ${item.name} ${item.type} ${item.comp} ${item.version}`.toLocaleLowerCase().includes(query)));
  managed.splice(0, managed.length, ...visible);
  if (!managed.some(item => item.id === managedId)) managedId = managed[0]?.id || "";
  const count = document.querySelector(".manage-toolbar h2 span"); if (count) count.textContent = `${visible.length} 条`;
}

async function prodReplaceManaged(packageId, kind) {
  const record = prodManagedRecords.find(item => item.packageId === packageId); if (!record) return;
  try {
    const paths = await prodSelectPaths(`选择${kind === "preview" ? "PNG 预览图" : "ZIP 源文件"}`, ["openFile"], [{ name: kind === "preview" ? "PNG" : "ZIP", extensions: [kind === "preview" ? "png" : "zip"] }]);
    if (!paths.length) return;
    const accepted = await new Promise(resolve => { openModal(`<div class="modal-head"><div><h2>确认修订已入库素材</h2><p>${prodEsc(record.packageName)} · ${prodEsc(record.packageId)}</p></div><button class="icon-btn" data-close>×</button></div><div class="modal-body"><p>将通过 Eagle API 新增 ${kind === "preview" ? "PNG" : "ZIP"} 并保留旧文件作为历史修订。</p><div class="warning-box">${prodEsc(paths[0])}</div><div class="drawer-footer"><button class="ghost-btn" data-prod-cancel>取消</button><button class="primary-btn" data-prod-accept>确认修订</button></div></div>`); document.querySelector("[data-prod-cancel]").onclick = () => { closeModal(); resolve(false); }; document.querySelector("[data-prod-accept]").onclick = () => { closeModal(); resolve(true); }; });
    if (!accepted) return;
    const result = await prodManagedApi.replaceFormalAsset(prodAdapter(), record, kind, paths[0]);
    try { prodIngest.publishIngestEvent({ batchId: result.batchId, projectName: result.projectName, sourcePath: result.sourcePath, importMode: "update", filed: [result] }); }
    catch (error) { prodToast("修订完成，索引同步待处理", error.message, "normal"); }
    await prodRefreshManaged(); prodToast("素材修订完成", `${record.packageName} · ${kind === "preview" ? "PNG" : "ZIP"}`, "success");
  } catch (error) { prodToast("素材修订失败", error.message, "error"); }
}

function prodOpenRepairChoice(item) {
  openModal(`<div class="modal-head"><div><h2>修复当前版本</h2><p>${prodEsc(item.name)} · 选择需要修复的素材</p></div><button class="icon-btn" data-close>×</button></div><div class="modal-body"><div class="decision-list"><button class="decision-card" data-prod-repair="preview"><i>PNG</i><span><strong>替换 PNG 预览图</strong><small>${prodEsc(item.preview || "当前 PNG")}</small></span><b>→</b></button><button class="decision-card" data-prod-repair="source"><i>ZIP</i><span><strong>替换 ZIP 源文件</strong><small>${prodEsc(item.source || "当前 ZIP")}</small></span><b>→</b></button></div><div class="drawer-footer"><button class="ghost-btn" data-close>取消</button></div></div>`);
  document.querySelectorAll("[data-close]").forEach(button => button.addEventListener("click", closeModal));
  document.querySelectorAll("[data-prod-repair]").forEach(button => button.addEventListener("click", () => { const kind = button.dataset.prodRepair; closeModal(); prodReplaceManaged(item.packageId, kind); }));
}

function prodOpenImage(name, file) {
  openModal(`<div class="modal-head"><div><h2>${prodEsc(name)} · 预览大图</h2><p>${prodEsc(file)}</p></div><button class="icon-btn" data-close>×</button></div><div class="modal-body"><div class="viewer has-actual-preview"><img class="frame-art actual-preview-image" src="${prodImageUrl(file)}" alt="${prodEsc(name)}"></div><div class="viewer-tools"><small>滚轮缩放 · 左键拖拽 · 双击适应/放大</small><div class="tool-group"><button class="tool-btn">−</button><button class="tool-btn">适应</button><button class="tool-btn">＋</button></div></div></div>`); bindClose(); bindPreviewViewer();
}

function prodOpenEmptyImage(name) {
  openModal(`<div class="modal-head"><div><h2>${prodEsc(name)} · 预览大图</h2><p>当前没有可查看的 PNG 预览图</p></div><button class="icon-btn" data-close>×</button></div><div class="modal-body"><div class="viewer is-empty"><span class="preview-empty">暂无预览图</span></div></div>`);
  bindClose();
}

function prodOpenAepPreview(comp) {
  if (comp.prodPreviewPath) { prodOpenImage(comp.name, comp.prodPreviewPath); return; }
  openModal(`<div class="modal-head"><div><h2>${prodEsc(comp.name)} · 预览大图</h2><p>当前合成尚未生成代表帧</p></div><button class="icon-btn" data-close>×</button></div><div class="modal-body"><div class="viewer is-empty"><span class="preview-empty">暂无预览图</span></div><div class="drawer-footer"><button class="primary-btn" type="button" data-prod-render-empty-preview>生成预览</button></div></div>`);
  bindClose();
  document.querySelector("[data-prod-render-empty-preview]")?.addEventListener("click", () => { closeModal(); prodRenderPreview(comp); });
}

async function prodCheckUpdates(force = false) {
  if (prodUpdateState.checking || prodUpdateState.downloading) return prodLatestRelease;
  const cached = prodUpdater.readUpdateCache(window.localStorage, prodManifest.version);
  if (cached) { prodLatestRelease = cached.info; prodUpdateState.checkedAt = cached.checkedAt; }
  if (!force && cached?.fresh) { prodRenderUpdates(); return prodLatestRelease; }
  prodUpdateState.checking = true; prodUpdateState.error = ""; prodRenderUpdates();
  try {
    prodLatestRelease = await prodUpdater.checkForUpdate(prodManifest.version);
    prodUpdateState.checkedAt = Date.now();
    // Storage failures must not turn a successful network check into an error.
    try { localStorage.setItem("xbot.pluginUpdate.cache.v1", JSON.stringify({ checkedAt: prodUpdateState.checkedAt, info: prodLatestRelease })); } catch (_) {}
    return prodLatestRelease;
  } catch (error) {
    prodUpdateState.error = error.message;
    if (force) prodToast("检查更新失败", error.message, "error");
    return null;
  } finally { prodUpdateState.checking = false; prodRenderUpdates(); }
}

function prodAddTypeFromMenu(menu, input) {
  const picker = menu._xbotPicker || menu.closest(".package-type-picker");
  const trigger = picker?.querySelector("[data-package-type-trigger]");
  const scope = trigger?.dataset.packageTypeScope || "card";
  try {
    const name = prodTypes.registerPackageType(input.value.trim());
    prodRefreshTypes();
    closePackageTypePickers();
    if (scope === "managed" || scope === "migration") {
      const item = trigger?._managedPackage || trigger?._migrationPackage;
      if (item) { prodChangeManagedType(item.id, name); return; }
    }
    const pair = prodPair(trigger?.dataset.packageTypeTrigger);
    if (pair) { pair.type = name; delete prodOutputNames[pair.id]; }
    prodRenderPairs();
    prodToast("包装类型已创建", name + " · 已保存共享配置", "success");
  } catch (error) { prodToast("无法创建包装类型", error.message, "error"); }
}

function prodOpenTypeManager() {
  prodRefreshTypes();
  const types = prodTypes.listPackageTypes();
  openModal('<div class="modal-head"><div><h2>管理包装类型</h2><p>改名纠正错误，停用不再使用的类型。</p></div><button class="icon-btn" data-close aria-label="关闭类型管理">×</button></div><div class="modal-body"><p class="form-help">自定义类型可改名；旧名称保留为别名。停用后不可新入库，已有素材仍可检索。内置类型名称固定。</p><div class="type-management-list">' + types.map(type => '<section class="type-management-row" data-type-record="' + prodEsc(type.name) + '"><div class="type-management-heading"><strong>' + prodEsc(type.name) + '</strong><span class="status-chip ' + (type.enabled ? 'ok' : 'warn') + '">' + (type.enabled ? '使用中' : '已停用') + '</span></div><div class="form-grid"><label>类型名称<input class="input" data-type-name value="' + prodEsc(type.name) + '" ' + (type.builtin ? 'readonly aria-readonly="true"' : '') + ' aria-label="' + prodEsc(type.name) + ' 类型名称"></label><label>别名（逗号分隔）<input class="input" data-type-aliases value="' + prodEsc(type.aliases.filter(alias => alias !== type.name).join('，')) + '" aria-label="' + prodEsc(type.name) + ' 别名"></label></div><div class="type-management-actions"><button class="ghost-btn" data-type-save>保存修改</button><button class="quiet" data-type-enabled="' + String(!type.enabled) + '">' + (type.enabled ? '停用类型' : '恢复使用') + '</button></div></section>').join('') + '</div><p class="form-help">配置管理不会批量重命名或移动 Eagle 中的素材；已有包装可在素材库单独更改类型。</p><p data-type-manager-error role="alert"></p><div class="drawer-footer"><button class="ghost-btn" data-close aria-label="关闭类型管理">关闭</button><button class="primary-btn" data-type-add>新增包装类型</button></div></div>');
  document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', closeModal));
  document.querySelector('[data-type-add]')?.addEventListener('click', () => { closeModal(); prodOpenAddType(); });
  document.querySelectorAll('[data-type-record]').forEach(row => {
    const apply = changes => {
      try {
        prodTypes.updatePackageType(row.dataset.typeRecord, changes);
        prodRefreshTypes(); pairs.forEach(pair => { pair.type = prodTypes.normalizePackageType(pair.type) || pair.type; delete prodOutputNames[pair.id]; });
        if (screen === 'pair') prodRenderPairs();
        if (screen === 'manage') renderManage();
        prodOpenTypeManager(); prodToast('包装类型已更新', '已保存共享配置', 'success');
      } catch (error) { document.querySelector('[data-type-manager-error]').textContent = error.message; }
    };
    row.querySelector('[data-type-save]').addEventListener('click', () => apply({ name: row.querySelector('[data-type-name]').value, aliases: row.querySelector('[data-type-aliases]').value.split(/[,，、]/).map(value => value.trim()).filter(Boolean) }));
    row.querySelector('[data-type-enabled]').addEventListener('click', event => apply({ enabled: event.currentTarget.dataset.typeEnabled === 'true' }));
  });
}

function prodOpenAddType() {
  const pendingManagedId = prodPendingManagedTypeId, pendingPairId = prodPendingPairTypeId; prodPendingManagedTypeId = ""; prodPendingPairTypeId = "";
  openModal(`<div class="modal-head"><div><h2>新增包装类型</h2><p>保存后会同步到插件、扫描和 X.bot 类型配置。</p></div><button class="icon-btn" data-close>×</button></div><div class="modal-body"><div class="form-grid"><div class="form-group"><label for="newTypeName">类型名称</label><input class="input" id="newTypeName" autocomplete="off" placeholder="例如：章节标题"></div><div class="form-group"><label for="newTypeAliases">常用别名</label><input class="input" id="newTypeAliases" autocomplete="off" placeholder="用逗号分隔，可留空"></div></div><div class="drawer-footer"><button class="ghost-btn" data-close>取消</button><button class="primary-btn" data-prod-save-type>创建并同步</button></div></div>`);
  document.querySelectorAll("[data-close]").forEach(button => button.addEventListener("click", closeModal));
  document.querySelector("[data-prod-save-type]")?.addEventListener("click", () => {
    const name = document.querySelector("#newTypeName").value.trim(), aliases = document.querySelector("#newTypeAliases").value.split(/[,，、]/).map(value => value.trim()).filter(Boolean);
    try {
      const created = prodTypes.registerPackageType(name, aliases); prodRefreshTypes(); closeModal();
      const pendingPair = prodPair(pendingPairId); if (pendingPair) { pendingPair.type = created; delete prodOutputNames[pendingPair.id]; }
      if (pendingManagedId) prodChangeManagedType(pendingManagedId, name);
      else { if (screen === "pair") prodRenderPairs(); if (screen === "manage") renderManage(); prodToast("包装类型已创建", `${name} · 已写入共享类型配置`, "success"); }
    }
    catch (error) { prodToast("无法创建包装类型", error.message, "error"); }
  });
}

async function prodChangeManagedType(managedIdValue, value) {
  const card = managed.find(item => item.id === managedIdValue);
  const record = prodManagedRecords.find(item => item.packageId === card?.packageId);
  if (!record) return prodToast("无法修改包装类型", "找不到素材库中的包装记录，请刷新后重试。", "error");
  try {
    const result = await prodManagedApi.changeFormalPackageType(prodAdapter(), record, value);
    try { prodIngest.publishIngestEvent({ batchId: result.batchId, projectName: result.projectName, sourcePath: result.sourcePath, importMode: "update", filed: [result] }); }
    catch (error) { prodToast("类型已更新，索引同步待处理", error.message, "normal"); }
    await prodRefreshManaged(); prodToast("包装类型已更新", `${record.packageName} → ${value}`, "success");
  }
  catch (error) { prodToast("包装类型更新失败", error.message, "error"); }
}
function prodRenderUpdates() {
  const update = prodLatestRelease || {};
  const state = prodUpdateState, busy = state.checking || state.downloading;
  const title = state.checking ? "正在查询版本" : state.downloading ? "正在下载更新"
    : state.error ? "更新操作失败" : !prodLatestRelease ? "等待检查"
    : !update.releaseFound ? "暂无稳定版发布"
    : update.updateAvailable ? "发现可用更新"
    : prodUpdater.compareVersions(prodManifest.version, update.version) > 0 ? "本地版本领先于发布版" : "已是最新版本";
  const setText = (selector, value) => { const element = document.querySelector(selector); if (element) element.textContent = value; };
  const versions = [...document.querySelectorAll(".update-version-row strong")];
  if (versions[0]) versions[0].textContent = `v${prodManifest.version}`;
  if (versions[1]) versions[1].textContent = update.version ? `v${update.version}` : "暂无";
  setText("#updateStatusTitle", title);
  setText("#previewUpdateStatus", state.checking ? "正在查询 GitHub Releases…"
    : state.downloading ? state.progress || "正在连接下载服务…"
    : state.error ? `${state.error}${prodLatestRelease ? " · 保留上次查询结果，可重试。" : " · 请重试。"}`
    : update.releaseFound ? `${update.title} · ${title}` : prodLatestRelease ? "GitHub 尚未发布可用的稳定版插件。" : "检查后显示发布信息。");
  const check = document.querySelector('[data-action="check-plugin-updates"]');
  if (check) { check.disabled = busy; check.textContent = state.checking ? "正在检查…" : "检查更新"; }
  const download = document.querySelector('[data-action="download-plugin-update"]');
  const hasDigest = /^[a-f\d]{64}$/i.test(update.asset?.digest || "");
  if (download) {
    download.disabled = busy || !update.updateAvailable || !hasDigest;
    download.textContent = state.downloading ? "正在下载并校验…" : "下载并打开安装包";
  }
  const lastCheck = state.checkedAt ? `上次成功检查：${new Date(state.checkedAt).toLocaleString()}` : "尚未完成检查";
  setText(".update-channel", `发布渠道 · GitHub Releases · ${lastCheck}`);
  const published = update.publishedAt && Number.isFinite(Date.parse(update.publishedAt))
    ? new Date(update.publishedAt).toLocaleString() : "未提供日期";
  setText(".update-card:nth-of-type(2) .update-card-head p", update.releaseFound ? `v${update.version} · 发布于 ${published}` : "GitHub Release");
  document.querySelectorAll(".update-demo-tag").forEach(tag => { tag.textContent = title; });
  setText(".update-notes", update.releaseFound ? update.notes || "该 Release 未附版本说明。" : "GitHub 尚未发布可用的稳定版插件。");
  setText(".update-install-hint", state.file ? `安装包已保存：${state.file.path}。请在 Eagle 确认安装，然后重新打开插件。`
    : update.updateAvailable && !hasDigest ? "安装包缺少 SHA-256 摘要，等待发布者补齐后才能下载。"
    : "大小与 SHA-256 校验通过后交给 Eagle 安装；安装完成后请重新打开插件。");
  const settingsCopy = document.querySelector(".settings-update-copy small");
  if (settingsCopy) settingsCopy.textContent = update.updateAvailable ? `v${update.version} 可用 · 查看版本说明` : `当前版本 v${prodManifest.version} · 查看更新状态`;
  const settingsBadge = document.querySelector(".settings-update-badge"); if (settingsBadge) { settingsBadge.textContent = update.updateAvailable ? "新" : ""; settingsBadge.hidden = !update.updateAvailable; }
  const settingsTrigger = document.querySelector("#tweakBtn"); if (settingsTrigger) { settingsTrigger.dataset.updateAvailable = String(Boolean(update.updateAvailable)); settingsTrigger.setAttribute("aria-label", update.updateAvailable ? "设置，有新版本" : "设置"); }
}
async function prodDownloadUpdate() {
  if (prodUpdateState.checking || prodUpdateState.downloading) return;
  if (!prodLatestRelease) return;
  prodUpdateState.downloading = true; prodUpdateState.error = ""; prodUpdateState.progress = "";
  prodUpdateState.file = null; prodRenderUpdates();
  try {
    const update = prodLatestRelease;
    if (!update?.updateAvailable || !update.asset) throw new Error("当前没有可下载的稳定版 Release 安装包。");
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
    prodToast("安装包已校验", "请在 Eagle 确认安装，然后重新打开插件。", "success");
  } catch (error) {
    prodUpdateState.error = error.message;
    prodToast(prodUpdateState.file ? "安装包打开失败" : "下载更新失败", error.message, "error");
  } finally { prodUpdateState.downloading = false; prodRenderUpdates(); }
}

async function prodAction(event) {
  const action = event.target.closest("[data-action]"); if (!action) return;
  const key = action.dataset.action;
  const handled = new Set(["open-manage", "refresh", "choose-aep", "start-from-aep", "open-folder", "replace-folder", "choose-output-path", "collect", "stop-collect", "open-rename", "import", "go-home", "new-version", "new-package", "repair-current", "managed-preview", "change-managed-type", "check-plugin-updates", "download-plugin-update", "resume", "clear-selection", "select-visible", "expand", "open-updates", "manage-types", "add-type"]);
  if (!handled.has(key)) return;
  event.preventDefault(); event.stopImmediatePropagation();
  try {
    if (key === "open-manage") { prodSetScreen("manage"); await prodRefreshManaged(); }
    else if (key === "refresh") await prodRefreshManaged();
    else if (["choose-aep", "start-from-aep"].includes(key)) { const paths = await prodSelectPaths("选择 After Effects 工程", ["openFile"], [{ name: "After Effects", extensions: ["aep"] }]); if (paths.length) await prodRouteSelection(paths); }
    else if (["open-folder", "replace-folder"].includes(key)) { const paths = await prodSelectPaths("选择包装交付文件夹", ["openDirectory"]); if (paths.length) await prodRouteSelection(paths); }
    else if (key === "choose-output-path") { const paths = await prodSelectPaths("选择 AEP 收集输出目录", ["openDirectory"]); if (paths.length) { prodAepOutput = paths[0]; document.querySelector("#aepOutputPath").value = paths[0]; } }
    else if (key === "collect") await prodCollectAep();
    else if (key === "stop-collect") prodCollectionAbort?.abort();
    else if (key === "open-rename") prodOpenRename();
    else if (key === "import") prodOpenRename();
    else if (key === "go-home") prodSetScreen("home");
    else if (key === "new-version" || key === "new-package") { const item = managed.find(p => p.id === managedId); if (!item) return; const base = key === "new-version" ? prodManagedRecords.find(p => p.packageId === item.packageId) : null; prodSetWorkflow(key === "new-version" ? "new-version" : "managed-add", base, item.project); const paths = await prodSelectPaths(key === "new-version" ? "选择新版本交付文件夹" : `项目新增包装 · ${item.project}`, ["openFile", "openDirectory", "multiSelections"], [{ name: "包装文件", extensions: ["aep", "png", "zip", "json"] }]); if (paths.length) await prodRouteSelection(paths, { kind: key === "new-version" ? "new-version" : "managed-add", base, projectName: item.project }); }
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
  if (zip) { event.preventDefault(); event.stopImmediatePropagation(); const pair = prodPair(zip.dataset.zipPair); if (pair?.sourcePath) prodToast("ZIP 源文件", pair.sourcePath); return; }
}

function prodOpenManagedTypeModal(item) {
  const options = prodTypes.PACKAGE_TYPES.map(type => `<option value="${prodEsc(type)}" ${type === item.type ? "selected" : ""}>${prodEsc(type)}</option>`).join("");
  openModal(`<div class="modal-head"><div><h2>修改包装类型</h2><p>${prodEsc(item.name)} · ${prodEsc(item.packageId)}</p></div><button class="icon-btn" data-close>×</button></div><div class="modal-body"><div class="form-group"><label for="managedTypeSelect">包装类型</label><select class="select" id="managedTypeSelect">${options}<option value="__add_type__">＋ 新增包装类型</option></select></div><div class="warning-box">更改后会通过 Eagle API 调整 PNG / ZIP 的正式目录、名称和类型标签。</div><div class="drawer-footer"><button class="ghost-btn" data-close>取消</button><button class="primary-btn" data-prod-save-managed-type>应用类型</button></div></div>`);
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
    if (!managed.length) { document.querySelector("#manageGrid").innerHTML = '<div class="bottom-sheet-empty">素材库中没有符合筛选条件的包装。</div>'; document.querySelector("#manageInspector").innerHTML = '<div class="bottom-sheet-empty">选择包装后查看版本、素材和操作。</div>'; return; }
    document.querySelectorAll("#manageGrid .manage-card").forEach(card => {
      const id = card.dataset.managedCard, item = managed.find(value => value.id === id); if (!item) return;
      const image = card.querySelector(".manage-thumb"); if (image && item.previewPath) { image.classList.add("has-actual-preview"); image.innerHTML = `<img class="frame-art actual-preview-image" src="${prodImageUrl(item.previewPath)}" alt="${prodEsc(item.name)}">`; }
      const pills = card.querySelector(".pill-row"); if (pills) pills.innerHTML = `<button type="button" class="tiny-pill asset-chip-button" data-managed-asset="preview" data-managed="${prodEsc(id)}" ${item.isCurrent ? "" : "disabled"}>PNG ✓</button><button type="button" class="tiny-pill asset-chip-button" data-managed-asset="source" data-managed="${prodEsc(id)}" ${item.isCurrent ? "" : "disabled"}>ZIP ✓</button>`;
    });
  };
  managedArt = item => item?.previewPath ? `<img class="frame-art actual-preview-image" src="${prodImageUrl(item.previewPath)}" alt="${prodEsc(item.name)} 的 PNG 预览">` : '<span class="preview-empty">暂无预览图</span>';
  document.addEventListener("click", prodInteraction, true);
  document.addEventListener("change", prodInteraction, true);
  document.addEventListener("click", prodAction, true);
  document.querySelector("#pairProjectName")?.addEventListener("change", event => { const value = event.target.value.trim(); if (value) { prodProject = value; if (workflowDraft) workflowDraft.project = value; prodSetPairSource(prodPath.basename(prodSourceDir || "交付文件夹")); } else event.target.value = prodProject; });
  document.querySelector("#themeBtn")?.addEventListener("click", () => { localStorage.setItem("xbot.theme", document.body.dataset.theme); });
  const manageCardSizeInput = document.querySelector("#manageCardSize");
  let savedManageCardSize = "medium";
  try { savedManageCardSize = localStorage.getItem("xbot.manage-card-size.v1") || "medium"; } catch {}
  prodSetManageCardSize(savedManageCardSize);
  manageCardSizeInput?.addEventListener("input", () => prodSetManageCardSize(prodManageCardSizeOptions[Number(manageCardSizeInput.value)] || "medium", true));
  document.querySelector("#homeDropZone")?.addEventListener("click", async event => { if (event.target.closest("button")) return; try { const paths = await prodSelectPaths("选择 AEP 工程或包装文件夹", ["openFile", "openDirectory", "multiSelections"], [{ name: "包装文件", extensions: ["aep", "png", "zip", "json"] }]); if (paths.length) await prodRouteSelection(paths); } catch (error) { prodToast("无法读取所选文件", error.message, "error"); } });
  document.querySelectorAll("[data-home-pick]").forEach(button => button.addEventListener("click", async event => { event.preventDefault(); event.stopImmediatePropagation(); try { const isAep = button.dataset.homePick === "aep"; const paths = await prodSelectPaths(isAep ? "选择 After Effects 工程" : "选择包装交付文件夹", isAep ? ["openFile"] : ["openDirectory"], isAep ? [{ name: "After Effects", extensions: ["aep"] }] : []); if (paths.length) await prodRouteSelection(paths); } catch (error) { prodToast("选择来源失败", error.message, "error"); } }));
  document.querySelector("#pairTabs")?.addEventListener("click", event => { const tab = event.target.closest("[data-pair-filter]"); if (!tab) return; pairFilter = tab.dataset.pairFilter; document.querySelectorAll("#pairTabs [data-pair-filter]").forEach(item => item.classList.toggle("active", item === tab)); prodRenderPairs(); }, true);
  document.querySelector("#aepOutputPath")?.addEventListener("change", event => { prodAepOutput = event.target.value.trim(); });
  document.body.dataset.theme = localStorage.getItem("xbot.theme") || "light";
  prodSetApiStatus(window.eagle?.item && window.eagle?.folder ? "ready" : "unavailable");
  document.querySelector("#pairProjectName").value = "";
  document.querySelector("#aepOutputPath").value = "";
  document.querySelector("#pairSourceName").textContent = "尚未选择包装来源";
  document.querySelector("#pairSourceMeta").textContent = "选择文件夹扫描配对，或从 AEP 收集合成";
  document.querySelector("#aepSourceName").textContent = "尚未选择 AEP 工程";
  document.querySelector("#aepSourceMeta").textContent = "选择后自动读取合成结构";
  document.querySelector("#treeList").innerHTML = '<div class="bottom-sheet-empty">从首页选择 AEP 工程后，这里会显示真实合成结构。</div>';
  document.querySelector("#aepInspector").innerHTML = '<div class="bottom-sheet-empty">尚未加载 AEP 工程。</div>';
  document.querySelector("#pairList").innerHTML = '<div class="bottom-sheet-empty">从首页选择文件夹后，这里会显示真实扫描结果。</div>';
  document.querySelector("#manageGrid").innerHTML = '<div class="bottom-sheet-empty">打开素材库以读取当前 Eagle Library。</div>';
  prodRenderManageFilters(); prodApplyManageFilters();
  setScreen("home", { remember: false });
  const localVersion = document.querySelector(".update-version-row strong"); if (localVersion) localVersion.textContent = `v${prodManifest.version}`;
  const updateBadges = document.querySelectorAll(".update-demo-tag"); updateBadges.forEach((badge, index) => { badge.textContent = index ? "等待检查" : "检查中"; });
  document.querySelector("#updateStatusTitle").textContent = "正在查询版本";
  document.querySelector("#previewUpdateStatus").textContent = "正在读取 GitHub Releases…";
  document.querySelector("#updatesTitle")?.parentElement?.querySelector("p")?.replaceChildren(document.createTextNode("查看插件版本和 Release 说明，下载后由 Eagle 接管安装。"));
  document.querySelector(".update-notes").style.whiteSpace = "pre-wrap";
  document.querySelector(".update-notes").style.overflowWrap = "anywhere";
  document.querySelector(".update-install-hint").style.overflowWrap = "anywhere";
  document.querySelector(".update-notes").textContent = "版本更新信息会在检查 GitHub Releases 后显示。";
  // Each plugin window queries once on initialization; the update page only renders this result.
  prodCheckUpdates(true);
}
