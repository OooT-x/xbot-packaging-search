const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");
const updater = require("../eagle-plugin/lib/updater.js");
function harness(overrides = {}, storage = { getItem: () => null, setItem() {} }) {
  const source = fs.readFileSync(path.join(__dirname, "../eagle-plugin/js/workbench.js"), "utf8");
  const check = source.slice(source.indexOf("async function prodCheckUpdates("), source.indexOf("\nfunction prodAddTypeFromMenu"));
  const render = source.slice(source.indexOf("function prodRenderUpdates()"), source.indexOf("\nasync function prodAction("));
  const nodes = new Map(), versions = [{}, {}], calls = [];
  const node = key => { if (!nodes.has(key)) nodes.set(key, { dataset: {}, setAttribute() {} }); return nodes.get(key); };
  const context = {
    prodLatestRelease: null, prodUpdateState: { checking: false, downloading: false, checkedAt: 0, error: "", file: null },
    prodUpdater: { ...updater, ...overrides }, prodManifest: { version: "1.8.4" }, prodPath: path, require, localStorage: storage,
    window: { localStorage: storage, eagle: { shell: { openPath: async file => { calls.push(file); } } } },
    document: { querySelector: node, querySelectorAll: selector => selector === ".update-version-row strong" ? versions : [] },
    prodToast: (...args) => calls.push(args),
  };
  vm.createContext(context); vm.runInContext(check + "\n" + render, context);
  return { context, node, calls };
}
const available = () => ({ releaseFound: true, updateAvailable: true, version: "1.9.0", title: "新版",
  notes: "<script>plain text</script>", publishedAt: "2026-10-08T00:00:00Z", asset: { digest: "a".repeat(64) } });

test("production update page preserves offline cache and recovers from query failure", async () => {
  const info = available(), checkedAt = Date.now() - 86400001;
  const storage = { getItem: () => JSON.stringify({ info, checkedAt }), setItem() { throw new Error("quota"); } };
  const { context: c, node } = harness({ checkForUpdate: async () => { throw new Error("限流"); } }, storage);
  await c.prodCheckUpdates();
  assert.equal(c.prodLatestRelease.version, "1.9.0");
  assert.match(node("#previewUpdateStatus").textContent, /限流.*保留/);
  assert.equal(node('[data-action="check-plugin-updates"]').disabled, false);
  assert.equal(node('[data-action="download-plugin-update"]').disabled, false);
  c.prodUpdater.checkForUpdate = async () => ({ releaseFound: false, updateAvailable: false });
  await c.prodCheckUpdates(true);
  assert.equal(node("#updateStatusTitle").textContent, "暂无稳定版发布");
  assert.equal(node('[data-action="download-plugin-update"]').disabled, true);
  assert.equal(c.prodUpdateState.error, "");
});

test("production cache rebases after installation and invalid storage falls back to network", async () => {
  const info = { ...available(), version: "1.8.4" };
  const { context: c, node } = harness({ checkForUpdate: async () => { throw new Error("should not query"); } },
    { getItem: () => JSON.stringify({ info, checkedAt: Date.now() }) });
  await c.prodCheckUpdates();
  assert.equal(node("#updateStatusTitle").textContent, "已是最新版本");
  assert.equal(node('[data-action="download-plugin-update"]').disabled, true);
  c.localStorage = c.window.localStorage = { getItem: () => "{bad", setItem() { throw new Error("quota"); } };
  c.prodUpdater.checkForUpdate = async () => available();
  await c.prodCheckUpdates();
  assert.equal(node("#updateStatusTitle").textContent, "发现可用更新");
});

test("production download prevents duplicate requests, shows progress and retains a package after open failure", async () => {
  let complete, downloads = 0;
  const { context: c, node, calls } = harness({ downloadPluginUpdate: async (_, __, options) => {
    downloads++; options.onProgress({ received: 5, total: 10 });
    await new Promise(resolve => { complete = resolve; });
    return { path: "C:/download/update.eagleplugin", verified: true };
  } });
  c.prodLatestRelease = available();
  c.window.eagle.shell.openPath = async file => { calls.push(file); return "open failed"; };
  const pending = c.prodDownloadUpdate();
  assert.match(node("#previewUpdateStatus").textContent, /50%/);
  assert.equal(node('[data-action="check-plugin-updates"]').disabled, true);
  await c.prodDownloadUpdate(); assert.equal(downloads, 1);
  complete(); await pending;
  assert.equal(c.prodUpdateState.downloading, false);
  assert.match(node("#previewUpdateStatus").textContent, /open failed/);
  assert.match(node(".update-install-hint").textContent, /C:\/download\/update.eagleplugin/);
  assert.equal(node('[data-action="download-plugin-update"]').disabled, false);
  assert.equal(calls[0], "C:/download/update.eagleplugin");
  c.prodLatestRelease.asset.digest = null; c.prodRenderUpdates();
  assert.equal(node('[data-action="download-plugin-update"]').disabled, true);
});
