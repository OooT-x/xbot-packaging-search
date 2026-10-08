const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const { execFileSync } = require("node:child_process");

test("type lifecycle persists, refreshes retained containers and preserves historical search", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xbot-types-lifecycle-"));
  const previous = process.env.XBOT_PACKAGE_TYPES_FILE;
  process.env.XBOT_PACKAGE_TYPES_FILE = path.join(root, "types.json");
  const types = require("../eagle-plugin/lib/package-types");
  t.after(() => { if (previous === undefined) delete process.env.XBOT_PACKAGE_TYPES_FILE; else process.env.XBOT_PACKAGE_TYPES_FILE = previous; types.refreshPackageTypes(); fs.rmSync(root, {recursive:true,force:true}); });
  const retainedArray = types.PACKAGE_TYPES, retainedSet = types.PACKAGE_TYPE_SET;
  types.registerPackageType("卡偏", ["卡画面"]);
  types.updatePackageType("卡偏", {name:"卡片"});
  assert.equal(types.normalizePackageType("卡偏"), "卡片");
  assert.ok(retainedArray.includes("卡片")); assert.ok(!retainedSet.has("卡偏"));
  assert.throws(() => types.updatePackageType("卡片", {name:"背景"}));
  assert.throws(() => types.updatePackageType("卡片", {aliases:["信息条"]}));
  assert.throws(() => types.updatePackageType("背景", {name:"底图"}));
  types.updatePackageType("卡片", {enabled:false});
  assert.ok(!retainedArray.includes("卡片")); assert.ok(!retainedSet.has("卡片"));
  assert.equal(types.normalizePackageType("卡偏"), "卡片");
  assert.throws(() => types.registerPackageType("卡偏"));
  const { buildCatalog } = require("../bot/lib/eagle-sync");
  const annotation = "项目：演示项目\npackage_id：old\n包装名称：旧卡片\n包装类型：卡偏\n版本：v01\n状态：启用";
  const items = ["png", "zip"].map(ext => {
    const id = "fixture-" + ext, dir = path.join(root, "images", id + ".info");
    fs.mkdirSync(dir, {recursive:true}); fs.writeFileSync(path.join(dir, "asset." + ext), "fixture");
    return {id,ext,name:"asset",annotation,tags:[],modificationTime:1};
  });
  const catalog = buildCatalog(items, root);
  assert.equal(catalog.errors.length, 0); assert.equal(catalog.packages.length, 1, "retirement must not remove existing indexed assets");
  const intent = require("../bot/lib/package-intent");
  const packages = [{project_id:"p",project_name:"演示项目",normalized_name:"演示项目",aliases:[],package_id:"old",package_name:"旧卡片",package_type:"卡偏",tags:[],eagle_modified_at:1}];
  assert.equal(intent.searchPackages(packages, "找演示项目卡片").candidates[0]?.package_id, "old");
  const reloaded = execFileSync(process.execPath, ["-e", "const t=require('./eagle-plugin/lib/package-types');console.log(t.isPackageTypeActive('卡片'),t.normalizePackageType('卡偏'))"], {cwd:path.join(__dirname,".."),env:process.env,encoding:"utf8"});
  assert.equal(reloaded.trim(), "false 卡片");
  types.updatePackageType("卡片", {enabled:true,aliases:["片卡"]});
  assert.equal(types.isPackageTypeActive("卡片"), true);
  assert.equal(types.normalizePackageType("卡画面"), null, "removed aliases must not remain cached");
  fs.unlinkSync(process.env.XBOT_PACKAGE_TYPES_FILE); types.refreshPackageTypes();
  assert.ok(!retainedArray.includes("卡片")); assert.equal(types.normalizePackageType("卡片"), null);
});

test("registered custom type satisfies production pair validation; retired type still blocks new ingest", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),"xbot-type-pair-")), previous = process.env.XBOT_PACKAGE_TYPES_FILE;
  process.env.XBOT_PACKAGE_TYPES_FILE = path.join(root,"types.json");
  const types = require("../eagle-plugin/lib/package-types");
  t.after(() => { if(previous===undefined)delete process.env.XBOT_PACKAGE_TYPES_FILE;else process.env.XBOT_PACKAGE_TYPES_FILE=previous;types.refreshPackageTypes();fs.rmSync(root,{recursive:true,force:true}); });
  const source=fs.readFileSync(path.join(__dirname,"../eagle-plugin/js/workbench.js"),"utf8");
  const start=source.indexOf("function prodRefreshPairState(pair) {"),end=source.indexOf("\nfunction prodRenderPairs()",start);
  const refresh=vm.runInNewContext(source.slice(start,end)+"\nprodRefreshPairState",{prodTypes:types});
  const pair={type:"卡片",name:"BG-02",previewPath:"preview.png",sourcePath:"source.zip",selected:true,_package:{}};
  refresh(pair);assert.equal(pair.state,"review");
  types.registerPackageType("卡片");refresh(pair);assert.equal(pair.state,"ready");assert.equal(pair._package.packageType,"卡片");
  pair.sourcePath="";refresh(pair);assert.equal(pair.state,"review");assert.match(pair.note,/缺少配对 ZIP/);
  pair.sourcePath="source.zip";types.updatePackageType("卡片",{enabled:false});refresh(pair);assert.equal(pair.state,"review");assert.match(pair.note,/已停用/);
  types.updatePackageType("卡片",{enabled:true});refresh(pair);assert.equal(pair.state,"ready");
});

test("the search-menu shortcut writes the shared registry before refreshing its pair", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),"xbot-type-shortcut-")), previous = process.env.XBOT_PACKAGE_TYPES_FILE;
  process.env.XBOT_PACKAGE_TYPES_FILE=path.join(root,"types.json");
  const types=require("../eagle-plugin/lib/package-types");
  t.after(()=>{if(previous===undefined)delete process.env.XBOT_PACKAGE_TYPES_FILE;else process.env.XBOT_PACKAGE_TYPES_FILE=previous;types.refreshPackageTypes();fs.rmSync(root,{recursive:true,force:true});});
  const source=fs.readFileSync(path.join(__dirname,"../eagle-plugin/js/workbench.js"),"utf8"), runtime=fs.readFileSync(path.join(__dirname,"../eagle-plugin/js/v5-runtime.js"),"utf8");
  const pair={id:"BG-02",type:""}, calls=[];
  const begin=source.indexOf("function prodAddTypeFromMenu("),end=source.indexOf("\nfunction prodOpenTypeManager(",begin);
  const context={prodTypes:types,prodRefreshTypes:()=>types.refreshPackageTypes(),prodPair:id=>id===pair.id?pair:null,prodOutputNames:{},prodRenderPairs:()=>calls.push(types.isPackageTypeActive(pair.type)),closePackageTypePickers:()=>{},prodToast:()=>{},window:{prodWorkbenchReady:true}};
  vm.runInNewContext(source.slice(begin,end)+"\nthis.prodAddTypeFromMenu=prodAddTypeFromMenu",context);
  const start=runtime.indexOf("function addPackageTypeFromMenu("),finish=runtime.indexOf("\n    function enhancePackageTypeMenu(",start);
  const shortcut=vm.runInNewContext(runtime.slice(start,finish)+"\naddPackageTypeFromMenu",context);
  shortcut({_xbotPicker:{querySelector:()=>({dataset:{packageTypeScope:"card",packageTypeTrigger:pair.id}})}},{value:"卡片"},{});
  assert.equal(pair.type,"卡片");assert.deepEqual(calls,[true]);
  assert.ok(JSON.parse(fs.readFileSync(process.env.XBOT_PACKAGE_TYPES_FILE,"utf8")).some(entry=>entry.name==="卡片"));
});
