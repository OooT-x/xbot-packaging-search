const path = require("path");
const {
  COLLECTED_ROOT,
  createBatchId,
  inferPackageType,
  metadataFromPair,
  normalizeDependencyList,
  normalizeText,
  pairWithoutManifest,
  stableId,
} = require("./scan.js");
const {
  PACKAGE_TYPES,
  PACKAGE_TYPE_SET,
} = require("./package-types");

const INGEST_ROOT_NAME = "00_待入库";
const BATCH_SUFFIX = "包装";
const FORMAL_PREVIEW_ROOT_NAME = "01_预览图";
const FORMAL_SOURCE_ROOT_NAME = "02_AE源文件";
const HISTORY_ROOT_NAME = "03_历史版本";
const KNOWN_PACKAGE_TYPES = PACKAGE_TYPES;
const IMPORT_MODES = ["prompt", "reuse", "update", "new"];
const PROJECT_TAG_GROUP_NAME = "项目";
const PROJECT_TAG_GROUP_COLOR = "yellow";

function folderId(folder) {
  if (!folder) return null;
  if (typeof folder === "string") return folder;
  return folder.id || folder.folderId || null;
}

function flattenFolderTree(folders) {
  const entriesById = new Map();
  const inferredParents = new Map();

  const visit = (entries, parentId = null) => {
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      const id = folderId(entry);
      if (!id) continue;
      if (typeof entry === "string") {
        if (parentId && !inferredParents.has(id)) inferredParents.set(id, parentId);
        continue;
      }
      if (!entriesById.has(id)) entriesById.set(id, entry);
      if (parentId && !folderId(entry.parent)) inferredParents.set(id, parentId);
      visit(entry.children, id);
    }
  };

  visit(folders);
  return [...entriesById.entries()].map(([id, folder]) => ({
    ...folder,
    id,
    name: folder.name || "",
    description: folder.description || "",
    children: Array.isArray(folder.children) ? folder.children : [],
    parent: folderId(folder.parent) || inferredParents.get(id) || null,
  }));
}

function itemFolderIds(item) {
  return (item?.folders || []).map(folderId).filter(Boolean);
}

function collectDescendantFolderIds(folders, rootFolderId) {
  const childrenByParent = new Map();
  for (const folder of folders || []) {
    const parentId = folderId(folder.parent);
    if (!childrenByParent.has(parentId)) childrenByParent.set(parentId, []);
    childrenByParent.get(parentId).push(folderId(folder));
  }

  const result = [];
  const queue = [rootFolderId];
  const visited = new Set();
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || visited.has(current)) continue;
    visited.add(current);
    result.push(current);
    queue.push(...(childrenByParent.get(current) || []));
  }
  return result;
}

function buildFolderContext(folders, rootFolderId) {
  const folderNamesById = {};
  const folderDepthById = { [rootFolderId]: 0 };
  const childrenByParent = new Map();
  for (const folder of folders || []) {
    const id = folderId(folder);
    const parentId = folderId(folder.parent);
    if (id) folderNamesById[id] = folder.name || "";
    if (!childrenByParent.has(parentId)) childrenByParent.set(parentId, []);
    childrenByParent.get(parentId).push(id);
  }

  const queue = [rootFolderId];
  while (queue.length > 0) {
    const current = queue.shift();
    const depth = folderDepthById[current] || 0;
    for (const childId of childrenByParent.get(current) || []) {
      if (!childId || Object.hasOwn(folderDepthById, childId)) continue;
      folderDepthById[childId] = depth + 1;
      queue.push(childId);
    }
  }
  return { folderNamesById, folderDepthById };
}

function inferProjectNameFromBatch(folder) {
  const name = String(folder?.name || "").trim();
  return name.replace(/包装$/u, "") || name || "未命名项目";
}

function buildAnnotation(pkg, pair, options = {}) {
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
  if (pkg.basePackageId) lines.push(`base_package_id：${pkg.basePackageId}`);
  if (pair && pair.previewItemId) lines.push(`配对 PNG：${pair.previewItemId}`);
  if (pair && pair.sourceItemId) lines.push(`配对 ZIP：${pair.sourceItemId}`);
  if (pkg.sourceOptional && !pair?.sourceItemId) {
    lines.push("源文件：无（仅图片背景）");
  }
  lines.push(`状态：${options.status || (pkg.dependencyStatus === "warning" ? "启用（依赖警告）" : "启用")}`);
  if (options.revisionId) lines.push(`修订号：${options.revisionId}`);
  if (options.replacedBy) lines.push(`取代为：${options.replacedBy}`);
  if (Array.isArray(pkg.fonts) && pkg.fonts.length > 0) {
    lines.push(`字体：${pkg.fonts.join("、")}`);
  }
  if (Array.isArray(pkg.effects) && pkg.effects.length > 0) {
    lines.push(`效果：${pkg.effects.join("、")}`);
  }
  return lines.join("\n");
}

function normalizeIdentity(value) {
  return String(value || "")
    .trim()
    .replace(/[\\/]+/g, "/")
    .replace(/\/+$/u, "")
    .toLowerCase();
}

function manifestIdentity(scanResult) {
  if (scanResult?.manifestKey) return String(scanResult.manifestKey);
  const paths = (scanResult?.manifestFiles || [])
    .map((filePath) => normalizeIdentity(filePath))
    .filter(Boolean)
    .sort();
  return paths.length > 0 ? stableId("manifest", ...paths) : "";
}

function batchIdentity(scanResult) {
  const ready = (scanResult?.packages || [])
    .filter((pkg) => pkg.state === "ready")
    .map((pkg) => [
      pkg.packageId,
      pkg.preview?.path || "",
      pkg.source?.path || "",
      pkg.manifestPath || "",
    ]);
  return {
    batchId: String(scanResult?.batchId || createBatchId()),
    batchKey:
      String(scanResult?.batchKey || "").trim() ||
      stableId("batch-key", scanResult?.sourceDir || "", ...ready.flat()),
    sourcePath: String(scanResult?.sourceDir || ""),
    sourcePathKey: normalizeIdentity(scanResult?.sourceDir),
    manifestKey: manifestIdentity(scanResult),
  };
}

function upsertDescription(description, fields) {
  const keys = new Set(Object.keys(fields));
  const lines = String(description || "")
    .split(/\r?\n/u)
    .filter((line) => {
      const index = line.indexOf("：");
      return index <= 0 || !keys.has(line.slice(0, index).trim());
    });
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null && String(value) !== "") {
      lines.push(`${key}：${value}`);
    }
  }
  return lines.filter(Boolean).join("\n");
}

function packageDetailFromItems(items) {
  const byPackage = new Map();
  for (const item of items || []) {
    const meta = parseAnnotation(item.annotation);
    const packageId = String(meta.package_id || "").trim();
    if (!packageId) continue;
    if (!byPackage.has(packageId)) {
      byPackage.set(packageId, {
        packageId,
        items: [],
        preview: null,
        source: null,
        meta,
      });
    }
    const entry = byPackage.get(packageId);
    entry.items.push(item);
    const kind = itemKind(item);
    if (kind === "preview") entry.preview = item;
    if (kind === "source") entry.source = item;
    entry.meta = { ...entry.meta, ...meta };
  }
  return byPackage;
}

async function findDuplicateBatches(adapter, scanResult, rootFolderId) {
  const identity = batchIdentity(scanResult);
  const folders = await adapter.getFolders();
  const packageIds = new Set(
    (scanResult?.packages || [])
      .filter((pkg) => pkg.state === "ready")
      .map((pkg) => String(pkg.packageId || "").trim())
      .filter(Boolean)
  );
  const candidates = folders.filter(
    (folder) => folderId(folder.parent) === rootFolderId
  );
  const matches = [];
  for (const folder of candidates) {
    const meta = parseAnnotation(folder.description);
    const matchedBy = [];
    if (meta.batch_id && meta.batch_id === identity.batchId) matchedBy.push("batch_id");
    if (meta.batch_key && meta.batch_key === identity.batchKey) matchedBy.push("batch_key");
    if (
      identity.sourcePathKey &&
      meta["来源"] &&
      normalizeIdentity(meta["来源"]) === identity.sourcePathKey
    ) {
      matchedBy.push("source_path");
    }
    if (identity.manifestKey && meta.manifest_key === identity.manifestKey) {
      matchedBy.push("manifest");
    }

    let items = [];
    if (
      matchedBy.length === 0 &&
      folder.name === `${scanResult.projectName}${BATCH_SUFFIX}` &&
      typeof adapter.getItemsByFolder === "function"
    ) {
      items = await adapter.getItemsByFolder(folderId(folder));
      const itemPackageIds = new Set(
        items
          .map((item) => parseAnnotation(item.annotation).package_id)
          .filter(Boolean)
      );
      if ([...packageIds].some((packageId) => itemPackageIds.has(packageId))) {
        matchedBy.push("package_id");
      }
    }
    if (matchedBy.length > 0) {
      matches.push({ folder, folderId: folderId(folder), meta, items, matchedBy });
    }
  }
  return matches;
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

function collectBatchItems(items, batchFolderIds) {
  const folderIds = new Set(
    (Array.isArray(batchFolderIds) ? batchFolderIds : [batchFolderIds]).filter(Boolean)
  );
  const inFolder = items.filter((item) =>
    itemFolderIds(item).some((id) => folderIds.has(id))
  );
  const inFolderIds = new Set(inFolder.map((item) => item.id));
  const batchIds = new Set();
  for (const item of inFolder) {
    const meta = parseAnnotation(item.annotation);
    if (meta["batch_id"]) batchIds.add(meta["batch_id"]);
  }
  const related = items.filter((item) => {
    if (itemFolderIds(item).length > 0) return false;
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

function itemFileName(item) {
  const name = String(item?.name || "");
  const ext = String(item?.ext || "").replace(/^\./, "").toLowerCase();
  if (!ext || name.toLowerCase().endsWith(`.${ext}`)) return name;
  return `${name}.${ext}`;
}

function itemContext(item, options = {}) {
  const folderNames = itemFolderIds(item)
    .map((id) => options.folderNamesById?.[id])
    .filter(Boolean);
  return [itemFileName(item), ...(item.tags || []), ...folderNames].join(" ");
}

function isManualCandidate(item, kind, options = {}) {
  if (!options.folderDepthById) return true;
  const folders = itemFolderIds(item);
  for (const id of folders) {
    const depth = options.folderDepthById[id];
    const folderName = options.folderNamesById?.[id] || "";
    if (depth === 0) return true;
    if (depth === 1 && KNOWN_PACKAGE_TYPES.includes(folderName)) return true;
    if (kind === "source" && depth === 1 && folderName === COLLECTED_ROOT) return true;
  }
  return false;
}

function pairMetadata(preview, source, options = {}, base = {}) {
  const previewMeta = preview.meta || {};
  const sourceMeta = source.meta || {};
  const projectName =
    previewMeta["项目"] || sourceMeta["项目"] || options.projectName || "未命名项目";
  const previewFile = { path: preview.item.id, name: itemFileName(preview.item) };
  const sourceFile = { path: source.item.id, name: itemFileName(source.item) };
  const inferred = metadataFromPair(previewFile, sourceFile, projectName);
  const packageId =
    base.packageId ||
    previewMeta["package_id"] ||
    sourceMeta["package_id"] ||
    inferred.packageId;
  const override = options.overrides?.[packageId] || {};
  const context = normalizeText(
    `${itemContext(preview.item, options)} ${itemContext(source.item, options)}`
  );
  const contextualType = inferPackageType(context);
  const packageType =
    override.packageType ||
    previewMeta["包装类型"] ||
    sourceMeta["包装类型"] ||
    inferred.packageType ||
    contextualType ||
    null;
  const packageName =
    previewMeta["包装名称"] ||
    sourceMeta["包装名称"] ||
    inferred.packageName ||
    path.basename(sourceFile.name, path.extname(sourceFile.name));
  const batchId =
    base.batchId ||
    previewMeta["batch_id"] ||
    sourceMeta["batch_id"] ||
    options.batchId ||
    stableId("batch", options.batchFolderId || projectName);
  const version =
    override.version ||
    previewMeta["版本"] ||
    sourceMeta["版本"] ||
    inferred.version ||
    "v01";
  const aeCompName =
    override.aeCompName ||
    previewMeta["AE 合成"] ||
    sourceMeta["AE 合成"] ||
    packageName;
  const dependencyStatus = /警告/.test(
    `${previewMeta["状态"] || ""} ${sourceMeta["状态"] || ""}`
  )
    ? "warning"
    : "complete";

  return {
    packageId,
    projectName,
    sourceProjectName:
      previewMeta["原 AE 项目"] || sourceMeta["原 AE 项目"] || projectName,
    packageName,
    packageType,
    version,
    aeCompName,
    batchId,
    dependencyStatus,
    fonts: normalizeDependencyList(previewMeta["字体"] || sourceMeta["字体"]),
    effects: normalizeDependencyList(previewMeta["效果"] || sourceMeta["效果"]),
  };
}

function planFormalFile(items, options = {}) {
  const formalFolderIds = new Set(options.formalFolderIds || []);
  const blocked = [];
  const reviewPairs = [];
  const ignored = [];
  const alreadyFiled = [];
  const pending = new Map();
  const rawEntries = [];

  for (const item of items) {
    const kind = itemKind(item);
    if (!kind) {
      ignored.push({ item, reason: "非 PNG/ZIP 素材，不参与正式入库" });
      continue;
    }
    if (itemFolderIds(item).some((id) => formalFolderIds.has(id))) {
      alreadyFiled.push(item);
      continue;
    }

    const meta = parseAnnotation(item.annotation);
    const packageId = meta["package_id"];
    if (!packageId) {
      if (isManualCandidate(item, kind, options)) {
        rawEntries.push({ item, meta, kind });
      } else {
        ignored.push({ item, reason: "深层目录中的未登记 PNG/ZIP 视为依赖文件" });
      }
      continue;
    }

    const batchId = meta["batch_id"] || options.batchId || "";
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
      pairId: kind === "preview" ? meta["配对 ZIP"] : meta["配对 PNG"],
    });
  }

  const pairCandidates = [];
  const addPairCandidate = (preview, source, base = {}) => {
    if (preview.pairId && preview.pairId !== source.item.id) {
      blocked.push({
        item: preview.item,
        reason: `配对 ZIP 不一致（记录 ${preview.pairId}，实际 ${source.item.id}）`,
      });
      blocked.push({
        item: source.item,
        reason: `配对 PNG 不一致（记录 ${source.pairId}，实际 ${preview.item.id}）`,
      });
      return;
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
      return;
    }

    const metadata = pairMetadata(preview, source, options, base);
    const pair = {
      ...metadata,
      metadata,
      preview: preview.item,
      source: source.item,
    };
    if (!KNOWN_PACKAGE_TYPES.includes(metadata.packageType)) {
      reviewPairs.push({
        ...pair,
        reason: metadata.packageType
          ? `未知包装类型“${metadata.packageType}”，请选择包装类型`
          : "请选择包装类型",
      });
      return;
    }
    pairCandidates.push(pair);
  };

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
    addPairCandidate(preview, source, {
      packageId: group.packageId,
      batchId: group.batchId || null,
    });
  }

  if (rawEntries.length > 0) {
    const itemById = new Map(rawEntries.map((entry) => [entry.item.id, entry]));
    const files = rawEntries.map((entry) => ({
      path: entry.item.id,
      name: itemFileName(entry.item),
      kind: entry.kind === "preview" ? "png" : "zip",
      status: "candidate",
    }));
    for (const pair of pairWithoutManifest(files)) {
      const preview = pair.png ? itemById.get(pair.png.path) : null;
      const source = pair.zip ? itemById.get(pair.zip.path) : null;
      if (preview && source) {
        addPairCandidate(preview, source);
      } else {
        const entry = preview || source;
        blocked.push({
          item: entry.item,
          reason:
            pair.conflict === "multiple"
              ? "无法唯一配对，多张预览对应同一源文件"
              : preview
                ? "缺少配对 ZIP"
                : "缺少配对 PNG",
        });
      }
    }
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
    reviewPairs,
    ignored,
    alreadyFiled,
    stats: {
      ready: readyPairs.length,
      blocked: blocked.length + reviewPairs.length,
      ignored: ignored.length,
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

async function ensureProjectTagGroups(adapter, projectNames) {
  if (typeof adapter.ensureProjectTagGroup !== "function") return;
  const names = [...new Set(
    (projectNames || [])
      .map((name) => String(name || "").trim())
      .filter(Boolean)
  )];
  for (const name of names) {
    await adapter.ensureProjectTagGroup(name);
  }
}

async function importBatch(adapter, scanResult, options = {}) {
  const ready = scanResult.packages.filter((pkg) => pkg.state === "ready");
  if (ready.length === 0) {
    throw new Error("没有可导入的包装记录，请先处理冲突或补全 manifest");
  }
  const mode = String(options.mode || "prompt").trim();
  if (!IMPORT_MODES.includes(mode)) {
    throw new Error(`未知的批次导入模式：${mode}`);
  }
  const identity = batchIdentity(scanResult);
  const rootFolder = await ensureFolder(adapter, INGEST_ROOT_NAME, null);
  const duplicateMatches = await findDuplicateBatches(
    adapter,
    scanResult,
    folderId(rootFolder)
  );
  if (duplicateMatches.length > 0 && mode === "prompt") {
    return {
      state: "duplicate",
      duplicate: true,
      mode,
      batchId: identity.batchId,
      rootFolderId: folderId(rootFolder),
      matches: duplicateMatches.map((match) => ({
        batchFolderId: match.folderId,
        batchId: match.meta.batch_id || null,
        matchedBy: match.matchedBy,
      })),
      choices: ["reuse", "update", "new"],
      imported: [],
      reused: [],
      updated: [],
    };
  }

  await ensureProjectTagGroups(
    adapter,
    ready.map((pkg) => pkg.projectName || scanResult.projectName)
  );

  const matched = duplicateMatches[0] || null;
  let actualMode = matched && ["reuse", "update"].includes(mode) ? mode : "new";
  let batchFolder;
  let batchId = identity.batchId;
  if (matched && ["reuse", "update"].includes(mode)) {
    batchFolder = matched.folder;
    batchId = matched.meta.batch_id || stableId("batch", matched.folderId);
  } else {
    if (matched && mode === "new") batchId = createBatchId();
    const name =
      matched && mode === "new"
        ? `${scanResult.projectName}${BATCH_SUFFIX}-${batchId.replace(/^batch-/u, "").slice(-6)}`
        : `${scanResult.projectName}${BATCH_SUFFIX}`;
    batchFolder = await ensureFolder(adapter, name, folderId(rootFolder));
  }

  const existingItems =
    matched && typeof adapter.getItemsByFolder === "function"
      ? matched.items.length > 0
        ? matched.items
        : await adapter.getItemsByFolder(folderId(batchFolder))
      : [];
  const existingPackages = packageDetailFromItems(existingItems);

  const results = [];
  const reused = [];
  const updated = [];
  for (const pkg of ready) {
    const pair = {
      packageId: pkg.packageId,
      batchId,
      projectName: scanResult.projectName,
      sourceProjectName: pkg.sourceProjectName || null,
      packageName: pkg.packageName,
      packageType: pkg.packageType,
      version: pkg.version || "v01",
      aeCompName: pkg.aeCompName,
      dependencyStatus: pkg.dependencyStatus || "complete",
      fonts: pkg.fonts || [],
      effects: pkg.effects || [],
      previewPath: pkg.preview.path,
      sourcePath: pkg.source.path,
    };
    const existing = existingPackages.get(String(pkg.packageId));
    if (existing && existing.items.length > 0) {
      let previewItemId = existing.preview?.id || null;
      let sourceItemId = existing.source?.id || null;
      if (!previewItemId) {
        previewItemId = await adapter.addFromPath(pkg.preview.path, {
          name: itemName(pkg.preview.path, "png"),
          tags: buildTags(pair),
          folders: [folderId(batchFolder)],
          annotation: buildAnnotation(pair, null),
        });
      }
      if (!sourceItemId) {
        sourceItemId = await adapter.addFromPath(pkg.source.path, {
          name: itemName(pkg.source.path, "zip"),
          tags: buildTags(pair),
          folders: [folderId(batchFolder)],
          annotation: buildAnnotation(pair, { previewItemId, sourceItemId: null }),
        });
      }
      const record = {
        packageId: pkg.packageId,
        previewItemId,
        sourceItemId,
        previewPath: pkg.preview.path,
        sourcePath: pkg.source.path,
      };
      if (mode === "reuse" && existing.preview && existing.source) {
        reused.push(record);
      } else {
        const annotation = buildAnnotation(pair, {
          previewItemId,
          sourceItemId,
          previewPath: pkg.preview.path,
          sourcePath: pkg.source.path,
        });
        for (const itemId of [previewItemId, sourceItemId]) {
          const item = await adapter.getItem(itemId);
          if (!item) continue;
          item.annotation = annotation;
          item.tags = buildTags(pair);
          item.folders = [folderId(batchFolder)];
          await adapter.saveItem(item);
        }
        updated.push(record);
      }
      continue;
    }

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
    if (existing) updated.push(results[results.length - 1]);
  }

  const batchFolderInstance = await adapter.getFolder(folderId(batchFolder));
  if (batchFolderInstance) {
    batchFolderInstance.description = upsertDescription(
      batchFolderInstance.description,
      {
        batch_id: batchId,
        batch_key: identity.batchKey,
        来源: identity.sourcePath,
        manifest_key: identity.manifestKey,
        记录: `${ready.length} 条`,
        导入模式: actualMode,
      }
    );
    await adapter.saveFolder(batchFolderInstance);
  }

  return {
    state: actualMode === "new" ? "imported" : actualMode,
    duplicate: duplicateMatches.length > 0,
    mode: actualMode,
    batchId,
    batchFolderId: folderId(batchFolder),
    rootFolderId: folderId(rootFolder),
    imported: results,
    reused,
    updated,
    matches: duplicateMatches.map((match) => ({
      batchFolderId: match.folderId,
      batchId: match.meta.batch_id || null,
      matchedBy: match.matchedBy,
    })),
  };
}

async function inspectBatch(adapter, batchFolderId, options = {}) {
  const folders = await adapter.getFolders();
  const batchFolder = folders.find((folder) => folderId(folder) === batchFolderId) || null;
  const folderIds = collectDescendantFolderIds(folders, batchFolderId);
  const items = await adapter.getItemsByFolder(batchFolderId, { folderIds });
  const formalFolderIds = folders
    .filter((folder) =>
      [FORMAL_PREVIEW_ROOT_NAME, FORMAL_SOURCE_ROOT_NAME].includes(folder.name)
    )
    .map(folderId);
  const folderContext = buildFolderContext(folders, batchFolderId);
  const folderMeta = parseAnnotation(batchFolder?.description);
  const planOptions = {
    formalFolderIds,
    batchFolderId,
    batchId:
      options.batchId ||
      folderMeta["batch_id"] ||
      stableId("batch", batchFolderId || options.projectName || "manual"),
    projectName: options.projectName || inferProjectNameFromBatch(batchFolder),
    overrides: options.overrides || {},
    ...folderContext,
  };
  return {
    batchFolder,
    folderIds,
    folders,
    items,
    planOptions,
    plan: planFormalFile(items, planOptions),
  };
}

function mergeFormalTags(existingTags, metadata, formalRootName) {
  const combined = [...(existingTags || []), ...buildTags(metadata)];
  return [...new Set(replaceIngestTag(combined, formalRootName))];
}

function canonicalPreviewName(metadata) {
  return [
    metadata.projectName,
    metadata.packageType,
    metadata.packageName,
    metadata.version || "v01",
  ]
    .filter(Boolean)
    .join("_");
}

function canonicalSourceName(metadata) {
  return [metadata.projectName, metadata.packageName, metadata.version || "v01"]
    .filter(Boolean)
    .join("_");
}

const INVALID_ITEM_NAME_CHARACTERS = /[<>:"\/\\|?*\u0000-\u001F]/u;

function stripKnownExtension(value, kind) {
  const extension = kind === "preview" ? ".png" : ".zip";
  const text = String(value || "").trim();
  return text.toLowerCase().endsWith(extension)
    ? text.slice(0, -extension.length)
    : text;
}

function resolveFormalItemName(metadata, kind, options = {}) {
  const fallback = kind === "preview"
    ? canonicalPreviewName(metadata)
    : canonicalSourceName(metadata);
  const overrides = options.nameOverrides || {};
  const override = overrides[metadata.packageId]?.[kind];
  if (override === undefined || override === null || String(override).trim() === "") {
    return fallback;
  }

  const name = stripKnownExtension(override, kind);
  if (!name) throw new Error(`${kind === "preview" ? "预览图" : "源文件"}名称不能为空`);
  if (INVALID_ITEM_NAME_CHARACTERS.test(name)) {
    throw new Error(`名称“${override}”包含 Windows 不允许的文件名字符`);
  }
  if (/[. ]$/u.test(name)) {
    throw new Error(`名称“${override}”不能以空格或句点结尾`);
  }
  return name;
}

function validateFormalItemNames(pairs, options = {}) {
  const seen = new Map();
  for (const pair of pairs || []) {
    const metadata = pair.metadata || pair;
    const kinds = metadata.sourceOptional ? ["preview"] : ["preview", "source"];
    for (const kind of kinds) {
      const name = resolveFormalItemName(metadata, kind, options);
      const key = `${metadata.packageType || ""}\u0000${kind}\u0000${name.toLocaleLowerCase()}`;
      const previous = seen.get(key);
      if (previous && previous !== metadata.packageId) {
        throw new Error(
          `批量命名后出现重复名称“${name}”，请为 ${metadata.packageName || metadata.packageId} 修改名称`
        );
      }
      seen.set(key, metadata.packageId);
    }
  }
}

async function fileBatch(adapter, batchFolderId, options = {}) {
  const inspection = await inspectBatch(adapter, batchFolderId, options);
  const { folderIds, plan } = inspection;
  const folderMeta = parseAnnotation(inspection.batchFolder?.description);

  validateFormalItemNames(plan.readyPairs, options);
  await ensureProjectTagGroups(
    adapter,
    plan.readyPairs.map((pair) => (pair.metadata || pair).projectName)
  );

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
      const metadata = pair.metadata || pair;
      const annotation = buildAnnotation(metadata, {
        previewItemId: previewItem.id,
        sourceItemId: sourceItem.id,
      });
      previewItem.name = resolveFormalItemName(metadata, "preview", options);
      sourceItem.name = resolveFormalItemName(metadata, "source", options);
      previewItem.annotation = annotation;
      sourceItem.annotation = annotation;
      previewItem.folders = [folderId(previewFolder)];
      sourceItem.folders = [folderId(sourceFolder)];
      previewItem.tags = mergeFormalTags(
        previewItem.tags,
        metadata,
        FORMAL_PREVIEW_ROOT_NAME
      );
      sourceItem.tags = mergeFormalTags(
        sourceItem.tags,
        metadata,
        FORMAL_SOURCE_ROOT_NAME
      );
      await adapter.saveItem(previewItem);
      await adapter.saveItem(sourceItem);
      filed.push({
        packageId: pair.packageId,
        projectName: metadata.projectName,
        packageName: metadata.packageName,
        packageType: pair.packageType,
        version: pair.version,
        aeCompName: metadata.aeCompName,
        batchId: metadata.batchId,
        dependencyStatus: metadata.dependencyStatus,
        previewItemId: previewItem.id,
        sourceItemId: sourceItem.id,
        previewName: itemFileName(previewItem),
        sourceName: itemFileName(sourceItem),
        previewPath: previewItem.filePath || previewItem.filepath || "",
        sourcePath: sourceItem.filePath || sourceItem.filepath || "",
        previewFolderId: folderId(previewFolder),
        sourceFolderId: folderId(sourceFolder),
      });
    } catch (error) {
      failed.push({ pair, reason: error.message });
    }
  }

  const remaining = await adapter.getItemsByFolder(batchFolderId, { folderIds });
  const filedBatchIds = [...new Set(filed.map((item) => item.batchId).filter(Boolean))];
  const filedProjectNames = [...new Set(filed.map((item) => item.projectName).filter(Boolean))];
  return {
    batchId: filedBatchIds.length === 1 ? filedBatchIds[0] : inspection.planOptions.batchId,
    batchFolderId,
    projectName:
      filedProjectNames.length === 1
        ? filedProjectNames[0]
        : inspection.planOptions.projectName,
    sourcePath: folderMeta["来源"] || "",
    batchKey: folderMeta.batch_key || "",
    manifestKey: folderMeta.manifest_key || "",
    importMode: folderMeta["导入模式"] || "new",
    filed,
    failed,
    blocked: plan.blocked,
    reviewPairs: plan.reviewPairs,
    ignored: plan.ignored,
    alreadyFiled: plan.alreadyFiled,
    remaining,
    batchEmpty: remaining.length === 0,
  };
}

async function getFormalLibraryItems(adapter) {
  const folders = await adapter.getFolders();
  const formalRoots = folders.filter((folder) =>
    [FORMAL_PREVIEW_ROOT_NAME, FORMAL_SOURCE_ROOT_NAME].includes(folder.name)
  );
  const formalFolderIds = [
    ...new Set(
      formalRoots.flatMap((root) => collectDescendantFolderIds(folders, folderId(root)))
    ),
  ];
  if (!formalFolderIds.length || typeof adapter.getItemsByFolder !== "function") {
    return { folders, formalFolderIds, items: [] };
  }

  const itemResults = await Promise.all(
    formalFolderIds.map((id) =>
      adapter.getItemsByFolder(id, { folderIds: formalFolderIds })
    )
  );
  const items = uniqueItems(itemResults.flatMap((result) => result || []));
  const formalFolderIdSet = new Set(formalFolderIds);
  return {
    folders,
    formalFolderIds,
    items: (items || []).filter((item) =>
      itemFolderIds(item).some((id) => formalFolderIdSet.has(id))
    ),
  };
}

function directFormalDuplicateSummary(duplicates) {
  const batches = [
    ...new Map(
      duplicates.map(({ existing }) => {
        const metadata = existing?.meta || {};
        const batchId = metadata.batch_id || "formal-library";
        return [batchId, {
          batchFolderId: "",
          batchId,
          projectName: metadata.project_name || "",
          matchedBy: ["package_id"],
        }];
      })
    ).values(),
  ];
  return batches;
}

async function writeFormalPair(adapter, metadata, existing = null, options = {}) {
  const previewRoot = await ensureFolder(adapter, FORMAL_PREVIEW_ROOT_NAME, null);
  const sourceOptional = Boolean(metadata.sourceOptional);
  const hasSource = Boolean(String(metadata.sourcePath || "").trim());
  if (!hasSource && !sourceOptional) {
    throw new Error("缺少工程 ZIP；仅图片背景可省略源文件");
  }
  const sourceRoot = hasSource
    ? await ensureFolder(adapter, FORMAL_SOURCE_ROOT_NAME, null)
    : null;
  const previewFolder = await ensureFolder(
    adapter,
    metadata.packageType,
    folderId(previewRoot)
  );
  const sourceFolder = hasSource
    ? await ensureFolder(adapter, metadata.packageType, folderId(sourceRoot))
    : null;

  let previewItem = existing?.preview
    ? await adapter.getItem(existing.preview.id)
    : null;
  let sourceItem = hasSource && existing?.source
    ? await adapter.getItem(existing.source.id)
    : null;

  if (!previewItem) {
    const previewId = await adapter.addFromPath(metadata.previewPath, {
      name: resolveFormalItemName(metadata, "preview", options),
      tags: mergeFormalTags([], metadata, FORMAL_PREVIEW_ROOT_NAME),
      folders: [folderId(previewFolder)],
      annotation: buildAnnotation(metadata),
    });
    previewItem = await adapter.getItem(previewId);
  }
  if (hasSource && !sourceItem) {
    const sourceId = await adapter.addFromPath(metadata.sourcePath, {
      name: resolveFormalItemName(metadata, "source", options),
      tags: mergeFormalTags([], metadata, FORMAL_SOURCE_ROOT_NAME),
      folders: [folderId(sourceFolder)],
      annotation: buildAnnotation(metadata),
    });
    sourceItem = await adapter.getItem(sourceId);
  }
  if (!previewItem || (hasSource && !sourceItem)) {
    throw new Error("素材写入 Eagle 后无法读取记录");
  }

  const annotation = buildAnnotation(metadata, {
    previewItemId: previewItem.id,
    sourceItemId: sourceItem?.id,
  });
  previewItem.name = resolveFormalItemName(metadata, "preview", options);
  previewItem.annotation = annotation;
  previewItem.folders = [folderId(previewFolder)];
  previewItem.tags = mergeFormalTags(
    previewItem.tags,
    metadata,
    FORMAL_PREVIEW_ROOT_NAME
  );
  await adapter.saveItem(previewItem);
  if (sourceItem) {
    sourceItem.name = resolveFormalItemName(metadata, "source", options);
    sourceItem.annotation = annotation;
    sourceItem.folders = [folderId(sourceFolder)];
    sourceItem.tags = mergeFormalTags(
      sourceItem.tags,
      metadata,
      FORMAL_SOURCE_ROOT_NAME
    );
    await adapter.saveItem(sourceItem);
  }

  return {
    packageId: metadata.packageId,
    projectName: metadata.projectName,
    packageName: metadata.packageName,
    packageType: metadata.packageType,
    version: metadata.version,
    aeCompName: metadata.aeCompName,
    batchId: metadata.batchId,
    dependencyStatus: metadata.dependencyStatus,
    previewItemId: previewItem.id,
    sourceItemId: sourceItem?.id || null,
    previewName: itemFileName(previewItem),
    sourceName: sourceItem ? itemFileName(sourceItem) : null,
    previewPath: previewItem.filePath || previewItem.filepath || metadata.previewPath,
    sourcePath: sourceItem
      ? sourceItem.filePath || sourceItem.filepath || metadata.sourcePath
      : null,
    previewFolderId: folderId(previewFolder),
    sourceFolderId: folderId(sourceFolder),
  };
}

async function importFormalBatch(adapter, scanResult, options = {}) {
  const readyPackages = (scanResult?.packages || []).filter(
    (pkg) => pkg.state === "ready"
  );
  if (!readyPackages.length) throw new Error("没有可直接入库的素材");

  const projectName = String(scanResult.projectName || "").trim();
  if (!projectName) throw new Error("项目名称不能为空");
  const missingTypes = readyPackages.filter(
    (pkg) => !KNOWN_PACKAGE_TYPES.includes(String(pkg.packageType || ""))
  );
  if (missingTypes.length) {
    throw new Error(
      `请先补充包装类型：${missingTypes
        .map((pkg) => pkg.packageName || pkg.packageId)
        .join("、")}`
    );
  }
  const sourceOptionalForPackage = (pkg) => {
    const sourcePath = String(pkg.sourcePath || pkg.source?.path || "").trim();
    return Boolean(
      pkg.sourceOptional ||
      pkg.source_optional ||
      (!sourcePath && String(pkg.packageType || "").trim() === "背景")
    );
  };
  const missingSources = readyPackages.filter(
    (pkg) => !String(pkg.sourcePath || pkg.source?.path || "").trim() && !sourceOptionalForPackage(pkg)
  );
  if (missingSources.length) {
    throw new Error(
      `缺少工程 ZIP：${missingSources
        .map((pkg) => pkg.packageName || pkg.packageId)
        .join("、")}`
    );
  }

  const mode = options.mode || "prompt";
  if (!IMPORT_MODES.includes(mode)) throw new Error(`不支持的导入模式：${mode}`);
  const identity = batchIdentity(scanResult);
  const formalLibrary = await getFormalLibraryItems(adapter);
  const existingPackages = packageDetailFromItems(formalLibrary.items);
  const duplicates = readyPackages
    .map((pkg) => ({
      pkg,
      existing: existingPackages.get(String(pkg.packageId)),
    }))
    .filter(({ existing }) => existing);

  if (duplicates.length && mode === "prompt") {
    return {
      state: "duplicate",
      duplicate: true,
      mode,
      batchId: identity.batchId,
      batchFolderId: "",
      rootFolderId: "",
      imported: [],
      reused: [],
      updated: [],
      filed: [],
      failed: [],
      blocked: [],
      reviewPairs: [],
      ignored: [],
      alreadyFiled: [],
      remaining: [],
      batchEmpty: true,
      matches: directFormalDuplicateSummary(duplicates),
      choices: ["reuse", "update", "new"],
    };
  }

  const actualMode = mode === "prompt" ? "new" : mode;
  const firstExisting = duplicates[0]?.existing;
  const existingBatchId = firstExisting?.meta?.batch_id;
  const batchId =
    actualMode === "new"
      ? (duplicates.length ? createBatchId() : identity.batchId)
      : existingBatchId || identity.batchId;
  const metadataPairs = readyPackages.map((pkg) => ({
    ...pkg,
    projectName,
    batchId,
    previewPath: pkg.previewPath || pkg.preview?.path,
    sourcePath: pkg.sourcePath || pkg.source?.path,
    sourceOptional: sourceOptionalForPackage(pkg),
  }));
  validateFormalItemNames(metadataPairs, options);
  await ensureProjectTagGroups(adapter, [projectName]);

  const filed = [];
  const reused = [];
  for (const metadata of metadataPairs) {
    const existing = actualMode === "new"
      ? null
      : existingPackages.get(String(metadata.packageId));
    if (
      actualMode === "reuse" &&
      existing?.preview &&
      (metadata.sourceOptional ? !existing.source : existing.source)
    ) {
      reused.push({
        packageId: metadata.packageId,
        projectName,
        packageName: metadata.packageName,
        packageType: metadata.packageType,
        batchId: existing.meta?.batch_id || batchId,
        previewItemId: existing.preview.id,
        sourceItemId: existing.source?.id || null,
      });
      continue;
    }
    filed.push(await writeFormalPair(adapter, metadata, existing, options));
  }

  return {
    state: "filed",
    duplicate: duplicates.length > 0,
    mode: actualMode,
    batchId,
    batchFolderId: "",
    rootFolderId: "",
    projectName,
    sourcePath: identity.sourcePath,
    batchKey: identity.batchKey,
    manifestKey: identity.manifestKey,
    importMode: actualMode,
    imported: filed,
    reused,
    updated: actualMode === "update" ? filed : [],
    filed,
    failed: [],
    blocked: [],
    reviewPairs: [],
    ignored: [],
    alreadyFiled: [],
    remaining: [],
    batchEmpty: true,
    matches: directFormalDuplicateSummary(duplicates),
  };
}

class EaglePluginAdapter {
  constructor(eagleGlobal) {
    this.eagle = eagleGlobal;
    if (!eagleGlobal) throw new Error("Eagle Plugin API 不可用");
  }

  async getFolders() {
    const folders = await this.eagle.folder.getAll();
    return flattenFolderTree(Array.isArray(folders) ? folders : []);
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

  async ensureProjectTagGroup(projectName) {
    const tag = String(projectName || "").trim();
    if (!tag) return null;
    const tagGroupApi = this.eagle.tagGroup;
    if (!tagGroupApi || typeof tagGroupApi.get !== "function") {
      throw new Error("Eagle 标签组 API 不可用，请升级 Eagle 后重试");
    }
    const groups = await tagGroupApi.get();
    const group = (Array.isArray(groups) ? groups : []).find(
      (entry) => String(entry?.name || "").trim() === PROJECT_TAG_GROUP_NAME
    );
    if (!group) {
      if (typeof tagGroupApi.create !== "function") {
        throw new Error("Eagle 不支持创建标签组，请升级 Eagle 后重试");
      }
      return tagGroupApi.create({
        name: PROJECT_TAG_GROUP_NAME,
        color: PROJECT_TAG_GROUP_COLOR,
        tags: [tag],
      });
    }

    const existingTags = Array.isArray(group.tags)
      ? group.tags.map((entry) => String(entry || "").trim()).filter(Boolean)
      : [];
    if (existingTags.includes(tag)) return group;
    if (typeof group.addTags === "function") {
      return group.addTags({ tags: [tag] });
    }
    if (typeof group.save !== "function") {
      throw new Error("Eagle 标签组不支持保存，请升级 Eagle 后重试");
    }
    group.tags = [...new Set([...existingTags, tag])];
    await group.save();
    return group;
  }

  async addFromPath(filePath, options) {
    return this.eagle.item.addFromPath(filePath, options);
  }

  async getItem(id) {
    return this.eagle.item.getById(id);
  }

  async getItemsByFolder(folderId, options = {}) {
    const fields = ["id", "name", "ext", "tags", "annotation", "folders"];
    const folderIds = [
      ...new Set((options.folderIds || [folderId]).filter(Boolean)),
    ];
    let directItems = [];
    let unfiledItems = [];
    let directError = null;
    try {
      const results = await Promise.all(
        folderIds.map((id) => this.eagle.item.get({ folders: [id], fields }))
      );
      directItems = uniqueItems(
        results.flatMap((result) => (Array.isArray(result) ? result : []))
      );
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
    return collectBatchItems(items, folderIds);
  }

  async saveItem(item) {
    return item.save();
  }
}

module.exports = {
  BATCH_SUFFIX,
  FORMAL_PREVIEW_ROOT_NAME,
  FORMAL_SOURCE_ROOT_NAME,
  HISTORY_ROOT_NAME,
  INGEST_ROOT_NAME,
  PROJECT_TAG_GROUP_COLOR,
  PROJECT_TAG_GROUP_NAME,
  IMPORT_MODES,
  KNOWN_PACKAGE_TYPES,
  EaglePluginAdapter,
  buildAnnotation,
  buildTags,
  mergeFormalTags,
  packageDetailFromItems,
  getFormalLibraryItems,
  collectBatchItems,
  collectDescendantFolderIds,
  ensureFolder,
  ensureProjectTagGroups,
  fileBatch,
  flattenFolderTree,
  folderId,
  findDuplicateBatches,
  importFormalBatch,
  importBatch,
  inferProjectNameFromBatch,
  inspectBatch,
  itemKind,
  itemFileName,
  itemName,
  batchIdentity,
  manifestIdentity,
  normalizeIdentity,
  parseAnnotation,
  planFormalFile,
  replaceIngestTag,
  canonicalPreviewName,
  canonicalSourceName,
  resolveFormalItemName,
  validateFormalItemNames,
};
