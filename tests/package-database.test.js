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

test("snapshot migration expires legacy candidates without altering completed or uncertain deliveries", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xbot-snapshot-migration-"));
  const migrations = path.join(root, "migrations"), file = path.join(root, "index.sqlite");
  fs.mkdirSync(migrations);
  for (const name of fs.readdirSync(path.join(__dirname, "../migrations")).filter(name => name < "009")) {
    fs.copyFileSync(path.join(__dirname, "../migrations", name), path.join(migrations, name));
  }
  let database;
  try {
    database = new PackageDatabase(file, { migrationsDir: migrations });
    database.db.exec(`INSERT INTO projects(project_id, project_name, normalized_name, created_at, updated_at) VALUES ('p','项目','项目',1,1);
      INSERT INTO packages(package_id, project_id, package_name, package_type, version, preview_eagle_id, source_eagle_id,
        preview_path, source_path, synced_at) VALUES ('a','p','条','信息条','v01','png','zip','p.png','s.zip',1);
      INSERT INTO queries(request_id, requester_id, chat_id, root_message_id, status, created_at, expires_at)
        VALUES ('q','owner','chat','root','pending',1,9999999999999);
      INSERT INTO query_candidates(request_id, position, package_id) VALUES ('q',1,'a');
      INSERT INTO deliveries(request_id, package_id, idempotency_key, status, phase, created_at, updated_at)
        VALUES ('q','a','key','failed','uncertain',1,1);
      INSERT INTO queries(request_id, requester_id, chat_id, root_message_id, status, created_at, expires_at)
        VALUES ('done','owner','chat','root-done','completed',1,9999999999999);
      INSERT INTO deliveries(request_id, package_id, idempotency_key, status, phase, source_message_id, created_at, updated_at)
        VALUES ('done','a','done-key','completed','delivered','sent-id',1,1);`);
    const before = database.db.prepare("SELECT * FROM deliveries ORDER BY request_id").all();
    database.close();
    database = new PackageDatabase(file);
    assert.equal(database.getQueryWithCandidates("q").status, "expired");
    assert.equal(database.getQueryWithCandidates("done").status, "completed");
    const after = database.db.prepare("SELECT * FROM deliveries ORDER BY request_id").all();
    assert.deepEqual(after.map(({ snapshot_key, ...row }) => row), before.map(row => ({ ...row })));
    assert.ok(database.getQueryWithCandidates("q").expires_at <= Date.now());
  } finally { database?.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

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
      "006_interrupted_delivery.sql",
      "007_query_browsing.sql",
      "008_followup_filters.sql",
      "009_candidate_snapshots.sql",
      "010_card_sessions.sql",
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
