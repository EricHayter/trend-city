/**
 * _dustcover.mjs — how much of the character does the dust actually cover?
 *
 * The report is "janky, unfun, bad", and the frames captured for the movement
 * work say something the movement numbers cannot: in most of them the dust plume
 * is the largest object on screen and it is sitting on the character. A character
 * you cannot see is a character whose movement you cannot read, so this is a
 * movement defect and not a taste question.
 *
 * It is also not answerable from a screenshot. A plume drawn over a character at
 * two thirds opacity looks intentional in a still, and the thing that decides
 * whether it is a defect is a number nobody can eyeball: the fraction of the
 * character's silhouette that has opaque dust in front of it.
 *
 * So this replicates the vertex shader on the CPU, per live puff, exactly — the
 * closed-form drag, the lift/settle pair, the world-space spread bearing, the
 * quantised age that scale reads from, and both proximity rules — and then
 * rasterises the result: the character's silhouette is sampled on a grid, and for
 * each sample the probe asks whether any puff disc covers it while being nearer to
 * the lens than the character is. That is the actual quantity.
 *
 * The shader math is duplicated rather than queried because there is no way to
 * read a varying back out of a draw call, and a probe that measures a DIFFERENT
 * plume than the one on screen measures nothing. Every constant below is quoted
 * from src/fx/DustSystem.ts and any edit there invalidates this file.
 *
 * Usage: node tools/capture/_dustcover.mjs
 */
import { chromium } from 'playwright';

const DT = 1 / 120;

const browser = await chromium.launch({
  args: ['--use-angle=default', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
page.on('pageerror', (e) => { if (!/SERVER_FORWARD_CONSOLE/.test(e.message)) console.log('PAGEERROR', e.message); });
await page.goto('http://127.0.0.1:5173/?capture=1&pr=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__DESCENT__?.game?.capture, null, { timeout: 240000 });

const out = await page.evaluate(async () => {
  const g = window.__DESCENT__.game, P = g.player, cam = g.effects.cameraDirector;
  g.capture.takeControl();
  g.input.setScripted(false);
  g.input.update = () => {};
  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  let hint = 0;

  const drive = () => {
    const pos = P.state.position;
    const pr = g.track.project(pos, hint);
    hint = pr.distance;
    const ahead = g.track.sampleAtDistance(Math.min(pr.distance + 22, g.track.length - 1));
    const want = Math.atan2(ahead.position.x - pos.x, ahead.position.z - pos.z);
    const err = wrap(want - cam.yaw);
    g.input.intent.moveX = Math.sin(err);
    g.input.intent.moveZ = Math.cos(err);
    g.capture.step(1 / 120);
    return ['cleared', 'failed', 'results'].includes(g.stage.phase);
  };

  g.stage.restart();
  g.stage.forceRunning();
  const s0 = g.track.sampleAtDistance(0);
  P.reset({ x: s0.position.x, y: s0.position.y, z: s0.position.z }, Math.atan2(s0.tangent.x, s0.tangent.z));
  P.state.velocity.set(0, 0, 0);
  cam.resetTo(P.state);

  const dust = g.effects.dust;
  const camObj = cam.camera;
  const TAU = Math.PI * 2;
  const fract = (x) => x - Math.floor(x);
  const mix = (a, b, t) => a + (b - a) * t;
  const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
  const smoothstep = (e0, e1, x) => {
    const t = clamp01((x - e0) / (e1 - e0 || 1e-6));
    return t * t * (3 - 2 * t);
  };

  // Read the uniforms rather than restating them, so a retune shows up here.
  const U = dust.material.uniforms;

  /** Every live puff, reconstructed exactly as the vertex shader does it. */
  function livePuffs() {
    const O = dust.aOrigin, V = dust.aVel, Pa = dust.aParams, Sh = dust.aShape;
    const n = Pa.length / 4;
    const fxTime = U.uFxTime.value;
    const sizeScale = U.uSizeScale.value;
    const list = [];
    for (let i = 0; i < n; i++) {
      const i4 = i * 4, i3 = i * 3;
      const t = fxTime - Pa[i4];
      const age = t * Pa[i4 + 1];
      if (age < 0 || age >= 1) continue;
      const kind = Pa[i4 + 3];
      const isPlume = kind >= 1.5 ? 1 : 0;
      const isSpray = kind >= 0.5 && !isPlume ? 1 : 0;
      const seed = Pa[i4 + 2];
      const steps = isPlume ? 7 : isSpray ? 4 : 5;
      const phase = fract(seed * 17.13);
      const q = clamp01(Math.floor(age * steps + phase * 0.7) / steps);
      const drag = mix(2.9, 1.6, isPlume);
      const k = (1 - Math.exp(-drag * t)) / drag;
      let px = O[i3] + V[i3] * k;
      let py = O[i3 + 1] + V[i3 + 1] * k;
      let pz = O[i3 + 2] + V[i3 + 2] * k;
      const rise = mix(0.30, 0.62, seed) * mix(0.55, 1.0, isPlume);
      py += rise * (1 - Math.exp(-2.4 * t)) - mix(0.20, 0.38, fract(seed * 5.77)) * age * age;
      const bear = fract(seed * 31.73) * TAU;
      const spread = mix(0.40, 1.30, fract(seed * 12.41)) * age * Math.sqrt(age) * mix(0.85, 1.35, isPlume);
      px += Math.cos(bear) * spread;
      pz += Math.sin(bear) * spread;
      const sz = Sh[i4] * (1 + Sh[i4 + 1] * q) * sizeScale;
      const vAlpha = Math.floor(clamp01(1 - q) * 4 + 0.5) / 4;
      list.push({ x: px, y: py, z: pz, sz, vAlpha, isPlume, age });
    }
    return list;
  }

  /** The two proximity rules, verbatim, returning the shader's own vNear. */
  function vNearOf(p, cp, sub) {
    const cd = Math.max(Math.hypot(p.x - cp.x, p.y - cp.y, p.z - cp.z), 1e-4);
    const angRadius = p.sz / cd;
    const na = U.uNearAng.value;
    const nearFade = clamp01((na.y - angRadius) / Math.max(na.y - na.x, 1e-3));
    let lensFade = 1;
    // `s` and `perp` are reported, so they are declared out here: a puff BEHIND
    // the lens skips the corridor entirely and still has to answer the question.
    let s = -1, perp = -1;
    if (sub.w > 0) {
      const tx = sub.x - cp.x, ty = sub.y - cp.y, tz = sub.z - cp.z;
      const subDist = Math.hypot(tx, ty, tz);
      if (subDist > 0.35) {
        const ux = p.x - cp.x, uy = p.y - cp.y, uz = p.z - cp.z;
        const along = (ux * tx + uy * ty + uz * tz) / subDist;
        if (along > 0) {
          perp = Math.sqrt(Math.max(ux * ux + uy * uy + uz * uz - along * along, 0));
          s = along / subDist;
          const reff = sub.w * clamp01(s);
          const cover = 1 - smoothstep(0, p.sz + reff, perp);
          const lb = U.uLensBand.value;
          const ahead = 1 - smoothstep(lb.x, lb.y, s);
          lensFade = 1 - cover * ahead;
        }
      }
    }
    return { vNear: Math.floor(clamp01(Math.min(nearFade, lensFade)) * 3 + 0.5) / 3, s, perp, nearFade, lensFade };
  }

  // The character's silhouette, sampled as a grid of world points on the
  // camera-facing plane through the body. A box rather than the mesh: the mesh is
  // skinned and its exact outline is not the question, "can you see the guy" is.
  const SAMP = [];
  const BANDS = 7;
  for (let a = 0; a < 5; a++) for (let b = 0; b < BANDS; b++) SAMP.push([(a / 4 - 0.5) * 0.80, (b / (BANDS - 1)) * 1.72, b]);

  const rows = [];
  const frames = [];
  for (let i = 0; i < 120 * 400; i++) {
    if (drive()) break;
    if (hint < 300) continue;
    if (i % 24) continue;                       // ~5 samples/second
    const st = P.state;
    const cp = camObj.position;
    const sub = U.uSubject.value;
    const puffs = livePuffs();

    // Camera basis, for placing the silhouette grid on a camera-facing plane.
    const fx = st.position.x - cp.x, fy = st.position.y - cp.y, fz = st.position.z - cp.z;
    const fd = Math.hypot(fx, fy, fz);
    const rx = -fz / Math.hypot(fx, fz), rz = fx / Math.hypot(fx, fz);

    let covered = 0, opaque = 0;
    // The puffs that are actually drawing opaquely over the body, deduplicated:
    // one puff covers many samples and must not be counted many times.
    const blockers = new Map();
    const bandHit = new Array(BANDS).fill(0);
    const bandN = new Array(BANDS).fill(0);
    for (const [ox, oy, band] of SAMP) {
      bandN[band]++;
      const sx = st.position.x + rx * ox, sy = st.position.y + oy, sz2 = st.position.z + rz * ox;
      const sd = Math.hypot(sx - cp.x, sy - cp.y, sz2 - cp.z);
      let best = 0;
      for (const p of puffs) {
        const pd = Math.hypot(p.x - cp.x, p.y - cp.y, p.z - cp.z);
        if (pd >= sd) continue;                 // behind the sample: cannot occlude it
        // Angular separation of sample and puff centre, against the puff's own
        // angular radius. Screen-space overlap without needing the projection.
        const dx = (p.x - cp.x) / pd - (sx - cp.x) / sd;
        const dy = (p.y - cp.y) / pd - (sy - cp.y) / sd;
        const dz = (p.z - cp.z) / pd - (sz2 - cp.z) / sd;
        if (Math.hypot(dx, dy, dz) > p.sz / pd) continue;
        const r = vNearOf(p, cp, sub);
        const a = p.vAlpha * r.vNear;
        if (a > best) best = a;
        if (a >= 0.5) blockers.set(p, r);
      }
      if (best > 0.05) covered++;
      if (best >= 0.5) { opaque++; bandHit[band]++; }
    }

    // Corridor statistics over the puffs that are actually in front of the body.
    let inBand = 0, released = 0, killed = 0;
    let szSum = 0, szMax = 0;
    for (const p of puffs) {
      const r = vNearOf(p, cp, sub);
      if (r.s > 0 && r.s < 1.05) {
        inBand++;
        if (r.lensFade > 0.9) released++;
        if (r.vNear <= 0) killed++;
      }
      szSum += p.sz; if (p.sz > szMax) szMax = p.sz;
    }
    const bl = [...blockers.entries()];
    const bmean = (f) => (bl.length ? +(bl.reduce((a, [p2, r]) => a + f(p2, r), 0) / bl.length).toFixed(2) : -1);
    rows.push({
      d: +hint.toFixed(0), spd: +st.speed.toFixed(1), live: puffs.length,
      blockers: bl.length,
      // Opaque coverage per height band, feet (0) to head (6).
      bands: bandHit.map((h, i) => +(100 * h / bandN[i]).toFixed(0)),
      bS: bmean((p2, r) => r.s),
      bPerp: bmean((p2, r) => r.perp),
      bSz: bmean((p2) => p2.sz),
      bAge: bmean((p2) => p2.age),
      bLens: bmean((p2, r) => r.lensFade),
      bNear: bmean((p2, r) => r.nearFade),
      covPct: +(100 * covered / SAMP.length).toFixed(0),
      opaquePct: +(100 * opaque / SAMP.length).toFixed(0),
      szMean: +(szSum / Math.max(puffs.length, 1)).toFixed(2), szMax: +szMax.toFixed(2),
      inBand, released, killed, boom: +fd.toFixed(2), subW: sub.w,
    });
    if (rows.length >= 60) break;
  }

  const agg = (k) => rows.reduce((a, r) => a + r[k], 0) / rows.length;
  const aggPos = (k) => {
    const v = rows.map((r) => r[k]).filter((x) => x >= 0);
    return v.length ? +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2) : -1;
  };
  return {
    subject: { w: U.uSubject.value.w, band: [U.uLensBand.value.x, U.uLensBand.value.y], nearAng: [U.uNearAng.value.x, U.uNearAng.value.y] },
    samples: rows.length,
    meanCovPct: +agg('covPct').toFixed(1),
    meanOpaquePct: +agg('opaquePct').toFixed(1),
    worstOpaquePct: Math.max(...rows.map((r) => r.opaquePct)),
    meanLive: +agg('live').toFixed(0),
    meanInBand: +agg('inBand').toFixed(1),
    meanReleased: +agg('released').toFixed(1),
    meanKilled: +agg('killed').toFixed(1),
    meanSz: +agg('szMean').toFixed(2),
    bandsMean: Array.from({ length: 7 }, (_, i) => +(rows.reduce((a, r) => a + r.bands[i], 0) / rows.length).toFixed(0)),
    blockers: { n: +agg('blockers').toFixed(1), s: aggPos('bS'), perp: aggPos('bPerp'), sz: aggPos('bSz'), age: aggPos('bAge'), lensFade: aggPos('bLens'), nearFade: aggPos('bNear') },
    rows: rows.slice(0, 4),
  };
});

console.log(JSON.stringify(out, null, 1));
await browser.close();
