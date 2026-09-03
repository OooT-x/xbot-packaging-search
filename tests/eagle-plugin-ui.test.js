const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const htmlPath = path.join(__dirname, "..", "eagle-plugin", "index.html");

test("keeps the formal workspace inside the app shell", () => {
  const html = fs.readFileSync(htmlPath, "utf8");

  assert.doesNotMatch(
    html,
    /<\/div>\s*<\/div><details class="log-drawer"[^>]*>\s*<summary>运行记录<\/summary><div id="log">/
  );
  assert.match(
    html,
    /<details class="log-drawer"><summary>运行记录<\/summary><div id="log">[\s\S]*?<\/details>\s*<\/section>\s*<section class="workspace-view active" id="view-formal">/
  );
  assert.match(html, /<section class="workspace-view" id="view-import" hidden>/);
  assert.match(html, /<section class="workspace-view" id="view-history" hidden>/);
  assert.match(html, /<section class="workspace-view" id="view-diagnostics" hidden>/);
});
