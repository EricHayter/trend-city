/**
 * traversal — the facade `PlayerPhysics` holds.
 *
 * `PlayerPhysics` was written against `ITraversal` from the start: `probeTraversal`
 * calls `boosters.probe`, then `rails.findMount`, then `walls.probe`, all on the
 * same swept segment, and `updatePrompt` re-runs the rail and wall queries over a
 * 0.25 s look-ahead to fill the HUD hint. Everything in this directory existed
 * except the object that hands those three to it, which is why grinding,
 * wall-running and springs were unreachable while the code to do all three sat
 * on disk. This file is that object.
 *
 * ORDER MATTERS IN `update`
 *
 * All four sub-systems window their geometry on the player's ROUTE distance, and
 * all four are told it here rather than reading it themselves, so there is one
 * place where the frame's notion of "where the player is on the course" comes
 * from and no chance of two of them disagreeing by a frame.
 *
 * PICKUPS ARE NOT PART OF `ITraversal`
 *
 * They are returned alongside it. Pickups do not affect the player's motion, so
 * the physics has no business holding them — the run loop collects them against
 * the same swept segment and hands the events to the stage director, which is
 * what actually cares about a count.
 */

import { Group, Object3D } from 'three';

import type { ITerrain, ITrack, ITraversal } from '../game/Contracts';
import { BoosterField } from './BoosterField';
import { planLayout } from './Layout';
import type { Layout, LayoutOptions } from './Layout';
import { PickupField } from './PickupField';
import { RailNetwork } from './RailNetwork';
import { WallSet } from './WallSet';

export interface TraversalDeps {
  track: ITrack;
  terrain: ITerrain;
  /** Passed straight through to `planLayout`. */
  layout?: LayoutOptions;
}

export interface TraversalBundle {
  traversal: ITraversal;
  pickups: PickupField;
  layout: Layout;
  /** Everything, under one node, ready to `scene.add`. */
  object: Object3D;
  dispose(): void;
}

class Traversal implements ITraversal {
  readonly object: Object3D = new Group();

  constructor(
    readonly rails: RailNetwork,
    readonly walls: WallSet,
    readonly boosters: BoosterField,
  ) {
    this.object.name = 'traversal';
    this.object.add(rails.object, walls.object, boosters.object);
  }

  update(playerRouteDistance: number, dt: number): void {
    this.rails.update(playerRouteDistance, dt);
    this.walls.update(playerRouteDistance, dt);
    this.boosters.update(playerRouteDistance, dt);
  }

  dispose(): void {
    this.rails.dispose();
    this.walls.dispose();
    this.boosters.dispose();
    this.object.clear();
  }
}

/**
 * Plan a layout for the course and build every affordance in it.
 *
 * The layout is a pure function of the track, the terrain and the seed, so two
 * runs of the same course get the same rails in the same places — which is what
 * lets the capture harness produce bit-identical frames and what lets a player
 * learn a line.
 */
export function createTraversal(deps: TraversalDeps): TraversalBundle {
  const layout = planLayout(deps.track, deps.terrain, deps.layout ?? {});

  const rails = new RailNetwork(layout.rails);
  const walls = new WallSet(layout.walls);
  const boosters = new BoosterField(layout.boosters);
  const pickups = new PickupField(layout.pickups);

  const traversal = new Traversal(rails, walls, boosters);

  const object = new Group();
  object.name = 'traversal-root';
  object.add(traversal.object, pickups.object);

  return {
    traversal,
    pickups,
    layout,
    object,
    dispose(): void {
      traversal.dispose();
      pickups.dispose();
      object.clear();
    },
  };
}

export { BoosterField } from './BoosterField';
export { PickupField } from './PickupField';
export { RailNetwork } from './RailNetwork';
export { WallSet } from './WallSet';
export { planLayout, LAYOUT_CONSTANTS } from './Layout';
export type { Layout, LayoutOptions, RailSpec, WallSpec, BoosterSpec, PickupSpec } from './Layout';
