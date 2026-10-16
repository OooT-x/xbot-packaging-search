const fs = require("fs");
const path = require("path");
const bridge = require("./ingest-bridge");
const team = require("./team-client");

function pendingDir(options = {}) { return path.join(options.outboxDir || bridge.defaultOutboxDir(), "team"); }
async function deliver(record, file, config) {
  const base = { event: record.event, recoveryPath: file };
  if (config.mode !== "team" || record.url !== config.url || !team.sameLibrary(record.libraryPath, config.libraryPath)) return { ...base, state: "pending", error: "待同步记录属于其他团队配置，请恢复原连接后重试" };
  try {
    const status = await team.request(config, "GET", `/v1/events/${record.event.event_id}`);
    if (status.state === "completed") { fs.unlinkSync(file); return { ...base, state: "completed" }; }
    if (status.state === "processing") return { ...base, state: "queued" };
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
module.exports = { publish, retry, pendingDir };
