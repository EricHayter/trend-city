import { chromium } from 'playwright';
import { writeFile, mkdir } from 'node:fs/promises';
const b = await chromium.launch({headless:true, args:['--use-angle=metal']});
const ctx = await b.newContext({viewport:{width:640,height:360}, deviceScaleFactor:1});
const p = await ctx.newPage();
p.on('pageerror', e=>console.log('[pe]', e.message));
await p.goto('http://127.0.0.1:5173/?manual&deterministic',{waitUntil:'load'});
await p.waitForFunction('window.__ready===true');
const out = await p.evaluate(() => {
  const g = window.__game;
  window.__t=1000; g.clock.reset(1000); g.step(1000);
  const seen = new Map();
  const grab = (t, label) => {
    if (!t || !t.image) return;
    const key = label + ':' + t.image.width + 'x' + t.image.height;
    if (seen.has(key)) return;
    let url = '';
    try {
      const c = document.createElement('canvas');
      c.width = t.image.width; c.height = t.image.height;
      c.getContext('2d').drawImage(t.image, 0, 0);
      url = c.toDataURL('image/png');
    } catch(e) { url = 'ERR ' + e.message; }
    seen.set(key, url);
  };
  g.scene.traverse(o => {
    if (!o.isMesh || !o.material || !o.material.uniforms) return;
    const u = o.material.uniforms;
    for (const k of ['uMap','uEmissiveMap','uRamp','uMatcap','hatchMap']) if (u[k]) grab(u[k].value, o.material.name + '|' + k);
  });
  return Array.from(seen.entries());
});
await mkdir('shots/tex', {recursive:true});
let i=0;
for (const [k,url] of out) {
  if (!url.startsWith('data:')) { console.log('ERR', k, url); continue; }
  const f = 'shots/tex/' + String(i++).padStart(2,'0') + '-' + k.replace(/[^a-z0-9]+/gi,'_') + '.png';
  await writeFile(f, Buffer.from(url.split(',')[1],'base64'));
  console.log(f);
}
await b.close();
