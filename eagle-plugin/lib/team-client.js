const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const https = require("https");
const { execFile } = require("child_process");

function inspectWindowsDrive(drive) {
  return new Promise((resolve, reject) => {
    const executable = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const command = "$ErrorActionPreference='Stop'; [int]([System.IO.DriveInfo]::new($env:XBOT_CHECK_DRIVE).DriveType)";
    execFile(executable, ["-NoProfile", "-NonInteractive", "-Command", command], {
      windowsHide: true, timeout: 10000, maxBuffer: 4096,
      env: { ...process.env, XBOT_CHECK_DRIVE: drive },
    }, (error, stdout) => error ? reject(error) : resolve(Number(stdout.trim())));
  });
}

async function assertLocalLibrary(libraryPath, options = {}) {
  const value = String(libraryPath || "").replace(/\//gu, "\\");
  if (!value) throw new Error("无法核验当前素材库路径，未开始写入");
  // Resolve junctions/SUBST where possible; never rely on the visible drive letter alone.
  let resolved = value;
  try { resolved = fs.realpathSync.native(value); } catch { /* Drive inspection below fails closed. */ }
  const plain = resolved.replace(/^\\\\\?\\/u, "");
  if (value.startsWith("\\\\") || plain.startsWith("\\\\") || /^UNC\\/iu.test(plain)) {
    throw new Error("共享库请选择团队入库模式，并使用 UNC 路径打开");
  }
  if ((options.platform || process.platform) !== "win32") return;
  const drive = plain.match(/^([a-z]:)\\/iu)?.[1];
  if (!drive) throw new Error("无法核验素材库所在磁盘，请使用 UNC 团队模式");
  let type;
  try { type = await (options.inspectDrive || inspectWindowsDrive)(drive.toUpperCase()); }
  catch { throw new Error("无法核验磁盘是否为共享映射盘，请使用 UNC 团队模式或检查本地磁盘"); }
  if (type === 4) throw new Error("映射共享盘不能使用单机模式，请以 UNC 路径打开并选择团队入库模式");
  if (![2, 3, 5, 6].includes(type)) throw new Error("无法确认本地磁盘类型，未开始写入");
}

function configPath() {
  return process.env.XBOT_TEAM_CONFIG || path.join(process.env.APPDATA || os.homedir(), "XbotPackaging", "team.json");
}
function validateConfig(input) {
  if (input.mode === "local") return { mode: "local" };
  if (input.mode !== "team") throw new Error("请选择单机或团队模式");
  const url = new URL(input.url);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("服务地址只填写 http(s)://主机:端口");
  if (typeof input.token !== "string" || input.token.length < 32 || /[\r\n]/u.test(input.token)) throw new Error("连接密钥至少需要 32 个字符");
  const libraryPath = String(input.libraryPath || "").trim();
  if (!libraryPath.startsWith("\\\\") || !/\.library[\\/]?$/iu.test(libraryPath)) throw new Error("团队库请填写完整 UNC 路径，不能使用映射盘符");
  return { mode: "team", url: url.origin, token: input.token, libraryPath };
}
function readConfig() {
  if (!fs.existsSync(configPath())) return { mode: "local", unconfigured: true };
  return validateConfig(JSON.parse(fs.readFileSync(configPath(), "utf8")));
}
function saveConfig(config) {
  const validated = validateConfig(config), file = configPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  try { fs.writeFileSync(temp, JSON.stringify(validated, null, 2), { mode: 0o600 }); fs.renameSync(temp, file); }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  return validated;
}
function request(config, method, route, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(route, config.url), payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = (url.protocol === "https:" ? https : http).request({
      protocol: url.protocol, hostname: url.hostname, port: url.port, path: url.pathname,
      method, headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json", ...(payload ? { "Content-Length": payload.length } : {}) },
    }, res => {
      let size = 0; const chunks = [];
      res.on("data", chunk => { size += chunk.length; if (size > 1024 * 1024) res.destroy(new Error("服务响应过大")); else chunks.push(chunk); });
      res.on("error", reject);
      res.on("end", () => {
        try { const data = JSON.parse(Buffer.concat(chunks).toString("utf8")); if (res.statusCode < 200 || res.statusCode >= 300) throw new Error(data.error || `服务返回 ${res.statusCode}`); resolve(data); }
        catch (error) { reject(error); }
      });
    });
    req.setTimeout(10000, () => req.destroy(new Error("连接超时，请检查服务和网络")));
    req.on("error", reject); if (payload) req.write(payload); req.end();
  });
}
function sameLibrary(a, b) { return String(a || "").replace(/\//gu, "\\").replace(/\\+$/u, "").toLowerCase() === String(b || "").replace(/\//gu, "\\").replace(/\\+$/u, "").toLowerCase(); }
function assertUnchanged(before, after) {
  if (!after || JSON.stringify(recordIdentity(before)) !== JSON.stringify(recordIdentity(after))) throw new Error("包装已被其他人修改，请刷新后重新操作");
  return after;
}
function recordIdentity(record) {
  return [record.packageId, record.version, record.packageType, record.preview?.id, record.source?.id,
    record.preview?.annotation, record.source?.annotation];
}
const originalTypeFile = process.env.XBOT_PACKAGE_TYPES_FILE;
async function refreshTypes(config = readConfig()) {
  if (config.mode !== "team") {
    if (originalTypeFile) process.env.XBOT_PACKAGE_TYPES_FILE = originalTypeFile;
    else delete process.env.XBOT_PACKAGE_TYPES_FILE;
    delete process.env.XBOT_TEAM_READONLY_TYPES;
    return;
  }
  const file = path.join(path.dirname(configPath()), "team-types.json");
  process.env.XBOT_PACKAGE_TYPES_FILE = file;
  process.env.XBOT_TEAM_READONLY_TYPES = "1";
  const data = await request(config, "GET", "/v1/types");
  if (!Array.isArray(data.types)) throw new Error("团队类型配置无效");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + ".tmp";
  fs.writeFileSync(temporary, JSON.stringify(data.types)); fs.renameSync(temporary, file);
}
async function mutateType(change, config = readConfig()) {
  const types = require("./package-types");
  if (config.unconfigured) throw new Error("请先设置连接模式");
  if (config.mode !== "team") {
    await refreshTypes(config);
    return change.action === "create" ? types.registerPackageType(change.name, change.aliases || []) : types.updatePackageType(change.currentName, change);
  }
  const data = await request(config, "POST", "/v1/types", { ...change, libraryPath: config.libraryPath });
  await refreshTypes(config);
  return data.name;
}
async function preflight(config, eagle) {
  if (config.unconfigured) throw new Error("请先在设置中选择单机或团队模式");
  if (config.mode !== "team") return null;
  if (!sameLibrary(eagle?.library?.path, config.libraryPath)) throw new Error("当前 Eagle 库与团队库不一致，请用 UNC 路径打开团队库");
  const health = await request(config, "GET", "/v1/health");
  if (!sameLibrary(health.libraryPath, config.libraryPath)) throw new Error("服务端素材库与团队配置不一致");
  return health;
}
async function withTeamWrite(eagle, action, config = readConfig(), options = {}) {
  await preflight(config, eagle);
  if (config.mode !== "team") {
    await assertLocalLibrary(eagle?.library?.path, options);
    return action();
  }
  await refreshTypes(config);
  const lock = await request(config, "POST", "/v1/write-lock", { owner: os.hostname() });
  // On failure keep the durable lock: the Eagle write may have partially completed.
  let result;
  try { result = await action(); }
  catch (error) { throw new Error(`${error.message}。团队写入已暂停，请维护者核对结果后解锁`); }
  try { await request(config, "DELETE", "/v1/write-lock", { id: lock.id }); }
  catch { result.teamLockWarning = "保存已完成，写入锁释放失败，请维护者核对后解锁"; }
  return result;
}
module.exports = { mutateType, configPath, validateConfig, readConfig, saveConfig, request, sameLibrary, preflight, withTeamWrite, refreshTypes, assertUnchanged, assertLocalLibrary, inspectWindowsDrive };
