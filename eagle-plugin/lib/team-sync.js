const fs = require("fs");
const path = require("path");
const bridge = require("./ingest-bridge");
const team = require("./team-client");
const { appendDurably } = require("./durable-jsonl");

function pendingDir(options = {}) { return path.join(options.outboxDir || bridge.defaultOutboxDir(), "team"); }
async function deliver(record, file, config) {
  const base = { event: record.event, recoveryPath: file };
  if (config.mode !== "team" || record.url !== config.url || !team.sameLibrary(record.libraryPath, config.libraryPath)) return { ...base, state: "pending", error: "待同步记录属于其他团队配置，请恢复原连接后重试" };
  try {
    const status = await team.request(config, "GET", `/v1/events/${record.event.event_id}`);
    if (status.state === "completed") { fs.unlinkSync(file); return { ...base, state: "completed" }; }
    if (status.state === "processing") return { ...base, state: "queued" };
    if (status.state === "failed") {
      await team.request(config, "POST", "/v1/events", record.event);
      return { ...base, state: "failed", error: status.error || "服务端核对失败，请重试" };
    }
    const result = await team.request(config, "POST", "/v1/events", record.event);
    if (result.state === "completed") { fs.unlinkSync(file); return { ...base, state: "completed" }; }
    return { ...base, state: "queued" };
  } catch (error) { return { ...base, state: "pending", error: error.message }; }
}
async function publish(result, options = {}) {
  const config = options.config || team.readConfig();
  if (config.mode !== "team") return bridge.publishIngestEvent(result, options);
  const event = bridge.buildIngestEvent(result);
  if (!event) return { state: "skipped", skipped: true };
  const record = { event, url: config.url, libraryPath: config.libraryPath };
  const dir = pendingDir(options), file = path.join(dir, `${event.event_id}.json`);
  fs.mkdirSync(dir, { recursive: true });
  const temporary = `${file}.${require("crypto").randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temporary, "wx", 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(record)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  return deliver(record, file, config);
}
async function retry(options = {}) {
  const config = options.config || team.readConfig(), dir = pendingDir(options), results = [];
  if (config.mode === "local") results.push(...bridge.retryPendingIngestEvents(options));
  if (!fs.existsSync(dir)) return results;
  for (const name of fs.readdirSync(dir).filter(name => /^ingest-[a-f0-9]{24}\.json$/u.test(name))) {
    const file = path.join(dir, name);
    try {
      const record = JSON.parse(fs.readFileSync(file, "utf8"));
      if (record.event?.event_id !== name.slice(0, -5)) throw new Error("待同步记录无效");
      results.push(await deliver(record, file, config));
    } catch (error) { results.push({ state: "pending", recoveryPath: file, error: error.message }); }
  }
  return results;
}
function readPending(options = {}) {
  const records = [], config = options.config || team.readConfig();
  const dirs = config.mode === "team" ? [pendingDir(options)] : [options.outboxDir || bridge.defaultOutboxDir()];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir).filter(name => /^ingest-[a-f0-9]{24}\.json$/u.test(name))) {
      try {
        const record = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
        if (record.event?.event_id !== name.slice(0, -5)) continue;
        if (config.mode === "team" && (record.url !== config.url || !team.sameLibrary(record.libraryPath, config.libraryPath))) continue;
        records.push({ ...record, recoveryPath: path.join(dir, name) });
      } catch { /* Keep corrupt records for diagnostics; never send guessed data. */ }
    }
  }
  return records;
}
async function listStatus(packages, options = {}) {
  const config = options.config || team.readConfig(), identities = packages.map(bridge.packageSyncIdentity);
  const pending = readPending({ ...options, config });
  let remote = [], error = "";
  if (config.mode === "team") {
    try {
      if (options.libraryPath && !team.sameLibrary(options.libraryPath, config.libraryPath)) throw new Error("当前 Eagle 库与团队库不一致");
      for (let offset = 0; offset < identities.length; offset += 500) {
        const result = await team.request(config, "POST", "/v1/package-sync-status", { libraryPath: config.libraryPath, packages: identities.slice(offset, offset + 500) });
        if (!Array.isArray(result.packages)) throw new Error("同步状态响应无效");
        remote.push(...result.packages);
      }
    } catch (cause) { error = cause.message; }
  }
  const localFile = options.filePath || bridge.defaultEventFile();
  const localEvents = config.mode === "local" && fs.existsSync(localFile) ? fs.readFileSync(localFile, "utf8").split(/\r?\n/u).flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  }) : [];
  return identities.map(identity => {
    const record = pending.findLast(item => bridge.eventMatchesPackage(item.event, identity));
    const status = remote.find(item => item.packageId === identity.package_id);
    if (status && status.state !== "unknown") return { ...status, state: status.state === "processing" ? "queued" : status.state };
    if (record) return { packageId: identity.package_id, eventId: record.event.event_id, state: error || config.mode === "local" ? "failed" : "queued", error: error || (config.mode === "local" ? "入库通知尚未提交，可重试同步" : ""), local: true };
    if (config.mode === "local" && localEvents.some(event => bridge.eventMatchesPackage(event, identity))) return { packageId: identity.package_id, state: "queued", error: "单机模式待机器人核对" };
    return { packageId: identity.package_id, state: error ? "unavailable" : "unknown", error };
  });
}
async function retryPackage(item, options = {}) {
  const config = options.config || team.readConfig(), identity = bridge.packageSyncIdentity(item);
  if (config.mode === "team" && options.libraryPath && !team.sameLibrary(options.libraryPath, config.libraryPath)) throw new Error("当前 Eagle 库与团队库不一致");
  const records = readPending({ ...options, config }).filter(record => bridge.eventMatchesPackage(record.event, identity));
  for (const record of records) {
    if (config.mode === "team") await deliver(record, record.recoveryPath, config);
    else {
      fs.mkdirSync(path.dirname(record.filePath), { recursive: true });
      appendDurably(record.filePath, record.event);
      fs.unlinkSync(record.recoveryPath);
    }
  }
  const [status] = await listStatus([item], { ...options, config });
  if (config.mode === "team" && status.eventId && status.state !== "completed") {
    await team.request(config, "POST", "/v1/retry-package-sync", { libraryPath: config.libraryPath, package: identity, eventId: status.eventId });
  }
  return (await listStatus([item], { ...options, config }))[0];
}
module.exports = { publish, retry, pendingDir, listStatus, retryPackage };
