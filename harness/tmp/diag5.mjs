import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';
const b = await chromium.launch({headless:true, args:['--use-angle=metal']});
const p = await (await b.newContext({viewport:{width:400,height:300}})).newPage();
await p.goto('http://127.0.0.1:5173/?manual&deterministic',{waitUntil:'load'});
await p.waitForFunction('window.__ready===true');
const r = await p.evaluate(()=>{
  const t = window.__game.pipeline.grade.mat.uniforms.tLut.value;
  const im = t.image;
  const c = document.createElement('canvas'); c.width=im.width; c.height=im.height;
  const g=c.getContext('2d'); g.drawImage(im,0,0);
  const d = g.getImageData(0,0,im.width,im.height).data;
  const probe = (R,G,B)=>{ const x=B*32+R, y=G; const i=(y*im.width+x)*4; return [d[i],d[i+1],d[i+2]]; };
  return { size:[im.width,im.height], url:c.toDataURL('image/png'),
    p_black: probe(0,0,0), p_mid: probe(16,16,16), p_white: probe(31,31,31),
    p_lav: probe(19,17,21), p_dark: probe(9,6,12) };
});
console.log(JSON.stringify({size:r.size, p_black:r.p_black, p_mid:r.p_mid, p_white:r.p_white, p_lav:r.p_lav, p_dark:r.p_dark}));
await writeFile('shots/lut.png', Buffer.from(r.url.split(',')[1],'base64'));
await b.close();
