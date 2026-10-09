const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");

test("library counts follow project/search scope and the current visible versions", () => {
  const source = fs.readFileSync(path.join(__dirname, "../eagle-plugin/js/workbench.js"), "utf8");
  const start = source.indexOf("function prodApplyManageFilters() {");
  const end = source.indexOf("\nasync function prodReplaceManaged(", start);
  assert.ok(start >= 0 && end > start);
  const types = ["", "信息条", "背景", "视频框"];
  const buttons = types.map(type => {
    const count = { textContent: "39" };
    return { dataset: { prodManageType: type }, count, querySelector: () => count };
  });
  const total = { textContent: "39 条" }, chip = { textContent: "当前版本 39" };
  const cards = [
    { id: "a1", project: "埃安", type: "信息条", name: "标注-02", isCurrent: true },
    { id: "a2", project: "埃安", type: "信息条", name: "角标", isCurrent: false },
    { id: "a3", project: "埃安", type: "背景", name: "背景", isCurrent: true },
    { id: "b1", project: "阿宝", type: "视频框", name: "竖屏框", isCurrent: true },
  ];
  const context = { prodManagedCards: cards, prodManageProjectFilter: "埃安", prodManageTypeFilter: "", prodManageSearch: "", managed: [], managedId: "b1",
    document: {
      querySelector: () => total,
      querySelectorAll: selector => selector.includes("data-prod-manage-type") ? buttons : [chip],
    },
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  const apply = () => vm.runInContext("prodApplyManageFilters()", context);
  const counts = () => buttons.map(button => button.count.textContent);
  apply();
  assert.deepEqual(counts(), ["3", "2", "1", "0"]);
  assert.equal(total.textContent, "3 条");
  assert.equal(chip.textContent, "当前版本 2");
  assert.equal(context.managedId, "a1");
  context.prodManageTypeFilter = "信息条"; apply();
  assert.deepEqual(counts(), ["3", "2", "1", "0"], "other type choices stay visible within the project");
  assert.equal(total.textContent, "2 条");
  assert.equal(chip.textContent, "当前版本 1");
  context.prodManageSearch = "标注-02"; apply();
  assert.deepEqual(counts(), ["1", "1", "0", "0"]);
  assert.equal(total.textContent, "1 条");
  context.prodManageSearch = "不存在"; apply();
  assert.deepEqual(counts(), ["0", "0", "0", "0"]);
  assert.equal(total.textContent, "0 条");
  assert.equal(chip.textContent, "当前版本 0");
  assert.equal(context.managedId, "");
  context.prodManageProjectFilter = ""; context.prodManageTypeFilter = ""; context.prodManageSearch = ""; apply();
  assert.deepEqual(counts(), ["4", "2", "1", "1"]);
  assert.equal(total.textContent, "4 条");
  assert.equal(chip.textContent, "当前版本 3");
});

