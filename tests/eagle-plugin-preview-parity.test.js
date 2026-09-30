const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const root = path.join(__dirname, "..");
const previewPath = path.join(root, "ui-preview", "xbot-eagle-interaction-system-v5.html");
const pluginPath = path.join(root, "eagle-plugin", "index.html");
const runtimePath = path.join(root, "eagle-plugin", "js", "v5-runtime.js");
const workbenchPath = path.join(root, "eagle-plugin", "js", "workbench.js");

function read(pathname) {
  return fs.readFileSync(pathname, "utf8");
}

function inlineStyle(html) {
  return html.match(/<style>([\s\S]*?)<\/style>/)?.[1];
}

function bodyShape(html) {
  const body = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/)?.[1];
  assert.ok(body, "expected a body element");
  const markup = body.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  return [...markup.matchAll(/<\/?([a-z][\w-]*)([^<>]*?)>/gi)].map(([, tag, rawAttributes]) => {
    const closing = rawAttributes.startsWith("/");
    const attributes = [...rawAttributes.matchAll(/([\w:-]+)(?:="([^"]*)")?/g)]
      .filter(([, name]) => name === "class" || name === "id" || name === "role" || name.startsWith("aria-") || name.startsWith("data-"))
      .map(([, name, value = ""]) => `${name}=${value}`)
      .sort();
    return `${closing ? "/" : ""}${tag.toLowerCase()} ${attributes.join(" ")}`;
  });
}

test("production plugin keeps the v5 preview styling and interactive DOM structure", () => {
  const preview = read(previewPath);
  const plugin = read(pluginPath);
  assert.equal(inlineStyle(plugin), inlineStyle(preview), "production CSS must be copied from the latest preview");
  assert.deepEqual(bodyShape(plugin), bodyShape(preview), "production markup should retain the preview element and interaction structure");
  assert.match(preview, /id="manageCardSize" type="range"[^>]*aria-label="素材卡片大小"/, "the library should expose an accessible card-size slider");
  assert.match(preview, /#manageGrid\[data-card-size="small"\]/, "the slider sizes must change the card grid density");
  assert.match(preview, /\*::-webkit-scrollbar-button\{display:none/, "custom scrollbars must suppress native scrollbar end caps");
  assert.match(preview, /\.frame-art\.actual-preview-image\{[^}]*background:transparent!important;box-shadow:none/, "real previews must not inherit a decorative backing tile");
  assert.match(plugin, /<script src='js\/workbench\.js'><\/script><script src='js\/v5-runtime\.js'><\/script>/);
  assert.doesNotMatch(plugin, /<script>\s*[\s\S]*?<\/script>/, "production must load the runtime only once");
});

test("production runtime starts without preview fixtures and delegates real work to project services", () => {
  const preview = read(previewPath);
  const runtime = read(runtimePath);
  const workbench = read(workbenchPath);
  assert.match(runtime, /const compositions=\[\];\s*const pairs=\[\];\s*const managed=\[\];/);
  assert.match(runtime, /!window\.prodWorkbenchReady&&next==='pair'/, "the preview-only AEP transition must not replace real scanner output");
  assert.match(workbench, /window\.prodWorkbenchReady = true;/, "the production controller must enable its runtime guard before interactions");
  assert.match(workbench, /prodWorker\.inspectAep/);
  assert.match(workbench, /prodWorker\.collectAep/);
  assert.match(workbench, /prodWorker\.previewAep/);
  assert.match(workbench, /prodEagle\.importFormalBatch/);
  assert.match(workbench, /prodManagedApi\.replaceFormalAsset/);
  assert.match(workbench, /prodManagedApi\.changeFormalPackageType/);
  assert.match(workbench, /manageCardSizeInput\?\.addEventListener\("input"/);
  assert.match(workbench, /has-actual-preview/);
  assert.match(preview, /applyManageCardSize\(manageCardSizeInput\.value,true\)/, "the preview slider must apply and persist the selected density");
  assert.match(runtime, /has-actual-preview/);
});
