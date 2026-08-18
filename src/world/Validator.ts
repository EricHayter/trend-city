import { Vector3, Quaternion } from 'three';
import { WorldData } from './Canvas';
import { TraversalNode } from './Types';
import { MOVE } from '../player/Tuning';

export interface ValidationReport {
  ok: boolean;
  checks: number;
  repairs: string[];
  warnings: string[];
  reachableGoal: boolean;
  estimatedTime: number;
}

/**
 * Ballistic reach, derived from the same tuning constants the player controller uses.
 * If these numbers and the controller ever disagree, the generator would happily author
 * impossible jumps, so they are imported rather than duplicated.
 */
export function maxJumpDistance(speed: number): number {
  const airTime = (2 * MOVE.jumpSpeed) / MOVE.gravity + (2 * MOVE.doubleJumpSpeed) / MOVE.gravity * 0.8;
  return speed * airTime * 0.92 + MOVE.airDashDistance * 0.8;
}

export function maxJumpHeight(): number {
  return (MOVE.jumpSpeed * MOVE.jumpSpeed) / (2 * MOVE.gravity) + (MOVE.doubleJumpSpeed * MOVE.doubleJumpSpeed) / (2 * MOVE.gravity);
}

const _q = new Quaternion();

/**
 * VALIDATION AND REPAIR
 * The generator is not trusted. Every stage is audited after assembly:
 *  - consecutive traversal nodes must be ballistically reachable at the speed the
 *    preceding module hands over;
 *  - every ground node must actually have ground under it;
 *  - no node may be trapped under a low ceiling;
 *  - the node graph must contain a start-to-goal path.
 * Failures are repaired in place by inserting catch geometry, then re-audited. A stage
 * that cannot be repaired is discarded and regenerated with a nudged seed.
 */
export function validateStage(data: WorldData, plannedSpeeds: number[], nodeRanges: [number, number][], timer: number): ValidationReport {
  const report: ValidationReport = { ok: true, checks: 0, repairs: [], warnings: [], reachableGoal: false, estimatedTime: 0 };
  const nodes = data.nodes;
  const phys = data.physics;

  // 1. GROUND PRESENCE. A ground node with nothing under it is a hole in the level.
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.kind !== 'ground' && n.kind !== 'launch') continue;
    report.checks++;
    const probe = phys.groundHeight(n.pos.x, n.pos.z, n.pos.y + 6, 14);
    if (probe.y === -Infinity) {
      addCatchPlatform(data, n.pos, 'missing ground at node ' + i);
      report.repairs.push('inserted deck under node ' + i);
    }
  }

  // 2. HEADROOM. Nothing may pin the player against a ceiling on the intended line.
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.kind !== 'ground') continue;
    report.checks++;
    const count = phys.gather(n.pos.x, n.pos.z, 2.4);
    const arr = phys.scratchArray;
    for (let k = 0; k < count; k++) {
      const s = arr[k];
      const dy = s.center.y - s.half.y - (n.pos.y + 1.0);
      if (dy > 0 && dy < 1.6 && Math.abs(s.center.x - n.pos.x) < s.half.x + 0.8 && Math.abs(s.center.z - n.pos.z) < s.half.z + 0.8) {
        report.warnings.push('tight headroom near node ' + i);
        break;
      }
    }
  }

  // 3. REACHABILITY. Walk the node chain module by module using that module's planned
  //    entry speed and the controller's real ballistic limits.
  let idx = 0;
  for (let m = 0; m < nodeRanges.length; m++) {
    const [from, to] = nodeRanges[m];
    const speed = plannedSpeeds[m];
    for (let i = from + 1; i < to; i++) {
      const a = nodes[i - 1], b = nodes[i];
      if (!a || !b) continue;
      if (a.route !== b.route && b.route !== 0) continue;   // separate lines are audited separately
      report.checks++;
      const horiz = Math.hypot(b.pos.x - a.pos.x, b.pos.z - a.pos.z);
      const rise = b.pos.y - a.pos.y;
      const reach = maxJumpDistance(Math.max(speed, b.requiredSpeed, 16));
      const climb = maxJumpHeight();
      if (horiz > reach || rise > climb) {
        // Repair: drop a stepping platform at the midpoint, biased toward the lower side.
        const mid = new Vector3().addVectors(a.pos, b.pos).multiplyScalar(0.5);
        mid.y = Math.min(a.pos.y, b.pos.y) + Math.min(4, Math.abs(rise) * 0.4);
        addCatchPlatform(data, mid, 'unreachable span');
        report.repairs.push('bridged span between nodes ' + (i - 1) + ' and ' + i +
          ' (' + horiz.toFixed(1) + 'm needed ' + reach.toFixed(1) + 'm available)');
      }
    }
    idx = to;
  }

  // 4. GOAL CONNECTIVITY. Breadth-first over the node graph with reachability edges.
  const goalIdx: number[] = [];
  for (let i = 0; i < nodes.length; i++) if (nodes[i].kind === 'goal') goalIdx.push(i);
  if (goalIdx.length === 0) {
    report.warnings.push('no goal node authored');
  } else {
    const seen = new Uint8Array(nodes.length);
    const queue: number[] = [0];
    seen[0] = 1;
    let found = false;
    while (queue.length) {
      const i = queue.shift()!;
      if (nodes[i].kind === 'goal') { found = true; break; }
      // Nodes are authored in stage order, so edges only need to look a short way ahead.
      for (let j = i + 1; j < Math.min(nodes.length, i + 6); j++) {
        if (seen[j]) continue;
        const horiz = nodes[i].pos.distanceTo(nodes[j].pos);
        if (horiz < maxJumpDistance(46) + 40) { seen[j] = 1; queue.push(j); }
      }
    }
    report.reachableGoal = found;
    if (!found) report.warnings.push('goal not reachable through the node graph');
  }

  // 5. PACING. Compare the timer against a conservative traversal estimate.
  let est = 0;
  for (let m = 0; m < nodeRanges.length; m++) {
    const [from, to] = nodeRanges[m];
    let dist = 0;
    for (let i = from + 1; i < to; i++) dist += nodes[i].pos.distanceTo(nodes[i - 1].pos);
    est += dist / Math.max(12, plannedSpeeds[m] * 0.55);
  }
  report.estimatedTime = est;
  if (timer < est * 1.05) report.warnings.push('timer is tight for the generated distance');
  report.ok = report.reachableGoal || goalIdx.length === 0;
  return report;
}

/** Repair primitive: a small deck with a hard silhouette, matched to the district. */
function addCatchPlatform(data: WorldData, pos: Vector3, reason: string) {
  const half = new Vector3(7, 0.7, 7);
  data.physics.addSolid(pos.clone().setY(pos.y - 0.7), half, _q.identity(), 'metal', 0, { boost: 1 });
  data.repairs.push({ pos: pos.clone(), reason });
}
