const PACKAGE_TYPES = [
  "信息条",
  "视频框",
  "背景",
  "分镜排版",
  "分Part板",
  "报道",
  "时间轴",
];

const PACKAGE_TYPE_ALIASES = new Map([
  ["信息条", ["信息条", "标注", "标注条", "人名条", "人物条", "姓名条"]],
  ["视频框", ["视频框", "画面框", "横框", "竖框", "横屏框", "竖屏框"]],
  ["背景", ["背景", "主背景", "过渡背景", "章节背景"]],
  ["分镜排版", ["分镜排版", "多画面", "双屏", "三屏", "对比排版", "排版"]],
  ["分Part板", ["分part板", "分Part板", "分P板", "分part"]],
  ["报道", ["报道", "报道板", "报道页"]],
  ["时间轴", ["时间轴", "时间线", "timeline"]],
]);

const PACKAGE_TYPE_SET = new Set(PACKAGE_TYPES);

function normalizePackageType(value) {
  const text = String(value || "").normalize("NFKC").trim();
  const compact = text.toLocaleLowerCase().replace(/[\s_\-—·・/\\]+/gu, "");
  if (!text) return null;
  for (const type of PACKAGE_TYPES) {
    if (type === text) return type;
    const aliases = PACKAGE_TYPE_ALIASES.get(type) || [];
    if (aliases.some((alias) => alias.toLocaleLowerCase().replace(/[\s_\-—·・/\\]+/gu, "") === compact)) {
      return type;
    }
  }
  return null;
}

function inferPackageType(value) {
  const text = String(value || "").normalize("NFKC").toLocaleLowerCase().replace(/[\s_\-—·・/\\]+/gu, "");
  if (!text) return null;
  for (const type of PACKAGE_TYPES) {
    const aliases = PACKAGE_TYPE_ALIASES.get(type) || [type];
    if (aliases.some((alias) => text.includes(String(alias).toLocaleLowerCase().replace(/[\s_\-—·・/\\]+/gu, "")))) return type;
  }
  return null;
}

module.exports = {
  PACKAGE_TYPES,
  PACKAGE_TYPE_ALIASES,
  PACKAGE_TYPE_SET,
  inferPackageType,
  normalizePackageType,
};
