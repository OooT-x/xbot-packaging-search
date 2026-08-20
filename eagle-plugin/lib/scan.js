const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PACKAGE_TYPES = ["信息条", "视频框", "背景", "分镜排版"];
const PACKAGE_TYPE_SET = new Set(PACKAGE_TYPES);
const MANIFEST_NAME = "manifest.json";
const COLLECTED_ROOT = "Root_Collected_Projects";
const PNG_EXT = ".png";
const ZIP_EXT = ".zip";
const AEP_EXT = ".aep";

const IGNORED_IMAGE_EXTS = new Set([
  ".jpg",
  ".jpeg",
  ".bmp",
  ".gif",
  ".webp",
  ".tiff",
  ".psd",
  ".ai",
  ".svg",
]);
const IGNORED_MEDIA_EXTS = new Set([
  ".mp4",
  ".mov",
  ".avi",
  ".mkv",
  ".wmv",
  ".flv",
  ".webm",
  ".m4v",
  ".mp3",
  ".wav",
  ".aac",
  ".m4a",
]);
const FONT_EXTS = new Set([".ttf", ".otf", ".woff", ".woff2", ".ttc"]);
const REPORT_PATTERNS = [/report/i, /收集报告/i, /dependencies/i, /依赖/i];

function normalizeText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s_\-—·・/\\]+/g, "")
    .trim();
}

function createBatchId() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let id = "";
  const bytes = crypto.randomBytes(13);
  for (const byte of bytes) id += alphabet[byte % alphabet.length];
  return `batch-${id}`;
}

function stableId(prefix, ...parts) {
  const digest = crypto
    .createHash("sha256")
    .update(parts.map(normalizeText).join("|"))
    .digest("hex")
    .slice(0, 16);
  return `${prefix}-${digest}`;
}

function extractVersion(stem) {
  const match = String(stem || "").match(/(?:^|[_\-\s])(v\d+)(?:[_\-\s]|$)/i);
  return match ? match[1].toLowerCase() : null;
}

function stemWithoutVersion(stem) {
  return String(stem || "")
    .replace(/(?:^|[_\-\s])(v\d+)(?:[_\-\s]|$)/i, "$1")
    .replace(/v\d+/i, "");
}

function nameTokens(stem) {
  return String(stem || "")
    .normalize("NFKC")
    .toLowerCase()
    .split(/[_\-\s·・/\\]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function significantTokens(stem) {
  return nameTokens(stem).filter((token) => token.length >= 2);
}

function sameVersion(left, right) {
  if (!left && !right) return true;
  if (!left || !right) return true;
  return left === right;
}

function similarityGrade(pngStem, zipStem) {
  const pngVersion = extractVersion(pngStem);
  const zipVersion = extractVersion(zipStem);
  if (!sameVersion(pngVersion, zipVersion)) return "none";

  const pngCore = normalizeText(stemWithoutVersion(pngStem));
  const zipCore = normalizeText(stemWithoutVersion(zipStem));
  if (!pngCore || !zipCore) return "none";
  if (pngCore === zipCore) return "strong";
  if (pngCore.includes(zipCore) || zipCore.includes(pngCore)) return "medium";

  const pngTokens = new Set(significantTokens(stemWithoutVersion(pngStem)));
  const zipTokens = new Set(significantTokens(stemWithoutVersion(zipStem)));
  let shared = 0;
  for (const token of zipTokens) {
    if (pngTokens.has(token)) shared += 1;
  }
  if (shared >= 2) return "medium";
  return "none";
}

function walkFiles(root) {
  const entries = [];
  const resolvedRoot = path.resolve(root);

  const visit = (dir, relative) => {
    let children;
    try {
      children = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      throw new Error(`无法读取目录 ${dir}: ${error.message}`);
    }
    for (const child of children) {
      const childRelative = relative ? path.join(relative, child.name) : child.name;
      const childPath = path.join(dir, child.name);
      if (child.isDirectory()) {
        if (child.name === ".git") continue;
        visit(childPath, childRelative);
      } else if (child.isFile()) {
        entries.push({
          path: childPath,
          relative: childRelative,
          name: child.name,
          ext: path.extname(child.name).toLowerCase(),
        });
      }
    }
  };

  if (!fs.existsSync(resolvedRoot)) {
    throw new Error(`源文件夹不存在: ${resolvedRoot}`);
  }
  visit(resolvedRoot, "");
  return entries;
}

function isZipCandidate(relative) {
  const depth = relative.split(/[\\/]/).length - 1;
  if (depth === 0) return true;
  if (depth === 1 && relative.split(/[\\/]/)[0] === COLLECTED_ROOT) return true;
  return false;
}

function isReportFile(name) {
  return REPORT_PATTERNS.some((pattern) => pattern.test(name));
}

function classifyFile(entry) {
  const { name, ext } = entry;
  if (ext === PNG_EXT) {
    const depth = entry.relative.split(/[\\/]/).length - 1;
    return depth === 0
      ? { kind: "png", status: "candidate" }
      : {
          kind: "png",
          status: "ignore",
          note: "子目录中的 PNG 视为依赖图或示例截图，不单独入库",
        };
  }
  if (ext === ZIP_EXT) {
    return isZipCandidate(entry.relative)
      ? { kind: "zip", status: "candidate" }
      : {
          kind: "zip",
          status: "ignore",
          note: "深层目录中的 ZIP 不作为源文件候选",
        };
  }
  if (ext === AEP_EXT) {
    return { kind: "aep", status: "validate-only", note: "展开的 AE 工程仅用于校验" };
  }
  if (isReportFile(name)) {
    return { kind: "report", status: "validate-only", note: "AE 收集报告仅用于校验" };
  }
  if (FONT_EXTS.has(ext)) {
    return { kind: "font", status: "ignore", note: "字体文件不单独入库，依赖记录在 manifest/Report" };
  }
  if (IGNORED_MEDIA_EXTS.has(ext)) {
    return { kind: "media", status: "ignore", note: "业务视频/音频不单独入库" };
  }
  if (IGNORED_IMAGE_EXTS.has(ext)) {
    return { kind: "image", status: "ignore", note: "非 PNG 图片不单独入库" };
  }
  return { kind: "other", status: "ignore", note: "与包装入库无关" };
}

function inferProjectName(sourceDir) {
  const base = path.basename(path.resolve(sourceDir));
  const stripped = base.replace(/包装$/u, "");
  return stripped.length > 0 ? stripped : base;
}

function parseManifestEntries(manifestPath) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    return { entries: [], error: `manifest 解析失败: ${error.message}` };
  }

  let rawEntries = [];
  if (Array.isArray(parsed)) {
    rawEntries = parsed;
  } else if (parsed && typeof parsed === "object") {
    rawEntries = Array.isArray(parsed.packages) ? parsed.packages : [parsed];
  }

  const entries = rawEntries
    .filter((entry) => entry && typeof entry === "object")
    .map((entry, index) => ({
      ...entry,
      manifestPath,
      index,
    }));
  return { entries, error: null };
}

function resolveManifestFile(sourceDir, fileName) {
  if (!fileName) return null;
  const target = path.resolve(sourceDir, String(fileName));
  if (!target.startsWith(path.resolve(sourceDir) + path.sep)) return null;
  return target;
}

function findManifests(entries) {
  return entries
    .filter((entry) => path.basename(entry.name).toLowerCase() === MANIFEST_NAME)
    .map((entry) => entry.path);
}

function pairWithoutManifest(files) {
  const pngCandidates = files.filter(
    (file) => file.kind === "png" && file.status === "candidate"
  );
  const zipCandidates = files.filter(
    (file) => file.kind === "zip" && file.status === "candidate"
  );
  const pairs = [];
  const usedPngs = new Set();

  for (const zip of zipCandidates) {
    const zipStem = path.basename(zip.name, path.extname(zip.name));
    const matches = pngCandidates
      .filter((png) => !usedPngs.has(png.path))
      .map((png) => ({
        png,
        grade: similarityGrade(path.basename(png.name, path.extname(png.name)), zipStem),
      }))
      .filter((candidate) => candidate.grade !== "none")
      .sort((left, right) => (left.grade === right.grade ? 0 : left.grade === "strong" ? -1 : 1));

    if (matches.length === 1) {
      const { png } = matches[0];
      usedPngs.add(png.path);
      pairs.push({ png, zip });
    } else {
      pairs.push({
        png: null,
        zip,
        conflict: matches.length > 1 ? "multiple" : "none",
      });
    }
  }

  for (const png of pngCandidates) {
    if (!usedPngs.has(png.path)) {
      pairs.push({ png, zip: null, conflict: "none" });
    }
  }
  return pairs;
}

function metadataFromPair(png, zip, projectName) {
  const pngStem = png ? path.basename(png.name, path.extname(png.name)) : "";
  const zipStem = zip ? path.basename(zip.name, path.extname(zip.name)) : "";
  const stem = zipStem || pngStem;
  const version = extractVersion(stem);
  const combinedStem = `${pngStem} ${zipStem}`;
  const type =
    PACKAGE_TYPES.find((candidate) =>
      normalizeText(combinedStem).includes(normalizeText(candidate))
    ) || null;
  const nameStem = stemWithoutVersion(zipStem || pngStem);
  const tokens = nameTokens(nameStem).filter(
    (token) => !projectName || !normalizeText(projectName).includes(normalizeText(token))
  );
  if (type) {
    const typeIndex = tokens.findIndex(
      (token) => normalizeText(token) === normalizeText(type)
    );
    if (typeIndex >= 0) tokens.splice(typeIndex, 1);
  }
  const packageName = tokens.join("") || (zip ? path.basename(zip.name, path.extname(zip.name)) : path.basename(png.name, path.extname(png.name)));
  return {
    packageId: stableId("pkg", projectName, packageName, version || "unversioned"),
    projectName,
    packageName,
    packageType: type,
    version,
    aeCompName: packageName || null,
  };
}

function scanDirectory(sourceDir, options = {}) {
  const root = path.resolve(sourceDir);
  const allEntries = walkFiles(root);
  const files = allEntries.map((entry) => ({
    path: entry.path,
    relative: entry.relative,
    name: entry.name,
    ext: entry.ext,
    ...classifyFile(entry),
  }));

  const errors = [];
  const warnings = [];
  const manifestPaths = findManifests(allEntries);
  const manifestEntries = [];
  for (const manifestPath of manifestPaths) {
    const { entries, error } = parseManifestEntries(manifestPath);
    if (error) {
      errors.push(error);
      continue;
    }
    manifestEntries.push(...entries);
  }

  const projectName = String(options.projectName || "").trim() || inferProjectName(root);
  const batchId = options.batchId || createBatchId();
  const packages = [];
  const packageIds = new Set();
  const referencedFiles = new Map();
  const hasManifest = manifestEntries.length > 0;

  const registerReference = (fileName, packageId, role, entryPath) => {
    const resolved = resolveManifestFile(root, fileName);
    if (!resolved) {
      errors.push(`manifest 条目 ${packageId} 的 ${role} 路径越界: ${fileName}`);
      return null;
    }
    if (!fs.existsSync(resolved)) {
      errors.push(`manifest 条目 ${packageId} 引用的 ${role} 不存在: ${fileName}`);
      return null;
    }
    const key = path.resolve(resolved);
    if (referencedFiles.has(key)) {
      errors.push(`文件 ${fileName} 被多个 manifest 条目引用，无法唯一配对`);
      return null;
    }
    referencedFiles.set(key, { packageId, role, entryPath });
    return key;
  };

  if (hasManifest) {
    for (const entry of manifestEntries) {
      const packageId = String(entry.package_id || "").trim();
      if (!packageId) {
        errors.push(`${entry.manifestPath} 条目 ${entry.index + 1} 缺少 package_id`);
        continue;
      }
      if (packageIds.has(packageId)) {
        errors.push(`package_id 重复: ${packageId}`);
        continue;
      }
      packageIds.add(packageId);

      const entryProject = String(entry.project_name || "").trim();
      const packageName = String(entry.package_name || "").trim();
      const packageType = String(entry.package_type || "").trim();
      const version = String(entry.version || "").trim() || null;
      const entryWarnings = [];
      if (!packageName) entryWarnings.push("缺少包装名称");
      if (!packageType) entryWarnings.push("缺少包装类型，确认时可补充");
      if (packageType && !PACKAGE_TYPE_SET.has(packageType)) {
        errors.push(`package_id ${packageId} 的包装类型无效: ${packageType}`);
        continue;
      }
      if (!version) entryWarnings.push("缺少版本，确认时默认登记为 v01");

      const previewPath = registerReference(entry.preview_file, packageId, "预览图", entry.manifestPath);
      const sourcePath = registerReference(entry.source_file, packageId, "源文件", entry.manifestPath);
      if (!previewPath || !sourcePath) {
        packages.push({
          packageId,
          projectName: entryProject || projectName,
          packageName,
          packageType,
          version,
          aeCompName: String(entry.ae_comp_name || "").trim() || null,
          preview: null,
          source: null,
          state: "blocked",
          warnings: entryWarnings,
          errors: ["预览图或源文件无法配对"],
          manifestPath: entry.manifestPath,
        });
        continue;
      }

      const dependencyStatus = String(entry.dependency_status || "").trim();
      if (/阻止|blocked/i.test(dependencyStatus)) {
        packages.push({
          packageId,
          projectName: entryProject || projectName,
          packageName,
          packageType,
          version,
          aeCompName: String(entry.ae_comp_name || "").trim() || null,
          preview: { path: previewPath, relative: path.relative(root, previewPath) },
          source: { path: sourcePath, relative: path.relative(root, sourcePath) },
          state: "blocked",
          warnings: [...entryWarnings, "manifest 标记为阻止入库"],
          errors: [],
          manifestPath: entry.manifestPath,
        });
        continue;
      }

      packages.push({
        packageId,
        projectName: entryProject || projectName,
        packageName,
        packageType,
        version,
        aeCompName: String(entry.ae_comp_name || "").trim() || null,
        preview: { path: previewPath, relative: path.relative(root, previewPath) },
        source: { path: sourcePath, relative: path.relative(root, sourcePath) },
        state: "ready",
        warnings: entryWarnings,
        errors: [],
        manifestPath: entry.manifestPath,
        fonts: normalizeDependencyList(entry.fonts),
        effects: normalizeDependencyList(entry.effects),
        dependencyStatus: /警告|warning/i.test(dependencyStatus) ? "warning" : "complete",
      });
    }
  } else {
    for (const pair of pairWithoutManifest(files)) {
      const { png, zip, conflict } = pair;
      if (png && zip) {
        const metadata = metadataFromPair(png, zip, projectName);
        packages.push({
          ...metadata,
          preview: { path: png.path, relative: png.relative },
          source: { path: zip.path, relative: zip.relative },
          state: "ready",
          warnings: [
            ...(metadata.version ? [] : ["缺少版本，确认时默认登记为 v01"]),
            ...(metadata.packageType ? [] : ["缺少包装类型，确认时可补充"]),
            ...(metadata.aeCompName ? [] : ["缺少 AE 合成名称，确认时可补充"]),
          ],
          errors: [],
          manifestPath: null,
          fonts: [],
          effects: [],
          dependencyStatus: "complete",
        });
      } else {
        const file = png || zip;
        packages.push({
          packageId: stableId("pkg", projectName, path.basename(file.name, path.extname(file.name))),
          projectName,
          packageName: null,
          packageType: null,
          version: extractVersion(path.basename(file.name, path.extname(file.name))),
          aeCompName: null,
          preview: png ? { path: png.path, relative: png.relative } : null,
          source: zip ? { path: zip.path, relative: zip.relative } : null,
          state: "blocked",
          warnings: [],
          errors: [conflict === "multiple" ? "无法唯一配对，多张预览对应同一源文件" : "缺少唯一配对的预览图或源文件"],
          manifestPath: null,
          fonts: [],
          effects: [],
          dependencyStatus: "complete",
        });
      }
    }
  }

  const referencedPaths = new Set(referencedFiles.keys());
  const fileRecords = files.map((file) => {
    const record = {
      path: file.path,
      relative: file.relative,
      name: file.name,
      kind: file.kind,
      status: "ignore",
      note: file.note || "",
      packageId: null,
    };
    if (referencedPaths.has(path.resolve(file.path))) {
      const reference = referencedFiles.get(path.resolve(file.path));
      record.packageId = reference.packageId;
      record.status = "to-import";
      record.note = "";
      return record;
    }
    if (hasManifest && (file.kind === "png" || file.kind === "zip")) {
      record.status = "ignore";
      record.note = "存在 manifest 时仅导入 manifest 明确引用的文件";
      return record;
    }
    if (file.kind === "png" || file.kind === "zip") {
      const packageEntry = packages.find((pkg) => {
        const previewMatch = pkg.preview && path.resolve(pkg.preview.path) === path.resolve(file.path);
        const sourceMatch = pkg.source && path.resolve(pkg.source.path) === path.resolve(file.path);
        return previewMatch || sourceMatch;
      });
      if (packageEntry && packageEntry.state === "ready") {
        record.status = "to-import";
        record.packageId = packageEntry.packageId;
      } else {
        record.status = "conflict";
        record.packageId = packageEntry ? packageEntry.packageId : null;
        record.note = packageEntry ? packageEntry.errors.join("；") : "无法唯一配对";
      }
    } else {
      record.status = file.status;
      record.note = file.note || record.note;
    }
    return record;
  });

  const batchKey = stableBatchKey(files);
  const stats = {
    toImport: fileRecords.filter((file) => file.status === "to-import").length,
    validateOnly: fileRecords.filter((file) => file.status === "validate-only").length,
    ignore: fileRecords.filter((file) => file.status === "ignore").length,
    conflict: fileRecords.filter((file) => file.status === "conflict").length,
  };

  return {
    sourceDir: root,
    projectName,
    batchId,
    batchKey,
    hasManifest,
    manifestFiles: manifestPaths,
    packages,
    files: fileRecords,
    stats,
    errors,
    warnings,
  };
}

function normalizeDependencyList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || "").trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(/[,，;；\n]+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function stableBatchKey(files) {
  const hash = crypto.createHash("sha256");
  for (const file of [...files]
    .sort((left, right) => left.relative.localeCompare(right.relative))
  ) {
    let size = 0;
    try {
      size = fs.statSync(file.path).size;
    } catch {
      size = 0;
    }
    hash.update(`${file.relative}:${size}\n`);
  }
  return hash.digest("hex").slice(0, 20);
}

module.exports = {
  COLLECTED_ROOT,
  MANIFEST_NAME,
  PACKAGE_TYPES,
  classifyFile,
  createBatchId,
  extractVersion,
  inferProjectName,
  metadataFromPair,
  normalizeDependencyList,
  normalizeText,
  pairWithoutManifest,
  parseManifestEntries,
  scanDirectory,
  similarityGrade,
  stableId,
  stemWithoutVersion,
  stableBatchKey,
  walkFiles,
};
