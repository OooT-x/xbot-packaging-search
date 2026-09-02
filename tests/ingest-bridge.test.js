const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  buildIngestEvent,
  publishIngestEvent,
} = require("../eagle-plugin/lib/ingest-bridge");

test("publishes a deterministic filed event with the bot sync fields", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xbot-ingest-"));
  try {
    const result = {
      batchId: "batch-1",
      batchFolderId: "folder-1",
      projectName: "变速箱",
      sourcePath: "D:\\Exports\\变速箱包装",
      batchKey: "batch-key-1",
      manifestKey: "manifest-key-1",
      importMode: "update",
      filed: [
        {
          packageId: "pkg-b",
          packageName: "背景",
          packageType: "背景",
          version: "v02",
          aeCompName: "背景",
          previewItemId: "png-b",
          sourceItemId: "zip-b",
        },
        {
          packageId: "pkg-a",
          packageName: "信息条",
          packageType: "信息条",
          previewItemId: "png-a",
          sourceItemId: "zip-a",
        },
      ],
    };
    const first = buildIngestEvent(result);
    const second = buildIngestEvent(result);
    assert.equal(first.event_type, "eagle.batch.filed");
    assert.equal(first.event_id, second.event_id);
    assert.deepEqual(first.details.map((detail) => detail.package_id), ["pkg-a", "pkg-b"]);

    const published = publishIngestEvent(result, {
      filePath: path.join(root, "queue", "events.jsonl"),
    });
    assert.equal(published.skipped, false);
    const written = JSON.parse(fs.readFileSync(published.filePath, "utf8"));
    assert.deepEqual(
      { ...written, created_at: undefined },
      { ...first, created_at: undefined }
    );
    assert.match(written.created_at, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
