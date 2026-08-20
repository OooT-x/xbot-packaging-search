const path = require("path");

const INGEST_ROOT_NAME = "00_待入库";
const BATCH_SUFFIX = "包装";

function folderId(folder) {
  if (!folder) return null;
  if (typeof folder === "string") return folder;
  return folder.id || folder.folderId || null;
}

function buildAnnotation(pkg, pair) {
  const lines = [
    `项目：${pkg.projectName}`,
    `原 AE 项目：${pkg.sourceProjectName || pkg.projectName}`,
    `package_id：${pkg.packageId}`,
    `包装名称：${pkg.packageName || ""}`,
    `包装类型：${pkg.packageType || ""}`,
    `版本：${pkg.version || "v01"}`,
    `AE 合成：${pkg.aeCompName || ""}`,
    `batch_id：${pkg.batchId}`,
  ];
  if (pair && pair.previewItemId && pair.sourceItemId) {
    lines.push(
      `配对 PNG：${pair.previewItemId}`,
      `配对 ZIP：${pair.sourceItemId}`
    );
  }
  lines.push(`状态：${pkg.dependencyStatus === "warning" ? "启用（依赖警告）" : "启用"}`);
  if (Array.isArray(pkg.fonts) && pkg.fonts.length > 0) {
    lines.push(`字体：${pkg.fonts.join("、")}`);
  }
  if (Array.isArray(pkg.effects) && pkg.effects.length > 0) {
    lines.push(`效果：${pkg.effects.join("、")}`);
  }
  return lines.join("\n");
}

function buildTags(pkg) {
  const tags = [pkg.projectName, pkg.packageType, pkg.version, INGEST_ROOT_NAME].filter(Boolean);
  if (pkg.dependencyStatus === "warning") tags.push("依赖警告");
  return [...new Set(tags)];
}

function itemName(filePath, kind) {
  const base = path.basename(filePath);
  return path.extname(base) ? base : `${base}.${kind}`;
}

async function ensureFolder(adapter, name, parentId) {
  const folders = await adapter.getFolders();
  const match = folders.find(
    (folder) => folder.name === name && folderId(folder.parent) === parentId
  );
  if (match) return match;
  return adapter.createFolder({
    name,
    description: "",
    parent: parentId || null,
  });
}

async function importBatch(adapter, scanResult, options = {}) {
  const ready = scanResult.packages.filter((pkg) => pkg.state === "ready");
  if (ready.length === 0) {
    throw new Error("没有可导入的包装记录，请先处理冲突或补全 manifest");
  }

  const rootFolder = await ensureFolder(adapter, INGEST_ROOT_NAME, null);
  const batchFolder = await ensureFolder(
    adapter,
    `${scanResult.projectName}${BATCH_SUFFIX}`,
    folderId(rootFolder)
  );

  const results = [];
  for (const pkg of ready) {
    const pair = {
      packageId: pkg.packageId,
      batchId: scanResult.batchId,
      projectName: scanResult.projectName,
      sourceProjectName: pkg.sourceProjectName || null,
      packageName: pkg.packageName,
      packageType: pkg.packageType,
      version: pkg.version || "v01",
      aeCompName: pkg.aeCompName,
      dependencyStatus: pkg.dependencyStatus || "complete",
      fonts: pkg.fonts || [],
      effects: pkg.effects || [],
    };
    const tags = buildTags(pair);
    const previewItemId = await adapter.addFromPath(pkg.preview.path, {
      name: itemName(pkg.preview.path, "png"),
      tags,
      folders: [folderId(batchFolder)],
      annotation: buildAnnotation(pair, null),
    });
    const sourceItemId = await adapter.addFromPath(pkg.source.path, {
      name: itemName(pkg.source.path, "zip"),
      tags,
      folders: [folderId(batchFolder)],
      annotation: buildAnnotation(pair, { previewItemId, sourceItemId: null }),
    });
    const annotation = buildAnnotation(pair, { previewItemId, sourceItemId });
    for (const itemId of [previewItemId, sourceItemId]) {
      const item = await adapter.getItem(itemId);
      if (!item) continue;
      item.annotation = annotation;
      await adapter.saveItem(item);
    }
    results.push({
      packageId: pkg.packageId,
      previewItemId,
      sourceItemId,
      previewPath: pkg.preview.path,
      sourcePath: pkg.source.path,
    });
  }

  const batchFolderInstance = await adapter.getFolder(folderId(batchFolder));
  if (batchFolderInstance) {
    batchFolderInstance.description = [
      batchFolderInstance.description || "",
      `batch_id：${scanResult.batchId}`,
      `来源：${scanResult.sourceDir}`,
      `记录：${ready.length} 条`,
    ]
      .filter(Boolean)
      .join("\n");
    await adapter.saveFolder(batchFolderInstance);
  }

  return {
    batchId: scanResult.batchId,
    batchFolderId: folderId(batchFolder),
    rootFolderId: folderId(rootFolder),
    imported: results,
  };
}

class EaglePluginAdapter {
  constructor(eagleGlobal) {
    this.eagle = eagleGlobal;
    if (!eagleGlobal) throw new Error("Eagle Plugin API 不可用");
  }

  async getFolders() {
    const folders = await this.eagle.folder.getAll();
    return Array.isArray(folders) ? folders : [];
  }

  async getFolder(id) {
    return this.eagle.folder.getById(id);
  }

  async createFolder(options) {
    return this.eagle.folder.create(options);
  }

  async saveFolder(folder) {
    return folder.save();
  }

  async addFromPath(filePath, options) {
    return this.eagle.item.addFromPath(filePath, options);
  }

  async getItem(id) {
    return this.eagle.item.getById(id);
  }

  async saveItem(item) {
    return item.save();
  }
}

module.exports = {
  BATCH_SUFFIX,
  INGEST_ROOT_NAME,
  EaglePluginAdapter,
  buildAnnotation,
  buildTags,
  ensureFolder,
  folderId,
  importBatch,
  itemName,
};
