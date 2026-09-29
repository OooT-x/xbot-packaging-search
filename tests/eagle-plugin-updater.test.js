const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  checkForUpdate,
  compareVersions,
  downloadPluginUpdate,
  inspectLatestRelease,
  rebaseUpdateInfo,
  selectLatestPluginRelease,
} = require("../eagle-plugin/lib/updater.js");

function release(version, overrides = {}) {
  const name = `xbot-eagle-plugin-v${version}.eagleplugin`;
  return {
    tag_name: `eagle-plugin-v${version}`,
    name: `Eagle 插件 v${version}`,
    body: "修复与改进",
    published_at: "2026-09-29T00:00:00Z",
    html_url: `https://github.com/OooT-x/xbot-packaging-search/releases/tag/eagle-plugin-v${version}`,
    assets: [{
      name,
      size: 6,
      browser_download_url: `https://github.com/OooT-x/xbot-packaging-search/releases/download/eagle-plugin-v${version}/${name}`,
      digest: `sha256:${crypto.createHash("sha256").update("plugin").digest("hex")}`,
    }],
    ...overrides,
  };
}

test("compares stable semantic plugin versions numerically", () => {
  assert.equal(compareVersions("1.10.0", "1.9.9"), 1);
  assert.equal(compareVersions("1.7.7", "1.7.8"), -1);
  assert.equal(compareVersions("1.7.7", "1.7.7"), 0);
  assert.throws(() => compareVersions("1.7", "1.7.7"), /MAJOR\.MINOR\.PATCH/);
});

test("finds only a newer Eagle plugin release with the expected package asset", async () => {
  const newer = await checkForUpdate("1.7.7", { fetchRelease: async () => release("1.8.0") });
  assert.equal(newer.releaseFound, true);
  assert.equal(newer.updateAvailable, true);
  assert.equal(newer.asset.name, "xbot-eagle-plugin-v1.8.0.eagleplugin");
  assert.equal(newer.notes, "修复与改进");

  const current = inspectLatestRelease(release("1.7.7"), "1.7.7");
  assert.equal(current.releaseFound, true);
  assert.equal(current.updateAvailable, false);
});

test("selects the newest stable Eagle plugin release when the repository has other releases", () => {
  const selected = selectLatestPluginRelease([
    { tag_name: "bot-v4.0.0", name: "X.bot" },
    release("1.8.0"),
    release("2.0.0", { prerelease: true }),
    release("1.10.0"),
    release("9.0.0", { draft: true }),
  ]);
  assert.equal(selected.tag_name, "eagle-plugin-v1.10.0");
  assert.equal(selectLatestPluginRelease([{ tag_name: "bot-v4.0.0" }]), null);
});

test("rechecks cached availability against the version installed after the previous check", () => {
  const cached = inspectLatestRelease(release("1.8.0"), "1.7.7");
  assert.equal(cached.updateAvailable, true);
  assert.equal(rebaseUpdateInfo(cached, "1.8.0").updateAvailable, false);
  assert.equal(rebaseUpdateInfo(cached, "1.7.7").updateAvailable, true);
});

test("ignores non-plugin and prerelease releases and rejects incomplete packages", () => {
  assert.equal(inspectLatestRelease({ tag_name: "v0.1.0" }, "1.7.7").releaseFound, false);
  assert.equal(inspectLatestRelease(release("1.8.0", { prerelease: true }), "1.7.7").releaseFound, false);
  assert.throws(() => inspectLatestRelease(release("1.8.0", { assets: [] }), "1.7.7"), /缺少/);
  assert.throws(() => inspectLatestRelease(release("1.8.0", {
    assets: [{ ...release("1.8.0").assets[0], browser_download_url: "http://example.com/plugin" }],
}), "1.7.7"), /HTTPS/);
});

test("reports an empty public Releases page as no update instead of a query failure", async () => {
  const result = await checkForUpdate("1.7.7", { fetchRelease: async () => null });
  assert.equal(result.releaseFound, false);
  assert.equal(result.updateAvailable, false);
});

test("downloads an update atomically and verifies GitHub's SHA-256 digest", async (t) => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "xbot-plugin-update-"));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const info = inspectLatestRelease(release("1.8.0"), "1.7.7");

  const downloaded = await downloadPluginUpdate(info, directory, {
    downloadAsset: async () => Buffer.from("plugin"),
  });
  assert.equal(downloaded.verified, true);
  assert.equal(await fs.promises.readFile(downloaded.path, "utf8"), "plugin");

  await assert.rejects(downloadPluginUpdate({
    ...info,
    asset: { ...info.asset, digest: "0".repeat(64) },
  }, directory, { downloadAsset: async () => Buffer.from("plugin") }), /SHA-256/);
});
