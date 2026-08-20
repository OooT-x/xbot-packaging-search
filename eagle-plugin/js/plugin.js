/* global eagle */
const path = require("path");
const { scanDirectory } = require("../lib/scan.js");
const { EaglePluginAdapter, importBatch } = require("../lib/eagle-api.js");

const state = {
  sourceDir: null,
  scan: null,
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

(function detectEagle() {
  if (window.eagle && window.eagle.item && window.eagle.folder) {
    elements.apiState.textContent = "Eagle 插件 API 已连接";
    elements.apiState.style.color = "#1f9d61";
  } else {
    elements.apiState.textContent = "未检测到 Eagle 插件 API（可在浏览器中预览扫描，导入需在 Eagle 内运行）";
    elements.apiState.style.color = "#b7791f";
  }
})();
