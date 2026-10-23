const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  buildIngestEvent,
  publishIngestEvent,
  retryPendingIngestEvents,
} = require("../eagle-plugin/lib/ingest-bridge");

test("all local enqueue paths isolate torn tails and retain recovery files on write failure", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xbot-local-torn-"));
  const filePath = path.join(root, "events.jsonl"), outboxDir = path.join(root, "outbox");
  const result = { batchId: "batch-torn", projectName: "项目", importMode: "new",
    filed: [{ packageId: "p", packageName: "条", packageType: "信息条", previewItemId: "png", sourceItemId: "zip" }] };
  const event = buildIngestEvent(result);
  const read = () => require("../bot/lib/ingest-sync").readIngestEvents(filePath);
  const recovery = path.join(outboxDir, event.event_id + ".json");
  fs.mkdirSync(outboxDir);
  try {
    fs.writeFileSync(filePath, '{"torn":');
    assert.equal(publishIngestEvent(result, { filePath, outboxDir }).state, "queued");
    assert.equal(read()[1].event_id, event.event_id);
    fs.writeFileSync(filePath, '{"torn":');
    fs.writeFileSync(recovery, JSON.stringify({ event, filePath }));
    assert.equal(retryPendingIngestEvents({ outboxDir })[0].state, "queued");
    assert.equal(read()[1].event_id, event.event_id);
    assert.equal(fs.existsSync(recovery), false);
    fs.writeFileSync(filePath, '{"torn":');
    fs.writeFileSync(recovery, JSON.stringify({ event, filePath }));
    await require("../eagle-plugin/lib/team-sync").retryPackage({ packageId: "p", projectName: "项目", packageName: "条",
      packageType: "信息条", version: "v01", preview: { id: "png" }, source: { id: "zip" } },
      { config: { mode: "local" }, outboxDir, filePath });
    assert.equal(read()[1].event_id, event.event_id);
    const blocked = path.join(root, "blocked"); fs.mkdirSync(blocked);
    fs.writeFileSync(recovery, JSON.stringify({ event, filePath: blocked }));
    assert.equal(retryPendingIngestEvents({ outboxDir })[0].state, "pending");
    assert.equal(fs.existsSync(recovery), true);
    const published = publishIngestEvent(result, { filePath: blocked, outboxDir });
    assert.equal(published.state, "pending");
    assert.equal(fs.existsSync(published.recoveryPath), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

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

test("keeps revision metadata and allows image-only background updates", () => {
  const event = buildIngestEvent({
    batchId: "batch-bg",
    projectName: "变速箱",
    importMode: "update",
    filed: [{
      packageId: "pkg-bg",
      packageName: "纯色背景",
      packageType: "背景",
      previewItemId: "png-new",
      sourceItemId: "",
      previewPath: "D:\\library\\preview.png",
      sourcePath: "",
      revisionId: "rev-preview-1",
      replacedItemId: "png-old",
      replacedKind: "preview",
    }],
  });
  assert.equal(event.details.length, 1);
  assert.equal(event.details[0].revision_id, "rev-preview-1");
  assert.equal(event.details[0].replaced_eagle_id, "png-old");
  assert.equal(event.details[0].replaced_kind, "preview");
});

test("failed queue append survives reopening and retries with the same event id", () => {
  const {retryPendingIngestEvents} = require("../eagle-plugin/lib/ingest-bridge");
  const root = fs.mkdtempSync(path.join(os.tmpdir(),"xbot-outbox-"));
  try {
    const filePath = path.join(root,"blocked"), outboxDir = path.join(root,"outbox");
    fs.mkdirSync(filePath);
    const sync = publishIngestEvent({batchId:"outbox-batch",projectName:"验收",
      filed:[{packageId:"p",previewItemId:"png",sourceItemId:"zip"}]}, {filePath,outboxDir});
    assert.equal(sync.state,"pending"); assert.ok(fs.existsSync(sync.recoveryPath));
    assert.equal(retryPendingIngestEvents({outboxDir})[0].state,"pending");
    fs.rmdirSync(filePath);
    const retry = retryPendingIngestEvents({outboxDir})[0];
    assert.equal(retry.state,"queued"); assert.equal(retry.event.event_id,sync.event.event_id);
    assert.equal(JSON.parse(fs.readFileSync(filePath)).event_id,sync.event.event_id);
    assert.equal(fs.existsSync(sync.recoveryPath),false);
    assert.deepEqual(retryPendingIngestEvents({outboxDir}),[]);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
