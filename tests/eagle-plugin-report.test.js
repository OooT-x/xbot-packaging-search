const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { parseReportFile, parseReportText } = require("../eagle-plugin/lib/report");
const { scanDirectory } = require("../eagle-plugin/lib/scan");

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `xbot-report-${prefix}-`));
}

function writeFile(root, relative, content) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

test("parses English and Chinese Collect Files dependency sections", () => {
  const report = parseReportText([
    "After Effects Collect Files Report",
    "Project: 阿宝包装.aep",
    "Compositions:",
    "  1. 包装",
    "  2. 视频框",
    "Collected Files:",
    "  Footage\\background.png",
    "  Footage\\clip.mp4",
    "Fonts Used: 思源黑体, Arial",
    "Effects/Plugins:",
    "  - Video Copilot Saber",
    "Missing Footage:",
    "  D:\\assets\\missing-logo.png",
    "Comments:",
    "  收集前请确认第三方效果授权",
  ].join("\r\n"));

  assert.equal(report.status, "parsed");
  assert.equal(report.project, "阿宝包装.aep");
  assert.deepEqual(report.compositions, ["包装", "视频框"]);
  assert.deepEqual(report.files, ["Footage\\background.png", "Footage\\clip.mp4"]);
  assert.deepEqual(report.fonts, ["思源黑体", "Arial"]);
  assert.deepEqual(report.effects, ["Video Copilot Saber"]);
  assert.deepEqual(report.missingFootage, ["D:\\assets\\missing-logo.png"]);
  assert.deepEqual(report.comments, ["收集前请确认第三方效果授权"]);
});

test("decodes a UTF-16LE AE report and records its encoding", () => {
  const root = makeTempDir("utf16");
  try {
    const reportPath = path.join(root, "Report.txt");
    const content = "字体:\r\n  思源黑体\r\n效果:\r\n  Saber\r\n";
    fs.writeFileSync(reportPath, Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(content, "utf16le"),
    ]));

    const report = parseReportFile(reportPath);

    assert.equal(report.status, "parsed");
    assert.equal(report.encoding, "utf-16le");
    assert.deepEqual(report.fonts, ["思源黑体"]);
    assert.deepEqual(report.effects, ["Saber"]);
    assert.equal(report.error, null);

    const bomlessPath = path.join(root, "Report-bomless.txt");
    fs.writeFileSync(bomlessPath, Buffer.from(content, "utf16le"));
    const bomless = parseReportFile(bomlessPath);
    assert.equal(bomless.encoding, "utf-16le");
    assert.deepEqual(bomless.fonts, ["思源黑体"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("attaches report facts to the local PNG and ZIP pair and blocks missing footage", () => {
  const root = makeTempDir("scan");
  try {
    writeFile(root, "包装_信息条_人物条_v01.png", "png");
    writeFile(root, "包装_人物条_v01.zip", "zip");
    writeFile(root, "Report.txt", [
      "Project: 包装.aep",
      "Compositions: 信息条",
      "Files:",
      "  Footage\\logo.png",
      "Fonts:",
      "  思源黑体",
      "Effects:",
      "  Saber",
      "Missing Footage:",
      "  Footage\\logo.png",
    ].join("\n"));

    const result = scanDirectory(root, { projectName: "包装" });
    const pkg = result.packages[0];
    const reportFile = result.files.find((file) => file.name === "Report.txt");

    assert.equal(result.reports.length, 1);
    assert.equal(result.reports[0].status, "parsed");
    assert.equal(reportFile.status, "validate-only");
    assert.equal(pkg.reportStatus, "parsed");
    assert.deepEqual(pkg.reportCompositions, ["信息条"]);
    assert.deepEqual(pkg.reportCollectedFiles, ["Footage\\logo.png"]);
    assert.deepEqual(pkg.fonts, ["思源黑体"]);
    assert.deepEqual(pkg.effects, ["Saber"]);
    assert.deepEqual(pkg.missingFootage, ["Footage\\logo.png"]);
    assert.equal(pkg.dependencyStatus, "blocked");
    assert.equal(pkg.state, "blocked");
    assert.ok(pkg.warnings.some((warning) => /阻止入库/.test(warning)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("uses report_files from a manifest to associate a report outside the asset directory", () => {
  const root = makeTempDir("manifest-reference");
  try {
    writeFile(root, "preview.png", "png");
    writeFile(root, "source.zip", "zip");
    writeFile(root, "meta/manifest.json", JSON.stringify({
      manifest_version: 1,
      packages: [{
        package_id: "pkg-report-reference",
        project_name: "变速箱",
        package_name: "黑底背景",
        package_type: "背景",
        version: "v01",
        ae_comp_name: "黑底背景",
        preview_file: "preview.png",
        source_file: "source.zip",
        report_files: ["meta/Report.txt"],
      }],
    }));
    writeFile(root, "meta/Report.txt", "字体:\n  思源黑体\n效果:\n  Saber\n");

    const result = scanDirectory(root);
    const pkg = result.packages[0];

    assert.equal(result.errors.length, 0);
    assert.equal(pkg.reportStatus, "parsed");
    assert.deepEqual(pkg.reportFiles, [path.join("meta", "Report.txt")]);
    assert.deepEqual(pkg.fonts, ["思源黑体"]);
    assert.deepEqual(pkg.effects, ["Saber"]);
    assert.equal(pkg.dependencyStatus, "warning");
    assert.equal(pkg.state, "ready");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("associates a report nested below the collected-project directory", () => {
  const root = makeTempDir("nested-report");
  try {
    writeFile(root, "包装_背景_黑底_v01.png", "png");
    writeFile(root, "包装_黑底_v01.zip", "zip");
    writeFile(root, "Root_Collected_Projects/包装_黑底_v01_收集/Report.txt", "字体:\n  思源黑体\n");

    const result = scanDirectory(root, { projectName: "包装" });
    const pkg = result.packages[0];

    assert.equal(pkg.reportStatus, "parsed");
    assert.deepEqual(pkg.fonts, ["思源黑体"]);
    assert.deepEqual(pkg.reportFiles, [path.join("Root_Collected_Projects", "包装_黑底_v01_收集", "Report.txt")]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
