const test = require("node:test");
const assert = require("node:assert/strict");

const {
  EaglePluginAdapter,
  buildAnnotation,
  collectBatchItems,
  collectDescendantFolderIds,
  fileBatch,
  flattenFolderTree,
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

test("requires correction for unknown package types", () => {
  const items = makePair({
    pkg: { packageType: "自定义版式" },
  });
  const plan = planFormalFile(items, { formalFolderIds: [] });

  assert.equal(plan.readyPairs.length, 0);
  assert.equal(plan.reviewPairs.length, 1);
  assert.match(plan.reviewPairs[0].reason, /未知包装类型.*请选择包装类型/);
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
  assert.equal(result.projectName, "变速箱");
  assert.ok(result.batchId);
  assert.equal(result.filed[0].packageName, "黑色纹理背景");
  assert.equal(result.filed[0].batchId, result.batchId);
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

test("collects unfiled pair partners referenced by batch items", () => {
  const items = makePair();
  const orphanZip = {
    id: "zip-2",
    name: "变速箱_小标注_v01.zip",
    ext: "zip",
    folders: [],
    tags: [],
    annotation: buildAnnotation(
      {
        projectName: "变速箱",
        packageId: "pkg-2",
        packageName: "小标注",
        packageType: "信息条",
        version: "v01",
        aeCompName: "小标注",
        batchId: "batch-OTHER1234567",
      },
      { previewItemId: "png-1", sourceItemId: "zip-2" }
    ),
  };
  const outside = {
    id: "zip-3",
    name: "无关.zip",
    ext: "zip",
    folders: ["preview-root"],
    tags: [],
    annotation: "项目：其他\npackage_id：pkg-3\nbatch_id：batch-OTHER1234567\n",
  };
  const collected = collectBatchItems([...items, orphanZip, outside], "batch-1");

  assert.equal(collected.length, 3);
  assert.ok(collected.some((item) => item.id === "zip-2"));
  assert.ok(!collected.some((item) => item.id === "zip-3"));
});

test("keeps an incomplete older batch from shadowing a complete newer batch", () => {
  const [currentPreview, currentSource] = makePair({
    pkg: { batchId: "batch-CURRENT12345" },
    previewId: "png-current",
    sourceId: "zip-current",
  });
  const [, oldSource] = makePair({
    pkg: { batchId: "batch-OLDER123456" },
    previewId: "png-missing",
    sourceId: "zip-old",
  });

  const plan = planFormalFile([currentPreview, currentSource, oldSource]);

  assert.equal(plan.readyPairs.length, 1);
  assert.equal(plan.readyPairs[0].batchId, "batch-CURRENT12345");
  assert.equal(plan.readyPairs[0].preview.id, "png-current");
  assert.equal(plan.readyPairs[0].source.id, "zip-current");
  assert.ok(
    plan.blocked.some(
      (entry) => entry.item.id === "zip-old" && /缺少配对 PNG/.test(entry.reason)
    )
  );
});

test("blocks the same package when two batches both contain complete pairs", () => {
  const first = makePair({
    pkg: { batchId: "batch-FIRST123456" },
    previewId: "png-first",
    sourceId: "zip-first",
  });
  const second = makePair({
    pkg: { batchId: "batch-SECOND12345" },
    previewId: "png-second",
    sourceId: "zip-second",
  });

  const plan = planFormalFile([...first, ...second]);

  assert.equal(plan.readyPairs.length, 0);
  assert.equal(plan.blocked.length, 4);
  assert.ok(plan.blocked.every((entry) => /多个完整批次/.test(entry.reason)));
});

test("queries the selected folder directly and recalls its unfiled partner", async () => {
  const [preview, source] = makePair({
    previewId: "png-direct",
    sourceId: "zip-unfiled",
  });
  source.folders = [];
  const calls = [];
  const adapter = new EaglePluginAdapter({
    item: {
      async get(options) {
        calls.push(options);
        if (options.folders) return [preview];
        if (options.isUnfiled) return [source];
        return [];
      },
      async getAll() {
        throw new Error("getAll should not be required");
      },
    },
  });

  const items = await adapter.getItemsByFolder("batch-1");

  assert.deepEqual(
    items.map((item) => item.id).sort(),
    ["png-direct", "zip-unfiled"]
  );
  assert.ok(calls.some((options) => options.folders?.[0] === "batch-1"));
  assert.ok(calls.some((options) => options.isUnfiled === true));
});

test("queries every descendant folder in a manually imported batch", async () => {
  const [preview, source] = makePair({
    previewId: "png-root",
    sourceId: "zip-child",
  });
  source.folders = ["collected-child"];
  const queriedFolders = [];
  const adapter = new EaglePluginAdapter({
    item: {
      async get(options) {
        if (options.isUnfiled) return [];
        const id = options.folders?.[0];
        queriedFolders.push(id);
        if (id === "batch-1") return [preview];
        if (id === "collected-child") return [source];
        return [];
      },
      async getAll() {
        return [];
      },
    },
  });

  const items = await adapter.getItemsByFolder("batch-1", {
    folderIds: ["batch-1", "collected-child"],
  });

  assert.deepEqual(
    items.map((item) => item.id).sort(),
    ["png-root", "zip-child"]
  );
  assert.deepEqual(queriedFolders.sort(), ["batch-1", "collected-child"]);
});

test("recursively resolves every folder below a manually imported batch", () => {
  const folders = [
    { id: "batch-1", name: "阿宝包装", parent: "ingest-root" },
    { id: "collected", name: "Root_Collected_Projects", parent: "batch-1" },
    { id: "assets", name: "素材", parent: "collected" },
    { id: "outside", name: "其他", parent: null },
  ];

  assert.deepEqual(collectDescendantFolderIds(folders, "batch-1"), [
    "batch-1",
    "collected",
    "assets",
  ]);
});

test("flattens Eagle's real nested folder tree and preserves inferred parents", () => {
  const folders = flattenFolderTree([
    {
      id: "ingest-root",
      name: "00_待入库",
      children: [
        {
          id: "batch-1",
          name: "阿宝包装",
          children: [
            { id: "collected", name: "Root_Collected_Projects", children: [] },
          ],
        },
      ],
    },
  ]);

  assert.deepEqual(
    folders.map((folder) => [folder.id, folder.parent]),
    [
      ["ingest-root", null],
      ["batch-1", "ingest-root"],
      ["collected", "batch-1"],
    ]
  );
  assert.deepEqual(collectDescendantFolderIds(folders, "batch-1"), [
    "batch-1",
    "collected",
  ]);
});

test("adapter flattens the nested tree returned by Eagle folder.getAll", async () => {
  const adapter = new EaglePluginAdapter({
    folder: {
      async getAll() {
        return [
          {
            id: "ingest-root",
            name: "00_待入库",
            children: [{ id: "batch-1", name: "阿宝包装", children: [] }],
          },
        ];
      },
    },
  });

  const folders = await adapter.getFolders();

  assert.deepEqual(
    folders.map((folder) => [folder.id, folder.parent]),
    [
      ["ingest-root", null],
      ["batch-1", "ingest-root"],
    ]
  );
});

test("preserves getter-backed fields from real Eagle Folder instances", () => {
  class EagleFolder {
    constructor(id, name, children = []) {
      this._id = id;
      this._name = name;
      this._children = children;
    }

    get id() {
      return this._id;
    }

    get name() {
      return this._name;
    }

    get description() {
      return `${this._name}说明`;
    }

    get children() {
      return this._children;
    }
  }

  const folders = flattenFolderTree([
    new EagleFolder("ingest-root", "00_待入库", [
      new EagleFolder("batch-1", "阿宝包装"),
    ]),
  ]);

  assert.deepEqual(
    folders.map((folder) => [folder.id, folder.name, folder.description, folder.parent]),
    [
      ["ingest-root", "00_待入库", "00_待入库说明", null],
      ["batch-1", "阿宝包装", "阿宝包装说明", "ingest-root"],
    ]
  );
});

test("normalizes folder objects attached to Eagle items", () => {
  const [preview, source] = makePair();
  preview.folders = [{ id: "batch-1" }];
  source.folders = [{ id: "batch-1" }];

  const collected = collectBatchItems([preview, source], "batch-1");

  assert.deepEqual(
    collected.map((item) => item.id).sort(),
    ["png-1", "zip-1"]
  );
});

test("infers a formal pair from unannotated Eagle items", () => {
  const items = [
    {
      id: "manual-png",
      name: "阿宝_背景_黑色纹理背景_v02",
      ext: "png",
      folders: ["batch-1"],
      tags: [],
      annotation: "",
    },
    {
      id: "manual-zip",
      name: "阿宝_黑色纹理背景_v02",
      ext: "zip",
      folders: ["batch-1"],
      tags: [],
      annotation: "",
    },
  ];

  const plan = planFormalFile(items, {
    projectName: "阿宝",
    batchId: "batch-MANUAL123456",
    batchFolderId: "batch-1",
    folderDepthById: { "batch-1": 0 },
  });

  assert.equal(plan.readyPairs.length, 1);
  assert.equal(plan.readyPairs[0].packageType, "背景");
  assert.equal(plan.readyPairs[0].version, "v02");
  assert.equal(plan.readyPairs[0].batchId, "batch-MANUAL123456");
  assert.equal(plan.reviewPairs.length, 0);
});

test("offers a type correction for an unannotated pair instead of rejecting it", () => {
  const items = [
    {
      id: "manual-png",
      name: "片头动画",
      ext: "png",
      folders: ["batch-1"],
      tags: [],
      annotation: "",
    },
    {
      id: "manual-zip",
      name: "片头动画",
      ext: "zip",
      folders: ["batch-1"],
      tags: [],
      annotation: "",
    },
  ];
  const options = {
    projectName: "变速箱",
    batchId: "batch-MANUAL123456",
    batchFolderId: "batch-1",
    folderDepthById: { "batch-1": 0 },
  };

  const initial = planFormalFile(items, options);
  assert.equal(initial.readyPairs.length, 0);
  assert.equal(initial.reviewPairs.length, 1);
  assert.match(initial.reviewPairs[0].reason, /选择包装类型/);

  const corrected = planFormalFile(items, {
    ...options,
    overrides: {
      [initial.reviewPairs[0].packageId]: { packageType: "信息条" },
    },
  });
  assert.equal(corrected.reviewPairs.length, 0);
  assert.equal(corrected.readyPairs.length, 1);
  assert.equal(corrected.readyPairs[0].packageType, "信息条");
});

test("classifies manual labels and nameplates as information strips", () => {
  const items = [
    { id: "label-png", name: "小标注", ext: "png", folders: ["batch-1"] },
    { id: "label-zip", name: "小标注", ext: "zip", folders: ["batch-1"] },
    { id: "name-png", name: "人物人名条", ext: "png", folders: ["batch-1"] },
    { id: "name-zip", name: "人物人名条", ext: "zip", folders: ["batch-1"] },
  ];

  const plan = planFormalFile(items, {
    projectName: "变速箱",
    batchFolderId: "batch-1",
    folderDepthById: { "batch-1": 0 },
  });

  assert.equal(plan.reviewPairs.length, 0);
  assert.equal(plan.readyPairs.length, 2);
  assert.ok(plan.readyPairs.every((pair) => pair.packageType === "信息条"));
});

test("ignores non PNG and ZIP files in a manually imported folder", () => {
  const plan = planFormalFile(
    [
      {
        id: "manual-video",
        name: "业务画面",
        ext: "mp4",
        folders: ["batch-1"],
        tags: [],
        annotation: "",
      },
    ],
    { projectName: "阿宝", batchFolderId: "batch-1" }
  );

  assert.equal(plan.blocked.length, 0);
  assert.equal(plan.ignored.length, 1);
});

test("formal filing writes inferred metadata for manually imported items", async () => {
  const items = [
    {
      id: "manual-png",
      name: "阿宝_背景_黑色纹理背景_v02",
      ext: "png",
      folders: ["batch-1"],
      tags: [],
      annotation: "",
    },
    {
      id: "manual-zip",
      name: "阿宝_黑色纹理背景_v02",
      ext: "zip",
      folders: ["batch-1"],
      tags: [],
      annotation: "",
    },
  ];
  const adapter = new FakeAdapter(items);
  adapter.folders.push({ id: "batch-1", name: "阿宝包装", parent: "ingest-root" });

  const result = await fileBatch(adapter, "batch-1", {
    projectName: "阿宝",
    batchId: "batch-MANUAL123456",
  });

  assert.equal(result.filed.length, 1);
  const preview = adapter.items.find((item) => item.id === "manual-png");
  const source = adapter.items.find((item) => item.id === "manual-zip");
  assert.ok(preview.annotation.includes("项目：阿宝"));
  assert.ok(preview.annotation.includes("包装类型：背景"));
  assert.ok(preview.annotation.includes("配对 ZIP：manual-zip"));
  assert.equal(preview.annotation, source.annotation);
  assert.ok(preview.tags.includes("01_预览图"));
  assert.ok(source.tags.includes("02_AE源文件"));
});
