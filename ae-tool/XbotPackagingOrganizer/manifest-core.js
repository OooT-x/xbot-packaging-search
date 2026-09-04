(function (root, factory) {
  var api = factory();
  root.XbotManifestCore = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
}(this, function () {
  var PACKAGE_TYPES = ["信息条", "视频框", "背景", "分镜排版", "分Part板", "报道", "时间轴"];

  function text(value) {
    return String(value === null || typeof value === "undefined" ? "" : value);
  }

  function trim(value) {
    return text(value).replace(/^\s+|\s+$/g, "");
  }

  function normalizeText(value) {
    return trim(value)
      .toLowerCase()
      .replace(/[\s_\-—·・/\\]+/g, "");
  }

  function uniqueStrings(values) {
    var result = [];
    var seen = {};
    var i;
    var value;
    var key;
    values = values || [];
    for (i = 0; i < values.length; i += 1) {
      value = trim(values[i]);
      if (!value) continue;
      key = value.toLowerCase();
      if (!seen[key]) {
        seen[key] = true;
        result.push(value);
      }
    }
    return result;
  }

  function arrayContains(values, target) {
    var i;
    for (i = 0; i < values.length; i += 1) {
      if (values[i] === target) return true;
    }
    return false;
  }

  function inferPackageType(value) {
    var normalized = normalizeText(value);
    if (!normalized) return "";
    if (normalized.indexOf("信息条") >= 0 || normalized.indexOf("标注") >= 0 || normalized.indexOf("人名条") >= 0) {
      return "信息条";
    }
    if (normalized.indexOf("视频框") >= 0) return "视频框";
    if (normalized.indexOf("背景") >= 0) return "背景";
    if (normalized.indexOf("分镜排版") >= 0) return "分镜排版";
    if (normalized.indexOf("分part板") >= 0 || normalized.indexOf("分p板") >= 0) return "分Part板";
    if (normalized.indexOf("报道") >= 0) return "报道";
    if (normalized.indexOf("时间轴") >= 0 || normalized.indexOf("时间线") >= 0) return "时间轴";
    return "";
  }

  function normalizeVersion(value) {
    var match = trim(value).match(/^v?(\d+)$/i);
    var digits;
    if (!match) return "";
    digits = match[1];
    while (digits.length < 2) digits = "0" + digits;
    return "v" + digits;
  }

  function sanitizeSegment(value) {
    var result = trim(value)
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
      .replace(/\s+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^[._ ]+|[._ ]+$/g, "");
    return result || "未命名";
  }

  function unsignedHex(value) {
    var hex = (value >>> 0).toString(16);
    while (hex.length < 8) hex = "0" + hex;
    return hex;
  }

  function fnv1a(value, seed) {
    var hash = typeof seed === "number" ? seed : 2166136261;
    var source = text(value);
    var i;
    for (i = 0; i < source.length; i += 1) {
      hash ^= source.charCodeAt(i);
      hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    return hash >>> 0;
  }

  function stablePackageId(projectName, packageName, version, compName) {
    var key = [projectName, packageName, version, compName]
      .join("|")
      .toLowerCase();
    return "pkg-" + unsignedHex(fnv1a(key)) + unsignedHex(fnv1a(key, 2246822507));
  }

  function makeBatchId(nowText, randomValue) {
    var key = text(nowText) + "|" + text(randomValue);
    return "batch-" + unsignedHex(fnv1a(key)).toUpperCase() + unsignedHex(fnv1a(key, 3266489909)).slice(0, 5).toUpperCase();
  }

  function makePackageStem(meta) {
    return [
      sanitizeSegment(meta.projectName),
      sanitizeSegment(meta.packageType),
      sanitizeSegment(meta.packageName),
      normalizeVersion(meta.version) || sanitizeSegment(meta.version)
    ].join("_");
  }

  function normalizeRisk(risk) {
    risk = risk || {};
    return {
      missingFootage: uniqueStrings(risk.missingFootage || []),
      fonts: uniqueStrings(risk.fonts || []),
      effects: uniqueStrings(risk.effects || []),
      thirdPartyEffects: uniqueStrings(risk.thirdPartyEffects || []),
      crossCompExpressions: risk.crossCompExpressions || [],
      scanErrors: uniqueStrings(risk.scanErrors || [])
    };
  }

  function dependencyStatus(risk) {
    var normalized = normalizeRisk(risk);
    if (normalized.missingFootage.length > 0 || normalized.crossCompExpressions.length > 0 || normalized.scanErrors.length > 0) {
      return "阻止入库";
    }
    if (normalized.fonts.length > 0 || normalized.thirdPartyEffects.length > 0) {
      return "警告";
    }
    return "完整";
  }

  function dependencyWarnings(risk) {
    var normalized = normalizeRisk(risk);
    var warnings = [];
    if (normalized.missingFootage.length > 0) warnings.push("存在缺失素材");
    if (normalized.crossCompExpressions.length > 0) warnings.push("存在跨合成表达式引用，禁止无提示精简");
    if (normalized.scanErrors.length > 0) warnings.push("风险扫描未完整执行");
    if (normalized.fonts.length > 0) warnings.push("字体需要在接收环境人工确认");
    if (normalized.thirdPartyEffects.length > 0) warnings.push("第三方效果需要在接收环境人工确认");
    return warnings;
  }

  function validatePackageMeta(meta) {
    var errors = [];
    var version = normalizeVersion(meta.version);
    if (!trim(meta.projectName)) errors.push("缺少项目名称");
    if (!trim(meta.packageName)) errors.push("缺少包装名称");
    if (!arrayContains(PACKAGE_TYPES, trim(meta.packageType))) errors.push("包装类型无效");
    if (!version) errors.push("版本必须是 v01 形式");
    if (!trim(meta.compName)) errors.push("缺少 AE 合成名称");
    if (isNaN(Number(meta.previewTime)) || Number(meta.previewTime) < 0) errors.push("预览时间必须是非负秒数");
    return errors;
  }

  function createPackageEntry(meta, risk, createdAt) {
    var normalizedRisk = normalizeRisk(risk);
    var version = normalizeVersion(meta.version);
    var stem = makePackageStem({
      projectName: meta.projectName,
      packageType: meta.packageType,
      packageName: meta.packageName,
      version: version
    });
    return {
      package_id: meta.packageId || stablePackageId(meta.projectName, meta.packageName, version, meta.compName),
      source_project_name: trim(meta.sourceProjectName),
      project_name: trim(meta.projectName),
      package_name: trim(meta.packageName),
      package_type: trim(meta.packageType),
      version: version,
      ae_comp_name: trim(meta.compName),
      preview_time: Number(meta.previewTime),
      alpha_required: meta.alphaRequired === true,
      preview_file: meta.previewFile || stem + ".png",
      source_file: meta.sourceFile || stem + ".zip",
      report_files: meta.reportFiles || [],
      fonts: normalizedRisk.fonts,
      effects: normalizedRisk.effects,
      third_party_effects: normalizedRisk.thirdPartyEffects,
      missing_footage: normalizedRisk.missingFootage,
      cross_comp_expressions: normalizedRisk.crossCompExpressions,
      dependency_warnings: dependencyWarnings(normalizedRisk),
      dependency_status: dependencyStatus(normalizedRisk),
      requires_manual_review: dependencyStatus(normalizedRisk) !== "完整",
      created_at: createdAt
    };
  }

  function buildManifest(projectName, packages, createdAt, batchId) {
    return {
      manifest_version: 1,
      manifest_type: "xbot-eagle-ingest",
      generator: "X.bot AE 包装整理",
      batch_id: batchId,
      project_name: trim(projectName),
      created_at: createdAt,
      packages: packages
    };
  }

  return {
    PACKAGE_TYPES: PACKAGE_TYPES,
    buildManifest: buildManifest,
    createPackageEntry: createPackageEntry,
    dependencyStatus: dependencyStatus,
    dependencyWarnings: dependencyWarnings,
    inferPackageType: inferPackageType,
    makeBatchId: makeBatchId,
    makePackageStem: makePackageStem,
    normalizeRisk: normalizeRisk,
    normalizeText: normalizeText,
    normalizeVersion: normalizeVersion,
    sanitizeSegment: sanitizeSegment,
    stablePackageId: stablePackageId,
    trim: trim,
    uniqueStrings: uniqueStrings,
    validatePackageMeta: validatePackageMeta
  };
}));
