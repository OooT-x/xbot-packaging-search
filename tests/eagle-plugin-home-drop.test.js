const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");

const source = fs.readFileSync(path.join(__dirname, "../eagle-plugin/js/workbench.js"), "utf8");
function harness() {
  const listeners = new Map(), classes = new Set(), calls = [];
  const zone = {
    dataset: {}, classList: { add: value => classes.add(value), remove: value => classes.delete(value) },
    contains: value => value === zone,
    addEventListener(type, listener, capture) { listeners.set(type, { listener, capture }); },
  };
  const c = {
    prodFs: fs, prodPath: path, workflowDraft: null, pairs: [],
    document: { querySelector: selector => selector === "#homeDropZone" ? zone : { value: "" } },
    require: name => { assert.equal(name, "electron"); return { webUtils: { getPathForFile: file => file.nativePath || "" } }; },
    prodToast: (...args) => calls.push(["toast", ...args]),
    prodScan: { inferProjectName: () => "项目", scanDirectory: (root, options) => { calls.push(["scan", root, options]); return { projectName: "项目", errors: [] }; } },
    prodSetWorkflow: (...args) => calls.push(["workflow", ...args]), prodLoadPairs: scan => calls.push(["pairs", scan]),
    prodSetPairSource: label => calls.push(["label", label]), prodSetScreen: screen => calls.push(["screen", screen]),
    prodInspectAep: async () => calls.push(["inspect"]),
  };
  vm.createContext(c);
  vm.runInContext(source.slice(source.indexOf("function prodDroppedPaths("), source.indexOf("function prodSetWorkflow(")), c);
  return { c, zone, listeners, classes, calls };
}

test("drop paths support both Electron path APIs and never guess missing paths from names", () => {
  const { c } = harness();
  const aep = path.resolve("拖入工程.aep"), folder = path.resolve("交付文件夹");
  assert.deepEqual(Array.from(c.prodDroppedPaths({ files: [{ path: aep }, { nativePath: folder }, { path: aep }] })), [aep, folder]);
  assert.deepEqual(Array.from(c.prodDroppedPaths({ items: [{ kind: "file", getAsFile: () => ({ path: folder }) }] })), [folder]);
  assert.throws(() => c.prodDroppedPaths({ files: [{ name: "工程.aep" }] }), /无法读取/);
  assert.throws(() => c.prodDroppedPaths({ files: [{ path: aep }, { name: "missing.zip" }] }), /无法读取/);
  assert.throws(() => c.prodDroppedPaths({ files: [] }), /请拖入/);
});

test("production drop binds once, routes one real selection and suppresses preview/default behavior", async () => {
  const { c, zone, listeners, classes, calls } = harness();
  let routes = 0;
  c.prodRouteSelection = async paths => { routes++; assert.equal(paths[0], path.resolve("文件夹")); };
  c.prodBindHomeDropZone(); const drop = listeners.get("drop");
  c.prodBindHomeDropZone(); assert.equal(listeners.get("drop"), drop);
  assert.equal(drop.capture, true);
  const event = { dataTransfer: { files: [{ path: path.resolve("文件夹") }] }, preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; } };
  listeners.get("dragover").listener(event); assert.ok(classes.has("is-dragover"));
  assert.equal(event.dataTransfer.dropEffect, "copy");
  listeners.get("dragleave").listener({ relatedTarget: zone }); assert.ok(classes.has("is-dragover"));
  await drop.listener(event);
  assert.equal(routes, 1); assert.equal(event.prevented, true); assert.equal(event.stopped, true);
  assert.equal(classes.has("is-dragover"), false);
  c.prodRouteSelection = async () => { throw new Error("读取失败原因"); };
  await drop.listener(event); assert.deepEqual(calls.at(-1), ["toast", "读取失败", "读取失败原因", "error"]);
  assert.match(source, /prodBindHomeDropZone\(\);/);
});

test("dropped AEP, folder and explicit PNG/ZIP reach the existing production routes", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xbot-drop-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const aep = path.join(root, "工程.aep"), png = path.join(root, "背景.png"), zip = path.join(root, "背景.zip");
  for (const file of [aep, png, zip]) fs.writeFileSync(file, "fixture");
  const { c, calls } = harness();
  await c.prodRouteSelection(c.prodDroppedPaths({ files: [{ path: aep }] }));
  assert.ok(calls.some(call => call[0] === "inspect")); assert.equal(c.prodAepPath, aep);
  calls.length = 0;
  await c.prodRouteSelection(c.prodDroppedPaths({ files: [{ path: root }] }));
  assert.equal(calls.find(call => call[0] === "scan")[1], root);
  assert.equal(calls.find(call => call[0] === "scan")[2].selectedPaths, undefined);
  assert.ok(calls.some(call => call[0] === "screen" && call[1] === "pair"));
  calls.length = 0;
  await c.prodRouteSelection(c.prodDroppedPaths({ files: [{ path: png }, { path: zip }] }));
  assert.deepEqual(Array.from(calls.find(call => call[0] === "scan")[2].selectedPaths), [png, zip]);
  await assert.rejects(c.prodRouteSelection([root, aep]), /单独选择/);
});
