const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const core = require("../ae-tool/XbotPackagingOrganizer/manifest-core");
const { scanDirectory } = require("../eagle-plugin/lib/scan");

test("normalizes package metadata into Eagle-compatible names", () => {
  assert.equal(core.inferPackageType("人物小标注"), "信息条");
  assert.equal(core.inferPackageType("横版视频框"), "视频框");
  assert.equal(core.normalizeVersion("1"), "v01");
  assert.equal(core.normalizeVersion("V12"), "v12");
  assert.equal(
    core.makePackageStem({
      projectName: "变速箱",
      packageType: "信息条",
      packageName: "人物/小标注",
      version: "1",
    }),
    "变速箱_信息条_人物_小标注_v01"
  );
});

test("creates a deterministic package id and a variable batch id", () => {
  const first = core.stablePackageId("变速箱", "小标注", "v01", "Comp_Label");
  const second = core.stablePackageId("变速箱", "小标注", "v01", "Comp_Label");
  assert.equal(first, second);
  assert.match(first, /^pkg-[0-9a-f]{16}$/);
  assert.match(core.makeBatchId("2026-08-20T10:00:00+08:00", 0.25), /^batch-[A-F0-9]{13}$/);
});

test("blocks missing footage and cross-comp expressions", () => {
  const risk = {
    missingFootage: ["missing.mov"],
    fonts: ["Source Han Sans CN"],
    crossCompExpressions: [{ comp: "包装", target_comp: "控制器" }],
  };
  assert.equal(core.dependencyStatus(risk), "阻止入库");
  assert.deepEqual(core.dependencyWarnings(risk), [
    "存在缺失素材",
    "存在跨合成表达式引用，禁止无提示精简",
    "字体需要在接收环境人工确认",
  ]);
});

test("marks font and third-party effect facts as review warnings", () => {
  assert.equal(core.dependencyStatus({ fonts: ["DIN"] }), "警告");
  assert.equal(core.dependencyStatus({ thirdPartyEffects: ["Deep Glow"] }), "警告");
  assert.equal(core.dependencyStatus({ effects: ["ADBE Gaussian Blur 2"] }), "完整");
});

test("builds the standard manifest entry consumed by Eagle", () => {
  const entry = core.createPackageEntry({
    sourceProjectName: "gearbox-master.aep",
    projectName: "变速箱",
    packageName: "小标注",
    packageType: "信息条",
    version: "1",
    compName: "小标注",
    previewTime: "1.5",
  }, {
    fonts: ["Source Han Sans CN", "Source Han Sans CN"],
    effects: ["ADBE Fill"],
  }, "2026-08-20T10:00:00+08:00");

  assert.equal(entry.version, "v01");
  assert.equal(entry.preview_file, "变速箱_信息条_小标注_v01.png");
  assert.equal(entry.source_file, "变速箱_信息条_小标注_v01.zip");
  assert.equal(entry.alpha_required, false);
  assert.equal(entry.dependency_status, "警告");
  assert.deepEqual(entry.fonts, ["Source Han Sans CN"]);
  assert.equal(entry.ae_comp_name, "小标注");

  const manifest = core.buildManifest("变速箱", [entry], "2026-08-20T10:00:00+08:00", "batch-ABCDE12345678");
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.packages[0].package_id, entry.package_id);
});

test("rejects incomplete or unsafe package metadata", () => {
  assert.deepEqual(core.validatePackageMeta({
    projectName: "",
    packageName: "",
    packageType: "其他",
    version: "latest",
    compName: "",
    previewTime: -1,
  }), [
    "缺少项目名称",
    "缺少包装名称",
    "包装类型无效",
    "版本必须是 v01 形式",
    "缺少 AE 合成名称",
    "预览时间必须是非负秒数",
  ]);
});

test("produces a manifest that the Eagle ingest scanner pairs without guessing", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "xbot-ae-eagle-"));
  try {
    const createdAt = "2026-08-20T10:00:00+08:00";
    const entry = core.createPackageEntry({
      sourceProjectName: "gearbox.aep",
      projectName: "变速箱",
      packageName: "黑色纹理",
      packageType: "背景",
      version: "v01",
      compName: "背景_黑色纹理",
      previewTime: 2,
    }, {}, createdAt);
    const manifest = core.buildManifest("变速箱", [entry], createdAt, "batch-ABCDE12345678");
    fs.writeFileSync(path.join(temp, "manifest.json"), JSON.stringify(manifest, null, 2));
    fs.writeFileSync(path.join(temp, entry.preview_file), "png");
    fs.writeFileSync(path.join(temp, entry.source_file), "zip");

    const scan = scanDirectory(temp);
    assert.equal(scan.errors.length, 0);
    assert.equal(scan.packages.length, 1);
    assert.equal(scan.packages[0].state, "ready");
    assert.equal(scan.packages[0].packageId, entry.package_id);
    assert.equal(scan.packages[0].aeCompName, "背景_黑色纹理");
    assert.equal(scan.stats.toImport, 2);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
