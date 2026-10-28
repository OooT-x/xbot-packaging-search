const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync('eagle-plugin/js/workbench.js','utf8');

test('pair tab counts follow changed data and conflict filtering shows its matching records', () => {
  const runtime = fs.readFileSync('eagle-plugin/js/v5-runtime.js','utf8');
  const pairs = [{state:'ready'}, {state:'review',risk:true}, {state:'review',conflict:true}];
  const tabs = ['all','ready','review','risk','conflict'].map(pairFilter=>({dataset:{pairFilter}}));
  const start = runtime.indexOf('function pairMatchesFilter('), end = runtime.indexOf('function renderPairs()',start);
  const ctx = {pairs,$$:()=>tabs}; vm.runInNewContext(runtime.slice(start,end),ctx);
  ctx.updatePairTabs(); assert.deepEqual(tabs.map(x=>x.textContent),['全部 3','可以保存 1','待处理 2','有缺失 1','配对冲突 1']);
  pairs[1].state='ready'; pairs[1].risk=false; pairs.push({state:'ready'});
  ctx.updatePairTabs(); assert.deepEqual(tabs.map(x=>x.textContent),['全部 4','可以保存 3','待处理 1','有缺失 0','配对冲突 1']);
  assert.equal(pairs.filter(p=>ctx.pairMatchesFilter(p,'conflict')).length,1);
  pairs.length=0;ctx.updatePairTabs();assert.ok(tabs.every(x=>x.textContent.endsWith(' 0')));
});

for (const kind of ['preview','source']) test(`external ${kind} file becomes a visible selected candidate and survives applying/reopening`, async () => {
  const extension=kind==='preview'?'png':'zip', file=`C:/external/new.${extension}`;
  const pair={id:'p1',name:'sample'}; let rows=[], picked=[file], renders=0;
  const button=()=>({disabled:true,addEventListener(_,fn){this.click=fn;}});
  const pick=button(),apply=button();
  const list={html:'',set innerHTML(value){this.html=value;rows=[...value.matchAll(/data-prod-select-file="([^"]+)" aria-pressed="(true|false)"/g)].map(m=>({...button(),dataset:{prodSelectFile:m[1]},selected:m[2]==='true',scrollIntoView(){}}));},get innerHTML(){return this.html;},querySelectorAll(){return rows;}};
  const document={querySelector(selector){return selector==='.file-candidate-list'?list:selector==='[data-prod-pick-external]'?pick:selector==='[data-prod-apply-file]'?apply:null;},querySelectorAll(selector){return selector==='[data-prod-select-file]'?rows:[];}};
  const context={document,prodPair:()=>pair,prodScanResult:{files:[]},prodPath:path.win32,prodEsc:String,prodImageUrl:x=>x,openDrawer(){},prodSelectPaths:async()=>picked,closeDrawer(){},prodRenderPairs(){renders++;},prodToast(){}};
  const start=source.indexOf('function prodOpenPairFileDrawer('),end=source.indexOf('\nfunction prodOpenStatus',start);
  vm.runInNewContext(source.slice(start,end),context);
  context.prodOpenPairFileDrawer('p1',kind);assert.equal(apply.disabled,true);
  await pick.click();assert.equal(rows.length,1);assert.equal(rows[0].selected,true);assert.ok(list.html.includes(file));assert.equal(apply.disabled,false);
  await pick.click();assert.equal(rows.length,1,'same external file must not duplicate the row');
  picked=[];await pick.click();assert.equal(rows[0].selected,true,'cancel keeps current selection');
  apply.click();assert.equal(pair[kind==='preview'?'previewPath':'sourcePath'],file);assert.equal(renders,1);
  context.prodOpenPairFileDrawer('p1',kind);assert.equal(rows.length,1);assert.equal(rows[0].selected,true);
});
