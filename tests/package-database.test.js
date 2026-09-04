const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { PackageDatabase, normalizeBatchPath } = require("../bot/lib/package-database");

function makeDatabase() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xbot-batches-"));
  const database = new PackageDatabase(path.join(root, "packaging.sqlite"));
  return { root, database };
}

test("migrates batches and batch details tables", () => {
  const { root, database } = makeDatabase();
  try {
    const migrations = database.db
      .prepare("SELECT name FROM schema_migrations ORDER BY name")
      .all()
      .map((row) => row.name);
    assert.deepEqual(migrations, [
      "001_initial.sql",
      "002_batches.sql",
      "003_batch_sync_events.sql",
      "004_image_only_backgrounds.sql",
      "005_package_revisions.sql",
    ]);
    assert.equal(database.db.prepare("SELECT COUNT(*) AS count FROM batches").get().count, 0);
    assert.equal(
      database.db.prepare("SELECT COUNT(*) AS count FROM batch_details").get().count,
      0
    );
  } finally {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("claims, retries, and deduplicates a batch sync event", () => {
  const { root, database } = makeDatabase();
  try {
    assert.equal(
      database.claimBatchSyncEvent("event-1", "batch-1", { payload: 1 }, 100).state,
      "claimed"
    );
    assert.equal(database.claimBatchSyncEvent("event-1", "batch-1", {}, 110).state, "processing");
    database.markBatchSyncEventFailed("event-1", "temporary error", 120);
    const retry = database.claimBatchSyncEvent("event-1", "batch-1", {}, 130);
    assert.equal(retry.state, "claimed");
    assert.equal(retry.event.attempts, 2);
    database.markBatchSyncEventCompleted("event-1", 140);
    assert.equal(database.claimBatchSyncEvent("event-1", "batch-1", {}, 150).state, "completed");
  } finally {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("records a batch and filters it by stable identity", () => {
  const { root, database } = makeDatabase();
  try {
    const first = database.recordBatchImport(
      {
        batchId: "batch-ONE",
        projectName: "变速箱",
        sourceDir: "D:\\Exports\\变速箱包装",
        batchKey: "content-key-1",
        manifestKey: "manifest-key-1",
        batchFolderId: "folder-1",
      },
      [
        {
          packageId: "pkg-bg",
          packageName: "背景",
          packageType: "背景",
          version: "v01",
          aeCompName: "背景",
          previewPath: "D:\\Exports\\变速箱包装\\背景.png",
          sourcePath: "D:\\Exports\\变速箱包装\\背景.zip",
          manifestPath: "D:\\Exports\\变速箱包装\\manifest.json",
          previewEagleId: "png-1",
          sourceEagleId: "zip-1",
          packageKey: "package-key-1",
        },
      ],
      { mode: "new", now: 100 }
    );

    assert.equal(first.batch_id, "batch-ONE");
    assert.equal(first.status, "imported");
    assert.equal(first.details.length, 1);
    assert.equal(first.details[0].preview_eagle_id, "png-1");
    assert.equal(database.findBatch({ batchKey: "content-key-1" }).batch_id, "batch-ONE");
    assert.equal(
      database.findBatch({ sourcePath: "d:/exports/变速箱包装/" }).batch_id,
      "batch-ONE"
    );
    assert.equal(
      database.findBatch({ manifestKey: "manifest-key-1" }).details[0].package_id,
      "pkg-bg"
    );
    assert.equal(normalizeBatchPath("D:\\Exports\\变速箱包装\\"), "d:/exports/变速箱包装");
  } finally {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("updates existing batch details without creating a second batch", () => {
  const { root, database } = makeDatabase();
  try {
    database.recordBatchImport(
      {
        batchId: "batch-ONE",
        projectName: "阿宝",
        sourceDir: "D:\\Exports\\阿宝包装",
        batchKey: "content-key-1",
        batchFolderId: "folder-1",
      },
      [
        {
          packageId: "pkg-bg",
          packageName: "背景",
          packageType: "背景",
          version: "v01",
          previewPath: "D:\\Exports\\阿宝包装\\背景.png",
          sourcePath: "D:\\Exports\\阿宝包装\\背景.zip",
        },
      ],
      { mode: "new", now: 100 }
    );

    const updated = database.recordBatchImport(
      {
        batchId: "batch-ONE",
        projectName: "阿宝",
        sourceDir: "D:\\Exports\\阿宝包装",
        batchKey: "content-key-2",
        batchFolderId: "folder-1",
      },
      [
        {
          packageId: "pkg-bg",
          packageName: "背景更新",
          packageType: "背景",
          version: "v02",
          previewPath: "D:\\Exports\\阿宝包装\\背景-v02.png",
          sourcePath: "D:\\Exports\\阿宝包装\\背景-v02.zip",
          status: "updated",
        },
        {
          packageId: "pkg-label",
          packageName: "信息条",
          packageType: "信息条",
          version: "v01",
          previewPath: "D:\\Exports\\阿宝包装\\信息条.png",
          sourcePath: "D:\\Exports\\阿宝包装\\信息条.zip",
          status: "updated",
        },
      ],
      { mode: "update", now: 200 }
    );

    assert.equal(updated.status, "updated");
    assert.equal(updated.details.length, 2);
    assert.equal(updated.details.find((detail) => detail.package_id === "pkg-bg").version, "v02");
    assert.equal(database.listBatches().length, 1);
  } finally {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
