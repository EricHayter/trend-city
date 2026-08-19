import { chromium } from 'playwright';
const b = await chromium.launch({headless:true, args:['--use-angle=metal']});
const ctx = await b.newContext({viewport:{width:640,height:360}, deviceScaleFactor:1});
const p = await ctx.newPage();
p.on('console', m=>{ if(m.type()==='error') console.log('[e]',m.text()); });
p.on('pageerror', e=>console.log('[pe]', e.message));
await p.goto('http://127.0.0.1:5173/?manual&deterministic',{waitUntil:'load'});
await p.waitForFunction('window.__ready===true');
const probe = await p.evaluate(() => {
  const g = window.__game;
  window.__t=1000; g.clock.reset(1000); g.step(1000);
  const names = g.pipeline.composer.passes.map(x=>x.constructor.name);
  const out = {names, results:{}};
  const gl = g.pipeline.renderer.getContext();
  function centerPixel() {
    const c = g.pipeline.renderer.domElement;
    const px = new Uint8Array(4);
    gl.readPixels(Math.floor(c.width/2), Math.floor(c.height/2), 1,1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return Array.from(px);
  }
  // full chain
  window.__t+=16; g.step(window.__t);
  out.full = centerPixel();
  // progressively disable from the end
  const passes = g.pipeline.composer.passes;
  for (let i = passes.length-1; i>=1; i--) {
    passes[i].enabled = false;
    // make the last enabled pass render to screen
    for (let j=0;j<passes.length;j++) passes[j].renderToScreen = false;
    for (let j=passes.length-1;j>=0;j--) if (passes[j].enabled) { passes[j].renderToScreen = true; break; }
    window.__t+=16; g.step(window.__t);
    out.results['off_from_'+passes[i].constructor.name] = centerPixel();
  }
  return out;
});
console.log(JSON.stringify(probe,null,1));
await b.close();
