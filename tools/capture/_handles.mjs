/**
 * _handles.mjs — what the harness can actually reach off `window.__DESCENT__`.
 *
 * Written because _lineab.mjs reported a ZERO diff for a control that was
 * guaranteed to move pixels, which means the grab was broken rather than the
 * effect being innocent. Cheaper to enumerate the handles once than to keep
 * guessing at property paths.
 */
import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--use-angle=default', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport: { width: 960, height: 540 } });
p.on('pageerror', (e) => { if (!/SERVER_FORWARD_CONSOLE/.test(e.message)) console.log('PAGEERROR', e.message); });
await p.goto('http://127.0.0.1:5173/?capture=1', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => !!window.__DESCENT__?.game?.capture, null, { timeout: 240000 });
console.log(JSON.stringify(await p.evaluate(() => {
  const D = window.__DESCENT__;
  const g = D.game;
  const r = D.engine?.renderer ?? g.engine?.renderer;
  const cv = r?.domElement;
  return {
    descentKeys: Object.keys(D),
    gameKeys: Object.keys(g),
    captureKeys: Object.keys(g.capture),
    captureRender: typeof g.capture.render,
    postPath: { game_post: !!g.post, game_effects_post: !!g.effects?.post },
    postKeys: g.post ? Object.keys(g.post) : g.effects?.post ? Object.keys(g.effects.post) : null,
    canvas: cv ? { w: cv.width, h: cv.height } : null,
    preserveDrawingBuffer: cv?.getContext('webgl2')?.getContextAttributes?.()?.preserveDrawingBuffer ?? null,
  };
}), null, 1));
await b.close();
