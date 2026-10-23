const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");
const { pathToFileURL } = require("node:url");

test("production import reaches Eagle instead of the earlier preview capture listener", () => {
  const source = fs.readFileSync(path.join(__dirname, "../eagle-plugin/js/v5-runtime.js"), "utf8");
  const marker = /document\.addEventListener\('click',event=>\{\s*if\(event\.target\.closest\('\[data-action\]'\)\?\.dataset\.action!=='import'\)return;/u;
  const start = source.search(marker);
  const endMarker = "    },true);";
  const end = source.indexOf(endMarker, start) + endMarker.length;
  assert.ok(start >= 0 && end > start);
  let handler;
  let previewWrites = 0;
  const context = {
    document: { addEventListener: (_type, listener) => { handler = listener; } },
    window: { prodWorkbenchReady: true },
    pairs: [{ selected: true, state: "ready" }],
    workflowDraft: null,
    commitPreviewImport: () => { previewWrites++; return null; },
  };
  vm.runInNewContext(source.slice(start, end), context);
  const event = {
    target: { closest: () => ({ dataset: { action: "import" } }) },
    preventDefault() { this.prevented = true; },
    stopImmediatePropagation() { this.stopped = true; },
  };
  let eagleWrites = 0;
  handler(event);
  if (!event.stopped) eagleWrites++;
  assert.equal(previewWrites, 0);
  assert.equal(eagleWrites, 1, "the production capture listener must receive the same click");
  context.window.prodWorkbenchReady = false;
  handler(event);
  assert.equal(previewWrites, 1, "standalone preview retains its simulated behavior");
  assert.equal(event.stopped, true);
});

test("preview URLs preserve UNC authority and encode URL-significant filename characters", () => {
  const source = fs.readFileSync(path.join(__dirname, "../eagle-plugin/js/workbench.js"), "utf8");
  const line = source.split(/\r?\n/u).find(line => line.startsWith("const prodImageUrl ="));
  const imageUrl = vm.runInNewContext(`${line}\nprodImageUrl`, { prodPathToFileURL: pathToFileURL });
  assert.equal(imageUrl(""), "");
  const uncPath = "\\\\192.168.31.100\\共享盘\\包装.library\\背景 #1%?.png";
  const result = new URL(imageUrl(uncPath));
  assert.equal(result.hostname, "192.168.31.100");
  assert.equal(result.hash, "");
  assert.equal(result.search, "");
  assert.ok(result.pathname.endsWith("%20%231%25%3F.png"));
  const localPath = path.resolve("预览 #1%.png");
  assert.equal(imageUrl(localPath), pathToFileURL(localPath).href);
});
