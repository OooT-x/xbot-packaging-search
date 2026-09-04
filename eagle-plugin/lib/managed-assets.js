const path = require("path");
const {
  FORMAL_PREVIEW_ROOT_NAME,
  FORMAL_SOURCE_ROOT_NAME,
  HISTORY_ROOT_NAME,
  buildAnnotation,
  buildTags,
  ensureFolder,
  getFormalLibraryItems,
  mergeFormalTags,
  packageDetailFromItems,
  parseAnnotation,
  resolveFormalItemName,
  folderId,
} = require("./eagle-api");

const DISABLED_STATUS = /^(?:已取代|已归档|停用)/u;

function enabledAsset(item) {
  const status = parseAnnotation(item?.annotation)["状态"] || "";
  return !DISABLED_STATUS.test(String(status).trim());
}

function metadataFromEntry(entry) {
  const meta = entry?.meta || {};
  return {
    packageId: entry.packageId,
    projectName: meta["项目"] || "未命名项目",
    sourceProjectName: meta["原 AE 项目"] || meta["项目"] || "未命名项目",
    packageName: meta["包装名称"] || "未命名包装",
    packageType: meta["包装类型"] || "",
    version: meta["版本"] || "v01",
    aeCompName: meta["AE 合成"] || meta["包装名称"] || "",
    batchId: meta.batch_id || "",
    basePackageId: meta.base_package_id || "",
    dependencyStatus: /警告/u.test(meta["状态"] || "") ? "warning" : "complete",
    fonts: meta["字体"] ? String(meta["字体"]).split(/[、,，]/u).filter(Boolean) : [],
    effects: meta["效果"] ? String(meta["效果"]).split(/[、,，]/u).filter(Boolean) : [],
  };
}

function formalPackageRecords(items) {
  const grouped = packageDetailFromItems((items || []).filter(enabledAsset));
  return [...grouped.values()]
    .filter((entry) => entry.preview || entry.source)
    .map((entry) => ({
      ...metadataFromEntry(entry),
      meta: entry.meta,
      preview: entry.preview,
      source: entry.source,
      complete: Boolean(entry.preview && entry.source),
    }))
    .sort((left, right) =>
      `${left.projectName}\u0000${left.packageType}\u0000${left.packageName}`
        .localeCompare(`${right.projectName}\u0000${right.packageType}\u0000${right.packageName}`, "zh-CN")
    );
}

async function listFormalPackages(adapter) {
  const library = await getFormalLibraryItems(adapter);
  const hydratedItems = await Promise.all((library.items || []).map(async (item) => {
    if (typeof adapter.getItem !== "function") return item;
    return (await adapter.getItem(item.id)) || item;
  }));
  return {
    ...library,
    items: hydratedItems,
    packages: formalPackageRecords(hydratedItems),
  };
}

function managedTags(existingTags, metadata, rootName) {
  const filtered = (existingTags || []).filter(
    (tag) => ![FORMAL_PREVIEW_ROOT_NAME, FORMAL_SOURCE_ROOT_NAME, HISTORY_ROOT_NAME, "00_待入库"].includes(tag)
  );
  return [...new Set([...filtered, ...buildTags(metadata).filter((tag) => tag !== "00_待入库"), rootName])];
}

function replacementRevisionId(record, kind) {
  return `rev-${kind}-${Date.now().toString(36)}`;
}

async function formalFolders(adapter, packageType) {
  const previewRoot = await ensureFolder(adapter, FORMAL_PREVIEW_ROOT_NAME, null);
  const sourceRoot = await ensureFolder(adapter, FORMAL_SOURCE_ROOT_NAME, null);
  const previewFolder = await ensureFolder(adapter, packageType, folderId(previewRoot));
  const sourceFolder = await ensureFolder(adapter, packageType, folderId(sourceRoot));
  return { previewFolder, sourceFolder };
}

async function replaceFormalAsset(adapter, record, kind, filePath, options = {}) {
  if (!record?.packageId) throw new Error("缺少 package_id，无法更新包装");
  if (!record.packageType) throw new Error("缺少包装类型，无法更新包装");
  if (!["preview", "source"].includes(kind)) throw new Error("只能更新预览图或源文件 ZIP");
  const resolvedPath = path.resolve(String(filePath || ""));
  const expectedExt = kind === "preview" ? ".png" : ".zip";
  if (path.extname(resolvedPath).toLocaleLowerCase() !== expectedExt) {
    throw new Error(`更新${kind === "preview" ? "预览图" : "源文件"}必须选择 ${expectedExt} 文件`);
  }
  const current = record[kind];
  if (!current) throw new Error(`当前包装缺少${kind === "preview" ? "预览图" : "源文件 ZIP"}`);

  const metadata = metadataFromEntry(record);
  const revisionId = options.revisionId || replacementRevisionId(record, kind);
  const folders = await formalFolders(adapter, record.packageType);
  const targetFolder = kind === "preview" ? folders.previewFolder : folders.sourceFolder;
  const currentPreviewId = kind === "preview" ? "__replacement__" : record.preview?.id;
  const currentSourceId = kind === "source" ? "__replacement__" : record.source?.id;
  const replacementId = await adapter.addFromPath(resolvedPath, {
    name: resolveFormalItemName(metadata, kind, options),
    tags: managedTags(current.tags, metadata, kind === "preview" ? FORMAL_PREVIEW_ROOT_NAME : FORMAL_SOURCE_ROOT_NAME),
    folders: [folderId(targetFolder)],
    annotation: buildAnnotation(metadata, {
      previewItemId: currentPreviewId,
      sourceItemId: currentSourceId,
    }, { revisionId }),
  });
  const replacement = await adapter.getItem(replacementId);
  if (!replacement) throw new Error("Eagle 未返回新素材记录");

  const previewId = kind === "preview" ? replacement.id : record.preview?.id;
  const sourceId = kind === "source" ? replacement.id : record.source?.id;
  const pair = { previewItemId: previewId, sourceItemId: sourceId };
  replacement.name = resolveFormalItemName(metadata, kind, options);
  replacement.annotation = buildAnnotation(metadata, pair, { revisionId });
  replacement.folders = [folderId(targetFolder)];
  replacement.tags = managedTags(current.tags, metadata, kind === "preview" ? FORMAL_PREVIEW_ROOT_NAME : FORMAL_SOURCE_ROOT_NAME);
  await adapter.saveItem(replacement);

  const counterpart = kind === "preview" ? record.source : record.preview;
  if (counterpart) {
    counterpart.annotation = buildAnnotation(metadata, pair, { revisionId });
    counterpart.tags = managedTags(counterpart.tags, metadata, kind === "preview" ? FORMAL_SOURCE_ROOT_NAME : FORMAL_PREVIEW_ROOT_NAME);
    await adapter.saveItem(counterpart);
  }

  const historyRoot = await ensureFolder(adapter, HISTORY_ROOT_NAME, null);
  const historyFolder = await ensureFolder(adapter, record.packageType, folderId(historyRoot));
  current.annotation = buildAnnotation(metadata, {
    previewItemId: record.preview?.id,
    sourceItemId: record.source?.id,
  }, { status: "已取代", revisionId, replacedBy: replacement.id });
  current.folders = [folderId(historyFolder)];
  current.tags = managedTags(current.tags, metadata, HISTORY_ROOT_NAME);
  await adapter.saveItem(current);

  return {
    packageId: metadata.packageId,
    projectName: metadata.projectName,
    packageName: metadata.packageName,
    packageType: metadata.packageType,
    version: metadata.version,
    aeCompName: metadata.aeCompName,
    batchId: metadata.batchId,
    dependencyStatus: metadata.dependencyStatus,
    previewItemId: previewId,
    sourceItemId: sourceId,
    previewPath: kind === "preview" ? resolvedPath : (record.preview?.filePath || record.preview?.filepath || ""),
    sourcePath: kind === "source" ? resolvedPath : (record.source?.filePath || record.source?.filepath || ""),
    replacedItemId: current.id,
    replacedKind: kind,
    revisionId,
    status: "updated",
  };
}

module.exports = {
  DISABLED_STATUS,
  enabledAsset,
  formalPackageRecords,
  listFormalPackages,
  managedTags,
  replaceFormalAsset,
  replacementRevisionId,
};
