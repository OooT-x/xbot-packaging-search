const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildAnnotation,
  fileBatch,
  parseAnnotation,
  planFormalFile,
  replaceIngestTag,
} = require("../eagle-plugin/lib/eagle-api");

function makePair(overrides = {}) {
  const pkg = {
    projectName: "变速箱",
    packageId: "pkg-gearbox-bg",
    packageName: "黑色纹理背景",
    packageType: "背景",
    version: "v01",
    aeCompName: "黑色纹理背景",
    batchId: "batch-TEST1234567",
    ...overrides.pkg,
  };
  const previewId = overrides.previewId || "png-1";
  const sourceId = overrides.sourceId || "zip-1";
  const folders = overrides.folders || ["batch-1"];
  const annotation = buildAnnotation(pkg, {
    previewItemId: previewId,
    sourceItemId: sourceId,
  });
  return [
    {
      id: previewId,
      name: `${pkg.projectName}_${pkg.packageType}_${pkg.packageName}_${pkg.version}.png`,
      ext: "png",
      folders,
      tags: [pkg.projectName, pkg.packageType, pkg.version, "00_待入库"],
      annotation,
    },
    {
      id: sourceId,
      name: `${pkg.projectName}_${pkg.packageName}_${pkg.version}.zip`,
      ext: "zip",
      folders,
      tags: [pkg.projectName, pkg.packageType, pkg.version, "00_待入库"],
      annotation,
    },
  ];
}

class FakeAdapter {
  constructor(items = []) {
    this.folders = [];
    this.items = items;
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

  async getItem(id) {
    return this.items.find((item) => item.id === id) || null;
  }

  async saveItem(item) {
    return item;
  }

  async getItemsByFolder(folderId) {
    return this.items.filter((item) => (item.folders || []).includes(folderId));
  }
}

test("plans a complete PNG+ZIP pair into a formal folder", () => {
  const items = makePair();
  const plan = planFormalFile(items, {
    formalFolderIds: ["preview-root", "source-root"],
  });

  assert.equal(plan.readyPairs.length, 1);
  assert.equal(plan.readyPairs[0].packageType, "背景");
  assert.equal(plan.readyPairs[0].preview.id, "png-1");
  assert.equal(plan.readyPairs[0].source.id, "zip-1");
  assert.equal(plan.blocked.length, 0);
  assert.equal(plan.stats.ready, 1);
});

test("blocks an incomplete pair and keeps the file in the batch", async () => {
  const [preview] = makePair();
  const adapter = new FakeAdapter([preview]);
  const result = await fileBatch(adapter, "batch-1");

  assert.equal(result.filed.length, 0);
  assert.equal(result.batchEmpty, false);
  assert.equal(result.remaining.length, 1);
  assert.ok(
    result.blocked.some(
      (entry) => entry.item.id === "png-1" && /缺少配对 ZIP/.test(entry.reason)
    )
  );
});

test("blocks unknown package types", () => {
  const items = makePair({
    pkg: { packageType: "自定义版式" },
  });
  const plan = planFormalFile(items, { formalFolderIds: [] });

  assert.equal(plan.readyPairs.length, 0);
  assert.ok(
    plan.blocked.some((entry) => /未知包装类型：自定义版式/.test(entry.reason))
  );
});

test("skips items already in a formal folder", () => {
  const items = makePair({ folders: ["preview-root", "batch-1"] });
  const plan = planFormalFile(items, {
    formalFolderIds: ["preview-root", "source-root"],
  });

  assert.equal(plan.readyPairs.length, 0);
  assert.equal(plan.alreadyFiled.length, 2);
});

test("files a batch into preview and source folders with updated tags", async () => {
  const adapter = new FakeAdapter(makePair());
  const result = await fileBatch(adapter, "batch-1");

  assert.equal(result.filed.length, 1);
  assert.equal(result.batchEmpty, true);
  assert.equal(adapter.folders.length, 4);
  assert.equal(adapter.folders[0].name, "01_预览图");
  assert.equal(adapter.folders[1].name, "02_AE源文件");
  assert.equal(adapter.folders[2].name, "背景");
  assert.equal(adapter.folders[3].name, "背景");

  const preview = adapter.items.find((item) => item.id === "png-1");
  const source = adapter.items.find((item) => item.id === "zip-1");
  assert.deepEqual(preview.folders, ["folder-3"]);
  assert.deepEqual(source.folders, ["folder-4"]);
  assert.ok(preview.tags.includes("01_预览图"));
  assert.ok(source.tags.includes("02_AE源文件"));
  assert.ok(!preview.tags.includes("00_待入库"));
  assert.ok(!source.tags.includes("00_待入库"));
});

test("parses annotation facts and replaces the ingest tag", () => {
  const meta = parseAnnotation(
    "项目：变速箱\npackage_id：pkg-1\n包装类型：信息条\n版本：v02\nbatch_id：batch-X\n"
  );
  assert.equal(meta["项目"], "变速箱");
  assert.equal(meta["包装类型"], "信息条");
  assert.equal(meta["batch_id"], "batch-X");
  assert.deepEqual(replaceIngestTag(["变速箱", "00_待入库"], "01_预览图"), [
    "变速箱",
    "01_预览图",
  ]);
});
