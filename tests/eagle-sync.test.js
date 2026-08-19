const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  buildCatalog,
  parseAnnotation,
  readLibraryFromDisk,
  resolveEagleItemFile,
  syncEagleCatalog,
} = require("../bot/lib/eagle-sync");
const { PackageDatabase } = require("../bot/lib/package-database");

function makeItem(library, id, ext, annotation, tags = []) {
  const dir = path.join(library, "images", `${id}.info`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `asset.${ext}`);
  fs.writeFileSync(file, ext === "png" ? "preview" : "source");
  fs.writeFileSync(path.join(dir, "metadata.json"), "{}");
  return {
    id,
    ext,
    name: `asset-${id}`,
    size: fs.statSync(file).size,
    tags,
    annotation,
    modificationTime: 123,
  };
}

test("parses Eagle annotations with Chinese and ASCII colons", () => {
  const parsed = parseAnnotation("项目：变速箱\npackage_id: pkg-1\n包装类型：信息条");
  assert.equal(parsed["项目"], "变速箱");
  assert.equal(parsed.package_id, "pkg-1");
  assert.equal(parsed["包装类型"], "信息条");
});

test("resolves the original item file without selecting metadata or thumbnails", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "xbot-eagle-"));
  try {
    const item = makeItem(temp, "preview-1", "png", "");
    fs.writeFileSync(
      path.join(temp, "images", "preview-1.info", "asset_thumbnail.png"),
      "thumb"
    );
    assert.equal(path.basename(resolveEagleItemFile(temp, item)), "asset.png");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("builds one active package from a paired PNG and ZIP", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "xbot-catalog-"));
  try {
    const common = [
      "项目：变速箱",
      "package_id：pkg-gearbox",
      "包装名称：小标注",
      "包装类型：信息条",
      "版本：v01",
      "AE 合成：小标注",
      "状态：启用（依赖警告）",
    ].join("\n");
    const items = [
      makeItem(temp, "preview-1", "png", common, ["变速箱", "信息条", "重点标注"]),
      makeItem(temp, "source-1", "zip", common, ["依赖警告"]),
    ];
    const catalog = buildCatalog(items, temp, { 变速箱: ["齿轮箱项目"] });

    assert.equal(catalog.errors.length, 0);
    assert.equal(catalog.projects.length, 1);
    assert.deepEqual(catalog.projects[0].aliases.sort(), ["变速箱包装", "齿轮箱项目"].sort());
    assert.equal(catalog.packages.length, 1);
    assert.equal(catalog.packages[0].dependency_status, "warning");
    assert.equal(path.extname(catalog.packages[0].preview_path), ".png");
    assert.equal(path.extname(catalog.packages[0].source_path), ".zip");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("reads and syncs an Eagle library from disk without the API", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "xbot-disk-lib-"));
  try {
    fs.writeFileSync(
      path.join(temp, "metadata.json"),
      JSON.stringify({ name: "包装", folders: [] })
    );
    const common = [
      "项目：变速箱",
      "package_id：pkg-gearbox",
      "包装名称：小标注",
      "包装类型：信息条",
      "版本：v01",
      "AE 合成：小标注",
      "状态：启用（依赖警告）",
    ].join("\n");
    const writeItem = (id, ext, annotation, tags = []) => {
      const dir = path.join(temp, "images", `${id}.info`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `asset.${ext}`), "x");
      fs.writeFileSync(
        path.join(dir, "metadata.json"),
        JSON.stringify({
          id,
          ext,
          name: `asset-${id}`,
          tags,
          annotation,
          modificationTime: 1,
          folders: [],
        })
      );
    };
    writeItem("preview-1", "png", common, ["变速箱", "信息条"]);
    writeItem("source-1", "zip", common, ["依赖警告"]);

    const library = readLibraryFromDisk(temp);
    assert.equal(library.name, "包装");
    assert.equal(library.items.length, 2);

    const database = new PackageDatabase(path.join(temp, "packaging.sqlite"));
    try {
      const report = await syncEagleCatalog(database, {
        libraryPath: temp,
        aliasesPath: path.join(temp, "aliases.json"),
      });
      assert.equal(report.library_source, "disk");
      assert.equal(report.package_count, 1);
      assert.equal(database.activePackageCount(), 1);
    } finally {
      database.close();
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
