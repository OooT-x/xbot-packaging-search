const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const EVENT_SCHEMA_VERSION = 1;
const EVENT_FILE_NAME = "packaging-ingest-events.jsonl";

function envValue(name) {
  return typeof process === "undefined" ? "" : String(process.env?.[name] || "").trim();
}

function defaultRuntimeRoot() {
  const fallbackHome =
    envValue("USERPROFILE") ||
    envValue("HOME") ||
    (typeof process === "undefined" ? "." : process.cwd());
  return (
    envValue("LARK_BOT_RUNTIME_ROOT") ||
    path.join(fallbackHome, "Documents", "飞书")
  );
}

function defaultEventFile() {
  return envValue("LARK_BOT_INGEST_EVENT_FILE") ||
    path.join(defaultRuntimeRoot(), EVENT_FILE_NAME);
}

function stableEventId(payload) {
  return `ingest-${crypto
    .createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex")
    .slice(0, 24)}`;
}

function buildIngestEvent(fileResult) {
  const filed = (fileResult?.filed || [])
    .map((item) => ({
      package_id: String(item.packageId || "").trim(),
      package_name: String(item.packageName || "").trim(),
      package_type: String(item.packageType || "").trim(),
      version: String(item.version || "v01").trim(),
      ae_comp_name: String(item.aeCompName || "").trim(),
      preview_eagle_id: String(item.previewItemId || "").trim(),
      source_eagle_id: String(item.sourceItemId || "").trim(),
      preview_path: String(item.previewPath || "").trim(),
      source_path: String(item.sourcePath || "").trim(),
      revision_id: String(item.revisionId || "").trim(),
      replaced_eagle_id: String(item.replacedItemId || "").trim(),
      replaced_kind: String(item.replacedKind || "").trim(),
      status: "filed",
    }))
    .filter((item) => item.package_id && item.preview_eagle_id && (item.source_eagle_id || item.package_type === "背景"))
    .sort((left, right) => left.package_id.localeCompare(right.package_id));
  if (filed.length === 0) return null;

  const batch = {
    batch_id: String(fileResult.batchId || "").trim(),
    batch_folder_id: String(fileResult.batchFolderId || "").trim(),
    project_name: String(fileResult.projectName || "").trim(),
    source_path: String(fileResult.sourcePath || "").trim(),
    batch_key: String(fileResult.batchKey || "").trim(),
    manifest_key: String(fileResult.manifestKey || "").trim(),
    import_mode: String(fileResult.importMode || "new").trim(),
  };
  const payload = { batch, details: filed };
  return {
    schema_version: EVENT_SCHEMA_VERSION,
    event_type: "eagle.batch.filed",
    event_id: stableEventId(payload),
    created_at: new Date().toISOString(),
    ...payload,
  };
}

function publishIngestEvent(fileResult, options = {}) {
  const event = buildIngestEvent(fileResult);
  if (!event) return { skipped: true, event: null, filePath: null };
  const filePath = path.resolve(options.filePath || defaultEventFile());
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(event)}\n`, "utf8");
  return { skipped: false, event, filePath };
}

module.exports = {
  EVENT_FILE_NAME,
  EVENT_SCHEMA_VERSION,
  buildIngestEvent,
  defaultEventFile,
  defaultRuntimeRoot,
  publishIngestEvent,
  stableEventId,
};
