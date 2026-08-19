const { normalizeText } = require("./eagle-sync");

const TYPE_SYNONYMS = new Map([
  ["信息条", ["信息条", "人名条", "人物条", "姓名条", "标注条", "小标注", "标注"]],
  ["视频框", ["视频框", "画面框", "横框", "竖框", "框"]],
  ["背景", ["背景", "主背景", "过渡背景", "章节背景"]],
  ["分镜排版", ["分镜排版", "多画面", "双屏", "三屏", "对比排版", "时间线", "排版"]],
]);

const ACTION_WORDS =
  /(找|查|搜|搜索|检索|看看|来个|发个|发一下|要|需要|想要|有没有|帮忙|帮|给我|想看)/;
const DOMAIN_WORDS =
  /(包装|信息条|人名条|人物条|姓名条|标注条|标注|视频框|画面框|横框|竖框|框|背景|分镜|排版|素材|模板)/;

function hasPackagingAction(content) {
  return ACTION_WORDS.test(normalizeText(content));
}

function hasPackagingDomain(content) {
  return DOMAIN_WORDS.test(normalizeText(content));
}

function isPackagingQueryText(content) {
  return hasPackagingAction(content) || hasPackagingDomain(content);
}

function extractPackageType(content) {
  const text = normalizeText(content);
  for (const [type, synonyms] of TYPE_SYNONYMS) {
    if (synonyms.some((synonym) => text.includes(normalizeText(synonym)))) return type;
  }
  return null;
}

function findProject(packages, content) {
  const text = normalizeText(content);
  const candidates = new Map();
  for (const item of packages) {
    if (!candidates.has(item.project_id)) {
      candidates.set(item.project_id, {
        project_id: item.project_id,
        project_name: item.project_name,
        normalized_name: item.normalized_name || normalizeText(item.project_name),
        aliases: item.aliases || [],
      });
    }
  }

  let best = null;
  for (const project of candidates.values()) {
    const names = [project.project_name, ...(project.aliases || [])]
      .map((value) => ({ value, normalized: normalizeText(value) }))
      .filter((entry) => entry.normalized);
    for (const entry of names) {
      if (!text.includes(entry.normalized)) continue;
      const exact = entry.normalized === normalizeText(project.project_name);
      const score = entry.normalized.length * 10 + (exact ? 5 : 0);
      if (!best || score > best.score) {
        best = { ...project, matched_name: entry.value, exact, score };
      }
    }
  }
  return best;
}

function searchPackages(packages, content, limit = 3) {
  const project = findProject(packages, content);
  const packageType = extractPackageType(content);
  if (!project) return { project: null, package_type: packageType, candidates: [] };

  const text = normalizeText(content);
  const candidates = packages
    .filter((item) => item.project_id === project.project_id)
    .filter((item) => !packageType || item.package_type === packageType)
    .map((item) => {
      let score = project.exact ? 100 : 80;
      if (packageType && item.package_type === packageType) score += 25;
      if (text.includes(normalizeText(item.package_name))) score += 12;
      score += (item.tags || []).filter((tag) => text.includes(normalizeText(tag))).length * 4;
      score += Math.min(5, Math.floor(Number(item.eagle_modified_at || 0) / 1e12));
      return { ...item, score };
    })
    .sort((a, b) => b.score - a.score || b.eagle_modified_at - a.eagle_modified_at)
    .slice(0, Math.max(1, Math.min(3, limit)));

  return { project, package_type: packageType, candidates };
}

function isPotentialConfirmation(content) {
  return /(确认|就是这|就这|这个|发源文件|发一下|第?[一二三123]个|第?[一二三123]张|^[一二三123]$|都不|不对|不是|换一个)/.test(
    String(content || "").trim()
  );
}

function confirmationIntent(content, candidateCount, repliedPosition = null) {
  const text = String(content || "").trim();
  if (/(都不对|都不是|不对|不是|换一个|换一批)/.test(text)) {
    return { kind: "reject" };
  }

  const numberWords = [
    { regex: /(?:第)?一(?:个|张)?|^1$/, position: 1 },
    { regex: /(?:第)?二(?:个|张)?|^2$/, position: 2 },
    { regex: /(?:第)?三(?:个|张)?|^3$/, position: 3 },
  ];
  for (const entry of numberWords) {
    if (entry.regex.test(text) && entry.position <= candidateCount) {
      return { kind: "select", position: entry.position };
    }
  }

  const positive = /(确认|就是这个|就这个|这个|发源文件|发一下|要这个)/.test(text);
  if (positive && repliedPosition && repliedPosition <= candidateCount) {
    return { kind: "select", position: repliedPosition };
  }
  if (positive && candidateCount === 1) return { kind: "select", position: 1 };
  if (positive) return { kind: "ambiguous" };
  return { kind: "unknown" };
}

module.exports = {
  TYPE_SYNONYMS,
  confirmationIntent,
  extractPackageType,
  findProject,
  hasPackagingAction,
  hasPackagingDomain,
  isPackagingQueryText,
  isPotentialConfirmation,
  searchPackages,
};
