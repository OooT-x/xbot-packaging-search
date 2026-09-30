const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const { scanDirectory } = require("../eagle-plugin/lib/scan");

test("explicit file selection cannot ingest unselected sibling PNGs or ZIPs", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xbot-v5-scan-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ["背景.png", "背景.zip", "信息条.png", "信息条.zip"]) fs.writeFileSync(path.join(root, name), "fixture");
  const selectedPaths = ["背景.png", "背景.zip"].map(name => path.join(root, name));
  const result = scanDirectory(root, { selectedPaths });
  assert.equal(result.files.length, 2);
  assert.equal(result.packages.length, 1);
  assert.equal(result.packages[0].packageType, "背景");
  fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify({ manifest_type: "xbot-eagle-ingest", packages: [{package_id:"unselected", project_name:"项目", package_name:"信息条",package_type:"信息条",preview_file:"信息条.png",source_file:"信息条.zip"}] }));
  const manifestResult = scanDirectory(root, { selectedPaths: [path.join(root,"manifest.json")] });
  assert.ok(manifestResult.errors.some(error => error.includes("未选择")));
  assert.ok(!manifestResult.packages.some(pkg => pkg.state === "ready"));
});

test("custom types persist across processes and become searchable without restarting bot", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xbot-v5-types-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, XBOT_PACKAGE_TYPES_FILE: path.join(root, "types.json") };
  const output = execFileSync(process.execPath, ["-e", `
    const assert = require('node:assert/strict');
    const intent = require('./bot/lib/package-intent');
    const types = require('./eagle-plugin/lib/package-types');
    types.registerPackageType('章节标题', ['章节名']);
    assert.equal(intent.extractPackageType('查章节名'), '章节标题');
    assert.throws(()=>types.registerPackageType('../目录'));
    assert.throws(()=>types.registerPackageType('背景'));
    console.log(types.normalizePackageType('章节名'));
  `], { cwd: path.join(__dirname, ".."), env, encoding: "utf8" });
  assert.match(output, /章节标题/);
  const reloaded = execFileSync(process.execPath, ["-e", "console.log(require('./eagle-plugin/lib/package-types').normalizePackageType('章节名'))"], { cwd: path.join(__dirname, ".."), env, encoding: "utf8" });
  assert.match(reloaded, /章节标题/);
});
