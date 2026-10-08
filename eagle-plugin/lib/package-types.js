const fs = require("fs"), path = require("path"), os = require("os");
const DEFAULT_ALIASES = new Map([
  ["信息条", ["信息条", "标注", "标注条", "人名条", "人物条", "姓名条"]],
  ["视频框", ["视频框", "画面框", "横框", "竖框", "横屏框", "竖屏框"]],
  ["背景", ["背景", "主背景", "过渡背景", "章节背景"]],
  ["分镜排版", ["分镜排版", "多画面", "双屏", "三屏", "对比排版", "排版"]],
  ["分Part板", ["分part板", "分Part板", "分P板", "分part"]],
  ["报道", ["报道", "报道板", "报道页"]],
  ["时间轴", ["时间轴", "时间线", "timeline"]],
]);
// Keep container identity: consumers retain these references.
const PACKAGE_TYPES = [], PACKAGE_TYPE_SET = new Set(), PACKAGE_TYPE_ALIASES = new Map();
let records = [];
function registryPath() {
  return process.env.XBOT_PACKAGE_TYPES_FILE || path.join(process.env.LARK_BOT_RUNTIME_ROOT || path.join(os.homedir(), "Documents", "飞书"), "packaging-types.json");
}
function validateTypeName(value) {
  const name = String(value || "").normalize("NFKC").trim();
  if (!name || name.length > 40 || /[<>:"/\\|?*\u0000-\u001f]/u.test(name) || /[. ]$/u.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(name)) throw new Error("包装类型名称无效，请使用不含路径符号的 1–40 个字符。");
  return name;
}
function compact(value) { return String(value || "").normalize("NFKC").toLocaleLowerCase().replace(/[\s_\-—·・/\\]+/gu, ""); }
function readEntries() {
  const file = registryPath(), entries = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
  if (!Array.isArray(entries)) throw new Error("包装类型配置格式错误");
  return entries;
}
function buildRecords(entries) {
  const all = new Map([...DEFAULT_ALIASES].map(([name, aliases]) => [name, { name, aliases: [...aliases], enabled: true, builtin: true }]));
  const seen = new Set();
  for (const entry of entries) {
    const name = validateTypeName(entry.name);
    if (seen.has(name)) throw new Error("包装类型配置含重复名称");
    seen.add(name);
    const aliases = [...new Set([name, ...(Array.isArray(entry.aliases) ? entry.aliases.map(validateTypeName) : DEFAULT_ALIASES.get(name) || []), ...(Array.isArray(entry.previousNames) ? entry.previousNames.map(validateTypeName) : [])])];
    all.set(name, { name, aliases, enabled: entry.enabled !== false, builtin: DEFAULT_ALIASES.has(name) });
  }
  const owners = new Map();
  for (const record of all.values()) for (const alias of record.aliases) {
    const key = compact(alias), owner = owners.get(key);
    if (owner && owner !== record.name) throw new Error("类型名称或别名与“" + owner + "”冲突");
    owners.set(key, record.name);
  }
  return [...all.values()];
}
function refreshPackageTypes() {
  const next = buildRecords(readEntries());
  records = next;
  PACKAGE_TYPES.splice(0, PACKAGE_TYPES.length, ...next.filter(record => record.enabled).map(record => record.name));
  PACKAGE_TYPE_SET.clear(); PACKAGE_TYPES.forEach(name => PACKAGE_TYPE_SET.add(name));
  PACKAGE_TYPE_ALIASES.clear(); next.forEach(record => PACKAGE_TYPE_ALIASES.set(record.name, [...record.aliases]));
}
function saveEntries(entries) {
  buildRecords(entries);
  const file = registryPath(), temporary = file + "." + process.pid + "." + Date.now() + ".tmp";
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try { fs.writeFileSync(temporary, JSON.stringify(entries, null, 2), "utf8"); fs.renameSync(temporary, file); }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  refreshPackageTypes();
}
function listPackageTypes() { refreshPackageTypes(); return records.map(record => ({ ...record, aliases: [...record.aliases] })); }
function registerPackageType(value, aliases = []) {
  refreshPackageTypes();
  const name = validateTypeName(value);
  if (normalizePackageType(name)) throw new Error("包装类型或别名已存在（停用类型可在管理页恢复）");
  const entries = readEntries(); entries.push({ name, aliases: aliases.map(validateTypeName), enabled: true }); saveEntries(entries);
  return name;
}
function updatePackageType(currentName, changes = {}) {
  refreshPackageTypes();
  const current = records.find(record => record.name === currentName);
  if (!current) throw new Error("找不到包装类型，请刷新后重试");
  const name = changes.name === undefined ? current.name : validateTypeName(changes.name);
  if (current.builtin && name !== current.name) throw new Error("内置类型名称固定，可修改别名或停用");
  const owner = normalizePackageType(name);
  if (owner && owner !== current.name) throw new Error("类型名称或别名已存在");
  const entries = readEntries(), stored = entries.find(entry => entry.name === current.name);
  const aliases = changes.aliases === undefined ? (stored?.aliases || current.aliases) : changes.aliases.map(validateTypeName);
  // Preserve historical custom aliases so existing indexed assets remain searchable.
  const next = { name, aliases: [...new Set(aliases)], previousNames: [...new Set([...(stored?.previousNames || []), ...(name !== current.name ? [current.name] : [])])], enabled: changes.enabled === undefined ? current.enabled : Boolean(changes.enabled) };
  const updated = entries.filter(entry => entry.name !== current.name); updated.push(next); saveEntries(updated);
  return name;
}
// Retired types still normalize for existing assets; ingestion uses the active set.
function normalizePackageType(value) {
  refreshPackageTypes(); const key = compact(value);
  return key ? records.find(record => record.aliases.some(alias => compact(alias) === key))?.name || null : null;
}
function isPackageTypeActive(value) { const type = normalizePackageType(value); return Boolean(type && PACKAGE_TYPE_SET.has(type)); }
function inferPackageType(value) {
  refreshPackageTypes(); const text = compact(value);
  if (!text) return null;
  return records.find(record => record.aliases.some(alias => compact(alias) === text))?.name || records.find(record => record.aliases.some(alias => text.includes(compact(alias))))?.name || null;
}
refreshPackageTypes();
module.exports = { registryPath, registerPackageType, updatePackageType, listPackageTypes, isPackageTypeActive, refreshPackageTypes, PACKAGE_TYPES, PACKAGE_TYPE_ALIASES, PACKAGE_TYPE_SET, inferPackageType, normalizePackageType };
