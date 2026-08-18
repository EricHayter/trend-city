# VOLTBOROUGH

A high-speed cel-shaded 3D action platformer that runs in the browser. Vite + Three.js +
TypeScript, ES modules, and **zero external assets**: every mesh, texture, ramp, matcap,
LUT, particle shape and sound in the game is generated in code at runtime.

```bash
npm install
npm run dev      # then open the printed localhost URL and play
```

Controls: **WASD** move, **Space** jump / double jump, **Shift** dash (air dash, and
homing attack when a target is in front), **C** attack, **V** boost, **Ctrl** slide /
ground pound, **Enter** confirm, **R** reroll seeds on the select screen. Gamepad works.

## What the game is

A stage is a time trial through one continuous futuristic borough. Reach the lattice
before the clock runs out, then fight the Halcyon Warden. Momentum is the resource:
slopes, ducts, solar arrays, rails and boosters give speed, obstacle corridors and
fights spend it, and most stretches offer a fast risky line, an honest middle line and a
slow safe line with health.

## Architecture

```
src/
  core/       Rng (seeded, deterministic), MathX, Input (keyboard/pad/harness), Pool, SpatialHash
  render/     Palette + district art direction, CelVertex/CelFragment (the cel shader),
              CelMaterial (per-class band tuning), Outline (inverted hull), Sky,
              PostShaders (Sobel ink, speed lines, LUT grade), Pipeline (prepass + composer)
  world/      Types, Physics (oriented-box solver), Builder (instancing + chunk streaming),
              Canvas (module authoring API), ModuleKit, Modules* (the grammar terminals),
              Generator (grammar + assembly), Validator (reach/pacing audit + repair)
  player/     Tuning (one shared constants table), Rig (procedural character), Anim,
              Player (movement state machine), CameraRig
  combat/     Enemies (7 archetypes), Boss (3 phases), Combat (projectiles/waves/beams)
  fx/         Particles (pooled, instanced, hard-edged), Trails
  audio/      Audio (Web Audio synthesis), Music (layered procedural score)
  ui/         UiKit, Hud (HUD + title/intro/select/results screens, canvas 2D)
  Game.ts     screens, stage lifecycle, one allocation-free update loop
```

### Rendering

* **Ramp lighting** - 3 to 4 band gradient LUTs sampled with `NearestFilter`, authored
  per material class so characters, metal, concrete, glass and panels each own their cel
  response.
* **Inverted-hull outlines** - view-space push scaled by depth for constant pixel width,
  modulated by per-vertex curvature so strokes taper and thicken; hull twins share the
  source geometry and instance buffer.
* **Screen-space ink** - Sobel over a normal + linear-depth prepass for interior lines,
  with a luminance guard so it never doubles up on the hull lines.
* Fresnel rim, hard two-step specular, banded matcap fake reflection, screen-aligned
  hatch inside shadow bands, quantised atmospheric depth plates, code-generated grading
  LUT applied as the final pass.

### Procedural generation

The stage is a sentence in a grammar: `START -> body -> FINAL ROUTE -> BOSS`. Body
modules are filtered by district appetite, momentum coherence (a module that needs entry
speed cannot follow one that cannot provide it, so the generator inserts a builder
instead of dropping it), repetition avoidance and pacing rules. Every stage is then
audited: ground presence under every node, headroom, ballistic reachability computed
from the same tuning table the controller uses, goal connectivity and timer pacing.
Failures are repaired in place with catch geometry and re-audited. Seeds are visible in
the HUD and on the select screen; the same seed always rebuilds the same borough.

### Performance

Instanced batches per chunk with shared geometry and materials, paired outline instances
that reuse the same buffers, distance-based chunk activation, frustum culling, spatial
hash broadphase, pooled particles and projectiles, adaptive pixel ratio driven by
smoothed frame time, and an update loop that allocates nothing per frame.

## Harness

```bash
npx playwright install chromium   # once
npm run dev                       # in one terminal
npm run capture                   # stills + turntables + motion sequences -> captures/
```

The harness drives the real build through `window.__input`, so the same deterministic
input sequence and the same deterministic camera angles can be replayed after a fix and
compared frame for frame.

## Status

All systems in the tree are implemented and wired. Known remaining work is tuning rather
than plumbing: band thresholds and ink weights want another pass against captured frames
in the reactor and lattice districts, and the boss arena rail ring could use tighter
framing during phase transitions.
