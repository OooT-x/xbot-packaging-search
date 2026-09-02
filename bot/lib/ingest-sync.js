const fs = require("fs");
const path = require("path");

const EVENT_SCHEMA_VERSION = 1;

function readIngestEvents(filePath) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) return [];
  const content = fs.readFileSync(resolved, "utf8");
  const events = [];
  for (const [index, line] of content.split(/\r?\n/u).entries()) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event && typeof event === "object") events.push(event);
    } catch {
      // Keep malformed lines in the queue for inspection without stopping later events.
      events.push({ _invalid: true, _line: index + 1 });
    }
  }
  return events;
}

function importModeForEvent(value) {
  const mode = String(value || "new").trim();
  return ["reuse", "update", "new"].includes(mode) ? mode : "new";
}

function normalizeBatchDetail(detail) {
  return {
    packageId: String(detail?.package_id || detail?.packageId || "").trim(),
    packageName: String(detail?.package_name || detail?.packageName || "").trim(),
    packageType: String(detail?.package_type || detail?.packageType || "").trim(),
    version: String(detail?.version || "v01").trim(),
    aeCompName: String(detail?.ae_comp_name || detail?.aeCompName || "").trim(),
    previewPath: String(detail?.preview_path || detail?.previewPath || "").trim(),
    sourcePath: String(detail?.source_path || detail?.sourcePath || "").trim(),
    previewEagleId: String(detail?.preview_eagle_id || detail?.previewItemId || "").trim(),
    sourceEagleId: String(detail?.source_eagle_id || detail?.sourceItemId || "").trim(),
    status: String(detail?.status || "filed").trim(),
  };
}

class IngestEventWatcher {
  constructor(options = {}) {
    if (!options.database) throw new Error("database is required");
    if (typeof options.refreshCatalog !== "function") {
      throw new Error("refreshCatalog is required");
    }
    this.database = options.database;
    this.refreshCatalog = options.refreshCatalog;
    this.eventFile = path.resolve(
      options.eventFile || path.join(process.cwd(), "packaging-ingest-events.jsonl")
    );
    this.intervalMs = Math.max(500, Number(options.intervalMs || 3000));
    this.log = options.log || (() => {});
    this.timer = null;
    this.running = false;
  }

  start() {
    if (this.timer) return this;
    this.timer = setInterval(() => {
      this.runOnce().catch((error) => this.log(`ingest event scan failed: ${error.message}`));
    }, this.intervalMs);
    this.timer.unref?.();
    this.runOnce().catch((error) => this.log(`ingest event scan failed: ${error.message}`));
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async runOnce() {
    if (this.running) return [];
    this.running = true;
    const results = [];
    try {
      for (const event of readIngestEvents(this.eventFile)) {
        results.push(await this.processEvent(event));
      }
    } finally {
      this.running = false;
    }
    return results;
  }

  async processEvent(event) {
    if (event?._invalid) {
      this.log(`ingest event ignored invalid JSON line=${event._line}`);
      return { state: "invalid" };
    }
    if (
      event?.schema_version !== EVENT_SCHEMA_VERSION ||
      event?.event_type !== "eagle.batch.filed"
    ) {
      return { state: "ignored" };
    }
    const batch = event.batch || {};
    const eventId = String(event.event_id || "").trim();
    const batchId = String(batch.batch_id || "").trim();
    if (!eventId || !batchId) {
      this.log("ingest event ignored because event_id or batch_id is missing");
      return { state: "invalid" };
    }

    const claim = this.database.claimBatchSyncEvent(eventId, batchId, event);
    if (claim.state !== "claimed") return claim;

    try {
      const details = (event.details || [])
        .map(normalizeBatchDetail)
        .filter((detail) => detail.packageId);
      if (details.length === 0) throw new Error("ingest event has no package details");
      this.database.recordBatchImport(
        {
          batchId,
          projectName: String(batch.project_name || "未命名项目").trim(),
          sourceDir: String(batch.source_path || "").trim(),
          batchKey: String(batch.batch_key || "").trim(),
          manifestKey: String(batch.manifest_key || "").trim(),
          batchFolderId: String(batch.batch_folder_id || "").trim() || null,
          importMode: importModeForEvent(batch.import_mode),
          status: "filed",
        },
        details,
        { mode: importModeForEvent(batch.import_mode), status: "filed" }
      );
      const report = await this.refreshCatalog(true);
      if (!report) throw new Error("catalog refresh did not complete");
      this.database.markBatchSyncEventCompleted(eventId);
      this.log(
        `ingest batch synced batch_id=${batchId} packages=${details.length} ` +
          `catalog=${report?.package_count ?? "unknown"}`
      );
      return { state: "completed", batchId, report };
    } catch (error) {
      this.database.markBatchSyncEventFailed(eventId, error.message);
      this.log(`ingest batch sync failed batch_id=${batchId}: ${error.message}`);
      return { state: "failed", batchId, error };
    }
  }
}

module.exports = {
  EVENT_SCHEMA_VERSION,
  IngestEventWatcher,
  importModeForEvent,
  normalizeBatchDetail,
  readIngestEvents,
};
