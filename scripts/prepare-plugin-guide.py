"""Create an offline documentation fixture from production UI. No Eagle I/O."""
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'data/manual-build'
OUT.mkdir(parents=True, exist_ok=True)
page = (ROOT / 'eagle-plugin/index.html').read_text(encoding='utf-8')
runtime = (ROOT / 'eagle-plugin/js/v5-runtime.js').read_text(encoding='utf-8')
demo = (ROOT / 'ui-preview/xbot-eagle-interaction-system-v5.html').read_text(encoding='utf-8')
sample = demo[demo.index('const compositions='):demo.index('const initialPairs=')]
runtime = re.sub(r'const compositions=\[\];\s*const pairs=\[\];\s*const managed=\[\];', lambda _: sample, runtime, count=1)
runtime = runtime.replace("activeComp=null", "activeComp=1").replace("projectName=''", "projectName='示例项目'").replace("selectedPair=''", "selectedPair='p1'").replace("managedId=''", "managedId='m1'")
runtime = runtime.replace('支付宝阿宝', '示例项目').replace('华为途灵', '示例项目B').replace('乾崑奕境', '示例项目C')
page = re.sub(r"<script\s+src=['\"]([^'\"]+)['\"]\s*></script>", '', page)
page = page.replace('</head>', '<script>function initializeProductionWorkbench(){return false;}</script></head>')
workbench = (ROOT / 'eagle-plugin/js/workbench.js').read_text(encoding='utf-8')
team = workbench[workbench.index('function prodOpenTeamSettings()'):workbench.index('async function prodRunImport')]
(OUT / 'team-function.js').write_text(team, encoding='utf-8')
rename = workbench[workbench.index('function prodOpenRename()'):workbench.index('function prodOpenDiagnostics()')]
(OUT / 'rename-function.js').write_text(rename, encoding='utf-8')
boundary = workbench[workbench.index('function prodRenderIngestBoundary('):workbench.index('function prodShowIngestRetry(')]
(OUT / 'boundary-function.js').write_text(boundary, encoding='utf-8')
diagnostics = workbench[workbench.index('function prodOpenDiagnostics()'):workbench.index('function prodOpenTeamSettings()')]
(OUT / 'diagnostics-function.js').write_text(diagnostics, encoding='utf-8')
extra = '''
window.guide={show:setScreen,preview:openPreview,drawer:openReplaceDrawer};
document.querySelector('#aepSourceName').textContent='示例项目.aep';
document.querySelector('#aepSourceMeta').textContent='17 个合成 · 示例数据';
document.querySelector('#aepOutputPath').value='D:\\交付\\示例项目_收集';
document.querySelector('#pairSourceName').textContent='示例项目_收集';
document.querySelector('#pairSourceMeta').textContent='3 组配对 · 示例数据';
document.querySelector('#pairProjectName').value='示例项目';
const guideSettings=document.querySelector('#tweaks');
guideSettings.insertAdjacentHTML('beforeend','<button class="settings-update" data-action="team-settings"><span class="settings-update-copy"><strong>团队连接</strong><small>配置与检查</small></span></button><button class="settings-update" data-action="diagnostics"><span class="settings-update-copy"><strong>诊断信息</strong><small>检查与导出</small></span></button>');
window.markGuide=(entries)=>{
 document.querySelectorAll('.guide-mark').forEach(e=>e.remove());
 entries.forEach(([selector,n])=>{const e=document.querySelector(selector);if(!e)throw Error('Missing '+selector);const r=e.getBoundingClientRect();if(!r.width||!r.height)throw Error('Hidden '+selector);const box=document.createElement('div');box.className='guide-mark';box.style.cssText=`position:fixed;z-index:99999;pointer-events:none;left:${Math.max(2,r.left-3)}px;top:${Math.max(2,r.top-3)}px;width:${r.width+6}px;height:${r.height+6}px;border:2px solid #d34427;border-radius:7px;box-shadow:0 0 0 2px white;`;const badge=document.createElement('b');badge.textContent=n;badge.style.cssText='position:absolute;top:-12px;left:-12px;background:#d34427;color:white;border:2px solid white;border-radius:50%;width:25px;height:25px;display:grid;place-items:center;font:700 15px Arial;';box.append(badge);document.body.append(box);});
};
'''
page = page.replace('</body>', '<script>'+runtime+'\n'+extra+'</script></body>')
(OUT / 'index.html').write_text(page, encoding='utf-8')
print(OUT / 'index.html')
