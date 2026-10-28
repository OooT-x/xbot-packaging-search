const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { configuredLibraryPath } = require("../bot/lib/library-config");

test("library configuration preserves fallback and explicit environment override", () => {
  const configFile = path.join(os.tmpdir(), `missing-library-${process.pid}.json`);
  assert.equal(configuredLibraryPath("old-library", { env: {}, configFile }), "old-library");
  assert.equal(configuredLibraryPath("", { env: {}, configFile }), "");
  assert.equal(configuredLibraryPath("old-library", {
    env: { LARK_BOT_EAGLE_LIBRARY_PATH: " explicit-library " }, configFile,
  }), "explicit-library");
});

test("local NAS configuration is shared and invalid configuration never falls back silently", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xbot-library-config-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const configFile = path.join(dir, "library.json");
  const libraryPath = "\\\\server\\share\\包装.library";
  fs.writeFileSync(configFile, JSON.stringify({ libraryPath }));
  assert.equal(configuredLibraryPath("old-library", { env: {}, configFile }), libraryPath);
  fs.writeFileSync(configFile, JSON.stringify({ libraryPath: "" }));
  assert.throws(() => configuredLibraryPath("old-library", { env: {}, configFile }), /Invalid Eagle libraryPath/);
  fs.writeFileSync(configFile, "{");
  assert.throws(() => configuredLibraryPath("old-library", { env: {}, configFile }), SyntaxError);
});
