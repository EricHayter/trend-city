import { chromium } from 'playwright';
const b = await chromium.launch({ headless: true, args:['--use-angle=metal','--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport:{width:400,height:300} });
await p.goto('http://127.0.0.1:5176/?capture=1', { waitUntil:'domcontentloaded' });
await p.waitForFunction(() => !!window.__DESCENT__?.game?.capture, null, { timeout:180000 });
console.log(JSON.stringify(await p.evaluate(() => {
  const { game } = window.__DESCENT__;
  const L = game.traversal?.layout ?? null;
  const t = game.track;
  const out = { length: Math.round(t.length), sections: t.sectionRanges?.map(s => `${s.kind} ${Math.round(s.start)}-${Math.round(s.end)}`) ?? null };
  if (L) {
    out.rails = L.rails?.length; out.walls = L.walls?.length;
    out.boosters = L.boosters?.length; out.pickups = L.pickups?.length;
    const k = {}; for (const b of (L.boosters ?? [])) k[b.kind] = (k[b.kind]??0)+1; out.boosterKinds = k;
    const pk = {}; for (const q of (L.pickups ?? [])) pk[q.kind] = (pk[q.kind]??0)+1; out.pickupKinds = pk;
    out.railMetres = Math.round((L.rails ?? []).reduce((a,r)=>{const c=r.cage??[];let n=0;for(let i=1;i<c.length;i++)n+=c[i].distanceTo(c[i-1]);return a+n;},0));
    out.wallMetres = Math.round((L.walls ?? []).reduce((a,w)=>{const c=w.nodes??[];let n=0;for(let i=1;i<c.length;i++)n+=c[i].distanceTo(c[i-1]);return a+n;},0));
    out.railRouteSpan = Math.round((L.rails ?? []).reduce((a,r)=>a+(r.exitRouceDistance??r.exitRouteDistance)-r.routeDistance,0));
    out.chimneys = (L.walls ?? []).filter(w=>w.chimney).length;
    out.wallHeights = (L.walls ?? []).map(w=>Math.round(w.height));
    const t2=game.track; out.summitY=Math.round(t2.sampleAtDistance(0).position.y); out.valleyY=Math.round(t2.sampleAtDistance(t2.length).position.y);
  } else out.layout = 'not on game';
  return out;
}), null, 1));
await b.close();
