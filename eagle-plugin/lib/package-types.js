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
const fs = require("fs");
const path = require("path");
const os = require("os");
function registryPath() {
  return process.env.XBOT_PACKAGE_TYPES_FILE || path.join(process.env.LARK_BOT_RUNTIME_ROOT || path.join(os.homedir(), "Documents", "飞书"), "packaging-types.json");
}
function validateTypeName(value) {
  const name = String(value || "").normalize("NFKC").trim();
  if (!name || name.length > 40 || /[<>:"/\\|?*\u0000-\u001f]/u.test(name) || /[. ]$/u.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(name)) throw new Error("包装类型名称无效，请使用不含路径符号的 1–40 个字符。");
  return name;
}
function refreshPackageTypes() {
  const file = registryPath();
  if (!fs.existsSync(file)) return;
  const entries = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(entries)) throw new Error("包装类型配置格式错误");
  for (const entry of entries) {
    const name = validateTypeName(entry.name);
    if (!PACKAGE_TYPE_SET.has(name)) { PACKAGE_TYPES.push(name); PACKAGE_TYPE_SET.add(name); }
    const aliases = Array.isArray(entry.aliases) ? entry.aliases.map(validateTypeName) : [];
    PACKAGE_TYPE_ALIASES.set(name, [...new Set([...(PACKAGE_TYPE_ALIASES.get(name) || [name]), ...aliases])]);
  }
}
function registerPackageType(value, aliases = []) {
  refreshPackageTypes();
  const name = validateTypeName(value);
  if (normalizePackageType(name)) throw new Error("包装类型或别名已存在");
  const cleanAliases = aliases.map(validateTypeName);
  if (cleanAliases.some(alias => normalizePackageType(alias))) throw new Error("别名与现有包装类型冲突");
  const file = registryPath();
  const entries = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
  entries.push({ name, aliases: cleanAliases });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(entries, null, 2), "utf8");
  fs.renameSync(temporary, file);
  refreshPackageTypes();
  return name;
}
refreshPackageTypes();

function normalizePackageType(value) {
  refreshPackageTypes();
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
  refreshPackageTypes();
  const text = String(value || "").normalize("NFKC").toLocaleLowerCase().replace(/[\s_\-—·・/\\]+/gu, "");
  if (!text) return null;
  for (const type of PACKAGE_TYPES) {
    const aliases = PACKAGE_TYPE_ALIASES.get(type) || [type];
    if (aliases.some((alias) => text.includes(String(alias).toLocaleLowerCase().replace(/[\s_\-—·・/\\]+/gu, "")))) return type;
  }
  return null;
}

module.exports = {
  registerPackageType,
  refreshPackageTypes,
  PACKAGE_TYPES,
  PACKAGE_TYPE_ALIASES,
  PACKAGE_TYPE_SET,
  inferPackageType,
  normalizePackageType,
};
