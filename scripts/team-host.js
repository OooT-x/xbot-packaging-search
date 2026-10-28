const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { teamServerConfig } = require("../bot/lib/team-server-config");
const { configuredLibraryPath } = require("../bot/lib/library-config");
const { request } = require("../eagle-plugin/lib/team-client");

async function run(args = process.argv.slice(2)) {
  const [command, ...rest] = args, options = new Map();
  for (let i = 0; i < rest.length; i += 2) {
    if (!rest[i].startsWith("--") || !rest[i + 1]) throw new Error("参数必须成对填写");
    options.set(rest[i], rest[i + 1]);
  }
  const file = path.join(__dirname, "..", "config", "team-server.local.json");
  if (command === "init") {
    const host = options.get("--host");
    if (!/^(?:192\.168\.|10\.|172\.(?:1[6-9]|2\d|3[01])\.|127\.)/u.test(host || "") || require("net").isIP(host) !== 4) throw new Error("请明确填写本机局域网 IPv4 地址");
    const config = { host, port: 41596, token: crypto.randomBytes(32).toString("hex") };
    fs.writeFileSync(file, JSON.stringify(config, null, 2), { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ configFile: file, address: `http://${host}:41596`, activated: false })); return;
  }
  const config = teamServerConfig();
  if (!config) throw new Error("尚未配置团队服务，先执行 init --host 局域网IP");
  if (command === "status") {
    console.log(JSON.stringify(await request({ ...config, url: `http://${config.host}:${config.port}` }, "GET", "/v1/health"))); return;
  }
  if (command === "export") {
    const output = options.get("--output");
    if (!output) throw new Error("填写 --output 私密连接文件路径");
    const client = { mode: "team", url: `http://${config.host}:${config.port}`, token: config.token, libraryPath: configuredLibraryPath("") };
    if (!client.libraryPath) throw new Error("尚未配置团队库");
    fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(client, null, 2), { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ connectionFile: path.resolve(output), containsSecret: true })); return;
  }
  if (command === "unlock") {
    if (options.get("--verified") !== "yes") throw new Error("先核对 Eagle 实际结果、事件和正在进行的入库，再填写 --verified yes");
    const runtime = process.env.LARK_BOT_RUNTIME_ROOT || path.join(os.homedir(), "Documents", "飞书");
    const lockFile = path.join(runtime, "team-write-lock.json");
    const lock = JSON.parse(fs.readFileSync(lockFile, "utf8"));
    if (lock.id !== options.get("--lock-id")) throw new Error("锁编号不一致，禁止释放其他操作的锁");
    const audit = path.join(runtime, "team-lock-audit.jsonl");
    fs.appendFileSync(audit, JSON.stringify({ ...lock, reconciledAt: new Date().toISOString() }) + "\n");
    fs.unlinkSync(lockFile); console.log("核对记录已保存，指定写入锁已释放；没有导入素材或发送消息"); return;
  }
  throw new Error("支持 init、status、export、unlock");
}
if (require.main === module) run().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { run };
