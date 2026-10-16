const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");

const source = fs.readFileSync(path.join(__dirname, "../eagle-plugin/js/workbench.js"), "utf8");
function harness() {
  const select = { value: "", dispatchEvent() {} }, saved = {};
  const context = {
    prodManageSort: "time", prodManageSortDirection: "desc", prodManageSortOptions: ["time", "name", "project", "type"],
    Event: class Event {},
    prodManagedCards: [], prodManageProjectFilter: "", prodManageTypeFilter: "", prodManageSearch: "", prodManageSyncFilter: "",
    managed: [], managedId: "", renderManage() {},
    document: { querySelector: selector => selector === "#manageSort" ? select : null, querySelectorAll: () => [] },
    localStorage: { getItem: key => saved[key] || null, setItem: (key, value) => { saved[key] = value; } },
  };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf("function prodManagedImportTime("), source.indexOf("async function prodRefreshManaged(")), context);
  vm.runInContext(source.slice(source.indexOf("function prodApplyManageFilters("), source.indexOf("async function prodReplaceManaged(")), context);
  return { context, select, saved };
}

test("library time uses earliest valid Eagle import time in the current pair", () => {
  const { context: c } = harness();
  assert.equal(c.prodManagedImportTime({ preview: { importedAt: 200 }, source: { importedAt: 100 } }), 100);
  assert.equal(c.prodManagedImportTime({ preview: { importedAt: "300" } }), 300);
  assert.equal(c.prodManagedImportTime({ preview: { importedAt: -1 }, source: { importedAt: NaN } }), 0);
  assert.equal(c.prodManagedImportTime({ preview: { modificationTime: 999, modifiedAt: 999 } }), 0);
});

test("sorting applies after filters, uses natural names and leaves unknown dates last", () => {
  const { context: c } = harness();
  c.prodManagedCards = [
    { id: "missing", name: "标注1", project: "B", type: "背景", importedAt: 0 },
    { id: "old", name: "标注10", project: "A", type: "背景", importedAt: 100 },
    { id: "new", name: "标注2", project: "B", type: "背景", importedAt: 200 },
    { id: "tie", name: "标注3", project: "B", type: "背景", importedAt: 200 },
  ];
  const ids = () => Array.from(c.managed, item => item.id);
  c.prodApplyManageFilters(); assert.deepEqual(ids(), ["new", "tie", "old", "missing"]);
  c.managedId = "old";
  c.prodSetManageSort("time", false, "asc"); assert.deepEqual(ids(), ["old", "new", "tie", "missing"]);
  assert.equal(c.managedId, "old", "sorting keeps the inspected package selected");
  c.prodSetManageSort("name"); assert.deepEqual(ids(), ["missing", "new", "tie", "old"]);
  c.prodSetManageSort("project"); assert.deepEqual(ids(), ["old", "missing", "new", "tie"]);
  c.prodManageProjectFilter = "B"; c.prodManageSearch = "标注2"; c.prodApplyManageFilters();
  assert.deepEqual(ids(), ["new"]); assert.equal(c.managedId, "new");
  assert.deepEqual(c.prodManagedCards.map(item => item.id), ["missing", "old", "new", "tie"], "do not reorder source records");
});

test("sort preference restores valid choices, defaults safely and tolerates blocked storage", () => {
  const { context: c, select, saved } = harness();
  c.prodSetManageSort("time", true, "asc");
  assert.equal(select.value, "time"); assert.deepEqual(JSON.parse(saved["xbot.manage-sort.v2"]), { by: "time", direction: "asc" });
  c.prodSetManageSort("invalid"); assert.equal(select.value, "time");
  c.localStorage.setItem = () => { throw new Error("blocked"); };
  assert.doesNotThrow(() => c.prodSetManageSort("name", true));
  const html = fs.readFileSync(path.join(__dirname, "../eagle-plugin/index.html"), "utf8");
  assert.match(html, /id="manageSort"[^>]*aria-label="排序依据"/);
  for (const value of c.prodManageSortOptions) assert.ok(html.includes(`value="${value}"`));
  assert.match(source, /localStorage.getItem\("xbot.manage-sort.v2"\)/);
  assert.match(source, /importedAt: prodManagedImportTime\(p\)/);
});

test("production cards render the sorted order without reversing it again", () => {
  const runtime = fs.readFileSync(path.join(__dirname, "../eagle-plugin/js/v5-runtime.js"), "utf8");
  const grid = { innerHTML: "" };
  const c = {
    managed: [{ id: "new", name: "最新" }, { id: "old", name: "较早" }], managedId: "new",
    $: () => grid, $$: () => [], escapeHtml: value => String(value || ""), managedArt: () => "", renderManageInspector() {},
  };
  vm.createContext(c);
  vm.runInContext(runtime.slice(runtime.indexOf("function renderManage(){"), runtime.indexOf("function nextVersion(")), c);
  c.renderManage();
  assert.ok(grid.innerHTML.indexOf("最新") < grid.innerHTML.indexOf("较早"));
});

test("time sorting groups batches and keeps natural name order within each batch in both directions", () => {
  const { context: c } = harness();
  c.prodManagedCards = [
    { id: "a10", name: "标注10", project: "A", batchId: "a", importedAt: 101 },
    { id: "b", name: "背景", project: "A", batchId: "b", importedAt: 200 },
    { id: "a2", name: "标注2", project: "A", batchId: "a", importedAt: 102 },
    { id: "unknown", name: "无时间", project: "A", importedAt: 0 },
  ];
  c.prodAssignBatchTimes(c.prodManagedCards);
  const ids = () => Array.from(c.managed, item => item.id);
  c.prodApplyManageFilters(); assert.deepEqual(ids(), ["b", "a2", "a10", "unknown"]);
  c.prodSetManageSort("time", false, "asc"); assert.deepEqual(ids(), ["a2", "a10", "b", "unknown"]);
  c.prodSetManageSort("name", false, "desc");
  assert.ok(ids().indexOf("a10") < ids().indexOf("a2"));
});

test("old sort preferences migrate and v2 basis and direction restore together", () => {
  for (const [legacy, by, direction] of [["newest", "time", "desc"], ["oldest", "time", "asc"], ["name", "name", "asc"], ["project", "project", "asc"]]) {
    const { context: c, saved } = harness(); saved["xbot.manage-sort.v1"] = legacy;
    c.prodRestoreManageSort(); assert.equal(c.prodManageSort, by); assert.equal(c.prodManageSortDirection, direction);
  }
  const { context: c, saved } = harness();
  saved["xbot.manage-sort.v2"] = JSON.stringify({ by: "type", direction: "desc" });
  c.prodRestoreManageSort(); assert.equal(c.prodManageSort, "type"); assert.equal(c.prodManageSortDirection, "desc");
  saved["xbot.manage-sort.v2"] = "invalid JSON";
  c.prodRestoreManageSort(); assert.equal(c.prodManageSort, "time"); assert.equal(c.prodManageSortDirection, "desc");
});
