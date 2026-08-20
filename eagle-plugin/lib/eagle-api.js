const path = require("path");

const INGEST_ROOT_NAME = "00_待入库";
const BATCH_SUFFIX = "包装";
const FORMAL_PREVIEW_ROOT_NAME = "01_预览图";
const FORMAL_SOURCE_ROOT_NAME = "02_AE源文件";
const KNOWN_PACKAGE_TYPES = ["信息条", "视频框", "背景", "分镜排版"];

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

function parseAnnotation(annotation) {
  const meta = {};
  for (const line of String(annotation || "").split("\n")) {
    const index = line.indexOf("：");
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    if (key && value) meta[key] = value;
  }
  return meta;
}

function itemKind(item) {
  const ext = String(item.ext || "").toLowerCase();
  const name = String(item.name || "");
  if (ext === "png" || /\.png$/i.test(name)) return "preview";
  if (ext === "zip" || /\.zip$/i.test(name)) return "source";
  return null;
}

function replaceIngestTag(tags, formalRootName) {
  return (tags || []).map((tag) => (tag === INGEST_ROOT_NAME ? formalRootName : tag));
}

function collectBatchItems(items, batchFolderId) {
  const inFolder = items.filter((item) => (item.folders || []).includes(batchFolderId));
  const inFolderIds = new Set(inFolder.map((item) => item.id));
  const batchIds = new Set();
  for (const item of inFolder) {
    const meta = parseAnnotation(item.annotation);
    if (meta["batch_id"]) batchIds.add(meta["batch_id"]);
  }
  const related = items.filter((item) => {
    if ((item.folders || []).some((id) => id)) return false;
    if (inFolderIds.has(item.id)) return false;
    const meta = parseAnnotation(item.annotation);
    return (
      (meta["配对 PNG"] && inFolderIds.has(meta["配对 PNG"])) ||
      (meta["配对 ZIP"] && inFolderIds.has(meta["配对 ZIP"])) ||
      (meta["batch_id"] && batchIds.has(meta["batch_id"]))
    );
  });
  return [...inFolder, ...related];
}

function uniqueItems(items) {
  const byId = new Map();
  for (const item of items || []) {
    if (item && item.id && !byId.has(item.id)) byId.set(item.id, item);
  }
  return [...byId.values()];
}

function planFormalFile(items, options = {}) {
  const formalFolderIds = new Set(options.formalFolderIds || []);
  const blocked = [];
  const alreadyFiled = [];
  const pending = new Map();

  for (const item of items) {
    const kind = itemKind(item);
    if (!kind) {
      blocked.push({ item, reason: "非 PNG/ZIP 素材，不能入库" });
      continue;
    }
    if ((item.folders || []).some((id) => formalFolderIds.has(id))) {
      alreadyFiled.push(item);
      continue;
    }

    const meta = parseAnnotation(item.annotation);
    const packageType = meta["包装类型"];
    if (!packageType) {
      blocked.push({ item, reason: "缺少包装类型，无法确定正式目录" });
      continue;
    }
    if (!KNOWN_PACKAGE_TYPES.includes(packageType)) {
      blocked.push({ item, reason: `未知包装类型：${packageType}` });
      continue;
    }
    const packageId = meta["package_id"];
    if (!packageId) {
      blocked.push({ item, reason: "缺少 package_id，无法配对" });
      continue;
    }

    const batchId = meta["batch_id"] || "";
    const key = JSON.stringify([batchId, String(packageId)]);
    if (!pending.has(key)) {
      pending.set(key, {
        packageId: String(packageId),
        batchId,
        preview: [],
        source: [],
      });
    }
    pending.get(key)[kind].push({
      item,
      meta,
      packageType,
      pairId: kind === "preview" ? meta["配对 ZIP"] : meta["配对 PNG"],
    });
  }

  const pairCandidates = [];
  for (const group of pending.values()) {
    if (group.preview.length > 1 || group.source.length > 1) {
      const batchLabel = group.batchId || "未记录 batch_id";
      for (const entry of [...group.preview, ...group.source]) {
        blocked.push({
          item: entry.item,
          reason: `同一批次存在重复的包装记录：${batchLabel} / ${group.packageId}`,
        });
      }
      continue;
    }

    const preview = group.preview[0];
    const source = group.source[0];
    if (!preview) {
      blocked.push({ item: source.item, reason: "缺少配对 PNG" });
      continue;
    }
    if (!source) {
      blocked.push({ item: preview.item, reason: "缺少配对 ZIP" });
      continue;
    }
    if (preview.pairId && preview.pairId !== source.item.id) {
      blocked.push({
        item: preview.item,
        reason: `配对 ZIP 不一致（记录 ${preview.pairId}，实际 ${source.item.id}）`,
      });
      blocked.push({
        item: source.item,
        reason: `配对 PNG 不一致（记录 ${source.pairId}，实际 ${preview.item.id}）`,
      });
      continue;
    }
    if (source.pairId && source.pairId !== preview.item.id) {
      blocked.push({
        item: preview.item,
        reason: `配对 PNG 不一致（记录 ${source.pairId}，实际 ${preview.item.id}）`,
      });
      blocked.push({
        item: source.item,
        reason: `配对 ZIP 不一致（记录 ${preview.pairId}，实际 ${source.item.id}）`,
      });
      continue;
    }
    pairCandidates.push({
      packageId: group.packageId,
      packageType: preview.packageType,
      version: preview.meta["版本"] || "v01",
      batchId: group.batchId || null,
      preview: preview.item,
      source: source.item,
    });
  }

  const candidatesByPackage = new Map();
  for (const pair of pairCandidates) {
    if (!candidatesByPackage.has(pair.packageId)) {
      candidatesByPackage.set(pair.packageId, []);
    }
    candidatesByPackage.get(pair.packageId).push(pair);
  }

  const readyPairs = [];
  for (const pairs of candidatesByPackage.values()) {
    if (pairs.length === 1) {
      readyPairs.push(pairs[0]);
      continue;
    }
    const batchLabels = pairs.map((pair) => pair.batchId || "未记录 batch_id").join("、");
    for (const pair of pairs) {
      for (const item of [pair.preview, pair.source]) {
        blocked.push({
          item,
          reason: `同一包装存在多个完整批次（${batchLabels}），请先保留一个批次`,
        });
      }
    }
  }

  return {
    readyPairs,
    blocked,
    alreadyFiled,
    stats: {
      ready: readyPairs.length,
      blocked: blocked.length,
      alreadyFiled: alreadyFiled.length,
      files: items.length,
    },
  };
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

async function fileBatch(adapter, batchFolderId, options = {}) {
  const [items, folders] = await Promise.all([
    adapter.getItemsByFolder(batchFolderId),
    adapter.getFolders(),
  ]);
  const formalFolderIds = folders
    .filter((folder) =>
      [FORMAL_PREVIEW_ROOT_NAME, FORMAL_SOURCE_ROOT_NAME].includes(folder.name)
    )
    .map(folderId);
  const plan = planFormalFile(items, { formalFolderIds });

  const filed = [];
  const failed = [];
  for (const pair of plan.readyPairs) {
    try {
      const previewRoot = await ensureFolder(adapter, FORMAL_PREVIEW_ROOT_NAME, null);
      const sourceRoot = await ensureFolder(adapter, FORMAL_SOURCE_ROOT_NAME, null);
      const previewFolder = await ensureFolder(adapter, pair.packageType, folderId(previewRoot));
      const sourceFolder = await ensureFolder(adapter, pair.packageType, folderId(sourceRoot));
      const previewItem = await adapter.getItem(pair.preview.id);
      const sourceItem = await adapter.getItem(pair.source.id);
      if (!previewItem || !sourceItem) {
        failed.push({ pair, reason: "素材读取失败，无法移动" });
        continue;
      }
      previewItem.folders = [folderId(previewFolder)];
      sourceItem.folders = [folderId(sourceFolder)];
      previewItem.tags = replaceIngestTag(previewItem.tags, FORMAL_PREVIEW_ROOT_NAME);
      sourceItem.tags = replaceIngestTag(sourceItem.tags, FORMAL_SOURCE_ROOT_NAME);
      await adapter.saveItem(previewItem);
      await adapter.saveItem(sourceItem);
      filed.push({
        packageId: pair.packageId,
        packageType: pair.packageType,
        version: pair.version,
        previewItemId: previewItem.id,
        sourceItemId: sourceItem.id,
        previewFolderId: folderId(previewFolder),
        sourceFolderId: folderId(sourceFolder),
      });
    } catch (error) {
      failed.push({ pair, reason: error.message });
    }
  }

  const remaining = await adapter.getItemsByFolder(batchFolderId);
  return {
    filed,
    failed,
    blocked: plan.blocked,
    alreadyFiled: plan.alreadyFiled,
    remaining,
    batchEmpty: remaining.length === 0,
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

  async getItemsByFolder(folderId) {
    const fields = ["id", "name", "ext", "tags", "annotation", "folders"];
    let directItems = [];
    let unfiledItems = [];
    let directError = null;
    try {
      const result = await this.eagle.item.get({ folders: [folderId], fields });
      directItems = Array.isArray(result) ? result : [];
    } catch (error) {
      directError = error;
    }

    try {
      const result = await this.eagle.item.get({ isUnfiled: true, fields });
      unfiledItems = Array.isArray(result) ? result : [];
    } catch {
      unfiledItems = [];
    }

    let items = uniqueItems([...directItems, ...unfiledItems]);
    if (directError || directItems.length === 0) {
      try {
        const allItems = await this.eagle.item.getAll();
        items = uniqueItems([...items, ...(Array.isArray(allItems) ? allItems : [])]);
      } catch (error) {
        if (directError) throw directError;
      }
    }
    return collectBatchItems(items, folderId);
  }

  async saveItem(item) {
    return item.save();
  }
}

module.exports = {
  BATCH_SUFFIX,
  FORMAL_PREVIEW_ROOT_NAME,
  FORMAL_SOURCE_ROOT_NAME,
  INGEST_ROOT_NAME,
  KNOWN_PACKAGE_TYPES,
  EaglePluginAdapter,
  buildAnnotation,
  buildTags,
  collectBatchItems,
  ensureFolder,
  fileBatch,
  folderId,
  importBatch,
  itemKind,
  itemName,
  parseAnnotation,
  planFormalFile,
  replaceIngestTag,
};
