const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { buildAnnotation } = require("../eagle-plugin/lib/eagle-api");
const {
  formalPackageRecords,
  replaceFormalAsset,
} = require("../eagle-plugin/lib/managed-assets");

function metadata(overrides = {}) {
  return {
    packageId: "pkg-managed-1",
    projectName: "变速箱",
    packageName: "黑底背景",
    packageType: "背景",
    version: "v01",
    aeCompName: "黑底背景",
    batchId: "batch-managed-1",
    dependencyStatus: "complete",
    ...overrides,
  };
}

function pair() {
  const pkg = metadata();
  const preview = {
    id: "png-old",
    name: "变速箱_背景_黑底背景_v01.png",
    ext: "png",
    filePath: "D:\\library\\images\\png-old.info\\preview.png",
    folders: ["preview-bg"],
    tags: ["变速箱", "背景", "v01", "01_预览图"],
    annotation: buildAnnotation(pkg, { previewItemId: "png-old", sourceItemId: "zip-old" }),
  };
  const source = {
    id: "zip-old",
    name: "变速箱_黑底背景_v01.zip",
    ext: "zip",
    filePath: "D:\\library\\images\\zip-old.info\\source.zip",
    folders: ["source-bg"],
    tags: ["变速箱", "背景", "v01", "02_AE源文件"],
    annotation: preview.annotation,
  };
  return { ...pkg, meta: {}, preview, source, complete: true };
}

class FakeAdapter {
  constructor(items = []) {
    this.items = items;
    this.folders = [
      { id: "preview-root", name: "01_预览图", parent: null },
      { id: "source-root", name: "02_AE源文件", parent: null },
      { id: "preview-bg", name: "背景", parent: "preview-root" },
      { id: "source-bg", name: "背景", parent: "source-root" },
    ];
    this.nextId = 1;
  }

  async getFolders() { return this.folders; }
  async createFolder(options) {
    const folder = { id: `folder-${this.nextId++}`, ...options };
    this.folders.push(folder);
    return folder;
  }
  async addFromPath(filePath, options) {
    const id = `item-${this.nextId++}`;
    this.items.push({ id, filePath, ext: path.extname(filePath).slice(1), ...options });
    return id;
  }
  async getItem(id) { return this.items.find((item) => item.id === id) || null; }
  async saveItem(item) {
    const index = this.items.findIndex((entry) => entry.id === item.id);
    if (index >= 0) this.items[index] = item;
    return item;
  }
}

test("groups only enabled formal package pairs", () => {
  const items = [pair().preview, pair().source, {
    ...pair().preview,
    id: "png-archived",
    annotation: buildAnnotation(metadata(), { previewItemId: "png-archived", sourceItemId: "zip-old" }, { status: "已取代", replacedBy: "png-new" }),
  }];
  const records = formalPackageRecords(items);
  assert.equal(records.length, 1);
  assert.equal(records[0].preview.id, "png-old");
});

test("replaces one formal asset and keeps the old item in history", async () => {
  const current = pair();
  const adapter = new FakeAdapter([current.preview, current.source]);
  const result = await replaceFormalAsset(adapter, current, "preview", "D:\\exports\\preview-new.png", { revisionId: "rev-preview-test" });

  assert.equal(result.replacedKind, "preview");
  assert.equal(adapter.items.length, 3);
  const old = adapter.items.find((item) => item.id === "png-old");
  const source = adapter.items.find((item) => item.id === "zip-old");
  const replacement = adapter.items.find((item) => item.id === result.previewItemId);
  assert.equal(old.folders.length, 1);
  const historyFolder = adapter.folders.find((folder) => folder.id === old.folders[0]);
  assert.equal(historyFolder.name, "背景");
  assert.equal(adapter.folders.find((folder) => folder.id === historyFolder.parent).name, "03_历史版本");
  assert.match(old.annotation, /状态：已取代/);
  assert.match(old.annotation, /取代为：/);
  assert.match(source.annotation, new RegExp(`配对 PNG：${result.previewItemId}`));
  assert.match(replacement.annotation, /修订号：rev-preview-test/);
  assert.equal(replacement.folders[0], "preview-bg");
});
