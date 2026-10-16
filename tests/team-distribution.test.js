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
