const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { PACKAGE_TYPE_SET } = require("../../eagle-plugin/lib/package-types");
const PACKAGE_TYPES = PACKAGE_TYPE_SET;

function normalizeText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s_\-—·・/\\]+/g, "")
    .trim();
}

function stableProjectId(projectName) {
  return `proj-${crypto.createHash("sha256").update(normalizeText(projectName)).digest("hex").slice(0, 16)}`;
}

function parseAnnotation(annotation) {
  const fields = {};
  for (const rawLine of String(annotation || "").replace(/\r/g, "").split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^([^:：]+)[:：]\s*(.*)$/);
    if (!match) continue;
    fields[match[1].trim()] = match[2].trim();
  }
  return fields;
}

function enabledStatus(value) {
  return /^启用/.test(String(value || "").trim());
}

function dependencyStatus(fields, tags) {
  const status = String(fields["状态"] || "");
  if (/阻止/.test(status)) return "blocked";
  if (/警告/.test(status) || tags.includes("依赖警告")) return "warning";
  return "complete";
}

function resolveEagleItemFile(libraryPath, item) {
  const itemDir = path.join(path.resolve(libraryPath), "images", `${item.id}.info`);
  if (!fs.existsSync(itemDir)) {
    throw new Error(`Eagle item directory not found: ${item.id}`);
  }

  const ext = `.${String(item.ext || "").toLowerCase()}`;
  const candidates = fs
    .readdirSync(itemDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(itemDir, entry.name))
    .filter((filePath) => path.extname(filePath).toLowerCase() === ext)
    .filter((filePath) => !/_thumbnail\.[^.]+$/i.test(filePath));

  if (candidates.length === 1) return candidates[0];

  const sizeMatches = candidates.filter((filePath) => {
    try {
      return Number(item.size || 0) > 0 && fs.statSync(filePath).size === Number(item.size);
    } catch {
      return false;
    }
  });
  if (sizeMatches.length === 1) return sizeMatches[0];

  throw new Error(
    `Eagle item ${item.id} expected one .${item.ext} file, found ${candidates.length}`
  );
}

function loadAliases(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return {};
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return parsed;
}

class EagleClient {
  constructor(options = {}) {
    this.baseUrl = String(options.baseUrl || "http://127.0.0.1:41595/api/v2").replace(/\/+$/, "");
    this.fetch = options.fetch || globalThis.fetch;
    if (typeof this.fetch !== "function") throw new Error("fetch is required");
  }

  async request(route, options = {}) {
    const response = await this.fetch(`${this.baseUrl}/${route.replace(/^\/+/, "")}`, {
      ...options,
      headers: {
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json; charset=utf-8" } : {}),
        ...(options.headers || {}),
      },
    });
    if (!response.ok) {
      throw new Error(`Eagle API ${route} failed with HTTP ${response.status}`);
    }
    const envelope = await response.json();
    if (envelope.status !== "success") {
      throw new Error(`Eagle API ${route} failed: ${envelope.message || "unknown error"}`);
    }
    return envelope.data;
  }

  async libraryInfo() {
    return await this.request("library/info");
  }

  async listItems() {
    const pageSize = 1000;
    const items = [];
    let offset = 0;

    while (true) {
      const page = await this.request("item/get", {
        method: "POST",
        body: JSON.stringify({
          offset,
          limit: pageSize,
          fields: [
            "id",
            "name",
            "size",
            "ext",
            "tags",
            "folders",
            "isDeleted",
            "annotation",
            "modifiedAt",
            "modificationTime",
            "lastModified",
          ],
        }),
      });
      const batch = Array.isArray(page.data) ? page.data : [];
      items.push(...batch);
      offset += batch.length;
      if (batch.length === 0 || offset >= Number(page.total || 0)) break;
    }
    return items;
  }
}

function buildCatalog(items, libraryPath, aliasConfig = {}) {
  const grouped = new Map();
  const errors = [];

  for (const item of items) {
    if (!item || item.isDeleted) continue;
    if (!/^(png|zip)$/i.test(String(item.ext || ""))) continue;
    const fields = parseAnnotation(item.annotation);
    if (!enabledStatus(fields["状态"])) continue;
    const packageId = fields.package_id;
    if (!packageId) continue;

    if (!grouped.has(packageId)) grouped.set(packageId, []);
    grouped.get(packageId).push({ item, fields });
  }

  const projectsById = new Map();
  const packages = [];

  for (const [packageId, records] of grouped) {
    const previews = records.filter(({ item }) => String(item.ext).toLowerCase() === "png");
    const sources = records.filter(({ item }) => String(item.ext).toLowerCase() === "zip");
    const packageTypeHint = records
      .map(({ fields }) => fields["包装类型"])
      .find(Boolean);
    const imageOnlyBackground =
      previews.length === 1 &&
      sources.length === 0 &&
      packageTypeHint === "背景";
    if (
      previews.length !== 1 ||
      sources.length > 1 ||
      (sources.length === 0 && !imageOnlyBackground)
    ) {
      errors.push(`${packageId}: expected one PNG and one ZIP, found ${previews.length}/${sources.length}`);
      continue;
    }

    const preview = previews[0];
    const source = sources[0] || null;
    const fields = { ...(source?.fields || {}), ...preview.fields };
    const projectName = fields["项目"];
    const packageName = fields["包装名称"];
    const packageType = fields["包装类型"];
    const version = fields["版本"];
    const statusText = fields["状态"];

    if (!projectName || !packageName || !version || !PACKAGE_TYPES.has(packageType)) {
      errors.push(`${packageId}: missing or invalid project/package/type/version metadata`);
      continue;
    }
    if (!enabledStatus(statusText)) continue;

    try {
      const projectId = stableProjectId(projectName);
      const configuredAliases = Array.isArray(aliasConfig[projectName])
        ? aliasConfig[projectName]
        : [];
      const aliases = [...new Set([`${projectName}包装`, ...configuredAliases])]
        .map((value) => String(value).trim())
        .filter((value) => value && normalizeText(value) !== normalizeText(projectName));
      projectsById.set(projectId, {
        project_id: projectId,
        project_name: projectName,
        normalized_name: normalizeText(projectName),
        aliases,
      });

      const tags = [...new Set([...(preview.item.tags || []), ...(source?.item.tags || [])])];
      packages.push({
        package_id: packageId,
        project_id: projectId,
        package_name: packageName,
        package_type: packageType,
        tags,
        version,
        base_package_id: fields.base_package_id || null,
        preview_eagle_id: preview.item.id,
        source_eagle_id: source?.item.id || null,
        preview_path: resolveEagleItemFile(libraryPath, preview.item),
        source_path: source ? resolveEagleItemFile(libraryPath, source.item) : null,
        ae_comp_name: fields["AE 合成"] || "",
        dependency_status: dependencyStatus(fields, tags),
        status: "active",
        eagle_modified_at: Math.max(
          Number(preview.item.modifiedAt || preview.item.modificationTime || preview.item.lastModified || 0),
          Number(source?.item.modifiedAt || source?.item.modificationTime || source?.item.lastModified || 0)
        ),
      });
    } catch (error) {
      errors.push(`${packageId}: ${error.message}`);
    }
  }

  return {
    projects: [...projectsById.values()],
    packages,
    errors,
  };
}

async function syncEagleCatalog(database, options = {}) {
  const libraryPath = String(options.libraryPath || "").trim();
  let library;
  let items;
  if (libraryPath) {
    const diskLibrary = readLibraryFromDisk(libraryPath);
    library = { name: diskLibrary.name, path: diskLibrary.path };
    items = diskLibrary.items;
  } else {
    const client = options.client || new EagleClient({ baseUrl: options.baseUrl, fetch: options.fetch });
    [library, items] = await Promise.all([client.libraryInfo(), client.listItems()]);
  }
  const aliasConfig = loadAliases(options.aliasesPath);
  const catalog = buildCatalog(items, library.path, aliasConfig);
  database.replaceCatalog(catalog.projects, catalog.packages);
  return {
    library_name: library.name,
    library_path: library.path,
    library_source: libraryPath ? "disk" : "api",
    item_count: items.length,
    project_count: catalog.projects.length,
    package_count: catalog.packages.length,
    errors: catalog.errors,
  };
}

function readLibraryFromDisk(libraryPath) {
  const root = path.resolve(libraryPath);
  const libraryMetaPath = path.join(root, "metadata.json");
  if (!fs.existsSync(libraryMetaPath)) {
    throw new Error(`Eagle library metadata.json not found: ${libraryMetaPath}`);
  }

  let libraryMeta = {};
  try {
    libraryMeta = JSON.parse(fs.readFileSync(libraryMetaPath, "utf8"));
  } catch (error) {
    throw new Error(`failed to parse Eagle library metadata.json: ${error.message}`);
  }

  const items = [];
  const imagesDir = path.join(root, "images");
  if (fs.existsSync(imagesDir)) {
    for (const entry of fs.readdirSync(imagesDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.endsWith(".info")) continue;
      const metaPath = path.join(imagesDir, entry.name, "metadata.json");
      if (!fs.existsSync(metaPath)) continue;
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
        if (meta && typeof meta === "object" && meta.id) items.push(meta);
      } catch {
        // skip malformed item metadata; the item simply does not enter the catalog
      }
    }
  }

  const name =
    String(libraryMeta.name || "").trim() ||
    path.basename(root).replace(/\.library$/i, "") ||
    "Eagle";
  return { name, path: root, items };
}

module.exports = {
  EagleClient,
  PACKAGE_TYPES,
  buildCatalog,
  dependencyStatus,
  normalizeText,
  parseAnnotation,
  readLibraryFromDisk,
  resolveEagleItemFile,
  stableProjectId,
  syncEagleCatalog,
};
