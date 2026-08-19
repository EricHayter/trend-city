# PIVOT — from DESCENT (BMX) to a Spark-style mountain platformer

## What this project now is

A high-speed cel-shaded 3D action platformer. The player is an original digital
protagonist running, dashing, wall-running and grinding **down a mountain**
against a stage clock. The mountain, the art direction, the NPR pipeline, the
terrain, the HUD framework and the capture harness are inherited from DESCENT
and are **not** being rebuilt. The bike is gone.

## Non-negotiables inherited from the old project (do not break)

- **Zero external assets.** Every mesh is code, every texture is canvas 2D or a
  shader, every sound is Web Audio. If it was downloaded, it does not ship.
- **No `MeshStandardMaterial`, ever.** Every surface is a `CelMaterial` built
  from a `RampPreset` in `src/npr/Palette.ts`. There is no PBR to leak in.
- **Colour lives in `src/npr/Palette.ts` and nowhere else.** No literal hex in
  a subsystem.
- **Outlined geometry must run through `finalizeGeometry()` /
  `prepareOutlineGeometry()`** or the inverted hull tears at every hard edge and
  `aCurvature` is missing, which gives every edge full stroke weight. This is
  the documented cause of the "exploded mesh" defect on the streambed boulders.
- **NEVER put a backtick inside a GLSL template-literal comment.**
  `npm run check:glsl` enforces it and it is part of `npm run build`.
- **Zero allocation in physics, IK and particle update paths.** Scratch objects
  at module scope. This is enforced by convention and it is why the old build
  holds frame time.
- Physics is a **fixed 120 Hz** step with an accumulator; rendering interpolates.
  Never read `dt` from a frame in a physics path.

## The spine

`src/game/Contracts.ts` is the only thing subsystems may depend on. It has been
rewritten: the bike half is replaced by `PlayerState` / `PlayerInput` /
`MoveMode` / `IPlayer`, plus new contracts for traversal furniture, pickups,
combat, enemies, the boss, the character rig and the stage director. The
terrain and track halves are **unchanged**.

Write against those interfaces and nothing else. Do not reach into another
subsystem's internals, and do not add a cross-subsystem import that is not a
type import from `Contracts`.

## Units and conventions

- SI everywhere: metres, seconds, radians, m/s. `+Y` is up. The mountain
  descends toward `-Y` and broadly `+Z`.
- The HUD shows **Spark display units** = m/s × 2.5. That conversion lives in
  `src/player/SparkConstants.ts` and nowhere else.
- Any subsystem that renders owns an `Object3D` and adds it to the scene itself.
  `Game` never reaches into a subsystem's scene graph.

## Movement — the whole point of the pivot

`src/player/SparkConstants.ts` is the tuning table and the only place a movement
number may live. Read its header before touching movement. Three values are
**anchored to Spark the Electric Jester 3's real physics** and must not be
"improved":

| | |
|---|---|
| `GRAVITY.accel` | **36 m/s²** |
| `RUN.max` | **74 m/s** (Spark 3's 185 display units ÷ 2.5) |
| `GRAVITY.groundStick` | **−2.0 m/s**, a velocity, independent of gravity |

Consequences everyone must design around:

- **74 m/s is 266 km/h with a 1.8 m character.** Platforms are spaced in tens
  of metres. A jump covers 68 m of ground. An enemy the player can react to has
  to be visible from ~150 m out.
- **Everything thin must be tested against the swept segment** from the previous
  position, never against a point. At 74 m/s a 120 Hz step covers 0.62 m; a rail
  is centimetres across. `HULL.maxSubstep` exists for this reason. A point test
  tunnels through every rail, wall, spring and pickup in the game.
- Wall jumps are **additive** on the vertical channel, leave at no less than
  dash speed, and have a deliberately **generous 0.18 s input buffer**. All
  three are from the Spark-remake author's own notes; do not tighten them.
- The character is aligned to the floor normal by **slerp**, never by
  assignment, and the visual and the collision hull are rotated **separately**.
  Assigning `get_floor_normal` directly is the documented cause of the jitter.

## Ownership boundaries for this round

| Area | Files | Owner |
|---|---|---|
| Player physics | `src/player/PlayerPhysics.ts` | main thread |
| Character rig | `src/player/Character*.ts` | main thread |
| Consumer retarget (camera, FX, audio) | `src/fx/*`, `src/audio/*` | main thread |
| Orchestration | `src/game/Game.ts`, `src/main.ts` | main thread |
| Traversal furniture | `src/traversal/*` | agent |
| Enemies + combat | `src/combat/*` | agent |
| Boss + set pieces | `src/boss/*` | agent |
| HUD model + screens | `src/hud/*` | agent |

Do not create files outside your own directory. If you need something from
another area, add it to `Contracts.ts`— and say so in your report rather than
editing another owner's file.

## Verifying your work

`npx tsc --noEmit` covers the whole project, so it will report other people's
in-progress errors too. Judge yourself by whether **your own paths** are clean:

```bash
npx tsc --noEmit 2>&1 | grep '^src/<your-dir>/'
```

Never claim a visual result you have not seen in a captured frame. The harness
is `node tools/capture/capture.mjs`; it steps the sim manually at a fixed dt, so
two builds are comparable. `RESUME.md` documents five separate occasions where a
reported defect was an artefact of the harness rather than the game — read that
section before trusting a capture.
