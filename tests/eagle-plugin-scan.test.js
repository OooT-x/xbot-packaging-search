const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  classifyFile,
  createBatchId,
  metadataFromPair,
  scanDirectory,
  similarityGrade,
} = require("../eagle-plugin/lib/scan");

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `xbot-ingest-${prefix}-`));
}

function writeFile(root, relative, content = "x") {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

test("classifies files into four states", () => {
  const cases = [
    ["preview.png", "candidate"],
    ["sub/inside.png", "ignore"],
    ["source.zip", "candidate"],
    ["Root_Collected_Projects/collected.zip", "candidate"],
    ["deep/nested/source.zip", "ignore"],
    ["project.aep", "validate-only"],
    ["AE收集报告.txt", "validate-only"],
    ["Arial.ttf", "ignore"],
    ["preview.mp4", "ignore"],
    ["shot.jpg", "ignore"],
    ["notes.md", "ignore"],
  ];
  for (const [relative, status] of cases) {
    const entry = {
      name: path.basename(relative),
      relative,
      ext: path.extname(relative).toLowerCase(),
    };
    assert.equal(classifyFile(entry).status, status, relative);
  }
});

test("pairs a root PNG with a matching ZIP without a manifest", () => {
  const temp = makeTempDir("basic");
  try {
    const png = writeFile(temp, "变速箱_信息条_小标注_v01.png", "png");
    const zip = writeFile(temp, "变速箱_小标注_v01.zip", "zip");
    const result = scanDirectory(temp, { projectName: "变速箱" });

    assert.equal(result.hasManifest, false);
    assert.equal(result.packages.length, 1);
    const pkg = result.packages[0];
    assert.equal(pkg.state, "ready");
    assert.equal(pkg.packageName, "小标注");
    assert.equal(pkg.packageType, "信息条");
    assert.equal(pkg.version, "v01");
    assert.equal(path.resolve(pkg.preview.path), path.resolve(png));
    assert.equal(path.resolve(pkg.source.path), path.resolve(zip));
    assert.match(pkg.packageId, /^pkg-[0-9a-f]{16}$/);
    assert.equal(result.stats.toImport, 2);
    assert.equal(result.stats.conflict, 0);
    assert.equal(result.files.filter((file) => file.status === "to-import").length, 2);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("marks ambiguous PNG/ZIP pairs as conflicts", () => {
  const temp = makeTempDir("conflict");
  try {
    writeFile(temp, "变速箱_背景_黑底_v01.png");
    writeFile(temp, "变速箱_信息条_黑底_v01.png");
    writeFile(temp, "变速箱_黑底_v01.zip");
    const result = scanDirectory(temp, { projectName: "变速箱" });

    assert.equal(result.packages.length, 3);
    assert.ok(result.packages.every((pkg) => pkg.state === "blocked"));
    assert.equal(result.stats.conflict, 3);
    assert.equal(result.stats.toImport, 0);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("keeps an unmatched preview as a conflict", () => {
  const temp = makeTempDir("lonely");
  try {
    writeFile(temp, "变速箱_背景_黑底_v01.png");
    const result = scanDirectory(temp);

    assert.equal(result.packages.length, 1);
    assert.equal(result.packages[0].state, "blocked");
    assert.equal(result.stats.conflict, 1);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("imports exactly the files referenced by a manifest", () => {
  const temp = makeTempDir("manifest");
  try {
    writeFile(temp, "manifest.json", JSON.stringify({
      manifest_version: 1,
      packages: [
        {
          package_id: "pkg-gearbox-bg",
          project_name: "变速箱",
          package_name: "黑底背景",
          package_type: "背景",
          version: "v01",
          ae_comp_name: "黑底背景",
          preview_file: "变速箱_背景_黑底背景_v01.png",
          source_file: "变速箱_黑底背景_v01.zip",
          dependency_status: "complete",
          fonts: ["思源黑体"],
          effects: [],
        },
      ],
    }));
    writeFile(temp, "变速箱_背景_黑底背景_v01.png", "png");
    writeFile(temp, "变速箱_黑底背景_v01.zip", "zip");
    writeFile(temp, "变速箱_信息条_旧版_v01.png", "png");
    writeFile(temp, "变速箱_旧版_v01.zip", "zip");

    const result = scanDirectory(temp);
    assert.equal(result.hasManifest, true);
    assert.equal(result.errors.length, 0);
    assert.equal(result.packages.length, 1);
    assert.equal(result.packages[0].state, "ready");
    assert.deepEqual(result.packages[0].fonts, ["思源黑体"]);
    assert.equal(result.stats.toImport, 2);
    assert.equal(result.stats.conflict, 0);
    assert.equal(
      result.files.filter((file) => file.status === "ignore" && /旧版/.test(file.name)).length,
      2
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("blocks manifest entries with missing or duplicated references", () => {
  const temp = makeTempDir("manifest-bad");
  try {
    writeFile(temp, "manifest.json", JSON.stringify({
      packages: [
        {
          package_id: "pkg-missing",
          project_name: "变速箱",
          package_name: "缺失源",
          package_type: "背景",
          preview_file: "ok.png",
          source_file: "missing.zip",
        },
        {
          package_id: "pkg-shared",
          project_name: "变速箱",
          package_name: "共用预览",
          package_type: "背景",
          preview_file: "shared.png",
          source_file: "shared.zip",
        },
        {
          package_id: "pkg-shared-2",
          project_name: "变速箱",
          package_name: "共用预览二",
          package_type: "背景",
          preview_file: "shared.png",
          source_file: "shared2.zip",
        },
      ],
    }));
    writeFile(temp, "ok.png");
    writeFile(temp, "shared.png");
    writeFile(temp, "shared.zip");
    writeFile(temp, "shared2.zip");

    const result = scanDirectory(temp);
    assert.ok(result.errors.some((message) => /不存在/.test(message)));
    assert.ok(result.errors.some((message) => /多个 manifest 条目/.test(message)));
    assert.equal(result.packages.length, 3);
    assert.equal(result.packages[0].state, "blocked");
    assert.ok(result.packages[1].state === "blocked" || result.packages[2].state === "blocked");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("blocks entries marked as blocked by the manifest", () => {
  const temp = makeTempDir("manifest-blocked");
  try {
    writeFile(temp, "manifest.json", JSON.stringify({
      packages: [
        {
          package_id: "pkg-blocked",
          project_name: "变速箱",
          package_name: "风险背景",
          package_type: "背景",
          version: "v01",
          preview_file: "a.png",
          source_file: "a.zip",
          dependency_status: "阻止入库",
        },
      ],
    }));
    writeFile(temp, "a.png");
    writeFile(temp, "a.zip");

    const result = scanDirectory(temp);
    assert.equal(result.packages[0].state, "blocked");
    assert.ok(result.packages[0].warnings.some((warning) => /阻止入库/.test(warning)));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("generates a stable batch key and a valid batch id", () => {
  const temp = makeTempDir("batch");
  try {
    writeFile(temp, "变速箱_背景_黑底_v01.png", "png");
    writeFile(temp, "变速箱_黑底_v01.zip", "zip");
    const first = scanDirectory(temp);
    const second = scanDirectory(temp);

    assert.equal(first.batchKey, second.batchKey);
    assert.match(first.batchId, /^batch-[A-Z0-9]{13}$/);
    assert.notEqual(first.batchId, second.batchId);
    assert.equal(scanDirectory(temp, { batchId: "batch-FIXED1234567" }).batchId, "batch-FIXED1234567");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("extracts metadata and similarity from file names", () => {
  assert.equal(
    similarityGrade("变速箱_信息条_小标注_v01", "变速箱_小标注_v01"),
    "medium"
  );
  assert.equal(
    similarityGrade("变速箱_信息条_小标注_v02", "变速箱_小标注_v01"),
    "none"
  );
  const metadata = metadataFromPair(
    { name: "阿宝_信息条_人物条_v02.png" },
    { name: "阿宝_人物条_v02.zip" },
    "阿宝"
  );
  assert.equal(metadata.packageName, "人物条");
  assert.equal(metadata.packageType, "信息条");
  assert.equal(metadata.version, "v02");
  assert.equal(createBatchId().length, 19);
});
