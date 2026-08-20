// What covers the middle of the screen? Raycast the camera's forward axis and
// report every hit in order, with its distance and world size. Answers "what is
// that object on top of the character" without guessing.
import { chromium } from 'playwright';
const URL_BASE = process.env.URL_BASE ?? 'http://127.0.0.1:5176';
const AT = (process.env.AT ?? '3,8').split(',').map(Number);
const NDC = (process.env.NDC ?? '0,0').split(',').map(Number);

const browser = await chromium.launch({ headless: false, args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log(`[exception] ${e.message}`));
await page.goto(`${URL_BASE}/?capture=1&pr=1`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__DESCENT__?.game?.capture, null, { timeout: 180_000 });
await page.evaluate(() => {
  const { game } = window.__DESCENT__;
  game.restart?.(); game.respawn?.();
  game.scriptedInput = { moveX: 0, moveZ: 1, cameraYaw: 0, jump: false, jumpHeld: false,
                         dash: false, crouch: false, attack: false, boost: false, dive: false };
});
const t0 = Date.now();
for (const at of AT) {
  while ((Date.now() - t0) / 1000 < at) await page.waitForTimeout(40);
  const info = await page.evaluate(async ({ NDC }) => {
    const { game, engine } = window.__DESCENT__;
    const cam = engine.camera, scene = engine.scene, st = game.player.state;
    const THREE = await import('/node_modules/three/build/three.module.js');
    const rc = new THREE.Raycaster();
    rc.setFromCamera(new THREE.Vector2(NDC[0], NDC[1]), cam);
    rc.far = 400;
    const hits = rc.intersectObjects(scene.children, true).slice(0, 8).map((h) => {
      const o = h.object;
      o.geometry?.computeBoundingBox?.();
      const bb = o.geometry?.boundingBox;
      const sc = o.getWorldScale(new THREE.Vector3());
      return {
        name: o.name || o.type,
        at: +h.distance.toFixed(2),
        size: bb ? [(bb.max.x - bb.min.x) * sc.x, (bb.max.y - bb.min.y) * sc.y, (bb.max.z - bb.min.z) * sc.z].map((v) => +v.toFixed(2)) : null,
      };
    });
    const camToPlayer = cam.position.distanceTo(st.position);
    return { boom: +camToPlayer.toFixed(2), camY: +cam.position.y.toFixed(2), plY: +st.position.y.toFixed(2),
             fov: +cam.fov.toFixed(1), spd: +Math.hypot(st.velocity.x, st.velocity.z).toFixed(1), hits };
  }, { NDC });
  console.log(`--- t=${at}s  boom=${info.boom}m camY=${info.camY} playerY=${info.plY} fov=${info.fov} spd=${info.spd} ---`);
  for (const h of info.hits) console.log('   ' + JSON.stringify(h));
}
await browser.close();
