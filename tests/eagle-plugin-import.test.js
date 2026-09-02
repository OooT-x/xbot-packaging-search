const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const {
  buildAnnotation,
  buildTags,
  importBatch,
} = require("../eagle-plugin/lib/eagle-api");

function makeScanResult(overrides = {}) {
  return {
    projectName: "变速箱",
    batchId: "batch-MSZQTI9M9MJOZ",
    sourceDir: "D:\\source\\变速箱包装",
    packages: [
      {
        packageId: "pkg-gearbox-bg",
        packageName: "黑底背景",
        packageType: "背景",
        version: "v01",
        aeCompName: "黑底背景",
        state: "ready",
        dependencyStatus: "complete",
        preview: { path: "D:\\source\\变速箱包装\\变速箱_背景_黑底背景_v01.png" },
        source: { path: "D:\\source\\变速箱包装\\变速箱_黑底背景_v01.zip" },
        fonts: [],
        effects: [],
      },
    ],
    ...overrides,
  };
}

class FakeAdapter {
  constructor() {
    this.folders = [];
    this.items = [];
    this.nextId = 1;
  }

  async getFolders() {
    return this.folders;
  }

  async getFolder(id) {
    return this.folders.find((folder) => folder.id === id) || null;
  }

  async createFolder(options) {
    const folder = { id: `folder-${this.nextId++}`, ...options };
    this.folders.push(folder);
    return folder;
  }

  async saveFolder(folder) {
    return folder;
  }

  async addFromPath(filePath, options) {
    const id = `item-${this.nextId++}`;
    const item = { id, filePath, ...options, annotation: options.annotation || "" };
    this.items.push(item);
    return id;
  }

  async getItem(id) {
    return this.items.find((item) => item.id === id) || null;
  }

  async getItemsByFolder(folderId) {
    return this.items.filter((item) => (item.folders || []).includes(folderId));
  }

  async saveItem(item) {
    return item;
  }
}

test("imports a ready batch into a created batch folder", async () => {
  const adapter = new FakeAdapter();
  const result = await importBatch(adapter, makeScanResult());

  assert.equal(result.batchId, "batch-MSZQTI9M9MJOZ");
  assert.equal(adapter.folders.length, 2);
  assert.equal(adapter.folders[0].name, "00_待入库");
  assert.equal(adapter.folders[1].name, "变速箱包装");
  assert.equal(adapter.folders[1].parent, "folder-1");
  assert.equal(adapter.items.length, 2);
  assert.equal(result.imported.length, 1);
  assert.ok(result.imported[0].previewItemId);
  assert.ok(result.imported[0].sourceItemId);

  const preview = await adapter.getItem(result.imported[0].previewItemId);
  const source = await adapter.getItem(result.imported[0].sourceItemId);
  assert.ok(preview.annotation.includes("配对 ZIP"));
  assert.ok(source.annotation.includes("配对 PNG"));
  assert.ok(
    adapter.folders[1].description.includes("batch_id：batch-MSZQTI9M9MJOZ")
  );
});

test("prompts before importing a duplicate batch", async () => {
  const adapter = new FakeAdapter();
  await importBatch(adapter, makeScanResult());
  const second = await importBatch(adapter, makeScanResult({ batchId: "batch-OTHER123456" }), {
    mode: "prompt",
  });

  assert.equal(adapter.folders.length, 2);
  assert.equal(adapter.items.length, 2);
  assert.equal(second.state, "duplicate");
  assert.deepEqual(second.choices, ["reuse", "update", "new"]);
  assert.deepEqual(second.matches[0].matchedBy, ["batch_key", "source_path"]);
});

test("detects duplicates from a manifest identity when other fields change", async () => {
  const adapter = new FakeAdapter();
  await importBatch(
    adapter,
    makeScanResult({
      batchId: "batch-FIRST123456",
      batchKey: "content-key-first",
      sourceDir: "D:\\exports\\first",
      manifestFiles: ["D:\\exports\\shared\\manifest.json"],
    })
  );
  const result = await importBatch(
    adapter,
    makeScanResult({
      batchId: "batch-SECOND12345",
      batchKey: "content-key-second",
      sourceDir: "D:\\exports\\second",
      manifestFiles: ["d:/exports/shared/manifest.json"],
    }),
    { mode: "prompt" }
  );

  assert.equal(result.state, "duplicate");
  assert.deepEqual(result.matches[0].matchedBy, ["manifest"]);
});

test("reuses an existing batch without creating duplicate items", async () => {
  const adapter = new FakeAdapter();
  await importBatch(adapter, makeScanResult());
  const second = await importBatch(adapter, makeScanResult(), { mode: "reuse" });

  assert.equal(adapter.folders.length, 2);
  assert.equal(adapter.items.length, 2);
  assert.equal(second.mode, "reuse");
  assert.equal(second.reused.length, 1);
  assert.equal(second.imported.length, 0);
  assert.equal(second.batchFolderId, "folder-2");
  const preview = await adapter.getItem(second.reused[0].previewItemId);
  const source = await adapter.getItem(second.reused[0].sourceItemId);
  assert.equal(preview.annotation, source.annotation);
  assert.ok(preview.annotation.includes(`配对 PNG：${second.reused[0].previewItemId}`));
  assert.ok(preview.annotation.includes(`配对 ZIP：${second.reused[0].sourceItemId}`));
});

test("updates metadata in an existing batch without creating a second batch", async () => {
  const adapter = new FakeAdapter();
  await importBatch(adapter, makeScanResult());
  const updatedScan = makeScanResult({
    packages: [
      {
        ...makeScanResult().packages[0],
        packageName: "黑底背景更新",
        version: "v02",
      },
    ],
  });
  const result = await importBatch(adapter, updatedScan, { mode: "update" });

  assert.equal(adapter.folders.length, 2);
  assert.equal(adapter.items.length, 2);
  assert.equal(result.updated.length, 1);
  const preview = await adapter.getItem(result.updated[0].previewItemId);
  assert.ok(preview.annotation.includes("包装名称：黑底背景更新"));
  assert.ok(preview.annotation.includes("版本：v02"));
});

test("fills a partial existing pair without duplicating the present item", async () => {
  const adapter = new FakeAdapter();
  const first = await importBatch(adapter, makeScanResult());
  adapter.items = adapter.items.filter(
    (item) => item.id === first.imported[0].previewItemId
  );

  const result = await importBatch(adapter, makeScanResult(), { mode: "update" });

  assert.equal(adapter.items.length, 2);
  assert.equal(result.updated.length, 1);
  assert.equal(result.updated[0].previewItemId, first.imported[0].previewItemId);
  assert.notEqual(result.updated[0].sourceItemId, first.imported[0].sourceItemId);
});

test("creates an independent batch when new mode is selected", async () => {
  const adapter = new FakeAdapter();
  await importBatch(adapter, makeScanResult());
  const result = await importBatch(adapter, makeScanResult(), { mode: "new" });

  assert.equal(adapter.folders.length, 3);
  assert.equal(adapter.items.length, 4);
  assert.equal(result.mode, "new");
  assert.equal(result.imported.length, 1);
  assert.notEqual(result.batchId, "batch-MSZQTI9M9MJOZ");
  assert.match(adapter.folders[2].name, /^变速箱包装-/u);
});

test("refuses to import when no package is ready", async () => {
  const scan = makeScanResult({
    packages: [
      {
        packageId: "pkg-blocked",
        state: "blocked",
        preview: null,
        source: null,
      },
    ],
  });
  await assert.rejects(() => importBatch(new FakeAdapter(), scan), /没有可导入的包装记录/);
});

test("builds tags and annotations with stable facts only", () => {
  const pkg = {
    projectName: "变速箱",
    packageType: "信息条",
    version: "v02",
    dependencyStatus: "warning",
    fonts: ["思源黑体"],
    effects: ["Saber"],
  };
  assert.deepEqual(buildTags(pkg), ["变速箱", "信息条", "v02", "00_待入库", "依赖警告"]);
  const annotation = buildAnnotation(pkg, {
    previewItemId: "png-1",
    sourceItemId: "zip-1",
  });
  assert.ok(annotation.includes("状态：启用（依赖警告）"));
  assert.ok(annotation.includes("字体：思源黑体"));
  assert.ok(annotation.includes("配对 PNG：png-1"));
  assert.ok(annotation.includes("配对 ZIP：zip-1"));
  assert.ok(!annotation.includes("确认"));
  assert.ok(!annotation.includes("流程"));
});

test("item names preserve the original file name", () => {
  const { itemName } = require("../eagle-plugin/lib/eagle-api");
  assert.equal(itemName("a\\b.png", "png"), path.basename("a\\b.png"));
});
