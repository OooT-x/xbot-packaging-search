const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { acquireListenerLock } = require("../bot/lib/runtime-lock");

test("refuses a live listener and recovers a dead listener lock", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xbot-lock-"));
  const file = path.join(root, "bot.lock");
  try {
    const release = acquireListenerLock(file);
    assert.throws(() => acquireListenerLock(file), /already running/);
    release();
    fs.writeFileSync(file, JSON.stringify({pid: 1234, token: "old"}));
    const recovered = acquireListenerLock(file, { processAlive: () => false });
    assert.equal(JSON.parse(fs.readFileSync(file)).pid, process.pid);
    recovered(); assert.equal(fs.existsSync(file), false);
    fs.writeFileSync(file, "");
    assert.throws(() => acquireListenerLock(file), /unreadable/);
  } finally { fs.rmSync(root, {recursive:true, force:true}); }
});
