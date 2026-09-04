const fs = require("fs");
const path = require("path");
const { TextDecoder } = require("util");

const SECTION_ALIASES = {
  project: [
    "project",
    "project name",
    "after effects project",
    "project file",
    "项目",
    "项目名称",
    "工程",
    "工程名称",
  ],
  compositions: [
    "composition",
    "compositions",
    "comp",
    "comps",
    "selected comps",
    "selected compositions",
    "合成",
    "合成名称",
    "选中的合成",
  ],
  files: [
    "files",
    "file",
    "footage",
    "footage files",
    "source files",
    "collected files",
    "assets",
    "素材",
    "素材文件",
    "文件",
    "源文件",
    "收集文件",
  ],
  missingFootage: [
    "missing",
    "missing files",
    "missing footage",
    "missing footage files",
    "missing footage items",
    "missing footage list",
    "missing assets",
    "unresolved footage",
    "缺失",
    "缺失文件",
    "缺失素材",
    "缺失素材列表",
    "缺少素材",
    "未找到素材",
    "丢失素材",
  ],
  fonts: [
    "font",
    "fonts",
    "fonts used",
    "used fonts",
    "missing fonts",
    "字体",
    "字体依赖",
    "缺失字体",
  ],
  effects: [
    "effect",
    "effects",
    "effects used",
    "plugin",
    "plugins",
    "plug-ins",
    "third-party effects",
    "third party effects",
    "third-party plugins",
    "third party plugins",
    "third-party plug-ins",
    "third party plug-ins",
    "effects/plugins",
    "效果",
    "效果插件",
    "插件",
    "第三方效果",
  ],
  comments: ["comment", "comments", "注释", "备注"],
};

const SECTION_BY_NORMALIZED_ALIAS = new Map();
for (const [section, aliases] of Object.entries(SECTION_ALIASES)) {
  for (const alias of aliases) {
    SECTION_BY_NORMALIZED_ALIAS.set(normalizeHeading(alias), section);
  }
}

const SECTION_KEYS = [
  "project",
  "compositions",
  "files",
  "missingFootage",
  "fonts",
  "effects",
  "comments",
];

const NO_VALUE_PATTERN = /^(?:-|—|–|none|none found|not found|not applicable|n\/a|na|no(?:ne)?(?:\s+(?:files?|footage|assets?|fonts?|effects?|plugins?))?|no\s+missing\s+(?:files?|footage|assets?|fonts?|effects?|plugins?)|无|没有|无缺失|未发现|不适用|空)$/iu;
const SEPARATOR_PATTERN = /^[\s\-_=*~.·•]{3,}$/u;
const LEADING_LIST_MARKER = /^(?:[-*+•▪◦·]\s+|\d+[.)、]\s*|[A-Za-z][.)]\s+)/u;

function normalizeHeading(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/^\s*[\[【(（]+|[\]】)）]+\s*$/gu, "")
    .replace(/[\s_\-—–/\\:：]+/gu, "")
    .trim()
    .toLocaleLowerCase();
}

function stripMarkup(value) {
  return String(value || "")
    .replace(/<br\s*\/?\s*>/giu, "\n")
    .replace(/<\/p\s*>/giu, "\n")
    .replace(/<[^>]+>/gu, "");
}

function decodeUtf16Be(buffer) {
  const swapped = Buffer.alloc(buffer.length - (buffer.length % 2));
  for (let index = 0; index < swapped.length; index += 2) {
    swapped[index] = buffer[index + 1];
    swapped[index + 1] = buffer[index];
  }
  return swapped.toString("utf16le");
}

function hasUtf16Layout(buffer) {
  if (buffer.length < 4) return false;
  const sampleLength = Math.min(buffer.length, 512);
  let evenNuls = 0;
  let oddNuls = 0;
  for (let index = 0; index < sampleLength; index += 1) {
    if (buffer[index] !== 0) continue;
    if (index % 2 === 0) evenNuls += 1;
    else oddNuls += 1;
  }
  return Math.max(evenNuls, oddNuls) >= 2 && Math.max(evenNuls, oddNuls) >= sampleLength / 12;
}

function decodeReportBuffer(buffer) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer || "");
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return { text: buffer.subarray(2).toString("utf16le"), encoding: "utf-16le" };
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return { text: decodeUtf16Be(buffer.subarray(2)), encoding: "utf-16be" };
  }
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return { text: buffer.subarray(3).toString("utf8"), encoding: "utf-8" };
  }
  if (hasUtf16Layout(buffer)) {
    const sampleLength = Math.min(buffer.length, 512);
    let evenNuls = 0;
    let oddNuls = 0;
    for (let index = 0; index < sampleLength; index += 1) {
      if (buffer[index] !== 0) continue;
      if (index % 2 === 0) evenNuls += 1;
      else oddNuls += 1;
    }
    const littleEndian = oddNuls >= evenNuls;
    return {
      text: littleEndian ? buffer.toString("utf16le") : decodeUtf16Be(buffer),
      encoding: littleEndian ? "utf-16le" : "utf-16be",
    };
  }

  const utf8 = buffer.toString("utf8");
  const replacementCount = (utf8.match(/\ufffd/gu) || []).length;
  if (replacementCount === 0) return { text: utf8, encoding: "utf-8" };

  try {
    return {
      text: new TextDecoder("gb18030").decode(buffer),
      encoding: "gb18030",
    };
  } catch (_error) {
    return { text: utf8, encoding: "utf-8" };
  }
}

function uniqueStrings(values) {
  const result = [];
  const seen = new Set();
  for (const value of values || []) {
    const item = String(value || "").replace(/\s+/gu, " ").trim();
    if (!item || isNoValue(item)) continue;
    const key = item.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function isNoValue(value) {
  return NO_VALUE_PATTERN.test(String(value || "").trim());
}

function cleanItem(value, section) {
  let item = String(value || "").replace(/^\ufeff/u, "").trim();
  item = item.replace(LEADING_LIST_MARKER, "").trim();
  if (!item || SEPARATOR_PATTERN.test(item) || isNoValue(item)) return "";

  const keyedValue = item.match(/^(?:file|footage|asset|font|effect|plugin|文件|素材|字体|效果|插件)\s*[:：]\s*(.+)$/iu);
  if (keyedValue) item = keyedValue[1].trim();

  if (section === "project" && /^after effects(?: project)?\s*[:：]/iu.test(item)) {
    item = item.replace(/^after effects(?: project)?\s*[:：]\s*/iu, "").trim();
  }
  return isNoValue(item) ? "" : item;
}

function splitInlineItems(value, section) {
  const separators = section === "files" || section === "project" || section === "compositions"
    ? /[\r\n;；|]+/u
    : /[\r\n,，;；|]+/u;
  return String(value || "")
    .split(separators)
    .map((item) => cleanItem(item, section))
    .filter(Boolean);
}

function headingFromLine(value) {
  const line = String(value || "").trim();
  if (!line || SEPARATOR_PATTERN.test(line)) return null;

  const keyValue = line.match(/^([^:：]{1,80})\s*[:：]\s*(.*)$/u);
  if (keyValue) {
    const section = SECTION_BY_NORMALIZED_ALIAS.get(normalizeHeading(keyValue[1]));
    if (section) return { section, inline: keyValue[2].trim() };
  }

  const section = SECTION_BY_NORMALIZED_ALIAS.get(normalizeHeading(line.replace(/[:：]\s*$/u, "")));
  return section ? { section, inline: "" } : null;
}

function parseReportText(value) {
  const text = stripMarkup(value).replace(/\r\n?/gu, "\n");
  const sections = Object.fromEntries(SECTION_KEYS.map((key) => [key, []]));
  let currentSection = null;
  let recognizedSectionCount = 0;
  const lines = text.split("\n");

  for (const rawLine of lines) {
    const line = rawLine.replace(/^\ufeff/u, "").trim();
    const heading = headingFromLine(line);
    if (heading) {
      currentSection = heading.section;
      recognizedSectionCount += 1;
      sections[currentSection].push(...splitInlineItems(heading.inline, currentSection));
      continue;
    }
    if (!currentSection) continue;
    sections[currentSection].push(...splitInlineItems(cleanItem(line, currentSection), currentSection));
  }

  const normalizedSections = Object.fromEntries(
    SECTION_KEYS.map((key) => [key, uniqueStrings(sections[key])])
  );
  const parsed = {
    status: recognizedSectionCount > 0 ? "parsed" : "unrecognized",
    recognizedSectionCount,
    sections: normalizedSections,
    project: normalizedSections.project[0] || null,
    compositions: normalizedSections.compositions,
    files: normalizedSections.files,
    missingFootage: normalizedSections.missingFootage,
    fonts: normalizedSections.fonts,
    effects: normalizedSections.effects,
    comments: normalizedSections.comments,
  };
  return parsed;
}

function parseReportFile(reportPath) {
  const absolutePath = path.resolve(reportPath);
  try {
    const decoded = decodeReportBuffer(fs.readFileSync(absolutePath));
    return {
      path: absolutePath,
      name: path.basename(absolutePath),
      encoding: decoded.encoding,
      ...parseReportText(decoded.text),
      error: null,
    };
  } catch (error) {
    return {
      path: absolutePath,
      name: path.basename(absolutePath),
      encoding: null,
      status: "error",
      recognizedSectionCount: 0,
      sections: Object.fromEntries(SECTION_KEYS.map((key) => [key, []])),
      project: null,
      compositions: [],
      files: [],
      missingFootage: [],
      fonts: [],
      effects: [],
      comments: [],
      error: error.message,
    };
  }
}

module.exports = {
  SECTION_KEYS,
  decodeReportBuffer,
  parseReportFile,
  parseReportText,
};
