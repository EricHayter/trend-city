import { chromium } from 'playwright';
import { mkdir, rm } from 'node:fs/promises';
const b = await chromium.launch({headless:true, args:['--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist']});
const p = await (await b.newContext({viewport:{width:520,height:292}, deviceScaleFactor:1})).newPage();
p.on('pageerror', e=>console.log('[pe]', e.message));
await p.goto('http://127.0.0.1:5173/?manual&deterministic',{waitUntil:'load'});
await p.waitForFunction('window.__ready===true');
await rm('shots/diag',{recursive:true,force:true}); await mkdir('shots/diag',{recursive:true});
await p.evaluate(()=>{ const g=window.__game; window.__t=1000; g.clock.reset(1000); g.step(1000); });
const CAM = [26,24,40, 0,9,120];
const steps = [
  ['0-base',        {}],
  ['1-noshadow',    {shadow:0}],
  ['2-nofog',       {fog:0}],
  ['3-noshadow-nofog', {shadow:0, fog:0}],
  ['4-noink',       {shadow:0, fog:0, ink:0}],
  ['5-inkonly',     {shadow:0, fog:0, surf:0}],
];
for (const [name,o] of steps) {
  await p.evaluate(({o,CAM})=>{
    const g=window.__game, S=window.__shared;
    S.shadowStrength.value = o.shadow===0?0:1;
    S.fogStrength.value = o.fog===0?0:0.92;
    g.camera.layers.enableAll();
    if (o.ink===0) g.camera.layers.disable(1);
    if (o.surf===0) g.camera.layers.disable(0);
    g.setCamera(...CAM);
    window.__t+=16; g.step(window.__t);
  }, {o,CAM});
  await p.screenshot({path:`shots/diag/${name}.png`});
}
await b.close();
