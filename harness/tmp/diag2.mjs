import { chromium } from 'playwright';
const b = await chromium.launch({headless:true, args:['--use-angle=metal']});
const ctx = await b.newContext({viewport:{width:640,height:360}, deviceScaleFactor:1});
const p = await ctx.newPage();
p.on('console', m=>{ if(m.type()==='error') console.log('[e]',m.text()); });
p.on('pageerror', e=>console.log('[pe]', e.message));
await p.goto('http://127.0.0.1:5173/?manual&deterministic',{waitUntil:'load'});
await p.waitForFunction('window.__ready===true');
const out = await p.evaluate(() => {
  const g = window.__game;
  window.__t=1000; g.clock.reset(1000); g.step(1000);
  window.__t+=16; g.step(window.__t);
  const P = g.pipeline, R = P.renderer;
  const cw = R.domElement.width, chh = R.domElement.height;
  const cx = Math.floor(cw*0.5), cy = Math.floor(chh*0.35);
  const fb = new Float32Array(4), fb2 = new Float32Array(4);
  R.readRenderTargetPixels(P.mrt, cx, cy, 1,1, fb, undefined, 0);
  R.readRenderTargetPixels(P.mrt, cx, cy, 1,1, fb2, undefined, 1);
  // find a cel material in the scene
  let mat=null, name='';
  g.scene.traverse(o=>{ if(!mat && o.isMesh && o.material && o.material.name && o.material.name.startsWith('cel:')) { mat=o.material; name=o.material.name; } });
  const u = mat ? mat.uniforms : {};
  const val = (k)=>{ const v=u[k] && u[k].value; if(v==null) return null; if(v.isColor) return [v.r,v.g,v.b]; if(v.isVector3) return [v.x,v.y,v.z]; if(v.isTexture) return 'tex:'+(v.image? v.image.width+'x'+v.image.height : 'noimg'); return v; };
  const keys = ['uColor','uMatcapStr','uRimStr','uSpecStr','uHatchStr','uEmissiveInt','uLightGain','sunDir','sunColor','ambSky','ambGround','fogStrength','fogBands','uRamp','uMatcap','uMap','uUvScale','uRampScale','uRampOffset','uWrap','shadowStrength'];
  const uni = {}; for (const k of keys) uni[k]=val(k);
  return { size:[cw,chh], mrtColor:Array.from(fb), mrtND:Array.from(fb2), matName:name, defines: mat? Object.keys(mat.defines||{}):[], uni,
           matCount: (()=>{let n=0; g.scene.traverse(o=>{if(o.isMesh)n++;}); return n;})() };
});
console.log(JSON.stringify(out,null,1));
await b.close();
