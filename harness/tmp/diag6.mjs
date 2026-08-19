import { chromium } from 'playwright';
const b = await chromium.launch({headless:true, args:['--use-angle=metal']});
const p = await (await b.newContext({viewport:{width:520,height:292}, deviceScaleFactor:1})).newPage();
p.on('pageerror', e=>console.log('[pe]', e.message));
await p.goto('http://127.0.0.1:5173/?manual&deterministic',{waitUntil:'load'});
await p.waitForFunction('window.__ready===true');
console.log(JSON.stringify(await p.evaluate(()=>{
  const g=window.__game, P=g.pipeline, R=P.renderer, gl=R.getContext();
  window.__t=1000; g.clock.reset(1000); g.step(1000);
  const cv=R.domElement;
  const X=Math.floor(cv.width*0.35), Y=Math.floor(cv.height*0.30); // deck area (gl y from bottom)
  const px=new Uint8Array(4);
  const read=()=>{ gl.readPixels(X,Y,1,1,gl.RGBA,gl.UNSIGNED_BYTE,px); return [px[0],px[1],px[2]]; };
  const frame=()=>{ g.setCamera(26,24,40,0,9,120); window.__t+=16; g.step(window.__t); };
  const U=P.grade.mat.uniforms;
  U.uLutAmount.value=0; frame(); const off=read();
  U.uLutAmount.value=1; frame(); const on=read();
  // decode srgb -> linear
  const dec=(v)=>{ const c=v/255; return c<=0.04045? c/12.92 : Math.pow((c+0.055)/1.055,2.4); };
  const lin=off.map(dec);
  // expected lut result computed from the canvas
  const t=U.tLut.value, im=t.image;
  const c2=document.createElement('canvas'); c2.width=im.width; c2.height=im.height;
  const ctx2=c2.getContext('2d'); ctx2.drawImage(im,0,0);
  const d=ctx2.getImageData(0,0,im.width,im.height).data;
  const N=32;
  const entry=(R_,G_,B_)=>{ const x=B_*N+R_, y=G_; const i=(y*im.width+x)*4; return [d[i]/255,d[i+1]/255,d[i+2]/255]; };
  const nearest=(c)=>entry(Math.round(c[0]*31),Math.round(c[1]*31),Math.round(c[2]*31));
  return { off, on, offLinear:lin.map(v=>+v.toFixed(4)),
           expectedLut: nearest(lin).map(v=>+v.toFixed(4)),
           actualLutLinear: on.map(dec).map(v=>+v.toFixed(4)),
           lutFlipY: t.flipY };
})));
await b.close();
