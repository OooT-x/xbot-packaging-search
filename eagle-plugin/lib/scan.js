const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { parseReportFile } = require("./report");

const PACKAGE_TYPES = ["信息条", "视频框", "背景", "分镜排版"];
const PACKAGE_TYPE_SET = new Set(PACKAGE_TYPES);
const PACKAGE_TYPE_KEYWORDS = new Map([
  ["信息条", ["信息条", "标注", "人名条"]],
  ["视频框", ["视频框", "横屏框", "竖屏框"]],
  ["背景", ["背景"]],
  ["分镜排版", ["分镜排版"]],
]);
const MANIFEST_NAME = "manifest.json";
const COLLECTION_MANIFEST_TYPE = "xbot-collection";
const INGEST_MANIFEST_TYPE = "xbot-eagle-ingest";
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

function inferPackageType(value) {
  const normalized = normalizeText(value);
  if (!normalized) return null;
  for (const type of PACKAGE_TYPES) {
    const keywords = PACKAGE_TYPE_KEYWORDS.get(type) || [type];
    if (keywords.some((keyword) => normalized.includes(normalizeText(keyword)))) {
      return type;
    }
  }
  return null;
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

function collectionPreviewCore(value) {
  return normalizeText(stemWithoutVersion(value))
    .replace(/角括号/g, "尖括号")
    .replace(/横向/g, "横屏")
    .replace(/竖向/g, "竖屏")
    .replace(/人物条|姓名条/g, "人名条");
}

function collectionPreviewScore(compName, pngName) {
  const pngStem = path.basename(String(pngName || ""), path.extname(String(pngName || "")));
  const compCore = collectionPreviewCore(compName);
  const pngCore = collectionPreviewCore(pngStem);
  if (!compCore || !pngCore) return 0;
  if (compCore === pngCore) return 100;

  const compactComp = compCore.replace(/视频框/g, "框");
  const compactPng = pngCore.replace(/视频框/g, "框");
  if (compactComp === compactPng) return 90;
  if (
    Math.min(compCore.length, pngCore.length) >= 2 &&
    (compCore.includes(pngCore) || pngCore.includes(compCore))
  ) {
    return 70;
  }
  return 0;
}

function matchCollectionPreviews(collectionEntries, pngCandidates) {
  const remainingEntries = new Set(collectionEntries.map((_, index) => index));
  const remainingPngs = new Set(pngCandidates.map((png) => png.path));
  const matches = new Map();
  let progress = true;

  while (progress) {
    progress = false;
    const proposals = [];
    for (const entryIndex of remainingEntries) {
      const entry = collectionEntries[entryIndex];
      const compName = String(entry.composition && entry.composition.name || "").trim();
      const scored = pngCandidates
        .filter((png) => remainingPngs.has(png.path))
        .map((png) => ({ png, score: collectionPreviewScore(compName, png.name) }))
        .filter((candidate) => candidate.score > 0);
      const bestScore = scored.reduce((best, candidate) => Math.max(best, candidate.score), 0);
      const best = scored.filter((candidate) => candidate.score === bestScore);
      if (best.length === 1) {
        proposals.push({ entryIndex, png: best[0].png, score: best[0].score });
      }
    }

    proposals.sort((left, right) => right.score - left.score);
    for (const proposal of proposals) {
      if (!remainingEntries.has(proposal.entryIndex) || !remainingPngs.has(proposal.png.path)) {
        continue;
      }
      const competingScore = [...remainingEntries]
        .filter((entryIndex) => entryIndex !== proposal.entryIndex)
        .reduce((best, entryIndex) => {
          const entry = collectionEntries[entryIndex];
          const compName = String(entry.composition && entry.composition.name || "").trim();
          return Math.max(best, collectionPreviewScore(compName, proposal.png.name));
        }, 0);
      if (competingScore >= proposal.score) continue;

      matches.set(proposal.entryIndex, proposal.png);
      remainingEntries.delete(proposal.entryIndex);
      remainingPngs.delete(proposal.png.path);
      progress = true;
    }
  }
  return matches;
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

  const manifestType = String(parsed && parsed.manifest_type || "").trim();
  const isCollectionManifest = Boolean(
    parsed &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    (
      manifestType === COLLECTION_MANIFEST_TYPE ||
      (parsed.collector_mode === "offline-py-aep" && parsed.composition && parsed.source_file)
    )
  );
  if (isCollectionManifest) {
    return {
      entries: [],
      collectionEntries: [{ ...parsed, manifestPath, index: 0 }],
      error: null,
    };
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
  return { entries, collectionEntries: [], error: null };
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

function uniqueDependencyValues(...values) {
  const result = [];
  const seen = new Set();
  for (const value of values.flatMap((item) => normalizeDependencyList(item))) {
    const key = value.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function reportReferencePaths(pkg, root, reports) {
  const references = normalizeDependencyList(pkg.reportReferences);
  if (!references.length) return [];
  const packageRoot = path.resolve(root);
  const manifestDir = pkg.manifestPath ? path.dirname(path.resolve(pkg.manifestPath)) : packageRoot;
  return references
    .map((reference) => {
      const candidates = [
        path.resolve(manifestDir, reference),
        path.resolve(packageRoot, reference),
      ];
      return candidates.find((candidate) => {
        const resolved = path.resolve(candidate);
        return resolved === packageRoot || resolved.startsWith(`${packageRoot}${path.sep}`);
      });
    })
    .filter(Boolean)
    .map((candidate) => path.resolve(candidate))
    .filter((candidate) => reports.some((report) => path.resolve(report.path) === candidate));
}

function reportCandidatesForPackage(pkg, root, reports) {
  if (!reports.length) return [];

  const explicitPaths = new Set(reportReferencePaths(pkg, root, reports));
  if (explicitPaths.size > 0) {
    return reports.filter((report) => explicitPaths.has(path.resolve(report.path)));
  }

  const packageDirectories = [pkg.preview?.path, pkg.source?.path, pkg.manifestPath]
    .filter(Boolean)
    .map((value) => path.dirname(path.resolve(value)));
  const exact = reports.filter((report) => packageDirectories.includes(path.dirname(path.resolve(report.path))));
  if (exact.length > 0) return exact;

  const rootPath = path.resolve(root);
  const packageHints = [
    pkg.packageName,
    pkg.aeCompName,
    pkg.preview && path.basename(pkg.preview.path, path.extname(pkg.preview.path)),
    pkg.source && path.basename(pkg.source.path, path.extname(pkg.source.path)),
  ]
    .map((value) => normalizeText(value))
    .filter(Boolean);
  const ranked = reports
    .map((report) => {
      const reportDirectory = path.dirname(path.resolve(report.path));
      let best = 0;
      for (const packageDirectory of packageDirectories) {
        const reportRelativeToPackage = path.relative(packageDirectory, reportDirectory);
        const packageRelativeToReport = path.relative(reportDirectory, packageDirectory);
        if (!reportRelativeToPackage.startsWith(`..${path.sep}`) && reportRelativeToPackage !== ".." && !path.isAbsolute(reportRelativeToPackage)) {
          const distance = reportRelativeToPackage ? reportRelativeToPackage.split(path.sep).length : 0;
          best = Math.max(best, 80 - distance);
        }
        if (!packageRelativeToReport.startsWith(`..${path.sep}`) && packageRelativeToReport !== ".." && !path.isAbsolute(packageRelativeToReport)) {
          const distance = packageRelativeToReport ? packageRelativeToReport.split(path.sep).length : 0;
          best = Math.max(best, 70 - distance);
        }
      }
      const reportHint = normalizeText(`${path.basename(reportDirectory)} ${report.name}`);
      if (packageHints.some((hint) => reportHint.includes(hint))) best += 20;
      if (!(reportDirectory === rootPath || reportDirectory.startsWith(`${rootPath}${path.sep}`))) best = 0;
      return { report, score: best };
    })
    .filter((item) => item.score > 0);
  const bestScore = ranked.reduce((best, item) => Math.max(best, item.score), 0);
  return ranked.filter((item) => item.score === bestScore).map((item) => item.report);
}

function reportFactsForPackage(pkg, reports) {
  const facts = {
    reportFiles: reports.map((report) => report.relative || report.name),
    reportStatus: reports.length === 0
      ? "absent"
      : reports.every((report) => report.status === "parsed")
        ? "parsed"
        : reports.some((report) => report.status === "error")
          ? "error"
          : "unrecognized",
    reportCompositions: uniqueDependencyValues(...reports.map((report) => report.compositions)),
    reportCollectedFiles: uniqueDependencyValues(...reports.map((report) => report.files)),
    missingFootage: uniqueDependencyValues(pkg.missingFootage, ...reports.map((report) => report.missingFootage)),
    fonts: uniqueDependencyValues(pkg.fonts, ...reports.map((report) => report.fonts)),
    effects: uniqueDependencyValues(pkg.effects, ...reports.map((report) => report.effects)),
    reportDetails: reports.map((report) => ({
      path: report.path,
      relative: report.relative || report.name,
      name: report.name,
      encoding: report.encoding,
      status: report.status,
      recognizedSectionCount: report.recognizedSectionCount,
      project: report.project,
      compositions: report.compositions,
      files: report.files,
      missingFootage: report.missingFootage,
      fonts: report.fonts,
      effects: report.effects,
      error: report.error,
    })),
  };
  return facts;
}

function applyReportFacts(pkg, reports) {
  const facts = reportFactsForPackage(pkg, reports);
  Object.assign(pkg, facts);
  if (!pkg.aeCompName && facts.reportCompositions.length > 0) {
    pkg.aeCompName = facts.reportCompositions[0];
  }
  if (!pkg.packageType) {
    pkg.packageType = inferPackageType(`${pkg.packageName || ""} ${facts.reportCompositions.join(" ")}`);
  }

  const reportWarnings = [];
  for (const report of reports) {
    if (report.status === "error") {
      reportWarnings.push(`AE Report 解析失败：${report.relative || report.name}${report.error ? `（${report.error}）` : ""}`);
    } else if (report.status === "unrecognized") {
      reportWarnings.push(`AE Report 未识别到标准依赖章节：${report.relative || report.name}`);
    }
  }
  if (facts.missingFootage.length > 0) {
    reportWarnings.push(`Report 检出缺失素材，阻止入库：${facts.missingFootage.join("、")}`);
    pkg.state = "blocked";
    pkg.errors = [...(pkg.errors || []), "Report 检出缺失素材，不能确认依赖完整性"];
    pkg.dependencyStatus = "blocked";
  } else if (facts.fonts.length > 0 || facts.effects.length > 0 || reportWarnings.length > 0) {
    pkg.dependencyStatus = "warning";
  }
  if (facts.fonts.length > 0) {
    reportWarnings.push(`Report 检出字体依赖：${facts.fonts.join("、")}`);
  }
  if (facts.effects.length > 0) {
    reportWarnings.push(`Report 检出效果或插件依赖：${facts.effects.join("、")}`);
  }
  pkg.warnings = uniqueDependencyValues(pkg.warnings, reportWarnings);
  return pkg;
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
  const type = inferPackageType(combinedStem);
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
  const reportSummaries = files
    .filter((file) => file.kind === "report")
    .map((file) => ({
      ...parseReportFile(file.path),
      relative: file.relative,
      name: file.name,
    }));
  reportSummaries.forEach((report) => {
    if (report.status === "error") {
      warnings.push(`AE Report 解析失败：${report.relative}${report.error ? `（${report.error}）` : ""}`);
    } else if (report.status === "unrecognized") {
      warnings.push(`AE Report 未识别到标准依赖章节：${report.relative}`);
    }
  });
  const manifestEntries = [];
  const collectionEntries = [];
  for (const manifestPath of manifestPaths) {
    const { entries, collectionEntries: parsedCollectionEntries = [], error } = parseManifestEntries(manifestPath);
    if (error) {
      errors.push(error);
      continue;
    }
    manifestEntries.push(...entries);
    collectionEntries.push(...parsedCollectionEntries);
  }

  const projectName = String(options.projectName || "").trim() || inferProjectName(root);
  const batchId = options.batchId || createBatchId();
  const packages = [];
  const packageIds = new Set();
  const referencedFiles = new Map();
  const hasManifest = manifestEntries.length > 0;
  const hasCollectionManifest = collectionEntries.length > 0;

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
      const rawPackageType = String(entry.package_type || "").trim();
      const packageType = inferPackageType(rawPackageType) || rawPackageType;
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
          reportReferences: normalizeDependencyList(entry.report_files),
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
          reportReferences: normalizeDependencyList(entry.report_files),
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
        reportReferences: normalizeDependencyList(entry.report_files),
        fonts: normalizeDependencyList(entry.fonts),
        effects: normalizeDependencyList(entry.effects),
        dependencyStatus: /警告|warning/i.test(dependencyStatus) ? "warning" : "complete",
      });
    }
  } else if (hasCollectionManifest) {
    const pngCandidates = files.filter(
      (file) => file.kind === "png" && file.status === "candidate"
    );
    const previewMatches = new Map();
    const explicitlyUsedPngs = new Set();
    collectionEntries.forEach((entry, entryIndex) => {
      const previewName = String(entry.preview_file || "").trim();
      if (!previewName) return;
      const previewPath = resolveManifestFile(root, previewName);
      const previewFile = previewPath
        ? pngCandidates.find((candidate) => path.resolve(candidate.path) === path.resolve(previewPath))
        : null;
      if (!previewFile || explicitlyUsedPngs.has(path.resolve(previewFile.path))) return;
      explicitlyUsedPngs.add(path.resolve(previewFile.path));
      previewMatches.set(entryIndex, previewFile);
    });
    const fallbackEntries = collectionEntries
      .map((entry, entryIndex) => ({ entry, entryIndex }))
      .filter(({ entryIndex }) => !previewMatches.has(entryIndex));
    const fallbackCandidates = pngCandidates.filter(
      (candidate) => !explicitlyUsedPngs.has(path.resolve(candidate.path))
    );
    const fallbackMatches = matchCollectionPreviews(
      fallbackEntries.map(({ entry }) => entry),
      fallbackCandidates
    );
    fallbackEntries.forEach(({ entryIndex }, fallbackIndex) => {
      const previewFile = fallbackMatches.get(fallbackIndex);
      if (previewFile) previewMatches.set(entryIndex, previewFile);
    });
    const usedSourcePaths = new Set();

    collectionEntries.forEach((entry, entryIndex) => {
      const compName = String(entry.composition && entry.composition.name || "").trim();
      const sourceName = String(entry.source_file || "").trim();
      const sourcePath = resolveManifestFile(root, sourceName);
      const previewFile = previewMatches.get(entryIndex) || null;
      const version = extractVersion(path.basename(sourceName, path.extname(sourceName)));
      const packageName = compName || path.basename(sourceName, path.extname(sourceName));
      const packageId = stableId(
        "pkg",
        projectName,
        packageName,
        version || "unversioned",
        entry.composition && entry.composition.id || sourceName
      );
      const entryWarnings = [
        ...(version ? [] : ["缺少版本，确认时默认登记为 v01"]),
        ...(inferPackageType(packageName) ? [] : ["缺少包装类型，确认时可补充"]),
        ...normalizeDependencyList(entry.warnings),
      ];
      const entryErrors = [];

      if (!sourcePath || !fs.existsSync(sourcePath) || path.extname(sourcePath).toLowerCase() !== ZIP_EXT) {
        entryErrors.push(`收集记录引用的 ZIP 不存在：${sourceName || "未填写"}`);
      } else if (usedSourcePaths.has(path.resolve(sourcePath))) {
        entryErrors.push(`ZIP 被多个收集记录引用：${sourceName}`);
      } else {
        usedSourcePaths.add(path.resolve(sourcePath));
      }
      if (!previewFile) {
        const explicitPreviewName = String(entry.preview_file || "").trim();
        if (explicitPreviewName) {
          entryErrors.push(`收集记录引用的根目录 PNG 不存在或被重复引用：${explicitPreviewName}`);
        } else {
          const possiblePreviews = pngCandidates.filter(
            (png) => collectionPreviewScore(compName, png.name) > 0
          );
          entryErrors.push(
            possiblePreviews.length > 0
              ? `预览图无法唯一配对：${possiblePreviews.map((png) => png.name).join("、")}`
              : `缺少与合成“${compName || packageName}”匹配的根目录 PNG`
          );
        }
      }

      const dependencyStatus = String(entry.dependency_status || "").trim();
      const blockedByDependency = /阻止|blocked/i.test(dependencyStatus);
      if (blockedByDependency) entryWarnings.push("收集记录标记为阻止入库");
      const state = entryErrors.length === 0 && !blockedByDependency ? "ready" : "blocked";
      const preview = previewFile
        ? { path: previewFile.path, relative: previewFile.relative }
        : null;
      const source = sourcePath && fs.existsSync(sourcePath)
        ? { path: sourcePath, relative: path.relative(root, sourcePath) }
        : null;

      packages.push({
        packageId,
        projectName,
        packageName,
        packageType: inferPackageType(packageName),
        version,
        aeCompName: compName || null,
        preview,
        source,
        state,
        warnings: entryWarnings,
        errors: entryErrors,
        manifestPath: entry.manifestPath,
        reportReferences: normalizeDependencyList(entry.report_files),
        fonts: normalizeDependencyList(entry.fonts),
        effects: normalizeDependencyList(entry.effects),
        dependencyStatus: /警告|warning/i.test(dependencyStatus) ? "warning" : "complete",
      });

      if (state === "ready") {
        referencedFiles.set(path.resolve(preview.path), {
          packageId,
          role: "预览图",
          entryPath: entry.manifestPath,
        });
        referencedFiles.set(path.resolve(source.path), {
          packageId,
          role: "源文件",
          entryPath: entry.manifestPath,
        });
      }
    });
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

  for (const pkg of packages) {
    applyReportFacts(pkg, reportCandidatesForPackage(pkg, root, reportSummaries));
  }

  const referencedPaths = new Set(referencedFiles.keys());
  const manifestPathSet = new Set(manifestPaths.map((manifestPath) => path.resolve(manifestPath)));
  const collectionManifestPathSet = new Set(
    collectionEntries.map((entry) => path.resolve(entry.manifestPath))
  );
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
    if (file.kind === "report") {
      const report = reportSummaries.find((item) => path.resolve(item.path) === path.resolve(file.path));
      record.status = "validate-only";
      record.note = report?.status === "parsed"
        ? `AE 收集报告已解析（${report.recognizedSectionCount} 个章节）`
        : report?.status === "error"
          ? `AE 收集报告解析失败：${report.error || "无法读取"}`
          : "AE 收集报告未识别到标准依赖章节";
      return record;
    }
    if (manifestPathSet.has(path.resolve(file.path))) {
      record.status = "validate-only";
      record.note = collectionManifestPathSet.has(path.resolve(file.path))
        ? "AEP 收集记录，仅用于合成、ZIP 和依赖校验"
        : "正式入库 manifest，仅用于配对和元数据校验";
      return record;
    }
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
    if (file.status === "candidate" && (file.kind === "png" || file.kind === "zip")) {
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
    hasCollectionManifest,
    manifestFiles: manifestPaths,
    reports: reportSummaries,
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
  COLLECTION_MANIFEST_TYPE,
  INGEST_MANIFEST_TYPE,
  MANIFEST_NAME,
  PACKAGE_TYPES,
  classifyFile,
  collectionPreviewScore,
  createBatchId,
  extractVersion,
  inferProjectName,
  inferPackageType,
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
