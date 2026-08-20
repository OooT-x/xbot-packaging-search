/* global eagle */
const path = require("path");
const { scanDirectory } = require("../lib/scan.js");
const {
  EaglePluginAdapter,
  fileBatch,
  folderId,
  importBatch,
  planFormalFile,
  INGEST_ROOT_NAME,
  FORMAL_PREVIEW_ROOT_NAME,
  FORMAL_SOURCE_ROOT_NAME,
} = require("../lib/eagle-api.js");

const state = {
  sourceDir: null,
  scan: null,
  batchFolders: [],
  filePlan: null,
};

const elements = {
  apiState: document.getElementById("apiState"),
  folderPicker: document.getElementById("folderPicker"),
  projectName: document.getElementById("projectName"),
  scanBtn: document.getElementById("scanBtn"),
  importBtn: document.getElementById("importBtn"),
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
  fileInfo: document.getElementById("fileInfo"),
  statFileReady: document.getElementById("statFileReady"),
  statFileBlocked: document.getElementById("statFileBlocked"),
  statFileAlready: document.getElementById("statFileAlready"),
  statFileRemaining: document.getElementById("statFileRemaining"),
  filePlanRows: document.getElementById("filePlanRows"),
  log: document.getElementById("log"),
};

function log(message) {
  const time = new Date().toLocaleTimeString();
  elements.log.textContent = `${elements.log.textContent}\n[${time}] ${message}`.trim();
}

function clearLog() {
  elements.log.textContent = "";
}

function badge(status) {
  const labels = {
    "to-import": "将导入",
    "validate-only": "仅校验",
    ignore: "忽略",
    conflict: "冲突",
    ready: "可导入",
    blocked: "阻止",
  };
  return `<span class="badge ${status}">${labels[status] || status}</span>`;
}

function render(scan) {
  state.scan = scan;
  elements.statToImport.textContent = scan.stats.toImport;
  elements.statValidate.textContent = scan.stats.validateOnly;
  elements.statIgnore.textContent = scan.stats.ignore;
  elements.statConflict.textContent = scan.stats.conflict;
  elements.batchInfo.textContent = `batch_id：${scan.batchId}`;

  elements.packageRows.innerHTML = scan.packages
    .map(
      (pkg) => `
        <tr>
          <td>${escapeHtml(pkg.packageName || "—")}</td>
          <td>${escapeHtml(pkg.packageType || "—")}</td>
          <td>${escapeHtml(pkg.version || "—")}</td>
          <td>${escapeHtml(pkg.aeCompName || "—")}</td>
          <td>${pkg.preview ? escapeHtml(path.basename(pkg.preview.path)) : "—"}</td>
          <td>${pkg.source ? escapeHtml(path.basename(pkg.source.path)) : "—"}</td>
          <td>${badge(pkg.state)}</td>
          <td>${escapeHtml([...(pkg.warnings || []), ...(pkg.errors || [])].join("；"))}</td>
        </tr>
      `
    )
    .join("");

  elements.fileRows.innerHTML = scan.files
    .map(
      (file) => `
        <tr>
          <td>${escapeHtml(file.relative)}</td>
          <td>${escapeHtml(file.kind)}</td>
          <td>${badge(file.status)}</td>
          <td>${escapeHtml(file.note || "")}</td>
        </tr>
      `
    )
    .join("");

  const readyCount = scan.packages.filter((pkg) => pkg.state === "ready").length;
  const blockedCount = scan.packages.filter((pkg) => pkg.state === "blocked").length;
  elements.importBtn.disabled = readyCount === 0 || blockedCount > 0;
  log(`扫描完成：${scan.stats.toImport} 个文件将导入，${blockedCount} 条记录被阻止`);
}

function createAdapter() {
  if (!window.eagle || !window.eagle.item || !window.eagle.folder) {
    throw new Error("Eagle 插件 API 不可用，请在 Eagle 内运行");
  }
  return new EaglePluginAdapter(window.eagle);
}

function formalFolderId(folders, name) {
  const match = folders.find((folder) => folder.name === name && !folderId(folder.parent));
  return match ? folderId(match) : null;
}

async function refreshBatches() {
  state.filePlan = null;
  elements.confirmFileBtn.hidden = true;
  elements.fileInfo.textContent = "";
  elements.filePlanRows.innerHTML = "";
  elements.statFileReady.textContent = "0";
  elements.statFileBlocked.textContent = "0";
  elements.statFileAlready.textContent = "0";
  elements.statFileRemaining.textContent = "0";
  elements.batchSelect.innerHTML = "";
  elements.batchSelect.disabled = true;
  elements.fileBtn.disabled = true;

  try {
    const adapter = createAdapter();
    const folders = await adapter.getFolders();
    const root = folders.find((folder) => folder.name === INGEST_ROOT_NAME);
    if (!root) {
      log("Eagle 中还没有 00_待入库 目录");
      return;
    }
    state.batchFolders = folders
      .filter((folder) => folderId(folder.parent) === folderId(root))
      .sort((a, b) => String(a.name).localeCompare(String(b.name), "zh-CN"));
    if (state.batchFolders.length === 0) {
      log("00_待入库 下还没有批次文件夹");
      return;
    }
    for (const folder of state.batchFolders) {
      const option = document.createElement("option");
      option.value = folderId(folder);
      option.textContent = folder.name;
      elements.batchSelect.appendChild(option);
    }
    elements.batchSelect.disabled = false;
    elements.fileBtn.disabled = false;
    log(`已加载 ${state.batchFolders.length} 个待入库批次`);
  } catch (error) {
    log(`加载批次失败：${error.message}`);
  }
}

function renderFilePlan(plan, remainingCount = 0) {
  elements.statFileReady.textContent = String(plan.stats.ready);
  elements.statFileBlocked.textContent = String(plan.stats.blocked);
  elements.statFileAlready.textContent = String(plan.stats.alreadyFiled);
  elements.statFileRemaining.textContent = String(remainingCount);

  const rows = [];
  for (const pair of plan.readyPairs) {
    rows.push(`
      <tr>
        <td>${escapeHtml(pair.preview.name || pair.packageId)}</td>
        <td>${escapeHtml(pair.packageType)}</td>
        <td>${escapeHtml(pair.version || "v01")}</td>
        <td>${escapeHtml(path.basename(pair.preview.name || ""))}</td>
        <td>${escapeHtml(path.basename(pair.source.name || ""))}</td>
        <td><span class="badge ready">可入库</span></td>
        <td></td>
      </tr>
    `);
  }
  for (const entry of plan.blocked) {
    rows.push(`
      <tr>
        <td>${escapeHtml(entry.item.name || entry.item.id)}</td>
        <td>-</td>
        <td>-</td>
        <td>-</td>
        <td>-</td>
        <td><span class="badge blocked">阻止</span></td>
        <td>${escapeHtml(entry.reason)}</td>
      </tr>
    `);
  }
  for (const item of plan.alreadyFiled) {
    rows.push(`
      <tr>
        <td>${escapeHtml(item.name || item.id)}</td>
        <td>-</td>
        <td>-</td>
        <td>-</td>
        <td>-</td>
        <td><span class="badge ignore">已入库</span></td>
        <td>已在正式目录</td>
      </tr>
    `);
  }
  if (rows.length === 0) {
    rows.push('<tr><td colspan="7" class="hint">没有可入库的记录</td></tr>');
  }
  elements.filePlanRows.innerHTML = rows.join("");
}

async function loadFilePlan() {
  const batchId = elements.batchSelect.value;
  if (!batchId) {
    log("请先选择一个待入库批次");
    return;
  }
  try {
    const adapter = createAdapter();
    const [items, folders] = await Promise.all([
      adapter.getItemsByFolder(batchId),
      adapter.getFolders(),
    ]);
    const formalFolderIds = [
      formalFolderId(folders, FORMAL_PREVIEW_ROOT_NAME),
      formalFolderId(folders, FORMAL_SOURCE_ROOT_NAME),
    ].filter(Boolean);
    state.filePlan = planFormalFile(items, { formalFolderIds });
    renderFilePlan(state.filePlan, items.length);
    elements.fileInfo.textContent = `批次共 ${items.length} 个文件`;
    elements.confirmFileBtn.hidden = state.filePlan.readyPairs.length === 0;
    elements.confirmFileBtn.disabled = false;
    log(
      `入库预检：${state.filePlan.readyPairs.length} 对可入库，` +
        `${state.filePlan.blocked.length} 条阻止，${state.filePlan.alreadyFiled.length} 条已入库`
    );
  } catch (error) {
    log(`入库预检失败：${error.message}`);
  }
}

async function confirmFile() {
  const batchId = elements.batchSelect.value;
  if (!batchId || !state.filePlan) return;
  try {
    const adapter = createAdapter();
    elements.confirmFileBtn.disabled = true;
    log("正在把待入库批次移入正式目录…");
    const result = await fileBatch(adapter, batchId);
    const plan = {
      readyPairs: [],
      blocked: result.blocked,
      alreadyFiled: result.alreadyFiled,
      stats: {
        ready: result.filed.length,
        blocked: result.blocked.length,
        alreadyFiled: result.alreadyFiled.length,
        files: result.remaining.length + result.filed.length * 2,
      },
    };
    renderFilePlan(plan, result.remaining.length);
    elements.fileInfo.textContent = result.batchEmpty
      ? "入库完成，批次已清空（可在 Eagle 界面删除空批次文件夹）"
      : `入库完成，批次还剩 ${result.remaining.length} 个文件`;
    elements.confirmFileBtn.hidden = true;
    log(`入库完成：${result.filed.length} 对进入正式目录`);
    for (const item of result.failed) {
      log(`入库失败：${item.pair.packageId} - ${item.reason}`);
    }
    await refreshBatches();
  } catch (error) {
    log(`入库失败：${error.message}`);
    elements.confirmFileBtn.disabled = false;
  }
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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

elements.scanBtn.addEventListener("click", () => {
  const files = elements.folderPicker.files;
  const sourceDir = resolvePickedDirectory(files);
  if (!sourceDir) {
    log("未选择文件夹，或当前环境无法读取文件绝对路径");
    return;
  }
  clearLog();
  state.sourceDir = sourceDir;
  log(`选择目录：${sourceDir}`);
  try {
    const scan = scanDirectory(sourceDir, {
      projectName: elements.projectName.value.trim() || undefined,
    });
    elements.projectName.value = scan.projectName;
    render(scan);
  } catch (error) {
    log(`扫描失败：${error.message}`);
  }
});

elements.importBtn.addEventListener("click", async () => {
  if (!state.scan) return;
  try {
    const adapter = new EaglePluginAdapter(window.eagle);
    elements.importBtn.disabled = true;
    log("正在调用 Eagle API 导入…");
    const result = await importBatch(adapter, state.scan);
    log(
      `导入完成：批次 ${result.batchId}，共 ${result.imported.length} 条记录（${result.imported.length * 2} 个文件）`
    );
    elements.batchInfo.textContent = `batch_id：${result.batchId}（已导入）`;
  } catch (error) {
    log(`导入失败：${error.message}`);
    elements.importBtn.disabled = false;
  }
});

elements.reloadBatchBtn.addEventListener("click", () => {
  refreshBatches();
});

elements.fileBtn.addEventListener("click", () => {
  loadFilePlan();
});

elements.confirmFileBtn.addEventListener("click", () => {
  confirmFile();
});

(function detectEagle() {
  if (window.eagle && window.eagle.item && window.eagle.folder) {
    elements.apiState.textContent = "Eagle 插件 API 已连接";
    elements.apiState.style.color = "#1f9d61";
    refreshBatches();
  } else {
    elements.apiState.textContent = "未检测到 Eagle 插件 API（可在浏览器中预览扫描，导入需在 Eagle 内运行）";
    elements.apiState.style.color = "#b7791f";
  }
})();
