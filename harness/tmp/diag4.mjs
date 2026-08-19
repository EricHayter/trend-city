import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
const b = await chromium.launch({headless:true, args:['--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist']});
const ctx = await b.newContext({viewport:{width:520,height:292}, deviceScaleFactor:1});
const p = await ctx.newPage();
p.on('pageerror', e=>console.log('[pe]', e.message));
await p.goto('http://127.0.0.1:5173/?manual&deterministic',{waitUntil:'load'});
await p.waitForFunction('window.__ready===true');
await mkdir('shots/diag',{recursive:true});
await p.evaluate(()=>{ const g=window.__game; window.__t=1000; g.clock.reset(1000); g.step(1000); });
const steps = [
  ['0-base', {}],
  ['1-nofog', {fog:0}],
  ['2-nomatcap', {fog:0, matcap:0}],
  ['3-nohatch', {fog:0, matcap:0, hatch:0}],
  ['4-norimspec', {fog:0, matcap:0, hatch:0, rim:0, spec:0}],
  ['5-nolut', {fog:0, matcap:0, hatch:0, rim:0, spec:0, lut:0}],
  ['6-nopost', {fog:0, matcap:0, hatch:0, rim:0, spec:0, lut:0, post:0}],
  ['7-onlyfogoff-lutoff', {fog:0, lut:0}],
];
for (const [name, o] of steps) {
  await p.evaluate((o)=>{
    const g=window.__game, S=window.__shared;
    const mats=[]; g.scene.traverse(x=>{if(x.isMesh&&x.material&&x.material.uniforms)mats.push(x.material);});
    g.pipeline.edge.enabled = o.post!==0; g.pipeline.bloom.enabled = o.post!==0;
    g.pipeline.grade.mat.uniforms.uLutAmount.value = o.lut===0?0:1;
    S.fogStrength.value = o.fog===0?0:0.92;
    for (const m of mats) { const u=m.material?m.material.uniforms:m.uniforms;
      if (o.matcap!==undefined && u.uMatcapStr) u.uMatcapStr.value=o.matcap;
      if (o.hatch!==undefined && u.uHatchStr) u.uHatchStr.value=o.hatch;
      if (o.rim!==undefined && u.uRimStr) u.uRimStr.value=o.rim;
      if (o.spec!==undefined && u.uSpecStr) u.uSpecStr.value=o.spec;
    }
    g.setCamera(26,24,40, 0,9,120);
    window.__t+=16; g.step(window.__t);
  }, o);
  await p.screenshot({path:`shots/diag/${name}.png`, clip:{x:0,y:0,width:520,height:292}});
}
console.log(JSON.stringify(await p.evaluate(()=>{
  const S=window.__shared;
  const v=(x)=>{const y=x&&x.value; return y&&y.isColor?[+y.r.toFixed(3),+y.g.toFixed(3),+y.b.toFixed(3)]:y;};
  return {fogColor:v(S.fogColor), fogColorHi:v(S.fogColorHi), fogNear:v(S.fogNear), fogFar:v(S.fogFar), fogBands:v(S.fogBands), inkTint:v(S.inkTint), sunColor:v(S.sunColor), lightGain:v(S.lightGain)};
})));
await b.close();
