const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const source = fs.readFileSync(path.join(__dirname, "../eagle-plugin/js/window-controls.js"), "utf8");
function harness(native = true) {
  const calls = [];
  const element = () => ({ hidden: true, dataset: {}, handlers: {}, addEventListener(type, fn) { this.handlers[type] = fn; }, setAttribute(name, value) { this[name] = value; } });
  const controls = element(), bar = element(), minimize = element(), maximize = element(), close = element(), status = element();
  controls.querySelector = selector => selector.includes("minimize") ? minimize : selector.includes("maximize") ? maximize : selector.includes("close") ? close : status;
  let maximized = false;
  const api = {
    isMaximized: async () => maximized,
    minimize: async () => calls.push("minimize"),
    maximize: async () => { calls.push("maximize"); maximized = true; },
    unmaximize: async () => { calls.push("unmaximize"); maximized = false; },
  };
  const window = { eagle: native ? { window: api } : undefined, close: () => calls.push("close"), addEventListener() {} };
  const document = { querySelector: selector => selector === "#windowControls" ? controls : bar, body: { classList: { add() {} } } };
  vm.runInNewContext(source, { window, document });
  return { calls, controls, bar, minimize, maximize, close, status, api };
}
test("Eagle buttons minimize, toggle maximize/restore, and close the window", async () => {
  const h = harness();
  assert.equal(h.controls.hidden, false);
  await h.minimize.handlers.click();
  await h.maximize.handlers.click();
  assert.equal(h.maximize["aria-label"], "还原窗口");
  assert.equal(h.maximize.dataset.maximized, "true");
  await h.maximize.handlers.click();
  assert.equal(h.maximize["aria-label"], "最大化窗口");
  h.close.handlers.click();
  assert.deepEqual(h.calls, ["minimize", "maximize", "unmaximize", "close"]);
});
test("maximize ignores repeated clicks while pending and recovers from native errors", async () => {
  const h = harness();
  let release;
  h.api.maximize = () => new Promise(resolve => { release = resolve; });
  const pending = h.maximize.handlers.click();
  await Promise.resolve();
  assert.equal(h.maximize.disabled, true);
  await h.maximize.handlers.click();
  release();
  await pending;
  assert.equal(h.maximize.disabled, false);
  h.api.maximize = async () => { throw new Error("native failure"); };
  await h.maximize.handlers.click();
  assert.match(h.status.textContent, /native failure/);
  assert.equal(h.maximize.disabled, false);
});
test("navigation double-clicks do not maximize; browser preview has no native controls", async () => {
  const h = harness();
  h.bar.handlers.dblclick({ target: { closest: () => ({}) }, preventDefault() { throw new Error("must not intercept navigation"); } });
  assert.deepEqual(h.calls, []);
  h.bar.handlers.dblclick({ target: { closest: () => null }, preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.calls, ["maximize"]);
  const preview = harness(false);
  assert.equal(preview.controls.hidden, true);
  assert.equal(preview.close.handlers.click, undefined);
});
