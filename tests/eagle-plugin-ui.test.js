const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const root = path.join(__dirname, "..");
const read = relative => fs.readFileSync(path.join(root, relative), "utf8");

test("production Eagle entry uses the preview-native page and dedicated controller", () => {
  const html = read("eagle-plugin/index.html");
  const runtime = read("eagle-plugin/js/v5-runtime.js");
  const controller = read("eagle-plugin/js/workbench.js");
  const manifest = JSON.parse(read("eagle-plugin/manifest.json"));

  assert.match(html, /<script src='js\/workbench\.js'><\/script><script src='js\/v5-runtime\.js'><\/script>/);
  assert.doesNotMatch(html, /<script src=['"]js\/plugin\.js['"]/);
  assert.doesNotMatch(html, /<script src=['"]js\/v5-workspace\.js['"]/);
  assert.match(runtime, /const compositions=\[\];\s*const pairs=\[\];\s*const managed=\[\];/);
  assert.equal(manifest.version, "1.8.1");

  for (const action of ["open-manage", "choose-aep", "collect", "open-rename", "import", "check-plugin-updates", "download-plugin-update"]) {
    assert.match(html, new RegExp(`data-action=["']${action}["']`), `${action} remains available in the preview-native UI`);
  }
  for (const action of ["stop-collect", "new-version", "new-package", "repair-current"]) {
    assert.ok(controller.includes(`"${action}"`), `${action} is handled when its control is rendered`);
  }
  assert.match(controller, /const handled = new Set\(/);
  assert.match(controller, /document\.addEventListener\("click", prodAction, true\)/);
  assert.match(controller, /document\.addEventListener\("change", prodInteraction, true\)/);
});

test("preview-native controls call the existing worker, scanner, and Eagle service layer", () => {
  const controller = read("eagle-plugin/js/workbench.js");
  for (const integration of [
    "prodWorker.inspectAep",
    "prodWorker.collectAep",
    "prodWorker.previewAep",
    "prodScan.scanDirectory",
    "prodEagle.importFormalBatch",
    "prodManagedApi.listFormalPackages",
    "prodManagedApi.replaceFormalAsset",
    "prodManagedApi.changeFormalPackageType",
    "prodUpdater.checkForUpdate",
    "prodUpdater.downloadPluginUpdate",
  ]) assert.ok(controller.includes(integration), `production controller should connect ${integration}`);
  assert.match(controller, /new prodEagle\.EaglePluginAdapter\(window\.eagle\)/);
  assert.match(controller, /window\.prodWorkbenchReady = true;/);
});
