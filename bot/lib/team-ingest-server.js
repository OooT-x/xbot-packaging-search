const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { stableEventId } = require("../../eagle-plugin/lib/ingest-bridge");
const { readIngestEvents } = require("./ingest-sync");
const { listPackageTypes } = require("../../eagle-plugin/lib/package-types");

function validateEvent(event) {
  if (!event || event.schema_version !== 1 || event.event_type !== "eagle.batch.filed" || !event.batch || !Array.isArray(event.details) || !event.details.length || event.details.length > 500) throw new Error("事件结构无效");
  const text = value => typeof value === "string" && value.length > 0 && value.length <= 300;
  if (!text(event.batch.batch_id) || !text(event.batch.project_name) || !["new", "reuse", "update"].includes(event.batch.import_mode)) throw new Error("批次信息无效");
  const ids = new Set();
  for (const item of event.details) {
    if (!text(item.package_id) || ids.has(item.package_id) || !text(item.package_name) || !text(item.package_type) || !text(item.preview_eagle_id) || (!text(item.source_eagle_id) && item.package_type !== "背景")) throw new Error("包装配对信息无效");
    ids.add(item.package_id);
  }
  if (event.event_id !== stableEventId({ batch: event.batch, details: event.details })) throw new Error("事件摘要不一致");
  return event;
}
function appendDurably(file, event) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, "a+");
  try {
    const size = fs.fstatSync(fd).size;
    if (size) { const last = Buffer.alloc(1); fs.readSync(fd, last, 0, 1, size - 1); if (last[0] !== 10) fs.writeFileSync(fd, "\n"); }
    fs.writeFileSync(fd, JSON.stringify(event) + "\n"); fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}
function createTeamIngestServer({ watcher, libraryPath, token, lockFile, log = () => {} }) {
  if (!watcher || !libraryPath || typeof token !== "string" || token.length < 32 || !lockFile) throw new Error("团队服务缺少库路径、密钥或锁文件配置");
  const secret = Buffer.from(`Bearer ${token}`);
  const queued = new Set(readIngestEvents(watcher.eventFile).map(event => event.event_id).filter(Boolean));
  const reply = (res, status, data) => { res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); res.end(JSON.stringify(data)); };
  const server = http.createServer(async (req, res) => {
    const auth = Buffer.from(req.headers.authorization || "");
    if (auth.length !== secret.length || !crypto.timingSafeEqual(auth, secret)) { req.resume(); return reply(res, 401, { error: "连接密钥无效" }); }
    try {
      if (req.method === "GET" && req.url === "/v1/health") {
        fs.accessSync(libraryPath, fs.constants.R_OK);
        return reply(res, 200, { state: "ready", libraryPath, writeLocked: fs.existsSync(lockFile) });
      }
      if (req.method === "GET" && req.url === "/v1/types") return reply(res, 200, { types: listPackageTypes() });
      if (req.method === "GET" && /^\/v1\/events\/ingest-[a-f0-9]{24}$/u.test(req.url)) {
        const record = watcher.database.getBatchSyncEvent(req.url.split("/").pop());
        return reply(res, 200, { state: record?.status || "unknown" });
      }
      const routes = ["POST /v1/events", "POST /v1/write-lock", "DELETE /v1/write-lock"];
      if (!routes.includes(`${req.method} ${req.url}`)) { req.resume(); return reply(res, 404, { error: "接口不存在" }); }
      let bytes = 0; const chunks = [];
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 1024 * 1024) { reply(res, 413, { error: "请求过大" }); req.destroy(); return; } chunks.push(chunk); }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return reply(res, 400, { error: "JSON 无效" }); }
      if (req.url === "/v1/write-lock") {
        fs.mkdirSync(path.dirname(lockFile), { recursive: true });
        if (req.method === "POST") {
          const lock = { id: crypto.randomUUID(), owner: String(body.owner || "未知终端").slice(0, 100), createdAt: new Date().toISOString() };
          try { fs.writeFileSync(lockFile, JSON.stringify(lock), { flag: "wx", mode: 0o600 }); }
          catch (error) { if (error.code === "EEXIST") return reply(res, 409, { error: "其他终端正在保存；若已中断，请维护者核对后解锁" }); throw error; }
          return reply(res, 201, lock);
        }
        if (!fs.existsSync(lockFile)) return reply(res, 200, { state: "released" });
        if (JSON.parse(fs.readFileSync(lockFile, "utf8")).id !== body.id) return reply(res, 409, { error: "写入锁不属于本次操作" });
        fs.unlinkSync(lockFile); return reply(res, 200, { state: "released" });
      }
      try { validateEvent(body); } catch (error) { return reply(res, 400, { error: error.message }); }
      // Queue before acknowledging. The existing watcher is the sole mapping writer.
      const existing = watcher.database.getBatchSyncEvent(body.event_id);
      if (existing && JSON.stringify(JSON.parse(existing.payload_json).batch) !== JSON.stringify(body.batch)) return reply(res, 409, { error: "事件编号冲突" });
      if (existing?.status !== "completed" && !queued.has(body.event_id)) {
        appendDurably(watcher.eventFile, { ...body, _team: true }); queued.add(body.event_id);
      }
      reply(res, 202, { state: existing?.status === "completed" ? "completed" : "queued", eventId: body.event_id });
      watcher.runOnce().catch(error => log(`team ingest scan failed: ${error.message}`));
    } catch (error) {
      log(`team ingest request failed: ${error.code || "internal"}`);
      if (!res.headersSent) reply(res, 500, { error: "服务暂时无法处理，请重试" }); else res.end();
    }
  });
  server.headersTimeout = 15000; server.requestTimeout = 20000; server.timeout = 20000;
  return server;
}
module.exports = { createTeamIngestServer, validateEvent, appendDurably };
