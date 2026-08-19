import { chromium } from 'playwright';
import { mkdir, rm } from 'node:fs/promises';
const b = await chromium.launch({headless:true, args:['--use-angle=metal','--enable-gpu']});
const p = await (await b.newContext({viewport:{width:520,height:292}, deviceScaleFactor:1})).newPage();
p.on('pageerror', e=>console.log('[pe]', e.message));
await p.goto('http://127.0.0.1:5173/?manual&deterministic',{waitUntil:'load'});
await p.waitForFunction('window.__ready===true');
await rm('shots/diag',{recursive:true,force:true}); await mkdir('shots/diag',{recursive:true});
console.log(JSON.stringify(await p.evaluate(()=>{
  const g=window.__game; g.debugHud=false; window.__t=1000; g.clock.reset(1000); g.step(1000);
  const tally={};
  g.scene.traverse(o=>{ if(!o.isMesh)return; const k=o.layers.mask+'|'+(o.material&&o.material.name||'?').split(':').slice(0,2).join(':'); tally[k]=(tally[k]||0)+1; });
  return tally;
})));
const CAM=[26,24,40,0,9,120];
for (const [name, code] of [
  ['A-all', 'c.layers.enableAll();'],
  ['B-layer0only', 'c.layers.set(0);'],
  ['C-layer1only', 'c.layers.set(1);'],
  ['D-layer3only', 'c.layers.set(3);'],
  ['E-ink-magenta', 'c.layers.enableAll(); mats.forEach(m=>{ if(m.name&&m.name.startsWith("ink:")) m.uniforms.uInk.value.setRGB(1,0,1); });'],
]) {
  await p.evaluate(({code,CAM})=>{
    const g=window.__game, c=g.camera;
    const mats=[]; const seen=new Set();
    g.scene.traverse(o=>{ if(o.isMesh&&o.material&&!seen.has(o.material)){seen.add(o.material);mats.push(o.material);} });
    // eslint-disable-next-line no-eval
    eval(code);
    g.setCamera(...CAM); window.__t+=16; g.step(window.__t);
  }, {code,CAM});
  await p.screenshot({path:`shots/diag/${name}.png`});
}
await b.close();
