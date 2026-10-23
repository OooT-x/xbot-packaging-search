const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { once } = require("events");
const { PackageDatabase } = require("../bot/lib/package-database");
const { IngestEventWatcher } = require("../bot/lib/ingest-sync");
const { createTeamIngestServer, appendDurably } = require("../bot/lib/team-ingest-server");
const bridge = require("../eagle-plugin/lib/ingest-bridge");
const team = require("../eagle-plugin/lib/team-client");
const sync = require("../eagle-plugin/lib/team-sync");

const result = () => ({ batchId: "team-batch", projectName: "团队项目", importMode: "new", filed: [{ packageId: "p", packageName: "背景", packageType: "背景", previewItemId: "png", sourceItemId: "zip", version: "v01" }] });
const currentPackage = () => ({ packageId: "p", projectName: "团队项目", packageName: "背景", packageType: "背景", version: "v01", preview: { id: "png" }, source: { id: "zip" } });

test("legacy pairs without events are completed only when current Eagle files and index agree", async t => {
  const f = await fixture(t);
  const eagle = require("../bot/lib/eagle-sync");
  fs.writeFileSync(path.join(f.root, "metadata.json"), JSON.stringify({ name: "历史库" }));
  const annotation = "package_id：p\n项目：团队项目\n包装名称：背景\n包装类型：背景\n版本：v01\n状态：启用";
  for (const [id, ext] of [["png", "png"], ["zip", "zip"]]) {
    const dir = path.join(f.root, "images", `${id}.info`); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `背景.${ext}`), "test-file");
    fs.writeFileSync(path.join(dir, "metadata.json"), JSON.stringify({ id, ext, name: "背景", annotation }));
  }
  const library = eagle.readLibraryFromDisk(f.root), catalog = eagle.buildCatalog(library.items, f.root);
  f.database.replaceCatalog(catalog.projects, catalog.packages);
  const status = async item => (await sync.listStatus([item || currentPackage()], { config: f.config }))[0];
  assert.equal((await status()).state, "completed");
  assert.equal((await status()).evidence, "catalog");
  assert.equal(fs.existsSync(f.watcher.eventFile), false, "a read must not manufacture an ingestion event");
  for (const changed of [{ ...currentPackage(), packageType: "信息条" }, { ...currentPackage(), preview: { id: "other" } }, { ...currentPackage(), meta: { revision_id: "unseen" } }]) assert.equal((await status(changed)).state, "unknown");
  const pngMeta = path.join(f.root, "images/png.info/metadata.json"), meta = JSON.parse(fs.readFileSync(pngMeta));
  fs.writeFileSync(pngMeta, JSON.stringify({ ...meta, annotation: annotation + "\nrevision_id：new" }));
  assert.equal((await status()).state, "unknown", "a changed Eagle revision must invalidate an old client snapshot");
  fs.writeFileSync(pngMeta, JSON.stringify(meta));
  fs.unlinkSync(path.join(f.root, "images/zip.info/背景.zip"));
  assert.equal((await status()).state, "unknown", "a stale index cannot certify a missing file");
  f.database.replaceCatalog([], []);
  assert.equal((await status()).state, "unknown");
});

test("another terminal can see a failed current pair and retry its durable event without writing Eagle", async t => {
  const f = await fixture(t), options = { config: f.config, outboxDir: path.join(f.root, "terminal-a") };
  f.setIndexed(false);
  const published = await sync.publish(result(), options); await f.watcher.runOnce();
  const other = { config: f.config, outboxDir: path.join(f.root, "terminal-b") };
  const [failed] = await sync.listStatus([currentPackage()], other);
  assert.equal(failed.state, "failed"); assert.match(failed.error, /配对尚未核实/u);
  f.setIndexed(true);
  assert.equal((await sync.retryPackage(currentPackage(), other)).state, "completed");
  const [done] = await sync.listStatus([currentPackage()], other); assert.equal(done.state, "completed");
  const attempts = f.database.getBatchSyncEvent(published.event.event_id).attempts;
  await sync.retryPackage(currentPackage(), other);
  assert.equal(f.database.getBatchSyncEvent(published.event.event_id).attempts, attempts);
  assert.equal(fs.readFileSync(f.watcher.eventFile, "utf8").trim().split("\n").length, 1);
});

test("old receipts cannot certify a changed pair, type or revision, and wrong-library retry is rejected", async t => {
  const f = await fixture(t), item = currentPackage();
  const event = bridge.buildIngestEvent(result());
  await team.request(f.config, "POST", "/v1/events", event); await f.watcher.runOnce();
  for (const changed of [{ ...item, preview: { id: "new-png" } }, { ...item, packageType: "信息条" }, { ...item, meta: { revision_id: "new-revision" } }]) {
    assert.equal((await sync.listStatus([changed], { config: f.config }))[0].state, "unknown");
    await assert.rejects(team.request(f.config, "POST", "/v1/retry-package-sync", { libraryPath: f.root, package: bridge.packageSyncIdentity(changed), eventId: event.event_id }), /不一致/u);
  }
  await assert.rejects(sync.retryPackage(item, { config: f.config, libraryPath: "other.library" }), /不一致/u);
  await assert.rejects(team.request(f.config, "POST", "/v1/package-sync-status", { libraryPath: "other", packages: [bridge.packageSyncIdentity(item)] }), /不一致/u);
  const replaced = bridge.buildIngestEvent({ ...result(), filed: [{ ...result().filed[0], previewItemId: "new-png", revisionId: "new-revision" }] });
  const mixedAnnotations = { ...item, preview: { id: "new-png", annotation: "revision_id: new-revision" }, source: { id: "zip", annotation: "revision_id: old-revision" }, meta: { revision_id: "old-revision" } };
  assert.equal(bridge.eventMatchesPackage(replaced, bridge.packageSyncIdentity(mixedAnnotations)), true);
  assert.equal(bridge.eventMatchesPackage(event, bridge.packageSyncIdentity(mixedAnnotations)), false);
  f.database.replaceCatalog([], []);
  assert.equal((await sync.listStatus([item], { config: f.config }))[0].state, "unknown", "an old completion cannot hide a now-missing catalog mapping");
});

test("offline local notices remain retryable; unobserved old packages never get a success badge", async t => {
  const f = await fixture(t), outboxDir = path.join(f.root, "offline-outbox"), offline = { ...f.config, url: "http://127.0.0.1:1" };
  await sync.publish(result(), { config: offline, outboxDir });
  assert.equal((await sync.listStatus([currentPackage()], { config: offline, outboxDir }))[0].state, "failed");
  assert.equal((await sync.listStatus([{ ...currentPackage(), packageId: "legacy" }], { config: f.config, outboxDir }))[0].state, "unknown");
  assert.equal((await sync.listStatus([{ ...currentPackage(), packageId: "legacy" }], { config: offline, outboxDir }))[0].state, "unavailable");
  assert.equal((await sync.listStatus([currentPackage()], { config: f.config, outboxDir }))[0].state, "unknown");
});

test("local mode retries only the selected matching notice and keeps unknown receipts unverified", async t => {
  const f = await fixture(t), outboxDir = path.join(f.root, "local-outbox"), filePath = path.join(f.root, "local-events.jsonl");
  fs.mkdirSync(outboxDir);
  const event = bridge.buildIngestEvent(result()), unrelated = bridge.buildIngestEvent({ ...result(), batchId: "other", filed: [{ ...result().filed[0], packageId: "other" }] });
  for (const e of [event, unrelated]) fs.writeFileSync(path.join(outboxDir, `${e.event_id}.json`), JSON.stringify({ event: e, filePath }));
  const options = { config: { mode: "local" }, outboxDir, filePath };
  assert.equal((await sync.listStatus([currentPackage()], options))[0].state, "failed");
  assert.equal((await sync.retryPackage(currentPackage(), options)).state, "queued");
  assert.equal(fs.existsSync(path.join(outboxDir, `${unrelated.event_id}.json`)), true);
  assert.equal(fs.readFileSync(filePath, "utf8").trim().split("\n").length, 1);
});
test("a crash-truncated queue tail cannot swallow the next retry event", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xbot-torn-queue-")), file = path.join(root, "events.jsonl");
  try {
    fs.writeFileSync(file, '{"unfinished":');
    const event = bridge.buildIngestEvent(result()); appendDurably(file, event);
    const events = require("../bot/lib/ingest-sync").readIngestEvents(file);
    assert.equal(events[0]._invalid, true); assert.equal(events[1].event_id, event.event_id);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xbot-team-"));
  const database = new PackageDatabase(path.join(root, "index.sqlite"));
  let indexed = true, refreshes = 0;
  const watcher = new IngestEventWatcher({ database, eventFile: path.join(root, "events.jsonl"), refreshCatalog: async () => {
    refreshes++;
    database.replaceCatalog([{ project_id: "project", project_name: "团队项目", normalized_name: "团队项目", aliases: [] }], indexed ? [{ package_id: "p", project_id: "project", package_name: "背景", package_type: "背景", version: "v01", preview_eagle_id: "png", source_eagle_id: "zip", preview_path: "server-preview.png", source_path: "server-source.zip", status: "active", tags: [], dependency_status: "complete" }] : []);
    return { package_count: indexed ? 1 : 0 };
  } });
  const token = "t".repeat(40), lockFile = path.join(root, "write-lock.json");
  const server = createTeamIngestServer({ watcher, token, libraryPath: root, lockFile });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const config = { mode: "team", url: `http://127.0.0.1:${server.address().port}`, token, libraryPath: root };
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); watcher.stop(); database.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, database, watcher, server, config, lockFile, setIndexed: value => { indexed = value; }, refreshes: () => refreshes };
}

test("team HTTP persists, verifies Eagle pairs, deduplicates and acknowledges completion; rejects unauthorized and malformed events", async t => {
  const f = await fixture(t), event = bridge.buildIngestEvent(result());
  await assert.rejects(team.request({ ...f.config, token: "wrong" }, "GET", "/v1/health"), /密钥/u);
  await assert.rejects(team.request(f.config, "POST", "/v1/events", { ...event, event_id: "bad" }), /摘要/u);
  assert.equal(fs.existsSync(f.watcher.eventFile), false);
  const reply = await team.request(f.config, "POST", "/v1/events", event);
  assert.equal(reply.state, "queued");
  await f.watcher.runOnce();
  assert.equal((await team.request(f.config, "GET", `/v1/events/${event.event_id}`)).state, "completed");
  await team.request(f.config, "POST", "/v1/events", event);
  assert.equal(f.refreshes(), 1);
  assert.equal(fs.readFileSync(f.watcher.eventFile, "utf8").trim().split("\n").length, 1);
  assert.equal(f.database.getBatch("team-batch").details[0].preview_path, "server-preview.png");
});

test("missing Eagle item stays failed; client keeps outbox until a verified receipt, including after a connection outage", async t => {
  const f = await fixture(t), outboxDir = path.join(f.root, "outbox");
  f.setIndexed(false);
  const published = await sync.publish(result(), { config: f.config, outboxDir });
  await f.watcher.runOnce();
  assert.equal(f.database.getBatchSyncEvent(published.event.event_id).status, "failed");
  assert.equal(fs.existsSync(published.recoveryPath), true);
  assert.equal(f.database.getBatch("team-batch"), null);
  f.setIndexed(true);
  await f.watcher.runOnce();
  const completed = await sync.retry({ config: f.config, outboxDir });
  assert.equal(completed[0].state, "completed"); assert.equal(fs.existsSync(published.recoveryPath), false);
  const offline = await sync.publish({ ...result(), batchId: "offline" }, { config: { ...f.config, url: "http://127.0.0.1:1" }, outboxDir });
  assert.equal(offline.state, "pending"); assert.equal(fs.existsSync(offline.recoveryPath), true);
  const mismatch = await sync.retry({ config: f.config, outboxDir });
  assert.match(mismatch[0].error, /其他团队/u);
  const port = f.server.address().port;
  f.server.closeAllConnections(); await new Promise(resolve => f.server.close(resolve));
  const interrupted = await sync.publish({ ...result(), batchId: "network-outage" }, { config: f.config, outboxDir });
  assert.equal(interrupted.state, "pending");
  f.server.listen(port, "127.0.0.1"); await once(f.server, "listening");
  await sync.retry({ config: f.config, outboxDir }); await f.watcher.runOnce();
  const recovered = await sync.retry({ config: f.config, outboxDir });
  assert.equal(recovered.find(item => item.event?.event_id === interrupted.event.event_id).state, "completed");
  assert.equal(fs.existsSync(interrupted.recoveryPath), false);
});

test("global write lock excludes another terminal, rejects wrong release, and survives server restart", async t => {
  const f = await fixture(t);
  const lock = await team.request(f.config, "POST", "/v1/write-lock", { owner: "A" });
  await assert.rejects(team.request(f.config, "POST", "/v1/write-lock", { owner: "B" }), /其他终端/u);
  await assert.rejects(team.request(f.config, "DELETE", "/v1/write-lock", { id: "wrong" }), /不属于/u);
  const second = createTeamIngestServer({ watcher: f.watcher, token: f.config.token, libraryPath: f.root, lockFile: f.lockFile });
  second.listen(0, "127.0.0.1"); await once(second, "listening");
  try { await assert.rejects(team.request({ ...f.config, url: `http://127.0.0.1:${second.address().port}` }, "POST", "/v1/write-lock", { owner: "B" }), /其他终端/u); }
  finally { await new Promise(resolve => second.close(resolve)); }
  await team.request(f.config, "DELETE", "/v1/write-lock", lock);
  assert.equal(fs.existsSync(f.lockFile), false);
});

test("configuration rejects credentials in URLs and mapped drives; unconfigured or wrong-library clients cannot mutate", async () => {
  const config = { mode: "team", url: "http://example.local:41596", token: "x".repeat(32), libraryPath: "\\\\server\\share\\包装.library" };
  assert.equal(team.validateConfig(config).mode, "team");
  assert.throws(() => team.validateConfig({ ...config, url: "http://user:pass@example.local" }));
  assert.throws(() => team.validateConfig({ ...config, libraryPath: "Z:\\包装.library" }));
  let calls = 0;
  await assert.rejects(team.withTeamWrite({}, () => { calls++; }, { mode: "local", unconfigured: true }), /先在设置/u);
  await assert.rejects(team.withTeamWrite({ library: { path: "C:\\wrong.library" } }, () => { calls++; }, config), /不一致/u);
  assert.equal(calls, 0);
  const original = { packageId: "p", version: "v01", packageType: "背景", preview: { id: "png", annotation: "revision: old" } };
  assert.throws(() => team.assertUnchanged(original, { ...original, preview: { id: "png", annotation: "revision: new" } }), /被其他人/u);
});

test("local writes reject mapped/UNC/unknown drives and permit a verified local disk", async () => {
  let calls = 0;
  const action = async () => { calls++; return {}; };
  const local = { mode: "local" };
  const drive = type => ({ platform: "win32", inspectDrive: async () => type });
  await assert.rejects(team.withTeamWrite({ library: { path: "Z:\\包装.library" } }, action, local, drive(4)), /映射共享盘/u);
  await assert.rejects(team.withTeamWrite({ library: { path: "\\\\server\\share\\包装.library" } }, action, local, drive(3)), /共享库/u);
  await assert.rejects(team.withTeamWrite({ library: { path: "Z:\\包装.library" } }, action, local, drive(0)), /无法确认/u);
  await assert.rejects(team.withTeamWrite({ library: { path: "Z:\\包装.library" } }, action, local,
    { platform: "win32", inspectDrive: async () => { throw new Error("WMI unavailable"); } }), /无法核验/u);
  assert.equal(calls, 0);
  await team.withTeamWrite({ library: { path: "C:\\包装.library" } }, action, local, drive(3));
  assert.equal(calls, 1);
});

test("a successful team write releases the lock; partial failure retains it; clients cannot edit team types", async t => {
  const f = await fixture(t);
  const previous = { config: process.env.XBOT_TEAM_CONFIG, types: process.env.XBOT_PACKAGE_TYPES_FILE, readonly: process.env.XBOT_TEAM_READONLY_TYPES };
  process.env.XBOT_TEAM_CONFIG = path.join(f.root, "client", "team.json");
  t.after(() => { for (const [key, value] of [["XBOT_TEAM_CONFIG", previous.config], ["XBOT_PACKAGE_TYPES_FILE", previous.types], ["XBOT_TEAM_READONLY_TYPES", previous.readonly]]) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const eagle = { library: { path: f.root } };
  assert.deepEqual(await team.withTeamWrite(eagle, async () => ({ ok: true }), f.config), { ok: true });
  assert.equal(fs.existsSync(f.lockFile), false);
  const types = require("../eagle-plugin/lib/package-types");
  assert.throws(() => types.registerPackageType("禁止客户端新增"), /维护者/u);
  await assert.rejects(team.withTeamWrite(eagle, async () => { throw new Error("second item failed"); }, f.config), /核对结果后解锁/u);
  assert.equal(fs.existsSync(f.lockFile), true);
});


test("team members centrally create and edit types; stale edits, conflicts and foreign libraries fail", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xbot-type-edit-"));
  const previous = process.env.XBOT_PACKAGE_TYPES_FILE;
  process.env.XBOT_PACKAGE_TYPES_FILE = path.join(root, "central-types.json");
  t.after(() => { if (previous === undefined) delete process.env.XBOT_PACKAGE_TYPES_FILE; else process.env.XBOT_PACKAGE_TYPES_FILE = previous; fs.rmSync(root, { recursive: true, force: true }); });
  const f = await fixture(t);
  const post = body => team.request(f.config, "POST", "/v1/types", { libraryPath: f.config.libraryPath, ...body });
  const list = async () => (await team.request(f.config, "GET", "/v1/types")).types;
  const created = await post({ action: "create", name: "章节标题", aliases: ["章节名"] });
  assert.equal(created.name, "章节标题");
  const before = (await list()).find(type => type.name === "章节标题");
  const edited = await post({ action: "update", currentName: before.name, expected: before, name: "章节页", aliases: ["章节名"], enabled: false });
  assert.equal(edited.types.find(type => type.name === "章节页").enabled, false);
  assert.ok(edited.types.find(type => type.name === "章节页").aliases.includes("章节标题"));
  await assert.rejects(post({ action: "update", currentName: before.name, expected: before, name: "覆盖" }), /其他人修改/u);
  const disabled = (await list()).find(type => type.name === "章节页");
  await post({ action: "update", currentName: disabled.name, expected: disabled, name: disabled.name, enabled: true });
  const builtin = (await list()).find(type => type.name === "背景");
  await post({ action: "update", currentName: builtin.name, expected: builtin, name: builtin.name, aliases: [...builtin.aliases, "底图"] });
  const updated = (await list()).find(type => type.name === "背景");
  assert.ok(updated.aliases.includes("底图"));
  await assert.rejects(post({ action: "update", currentName: updated.name, expected: builtin, name: updated.name, enabled: false }), /其他人修改/u);
  const renamed = await post({ action: "update", currentName: updated.name, expected: updated, name: "背景改名", aliases: updated.aliases });
  assert.ok(renamed.types.find(type => type.name === "背景改名").aliases.includes("背景"));
  assert.equal(renamed.types.some(type => type.name === "背景"), false);
  assert.equal(require("../eagle-plugin/lib/package-types").isBackgroundType("背景改名"), true);
  await assert.rejects(post({ action: "create", name: "新类型", aliases: ["底图"] }), /冲突/u);
  await assert.rejects(post({ action: "create", name: "../路径" }), /名称无效/u);
  await assert.rejects(post({ action: "create", name: "外库", libraryPath: "other.library" }), /素材库/u);
  await assert.rejects(team.request({ ...f.config, token: "bad" }, "POST", "/v1/types", { action: "create", name: "无权限" }), /密钥/u);
  assert.equal(fs.existsSync(f.lockFile), false, "type edits do not alter Eagle write locks");
  const oldConfig = process.env.XBOT_TEAM_CONFIG, oldReadonly = process.env.XBOT_TEAM_READONLY_TYPES;
  process.env.XBOT_TEAM_CONFIG = path.join(root, "client", "team.json");
  try {
    assert.equal(await team.mutateType({ action: "create", name: "客户端类型", aliases: ["客户端别名"] }, f.config), "客户端类型");
    assert.ok(JSON.parse(fs.readFileSync(path.join(root, "client", "team-types.json"))).some(type => type.name === "客户端类型"));
    assert.ok((await list()).some(type => type.name === "客户端类型"));
    assert.throws(() => require("../eagle-plugin/lib/package-types").registerPackageType("绕过中央"), /维护者/u);
  } finally {
    if (oldConfig === undefined) delete process.env.XBOT_TEAM_CONFIG; else process.env.XBOT_TEAM_CONFIG = oldConfig;
    if (oldReadonly === undefined) delete process.env.XBOT_TEAM_READONLY_TYPES; else process.env.XBOT_TEAM_READONLY_TYPES = oldReadonly;
  }

});
