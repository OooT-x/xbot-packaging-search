const fs = require("fs");
const path = require("path");

function teamServerConfig(env = process.env, file = path.join(__dirname, "..", "..", "config", "team-server.local.json")) {
  const saved = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  const token = env.XBOT_TEAM_TOKEN || saved.token;
  if (!token) return null;
  const port = Number(env.XBOT_TEAM_PORT || saved.port || 41596);
  const host = env.XBOT_TEAM_HOST || saved.host || "127.0.0.1";
  if (typeof token !== "string" || token.length < 32 || /[\r\n]/u.test(token)) throw new Error("团队服务密钥无效");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("团队服务端口无效");
  return { token, port, host };
}
module.exports = { teamServerConfig };
