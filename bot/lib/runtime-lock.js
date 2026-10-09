const fs = require("node:fs");
const crypto = require("node:crypto");

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== "ESRCH"; }
}

function acquireListenerLock(filePath, options = {}) {
  const alive = options.processAlive || processAlive;
  const token = crypto.randomUUID();
  for (let attempt = 0; attempt < 3; attempt++) {
    let fd;
    try { fd = fs.openSync(filePath, "wx"); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      let previous;
      try { previous = JSON.parse(fs.readFileSync(filePath, "utf8")); }
      catch { throw new Error("listener lock is unreadable; inspect it before restarting"); }
      if (alive(previous.pid)) throw new Error(`listener already running pid=${previous.pid}`);
      // Scheduled Task ignores concurrent starts; do not launch multiple recovery starters.
      fs.unlinkSync(filePath);
      continue;
    }
    try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token })); }
    finally { fs.closeSync(fd); }
    return () => {
      try {
        if (JSON.parse(fs.readFileSync(filePath, "utf8")).token === token) fs.unlinkSync(filePath);
      } catch (error) { if (error.code !== "ENOENT") throw error; }
    };
  }
  throw new Error("could not acquire listener lock");
}

module.exports = { acquireListenerLock, processAlive };
