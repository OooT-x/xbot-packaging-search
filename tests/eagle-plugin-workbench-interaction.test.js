const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");

const workbenchPath = path.join(__dirname, "..", "eagle-plugin", "js", "workbench.js");

class TestElement {
  constructor(matches = {}) {
    this.matches = matches;
    this.dataset = {};
  }

  closest(selector) {
    return this.matches[selector] || null;
  }
}

class TestSelectElement extends TestElement {}

function interactionHarness({ pairs = [], managed = [], managedId = "" } = {}) {
  const source = fs.readFileSync(workbenchPath, "utf8");
  const start = source.indexOf("function prodInteraction(event) {");
  const end = source.indexOf("\nfunction prodOpenManagedTypeModal(", start);
  assert.ok(start >= 0 && end > start, "production interaction handler must be available");

  const calls = { renders: 0, previews: [] };
  const context = {
    Element: TestElement,
    HTMLSelectElement: TestSelectElement,
    document: { querySelectorAll: () => [] },
    pairs,
    managed,
    managedId,
    selectedPair: "",
    prodPair: id => pairs.find(pair => pair.id === id),
    prodRenderPairs: () => { calls.renders++; },
    prodOpenImage: (name, file) => { calls.previews.push({ name, file }); },
  };
  const handler = vm.runInNewContext(`${source.slice(start, end)}\nprodInteraction`, context, {
    filename: workbenchPath,
  });
  return { handler, context, calls };
}

function interactionEvent(type, target) {
  return {
    type,
    target,
    defaultPrevented: false,
    stopped: false,
    preventDefault() { this.defaultPrevented = true; },
    stopImmediatePropagation() { this.stopped = true; },
  };
}

test("custom package-type trigger click reaches its own menu handler", () => {
  const row = new TestElement();
  row.dataset.pair = "pair-1";
  row.classList = { toggle() {} };
  const trigger = new TestElement({ "#pairList .pair-row": row });
  trigger.dataset.cardType = "pair-1";
  trigger.matches["[data-card-type]"] = trigger;
  const { handler, context } = interactionHarness({ pairs: [{ id: "pair-1", type: "" }] });
  const event = interactionEvent("click", trigger);

  handler(event);

  assert.equal(context.selectedPair, "pair-1");
  assert.equal(event.stopped, false, "capture handler must not swallow the custom button click");
  assert.equal(event.defaultPrevented, false, "the trigger must retain its normal click behavior");
});

test("native package-type select change still updates the pair", () => {
  const pair = { id: "pair-1", type: "" };
  const select = new TestSelectElement();
  select.dataset.cardType = pair.id;
  select.value = "视频框";
  select.matches["[data-card-type]"] = select;
  const { handler, calls } = interactionHarness({ pairs: [pair] });
  const event = interactionEvent("change", select);

  handler(event);

  assert.equal(pair.type, "视频框");
  assert.equal(calls.renders, 1);
  assert.equal(event.stopped, true);
});

test("managed thumbnail opens its own card preview instead of the selected card", () => {
  const cards = [
    { id: "selected", name: "旧选择", previewPath: "C:/selected.png" },
    { id: "clicked", name: "当前点击", previewPath: "C:/clicked.png" },
  ];
  const card = new TestElement();
  card.dataset.managedCard = "clicked";
  const thumb = new TestElement({ "[data-managed-card]": card });
  const image = new TestElement({ "#manageGrid .manage-thumb": thumb });
  const { handler, calls } = interactionHarness({ managed: cards, managedId: "selected" });
  const event = interactionEvent("click", image);

  handler(event);

  assert.deepEqual(calls.previews, [{ name: "当前点击", file: "C:/clicked.png" }]);
  assert.equal(event.defaultPrevented, true);
  assert.equal(event.stopped, true, "card selection should not replace the image click");
});

test("AEP preview opens an empty viewer before rendering and the image viewer afterward", () => {
  const source = fs.readFileSync(workbenchPath, "utf8");
  const start = source.indexOf("function prodOpenAepPreview(comp) {");
  const end = source.indexOf("\nasync function prodCheckUpdates(", start);
  assert.ok(start >= 0 && end > start);
  const calls = { modal: "", opened: [], rendered: [], closed: 0 };
  let generate;
  const context = {
    prodOpenImage: (name, file) => calls.opened.push({ name, file }),
    openModal: html => { calls.modal = html; },
    bindClose: () => {},
    closeModal: () => { calls.closed++; },
    prodRenderPreview: comp => calls.rendered.push(comp),
    prodEsc: value => String(value),
    document: { querySelector: () => ({ addEventListener: (_, listener) => { generate = listener; } }) },
  };
  const open = vm.runInNewContext(`${source.slice(start, end)}\nprodOpenAepPreview`, context);
  const comp = { name: "视频框", prodPreviewPath: "" };

  open(comp);
  assert.match(calls.modal, /暂无预览图/);
  assert.equal(typeof generate, "function");
  generate();
  assert.equal(calls.closed, 1);
  assert.deepEqual(calls.rendered, [comp]);

  comp.prodPreviewPath = "C:/preview.png";
  open(comp);
  assert.deepEqual(calls.opened, [{ name: "视频框", file: "C:/preview.png" }]);
});

test("AEP review explains only matching name and reference heuristics", () => {
  const source = fs.readFileSync(workbenchPath, "utf8");
  const start = source.indexOf("function prodAepReviewReasons(c) {");
  const end = source.indexOf("\nfunction prodOpenAepReview(", start);
  const reasons = vm.runInNewContext(source.slice(start, end) + "\nprodAepReviewReasons", { prodComp: id => ({ name: "父合成" + id }) });
  assert.equal(reasons({name:"背景",parent_ids:[1,1]}).length, 0);
  const video = reasons({name:"视频框-01",parent_ids:[1]});
  assert.equal(video.length, 1);
  assert.match(video[0].detail, /尚未证明工程存在错误/);
  assert.match(video[0].advice, /生成预览/);
  const shared = reasons({name:"临时视频框",parent_ids:[1,2]});
  assert.equal(shared.length, 3);
  assert.match(shared[1].detail, /父合成1、父合成2/);
  assert.match(shared[1].advice, /按 ID 去重/);
});

test("review drawer offers preview generation and viewing without changing collection", () => {
  const source = fs.readFileSync(workbenchPath, "utf8");
  const start = source.indexOf("function prodOpenAepReview(c) {");
  const end = source.indexOf("\nfunction prodRenderAep(", start);
  let html, action, closed = 0;
  const rendered = [], viewed = [];
  const open = vm.runInNewContext(source.slice(start, end) + "\nprodOpenAepReview", {
    prodAepReviewReasons: () => [{title:"取景",detail:"名称提示",advice:"核对代表帧"}],
    prodEsc: value => String(value), openDrawer: value => {html=value;},
    closeDrawer: () => {closed++;},
    prodRenderPreview: comp => rendered.push(comp), prodOpenAepPreview: comp => viewed.push(comp),
    document: {querySelectorAll: () => [], querySelector: () => ({addEventListener: (_, listener) => {action=listener;}})}
  });
  const comp = {name:"视频框-01"};
  open(comp); assert.match(html, /不是工程错误检测结果/); assert.match(html, /生成预览/);
  action(); assert.deepEqual(rendered, [comp]); assert.equal(closed, 1);
  comp.prodPreviewPath = "preview.png"; open(comp); assert.match(html, /查看预览/);
  action(); assert.deepEqual(viewed, [comp]);
});

test("production import keeps Eagle success separate from a failed queue and retries only the event", async () => {
  const source = fs.readFileSync(workbenchPath, "utf8");
  const start = source.indexOf("function prodSubmitIngest(result) {");
  const end = source.indexOf("\nasync function prodRefreshManaged(", start);
  const nodes = new Map(); let queueFails = true, imports = 0;
  const element = () => ({
    children: [], text: "", innerHTML: "",
    set textContent(value) { this.text = value; this.children = []; },
    get textContent() { return this.text; },
    appendChild(child) { this.children.push(child); },
    addEventListener(_, fn) { this.click = fn; },
  });
  const document = {querySelector(selector) {
    if (!nodes.has(selector)) nodes.set(selector, element());
    return nodes.get(selector);
  }, createElement:element, querySelectorAll: () => []};
  const context = {document, pairs:[{selected:true,state:"ready",_package:{},name:"包装",type:"背景"}],
    prodProject:"验收",prodScanResult:{},prodOutputNames:{},workflowDraft:{},
    prodRefreshPairState:() => {},prodAdapter:() => ({}),prodEsc:String,
    closeModal:() => {},prodSetScreen:() => {},prodToast:() => {},
    prodEagle:{async importFormalBatch() {
      imports++; return {filed:[{packageId:"p",packageName:"包装",version:"v01",previewName:"p.png",sourceName:"p.zip"}]};
    }},
    prodIngest:{publishIngestEvent() {
      if (queueFails) throw new Error("queue denied");
      return {state:"queued"};
    }},
  };
  const run = vm.runInNewContext(source.slice(start,end) + "\nprodRunImport",context);
  await run();
  const boundary = document.querySelector("#successBoundary");
  assert.equal(imports,1);
  assert.match(boundary.textContent,/Eagle 已写入正式目录/);
  assert.match(boundary.textContent,/未入队/);
  assert.doesNotMatch(boundary.textContent,/已提交|已入队/);
  assert.match(boundary.children[1].textContent,/尚未保存/);
  queueFails = false; boundary.children[0].click();
  assert.equal(imports,1,"event retry must not write Eagle again");
  assert.match(boundary.textContent,/已入队/);
  assert.match(boundary.textContent,/结果仍待核对/);
  assert.equal(boundary.children.length,0);
  context.prodRenderIngestBoundary({state:"queued"},{archiveError:"archive denied"});
  assert.match(boundary.textContent,/已入队/);
  assert.match(boundary.textContent,/旧版本归档未完成/);
});
