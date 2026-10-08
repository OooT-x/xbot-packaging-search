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
  readUpdateCache,
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

test("cache rebases installed versions and tolerates invalid or blocked storage", () => {
  const now = Date.now(), info = inspectLatestRelease(release("1.8.0"), "1.7.7");
  const storage = { getItem: () => JSON.stringify({ info, checkedAt: now - 100 }) };
  assert.equal(readUpdateCache(storage, "1.8.0", now).info.updateAvailable, false);
  assert.equal(readUpdateCache(storage, "1.7.7", now).fresh, true);
  assert.equal(readUpdateCache(storage, "1.7.7", now + 86400000).fresh, false);
  assert.equal(readUpdateCache(storage, "1.7.7", now - 1000), null);
  assert.equal(readUpdateCache({ getItem: () => "broken" }, "1.8.0"), null);
  assert.equal(readUpdateCache({ getItem: () => { throw new Error("blocked"); } }, "1.8.0"), null);
});

test("queries subsequent Release pages before selecting the greatest stable version", async () => {
  let calls = 0;
  const first = [release("1.8.0"), ...Array.from({ length: 99 }, () => ({ tag_name: "bot-v1.0.0" }))];
  const result = await checkForUpdate("1.8.4", { request: async url => {
    calls++;
    return Buffer.from(JSON.stringify(new URL(url).searchParams.get("page") === "1" ? first : [release("1.9.0")]));
  } });
  assert.equal(calls, 2);
  assert.equal(result.version, "1.9.0");
});

test("rejects unverifiable downloads and leaves no partial or replaced package on failure", async t => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "xbot-update-invalid-"));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const info = inspectLatestRelease(release("1.8.0"), "1.7.7");
  let calls = 0;
  const options = { downloadAsset: async () => { calls++; return Buffer.from("plugin"); } };
  await assert.rejects(downloadPluginUpdate({ ...info, asset: { ...info.asset, digest: null } }, directory, options), /SHA-256/);
  assert.equal(calls, 0);
  await assert.rejects(downloadPluginUpdate(info, directory, { downloadAsset: async () => Buffer.from("truncated") }), /大小/);
  await assert.rejects(downloadPluginUpdate(info, directory, { downloadAsset: async () => { throw new Error("interrupted"); } }), /interrupted/);
  assert.deepEqual(await fs.promises.readdir(directory), []);
  const result = await downloadPluginUpdate(info, directory, options);
  await assert.rejects(downloadPluginUpdate({ ...info, asset: { ...info.asset, digest: "0".repeat(64) } }, directory, options), /SHA-256/);
  assert.equal(await fs.promises.readFile(result.path, "utf8"), "plugin");
  assert.deepEqual(await fs.promises.readdir(directory), [info.asset.name]);
});

test("transport reports progress and rejects interrupted or unsafe redirected responses", async () => {
  const vm = require("node:vm"), { EventEmitter } = require("node:events");
  const source = fs.readFileSync(path.join(__dirname, "../eagle-plugin/lib/updater.js"), "utf8");
  function transport(status, headers, emit) {
    const fake = { get: (_, __, callback) => {
      const request = new EventEmitter(); request.setTimeout = () => {};
      const response = new EventEmitter();
      Object.assign(response, { statusCode: status, headers, resume() {}, destroy() {} });
      queueMicrotask(() => { callback(response); emit(response); });
      return request;
    } };
    return vm.runInNewContext(source + "\nrequestBuffer", {
      require: name => name === "node:https" ? fake : require(name), module: { exports: {} }, URL, Buffer, process,
    });
  }
  const progress = [];
  const complete = transport(200, { "content-length": 6 }, response => {
    response.emit("data", Buffer.from("plugin")); response.emit("end");
  });
  assert.equal((await complete("https://github.com/file", { onProgress: p => progress.push(p) })).toString(), "plugin");
  assert.equal(progress[0].received, 6);
  const interrupted = transport(200, {}, response => response.emit("aborted"));
  await assert.rejects(interrupted("https://github.com/file"), /中断/);
  const redirect = transport(302, { location: "https://example.com/file" }, () => {});
  await assert.rejects(redirect("https://github.com/file"), /HTTPS/);
  const rateLimited = transport(429, {}, () => {});
  await assert.rejects(rateLimited("https://github.com/file"), /频率/);
});
