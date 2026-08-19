import { chromium } from 'playwright';
const b = await chromium.launch({headless:true, args:['--use-angle=metal']});
const p = await (await b.newContext({viewport:{width:520,height:292}, deviceScaleFactor:1})).newPage();
await p.goto('http://127.0.0.1:5173/?manual&deterministic',{waitUntil:'load'});
await p.waitForFunction('window.__ready===true');
console.log(JSON.stringify(await p.evaluate(()=>{
  const g=window.__game, S=window.__shared;
  window.__t=1000; g.clock.reset(1000); g.step(1000);
  const out={res:[S.resolution.value.x,S.resolution.value.y], drawBuf:[g.pipeline.renderer.domElement.width,g.pipeline.renderer.domElement.height], inks:[]};
  const seen=new Set();
  g.scene.traverse(o=>{
    if(!o.isMesh||!o.material||!o.material.name||!o.material.name.startsWith('ink:'))return;
    if(seen.has(o.material.name))return; seen.add(o.material.name);
    const u=o.material.uniforms;
    out.inks.push({name:o.material.name, side:o.material.side, order:o.renderOrder, layers:o.layers.mask,
      uWidth:u.uWidth.value, uMinW:u.uMinW.value, uTaper:u.uTaper.value, uCurvBoost:u.uCurvBoost.value,
      resShared: u.resolution===S.resolution, hasON: !!o.geometry.getAttribute('oNormal'),
      ocRange: (()=>{const a=o.geometry.getAttribute('oCurv'); if(!a)return null; let mn=9,mx=-9; for(let i=0;i<a.count;i+=Math.max(1,Math.floor(a.count/500))){const v=a.getX(i); if(v<mn)mn=v; if(v>mx)mx=v;} return [+mn.toFixed(3),+mx.toFixed(3)];})(),
      onLen: (()=>{const a=o.geometry.getAttribute('oNormal'); if(!a)return null; return +Math.hypot(a.getX(0),a.getY(0),a.getZ(0)).toFixed(3);})()});
  });
  out.inkCount=seen.size;
  return out;
})));
await b.close();
