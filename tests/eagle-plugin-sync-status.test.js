const fs = require("node:fs");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");
const source = fs.readFileSync(require("node:path").join(__dirname, "../eagle-plugin/js/workbench.js"), "utf8");

test("library retry blocks double clicks, rereads the current pair, and never imports an Eagle file", async () => {
  const record = { packageId: "p", preview: { id: "png" } }, card = { packageId: "p", sync: { state: "failed" } };
  let release, retryCalls = 0, reads = 0, refreshed = 0, replaced = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const c = { prodManagedRecords: [record], prodManagedCards: [card], prodManagedSyncRetrying: new Set(), renderManage() {},
    prodManagedApi: { listFormalPackages: async () => { reads++; return { packages: [record] }; }, replaceFormalAsset: () => { replaced++; } },
    prodAdapter: () => ({}), prodTeam: { assertUnchanged: (before, after) => { assert.equal(before, after); return after; } },
    prodIngest: { retryPackage: async () => { retryCalls++; await gate; return { state: "completed" }; } },
    window: { eagle: { library: { path: "library" } } }, prodToast() {}, prodRefreshManagedSync: async () => { refreshed++; },
  };
  vm.createContext(c);
  vm.runInContext(source.slice(source.indexOf("async function prodRetryManagedSync("), source.indexOf("function prodRenderManageFilters(")), c);
  const first = c.prodRetryManagedSync("p");
  await c.prodRetryManagedSync("p");
  release(); await first;
  assert.equal(reads, 1); assert.equal(retryCalls, 1); assert.equal(replaced, 0); assert.equal(refreshed, 1);
  assert.equal(card.sync.state, "completed"); assert.equal(c.prodManagedSyncRetrying.size, 0);
});

test("sync filter selects failed packages without losing existing project and type filters", () => {
  const c = { prodManagedCards: [
    { id: "failed", project: "A", type: "背景", name: "背景1", sync: { state: "failed" } },
    { id: "done", project: "A", type: "背景", name: "背景2", sync: { state: "completed" } },
    { id: "other", project: "B", type: "背景", name: "背景3", sync: { state: "failed" } },
  ], prodManageProjectFilter: "A", prodManageTypeFilter: "背景", prodManageSearch: "", prodManageSyncFilter: "failed", prodManageSort: "name", prodManageSortDirection: "asc", managed: [], managedId: "done",
    document: { querySelector: () => null, querySelectorAll: () => [] },
  };
  vm.createContext(c);
  vm.runInContext(source.slice(source.indexOf("function prodApplyManageFilters("), source.indexOf("async function prodReplaceManaged(")), c);
  c.prodApplyManageFilters();
  assert.deepEqual(Array.from(c.managed, item => item.id), ["failed"]);
  assert.equal(c.managedId, "failed");
});
