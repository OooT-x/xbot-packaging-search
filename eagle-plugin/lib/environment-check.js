const fs = require("fs");
const path = require("path");
const worker = require("./aep-worker");
function firstFile(candidates) { return candidates.filter(Boolean).find(file => { try { return fs.statSync(file).isFile(); } catch { return false; } }) || null; }
function dependencies() {
  const adobeRoots = [...new Set([process.env.ProgramFiles, process.env.ProgramW6432].filter(Boolean))].map(root => path.join(root, "Adobe"));
  const renderers = [];
  for (const root of adobeRoots) {
    if (!fs.existsSync(root)) continue;
    for (const name of fs.readdirSync(root).filter(name => /^Adobe After Effects /u.test(name)).sort().reverse()) renderers.push(path.join(root, name, "Support Files", "aerender.exe"));
  }
  let workerPath; try { workerPath = worker.resolveWorkerPath(); } catch { workerPath = null; }
  const ffmpeg = process.env.XBOT_FFMPEG_PATH ? firstFile([process.env.XBOT_FFMPEG_PATH.replace(/^"|"$/gu, "")]) : firstFile((process.env.PATH || "").split(path.delimiter).map(dir => path.join(dir, "ffmpeg.exe")));
  const aerender = process.env.XBOT_AERENDER_PATH ? firstFile([process.env.XBOT_AERENDER_PATH.replace(/^"|"$/gu, "")]) : firstFile(renderers);
  return { worker: Boolean(workerPath), aerender: Boolean(aerender), ffmpeg: Boolean(ffmpeg), note: "只检查文件存在；授权、字体、效果和实际渲染需用样例工程核对" };
}
module.exports = { dependencies };
