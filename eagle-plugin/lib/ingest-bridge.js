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
  if (!event) return { state: "skipped", skipped: true, event: null, filePath: null };
  const filePath = path.resolve(options.filePath || defaultEventFile());
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify(event)}\n`, "utf8");
    return { state: "queued", skipped: false, event, filePath };
  } catch (error) {
    const outbox = path.resolve(options.outboxDir || defaultOutboxDir());
    fs.mkdirSync(outbox, { recursive: true });
    const recoveryPath = path.join(outbox, `${event.event_id}.json`);
    fs.writeFileSync(recoveryPath, JSON.stringify({ event, filePath }), "utf8");
    return { state: "pending", skipped: false, event, filePath, recoveryPath, error: error.message };
  }
}

function defaultOutboxDir() {
  return envValue("LARK_BOT_INGEST_OUTBOX_DIR") ||
    path.join(envValue("APPDATA") || defaultRuntimeRoot(), "XbotPackaging", "ingest-outbox");
}

function retryPendingIngestEvents(options = {}) {
  const outbox = path.resolve(options.outboxDir || defaultOutboxDir());
  if (!fs.existsSync(outbox)) return [];
  return fs.readdirSync(outbox).filter(name => /^ingest-[a-f0-9]{24}\.json$/u.test(name)).map(name => {
    const recoveryPath = path.join(outbox, name);
    try {
      const { event, filePath } = JSON.parse(fs.readFileSync(recoveryPath, "utf8"));
      if (event?.event_id !== name.slice(0, -5) || event?.event_type !== "eagle.batch.filed") {
        throw new Error("invalid outbox event");
      }
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.appendFileSync(filePath, `${JSON.stringify(event)}\n`, "utf8");
      fs.unlinkSync(recoveryPath);
      return { state: "queued", event, filePath, recoveryPath };
    } catch (error) { return { state: "pending", recoveryPath, error: error.message }; }
  });
}

module.exports = {
  EVENT_FILE_NAME,
  EVENT_SCHEMA_VERSION,
  buildIngestEvent,
  defaultEventFile,
  defaultOutboxDir,
  defaultRuntimeRoot,
  retryPendingIngestEvents,
  publishIngestEvent,
  stableEventId,
};
