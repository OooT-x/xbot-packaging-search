const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { PackageDatabase } = require("../bot/lib/package-database");
const { IngestEventWatcher } = require("../bot/lib/ingest-sync");
const { publishIngestEvent } = require("../eagle-plugin/lib/ingest-bridge");

test("records a filed batch, retries a failed refresh, and skips completed events", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xbot-ingest-sync-"));
  const database = new PackageDatabase(path.join(root, "packaging.sqlite"));
  const eventFile = path.join(root, "events.jsonl");
  let refreshCalls = 0;
  try {
    publishIngestEvent(
      {
        batchId: "batch-1",
        batchFolderId: "folder-1",
        projectName: "变速箱",
        sourcePath: "D:\\Exports\\变速箱包装",
        batchKey: "batch-key-1",
        manifestKey: "manifest-key-1",
        importMode: "new",
        filed: [
          {
            packageId: "pkg-bg",
            packageName: "背景",
            packageType: "背景",
            version: "v01",
            aeCompName: "背景",
            previewItemId: "png-1",
            sourceItemId: "zip-1",
          },
        ],
      },
      { filePath: eventFile }
    );

    const watcher = new IngestEventWatcher({
      database,
      eventFile,
      refreshCatalog: async () => {
        refreshCalls += 1;
        if (refreshCalls === 1) throw new Error("Eagle 暂不可用");
        return { package_count: 1 };
      },
    });
    assert.equal((await watcher.runOnce())[0].state, "failed");
    assert.equal((await watcher.runOnce())[0].state, "completed");
    assert.equal((await watcher.runOnce())[0].state, "completed");
    assert.equal(refreshCalls, 2);
    const event = JSON.parse(fs.readFileSync(eventFile, "utf8"));
    assert.equal(database.getBatchSyncEvent(event.event_id).status, "completed");
    assert.equal(database.getBatchSyncEvent(event.event_id).attempts, 2);
    assert.equal(database.getBatch("batch-1").details[0].preview_eagle_id, "png-1");
  } finally {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
