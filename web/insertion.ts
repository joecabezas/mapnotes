import type { Position } from '../shared/model';
import {
  CLEARANCE,
  type Extent,
  isArced,
  type QualityEdge,
  SLACK,
  segmentBoxDistance,
  segmentHitsBox,
  segmentsCross,
} from './layoutQuality';

/**
 * Builds a layout by inserting nodes one at a time, each where it adds the fewest edge crossings, then
 * keeps taking out patches of it and inserting them again.
 *
 * - Order: the busiest node first; then, each time, the node with the most neighbours already placed
 *   (ties: the busiest), so every node goes in next to what it connects to.
 * - Placement: a node tries a few spots on rings around its placed neighbours and around their middle
 *   (turned at random, so each try differs), scored like `qualityScore` over what's placed so far
 *   (crossings + 2 × edges through nodes + 3 × overlaps, plus up to 1 for each edge passing a node closer
 *   than the clearance), with a gap around nodes and a little for edges much longer than they should be.
 *   An edge should be longer at a busy node, so its neighbours fit around it.
 * - Looking ahead: a spot also costs the crossings its edges to unplaced neighbours look set to make, and
 *   how crowded it is when it has unplaced neighbours (they'll need room).
 * - Making room: where nothing fits, it also tries pushing the placed nodes around the spots with the
 *   fewest crossings outwards, more the closer they are (like blowing up a balloon there), and goes in
 *   the hole if that's better.
 * - Accommodating: after each insertion, the nodes around it with something wrong try better spots, on
 *   their own or carrying what hangs off them (a branch that only connects to the rest through them).
 * - Ruin and recreate: once every node is in, a patch around a crossing (its neighbourhood in the graph,
 *   or the nodes nearest it) is taken out and inserted again the same way, keeping the result when it's
 *   no worse, until the time is up or nothing is wrong.
 */

/** The knobs a user can turn. */
export interface InsertSettings {
  /** Stops after this long (it also stops when no crossings or other problems are left). */
  budgetMs: number;
  /** Room kept free between nodes. */
  gap: number;
  /** Edges passing closer than this to a node (other than their ends) count against a spot. */
  clearance: number;
  /** Try pushing nodes aside to make room. */
  makeRoom: boolean;
  /** Weight of the crossings the edges to unplaced neighbours look set to make (0 ignores them). */
  lookahead: number;
  /** Weight of how crowded a spot is, for nodes with neighbours still to place. */
  crowd: number;
  /** The most nodes taken out and inserted again at once, as a share of all of them (0–1). */
  patch: number;
}

export const INSERT_DEFAULTS: InsertSettings = {
  budgetMs: 3000,
  gap: 30,
  clearance: CLEARANCE,
  makeRoom: true,
  lookahead: 0.5,
  crowd: 1,
  patch: 0.4,
};

export interface InsertProgress {
  /** Nodes placed so far: fewer than `total` while the first layout is being built. */
  placed: number;
  total: number;
  /** Patches taken out and inserted again so far. */
  rounds: number;
  /** Score of the layout shown (of what's placed of it, while building). */
  score: number;
}

export interface InsertOptions extends Partial<InsertSettings> {
  /** Seeds the random numbers, for repeatable runs. */
  seed?: number;
  /** Called (at most every `progressMs`) with the layout as it's built, then with the best one when it improves. */
  onProgress?(positions: Record<string, Position>, progress: InsertProgress): void;
  progressMs?: number;
  /** Ends early; the best layout so far is returned. */
  signal?: AbortSignal;
}

interface Fitness {
  score: number;
  /** The part of the score that isn't edges being long: crossings, edges through or near nodes, overlaps. */
  flaws: number;
  /** How far edges are from the ideal length; only breaks ties. */
  stretch: number;
}

const better = (a: Fitness, b: Fitness) => a.score < b.score - 1e-9 || (Math.abs(a.score - b.score) <= 1e-9 && a.stretch < b.stretch - 1e-9);
const minus = (a: Fitness, b: Fitness): Fitness => ({
  score: a.score - b.score,
  flaws: a.flaws - b.flaws,
  stretch: a.stretch - b.stretch,
});

/** Small fast random numbers (mulberry32). */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

/**
 * Lays out the `movable` nodes by inserting them one by one. Other nodes in `positions` stay put and
 * are in place from the start. Returns positions for the movable nodes.
 */
export async function insertLayout(
  positions: Record<string, Position>,
  extents: Record<string, Extent>,
  edges: QualityEdge[],
  movable: Iterable<string>,
  options: InsertOptions = {},
): Promise<Record<string, Position>> {
  const { budgetMs, gap, clearance, makeRoom, lookahead, crowd, patch: patchShare } = { ...INSERT_DEFAULTS, ...options };
  const { seed = Date.now(), onProgress, progressMs = 100, signal } = options;
  const deadline = performance.now() + budgetMs;
  const running = () => performance.now() < deadline && !signal?.aborted;
  const random = rng(seed);

  const ids = Object.keys(positions);
  const index = new Map(ids.map((id, i) => [id, i]));
  const n = ids.length;
  const movableSet = new Set(movable);
  const isMoving = ids.map((id) => movableSet.has(id));
  const moving = ids.flatMap((_, i) => (isMoving[i] ? [i] : []));
  if (moving.length < 2) return {};
  const ext = ids.map((id) => extents[id] ?? { left: 0, right: 0, top: 0, bottom: 0 });

  const ends: [number, number][] = [];
  for (const e of edges) {
    const a = index.get(e.source);
    const b = index.get(e.target);
    if (a !== undefined && b !== undefined && a !== b) ends.push([a, b]);
  }
  const m = ends.length;
  const incident: number[][] = ids.map(() => []);
  const neighbourSets = ids.map(() => new Set<number>());
  ends.forEach(([a, b], i) => {
    incident[a].push(i);
    incident[b].push(i);
    neighbourSets[a].add(b);
    neighbourSets[b].add(a);
  });
  const neighbours = neighbourSets.map((s) => [...s]);
  const degree = (i: number) => neighbours[i].length;
  const width = (i: number) => ext[i].left + ext[i].right;
  const height = (i: number) => ext[i].top + ext[i].bottom;
  const ideal = moving.reduce((sum, i) => sum + (width(i) + height(i)) / 2, 0) / moving.length + 2 * gap;
  /** The radius of a ring around node `i` with room for all its neighbours. */
  const room = ids.map((_, i) =>
    Math.max(ideal, neighbours[i].reduce((sum, j) => sum + Math.max(width(j), height(j)) + gap, 0) / (2 * Math.PI)),
  );
  /** How long an edge between `a` and `b` should be: two leaves `ideal` apart, a hub's neighbours on its ring, two hubs' rings side by side. */
  const lengthOf = (a: number, b: number) => room[a] + room[b] - ideal;

  /** The layout being built; only placed nodes (and edges between them) count. */
  const g: Position[] = ids.map((id) => ({ ...positions[id] }));
  const placed = new Uint8Array(n);
  const live = (e: number) => placed[ends[e][0]] && placed[ends[e][1]];

  // ---- Scoring. `local` scores everything involving the nodes in `set` (all placed), so the change
  // from moving or placing them is the difference of `local` before and after.
  const inSet = new Int32Array(n).fill(-1);
  const incMark = new Uint8Array(m);
  /** What edge `e` costs node `k`: 2 when it runs through it, otherwise up to 1 the closer it passes. */
  const edgeNode = (e: number, k: number): number => {
    const [a, b] = ends[e];
    if (k === a || k === b || !placed[k]) return 0;
    const p = g[k];
    const x = ext[k];
    const pa = g[a];
    const pb = g[b];
    // Most nodes are nowhere near the edge.
    const reach = Math.max(clearance, 0);
    if (
      p.x - x.left - reach > Math.max(pa.x, pb.x) ||
      p.x + x.right + reach < Math.min(pa.x, pb.x) ||
      p.y - x.top - reach > Math.max(pa.y, pb.y) ||
      p.y + x.bottom + reach < Math.min(pa.y, pb.y)
    )
      return 0;
    const box = { x1: p.x - x.left, x2: p.x + x.right, y1: p.y - x.top, y2: p.y + x.bottom };
    const d = clearance > 0 ? segmentBoxDistance(g[a], g[b], box, clearance) : 0;
    if (clearance > 0 && d >= clearance) return 0;
    const inside = { x1: box.x1 + SLACK, x2: box.x2 - SLACK, y1: box.y1 + SLACK, y2: box.y2 - SLACK };
    if (segmentHitsBox(g[a], g[b], inside)) return 2;
    return clearance > 0 ? 1 - d / clearance : 0;
  };
  const overlap = (i: number, j: number) => {
    const pi = g[i];
    const pj = g[j];
    const half = gap / 2 - SLACK;
    return (
      pi.x - ext[i].left - half < pj.x + ext[j].right + half &&
      pj.x - ext[j].left - half < pi.x + ext[i].right + half &&
      pi.y - ext[i].top - half < pj.y + ext[j].bottom + half &&
      pj.y - ext[j].top - half < pi.y + ext[i].bottom + half
    );
  };
  const local = (set: number[]): Fitness => {
    let score = 0;
    let long = 0;
    let stretch = 0;
    set.forEach((i, k) => (inSet[i] = k));
    const inc: number[] = [];
    for (const i of set)
      for (const e of incident[i])
        if (!incMark[e] && live(e)) {
          incMark[e] = 1;
          inc.push(e);
        }
    for (const e of inc) {
      const [a, b] = ends[e];
      const pa = g[a];
      const pb = g[b];
      if (pa.x === pb.x && pa.y === pb.y) continue;
      for (let f = 0; f < m; f++) {
        if ((incMark[f] && f <= e) || !live(f)) continue;
        const [c, d] = ends[f];
        if (a === c || a === d || b === c || b === d) continue;
        if (segmentsCross(pa, pb, g[c], g[d])) score += 1;
      }
      if (!isArced(pa, pb)) for (let k = 0; k < n; k++) score += edgeNode(e, k);
      const ratio = Math.hypot(pb.x - pa.x, pb.y - pa.y) / lengthOf(a, b);
      stretch += (ratio - 1) ** 2;
      // Spreading everything out keeps edges clear of nodes but shrinks the graph on screen: long edges cost a little.
      if (ratio > 1.5) long += 0.1 * (ratio - 1.5);
    }
    for (let f = 0; f < m; f++) {
      if (incMark[f] || !live(f)) continue;
      const [c, d] = ends[f];
      if (isArced(g[c], g[d])) continue;
      for (const k of set) score += edgeNode(f, k);
    }
    set.forEach((i, k) => {
      for (let j = 0; j < n; j++) {
        // Each overlapping pair once, also when both nodes are in the set.
        if (j === i || !placed[j] || (inSet[j] >= 0 && inSet[j] >= k)) continue;
        if (overlap(i, j)) score += 3;
      }
    });
    for (const i of set) inSet[i] = -1;
    for (const e of inc) incMark[e] = 0;
    return { score: score + long, flaws: score, stretch };
  };
  const everyNode = ids.map((_, i) => i);
  const totalFitness = () => local(everyNode.filter((i) => placed[i]));

  // ---- Where a node could go.
  const centreOf = (list: number[]): Position => {
    let x = 0;
    let y = 0;
    for (const i of list) {
      x += g[i].x;
      y += g[i].y;
    }
    return { x: x / list.length, y: y / list.length };
  };
  /** `count` spots evenly round a circle, turned at random: few spots, but different ones every time. */
  const ring = (out: Position[], c: Position, r: number, count: number) => {
    const turn = random() * 2 * Math.PI;
    for (let k = 0; k < count; k++) {
      const t = turn + (2 * Math.PI * k) / count;
      out.push({ x: c.x + r * Math.cos(t), y: c.y + r * Math.sin(t) });
    }
  };
  /** The middle of where the movable nodes were: the first one goes there. */
  const start = centreOf(moving);
  /** Where the placed movable nodes are, shapes included; null if none is. */
  const bounds = () => {
    let x1 = Infinity;
    let x2 = -Infinity;
    let y1 = Infinity;
    let y2 = -Infinity;
    for (const i of moving) {
      if (!placed[i]) continue;
      x1 = Math.min(x1, g[i].x - ext[i].left);
      x2 = Math.max(x2, g[i].x + ext[i].right);
      y1 = Math.min(y1, g[i].y - ext[i].top);
      y2 = Math.max(y2, g[i].y + ext[i].bottom);
    }
    return x1 <= x2 ? { x1, x2, y1, y2 } : null;
  };
  /** Spots worth trying for node `v`: around the middle of its placed neighbours, and around each of them. */
  const spots = (v: number): Position[] => {
    const out: Position[] = [];
    const near = neighbours[v].filter((j) => placed[j] && j !== v);
    if (near.length) {
      const c = centreOf(near);
      out.push(c);
      ring(out, c, 0.5 * ideal, 4);
      ring(out, c, ideal, 4);
      ring(out, c, 1.6 * ideal, 5);
      // The busiest neighbours first; a hub's other neighbours tend to sit around it.
      for (const u of [...near].sort((a, b) => degree(b) - degree(a)).slice(0, 6)) {
        const r = lengthOf(u, v);
        ring(out, g[u], r, 4);
        ring(out, g[u], 1.6 * r, 4);
      }
    }
    if (placed[v]) {
      // Small steps from where it is.
      ring(out, g[v], 0.3 * ideal, 4);
      ring(out, g[v], 0.8 * ideal, 4);
    }
    if (!out.length) {
      // Nothing to go next to: where the nodes were if it's the first, otherwise a new part of the graph beside what's there.
      const b = bounds();
      const c = b ? { x: b.x2 + ideal + ext[v].left, y: (b.y1 + b.y2) / 2 } : start;
      out.push(c);
      ring(out, c, ideal, 4);
    }
    return out;
  };

  /**
   * Pushes the placed movable nodes around `spot` outwards, the closest by `push`, fading to nothing
   * `reach` away. Points keep their order along each ray from the spot (since push < reach), so it
   * mostly keeps crossings as they were. Returns who moved and where they were.
   */
  const balloon = (v: number, spot: Position, push: number, reach: number) => {
    const moved: number[] = [];
    const was: Position[] = [];
    for (const j of moving) {
      if (j === v || !placed[j]) continue;
      const dx = g[j].x - spot.x;
      const dy = g[j].y - spot.y;
      const d = Math.hypot(dx, dy);
      if (d >= reach) continue;
      const t = d > 1e-6 ? null : random() * 2 * Math.PI;
      const ux = t === null ? dx / d : Math.cos(t);
      const uy = t === null ? dy / d : Math.sin(t);
      const s = push * (1 - d / reach);
      moved.push(j);
      was.push(g[j]);
      g[j] = { x: g[j].x + ux * s, y: g[j].y + uy * s };
    }
    return { moved, was };
  };

  /**
   * Crossings that the edges from just-placed `v` to its unplaced neighbours look set to make: a
   * neighbour that has other placed neighbours will likely go in the middle of them and `v`, so its
   * edges are drawn to there.
   */
  const ahead = (v: number): number => {
    if (!lookahead) return 0;
    let cost = 0;
    for (const w of neighbours[v]) {
      if (placed[w]) continue;
      const others = neighbours[w].filter((u) => placed[u] && u !== v);
      if (!others.length) continue;
      let x = g[v].x;
      let y = g[v].y;
      for (const u of others) {
        x += g[u].x;
        y += g[u].y;
      }
      const t = { x: x / (others.length + 1), y: y / (others.length + 1) };
      for (const u of [v, ...others]) {
        for (let f = 0; f < m; f++) {
          if (!live(f)) continue;
          const [c, d] = ends[f];
          if (c === u || d === u) continue;
          if (segmentsCross(g[u], t, g[c], g[d])) cost += 1;
        }
      }
    }
    let pending = 0;
    for (const w of neighbours[v]) if (!placed[w]) pending++;
    if (!pending || !crowd) return lookahead * cost;
    // Its unplaced neighbours will want room around it.
    let crowding = 0;
    const r = room[v] * 1.5;
    for (let j = 0; j < n; j++) {
      if (!placed[j] || j === v) continue;
      const d = Math.hypot(g[j].x - g[v].x, g[j].y - g[v].y);
      if (d < r) crowding += 1 - d / r;
    }
    return lookahead * cost + crowd * pending * crowding;
  };
  const plus = (f: Fitness, extra: number): Fitness => ({ ...f, score: f.score + extra });

  /** Edges of `v` crossing other placed edges. */
  const crossings = (v: number): number => {
    let count = 0;
    for (const e of incident[v]) {
      if (!live(e)) continue;
      const [a, b] = ends[e];
      for (let f = 0; f < m; f++) {
        if (!live(f)) continue;
        const [c, d] = ends[f];
        if (a === c || a === d || b === c || b === d) continue;
        if (segmentsCross(g[a], g[b], g[c], g[d])) count++;
      }
    }
    return count;
  };

  /** Puts unplaced node `v` at its best spot, pushing others aside when that's better. */
  const insert = (v: number) => {
    const candidates = spots(v);
    placed[v] = 1;
    const scored: { spot: Position; fitness: Fitness; tangle: number }[] = [];
    for (const spot of candidates) {
      g[v] = spot;
      const later = ahead(v);
      scored.push({ spot, fitness: plus(local([v]), later), tangle: crossings(v) + later });
    }
    scored.sort((a, b) => (better(a.fitness, b.fitness) ? -1 : better(b.fitness, a.fitness) ? 1 : 0));
    let best = scored[0];
    let bestMoves: { moved: number[]; to: Position[] } | null = null;
    // Only worth it where something's in the way: then where it would cross the least if there was
    // room (pushing others aside fixes overlaps and edges too close, not crossings).
    if (makeRoom && best.fitness.score >= 0.5) {
      const size = Math.max(width(v), height(v));
      const roomy = [...scored].sort((a, b) => a.tangle - b.tangle).slice(0, 3);
      for (const { spot } of roomy) {
        for (const push of [0.5 * (size + gap), size + gap]) {
          placed[v] = 0;
          const reach = 3 * ideal;
          const { moved, was } = balloon(v, spot, push, reach);
          const after = moved.map((j) => g[j]);
          moved.forEach((j, k) => (g[j] = was[k]));
          const before = local(moved);
          moved.forEach((j, k) => (g[j] = after[k]));
          placed[v] = 1;
          g[v] = spot;
          const fitness = plus(minus(local([v, ...moved]), before), ahead(v));
          if (better(fitness, best.fitness)) {
            best = { spot, fitness, tangle: 0 };
            bestMoves = { moved, to: after };
          }
          moved.forEach((j, k) => (g[j] = was[k]));
        }
      }
    }
    g[v] = best.spot;
    if (bestMoves) bestMoves.moved.forEach((j, k) => (g[j] = bestMoves.to[k]));
    return best.fitness;
  };

  /**
   * What hangs off each node: the parts of the graph that only connect to the rest through it (all of
   * them but the biggest), movable ones only. Moving a node with what hangs off it moves a whole branch.
   */
  const hanging: number[][] = ids.map((_, v) => {
    if (!isMoving[v] || degree(v) < 2) return [];
    const seen = new Uint8Array(n);
    seen[v] = 1;
    const parts: number[][] = [];
    for (const start of neighbours[v]) {
      if (seen[start]) continue;
      const part = [start];
      seen[start] = 1;
      for (let k = 0; k < part.length; k++)
        for (const j of neighbours[part[k]])
          if (!seen[j]) {
            seen[j] = 1;
            part.push(j);
          }
      parts.push(part);
    }
    parts.sort((a, b) => b.length - a.length);
    // Fixed nodes don't move, so neither does a part holding one.
    return parts.slice(1).flatMap((part) => (part.every((j) => isMoving[j]) ? part : []));
  });

  /** Moves placed node `v` to the best of its spots if that's better than where it is. */
  const improve = (v: number): boolean => {
    const home = g[v];
    let best = local([v]);
    let bestSpot = home;
    const candidates = spots(v);
    for (const spot of candidates) {
      g[v] = spot;
      const f = local([v]);
      if (better(f, best)) {
        best = f;
        bestSpot = spot;
      }
    }
    g[v] = bestSpot;
    if (bestSpot !== home) return true;
    return carry(v, candidates);
  };
  /**
   * Moves `v` with what hangs off it to the best of `candidates` if that's better, the branch turned
   * to keep facing away from the rest of the graph.
   */
  const carry = (v: number, candidates: Position[]): boolean => {
    const branch = hanging[v].filter((j) => placed[j]);
    if (!branch.length) return false;
    const group = [v, ...branch];
    const inBranch = new Set(branch);
    const anchors = neighbours[v].filter((j) => placed[j] && !inBranch.has(j));
    const anchor = anchors.length ? centreOf(anchors) : null;
    const was = group.map((j) => g[j]);
    const home = g[v];
    let best = local(group);
    let bestAt: Position[] | null = null;
    // Fewer spots: each try moves the whole branch.
    for (let k = 0; k < candidates.length; k += 2) {
      const spot = candidates[k];
      const turn = anchor
        ? Math.atan2(spot.y - anchor.y, spot.x - anchor.x) - Math.atan2(home.y - anchor.y, home.x - anchor.x)
        : 0;
      const cos = Math.cos(turn);
      const sin = Math.sin(turn);
      group.forEach((j, i) => {
        const dx = was[i].x - home.x;
        const dy = was[i].y - home.y;
        g[j] = { x: spot.x + cos * dx - sin * dy, y: spot.y + sin * dx + cos * dy };
      });
      const f = local(group);
      if (better(f, best)) {
        best = f;
        bestAt = group.map((j) => g[j]);
      }
    }
    group.forEach((j, i) => (g[j] = bestAt ? bestAt[i] : was[i]));
    return bestAt !== null;
  };
  /** The placed movable nodes near `v` (its neighbours and whatever is within reach). */
  const around = (v: number) => {
    const reach2 = (1.5 * ideal) ** 2;
    return moving.filter(
      (j) => j !== v && placed[j] && (neighbourSets[v].has(j) || (g[j].x - g[v].x) ** 2 + (g[j].y - g[v].y) ** 2 < reach2),
    );
  };
  /** Whether node `i` is involved in anything that costs. */
  const troubled = (i: number) => local([i]).score >= 0.5;

  // ---- Reporting.
  let best: { layout: Position[]; fitness: Fitness } | null = null;
  let rounds = 0;
  let shownAt = -Infinity;
  let shown = Infinity;
  const positionsOf = (layout: Position[], onlyPlaced = false) => {
    const result: Record<string, Position> = {};
    for (const i of moving)
      if (!onlyPlaced || placed[i]) result[ids[i]] = { x: Math.round(layout[i].x), y: Math.round(layout[i].y) };
    return result;
  };
  /** While building, the layout so far; then the best one, when it's better than the one shown. */
  const report = () => {
    if (!onProgress || performance.now() - shownAt < progressMs) return;
    if (best && best.fitness.score >= shown) return;
    shownAt = performance.now();
    const total = moving.length;
    if (best) {
      shown = best.fitness.score;
      onProgress(positionsOf(best.layout), { placed: total, total, rounds, score: shown });
    } else {
      const placedNow = moving.filter((i) => placed[i]).length;
      onProgress(positionsOf(g, true), { placed: placedNow, total, rounds, score: totalFitness().score });
    }
  };
  let lastYield = performance.now();
  /** Lets the page breathe. */
  const breathe = async () => {
    if (performance.now() - lastYield < 30) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
    lastYield = performance.now();
  };

  // ---- Building: inserting nodes one by one.
  const hubs = [...moving].sort((a, b) => degree(b) - degree(a));
  /**
   * Inserts the unplaced nodes of `set`, each time the one with the most placed neighbours (ties: the
   * busiest), `first` first if nothing it connects to is placed. False if it ran out of time (unless
   * nothing was laid out yet) or was stopped.
   */
  const recreate = async (set: number[], first = -1) => {
    const pull = new Int32Array(n);
    for (const i of set) for (const j of neighbours[i]) if (placed[j]) pull[i]++;
    const tie = new Float64Array(n).map(() => random());
    for (let count = 0; count < set.length; count++) {
      let v = -1;
      for (const i of set) {
        if (placed[i]) continue;
        if (
          v < 0 ||
          pull[i] > pull[v] ||
          (pull[i] === pull[v] && (degree(i) > degree(v) || (degree(i) === degree(v) && tie[i] > tie[v])))
        )
          v = i;
      }
      if (count === 0 && pull[v] === 0 && first >= 0) v = first;
      insert(v);
      for (const j of neighbours[v]) pull[j]++;
      // Accommodate: the nodes around it may now have better spots.
      for (const j of around(v)) if (troubled(j)) improve(j);
      if (!best) report();
      await breathe();
      if (signal?.aborted || (best && !running())) return false;
    }
    return true;
  };

  // ---- Ruin and recreate: take out a patch with something wrong in it and insert it again.
  /** An end of a crossing edge if a few tries find one, otherwise a node that costs, otherwise any. */
  const culprit = (): number => {
    for (let tries = 0; tries < 10 && m; tries++) {
      const e = Math.floor(random() * m);
      const [a, b] = ends[e];
      for (let f = 0; f < m; f++) {
        const [c, d] = ends[f];
        if (a === c || a === d || b === c || b === d) continue;
        if (segmentsCross(g[a], g[b], g[c], g[d])) {
          const candidates = [a, b, c, d].filter((k) => isMoving[k]);
          if (candidates.length) return candidates[Math.floor(random() * candidates.length)];
        }
      }
    }
    for (let tries = 0; tries < 10; tries++) {
      const i = moving[Math.floor(random() * moving.length)];
      if (troubled(i)) return i;
    }
    return moving[Math.floor(random() * moving.length)];
  };
  /** Takes out `size` movable nodes around a culprit: its neighbourhood in the graph, or the nodes nearest it. */
  const ruin = (size: number): number[] => {
    const centre = culprit();
    let patch: number[];
    if (random() < 0.5) {
      patch = [centre];
      const seen = new Set(patch);
      for (let k = 0; k < patch.length && patch.length < size; k++) {
        const next = neighbours[patch[k]].filter((j) => isMoving[j] && !seen.has(j)).sort(() => random() - 0.5);
        for (const j of next) {
          if (patch.length >= size) break;
          seen.add(j);
          patch.push(j);
        }
      }
    } else {
      const c = g[centre];
      const distance = (i: number) => (g[i].x - c.x) ** 2 + (g[i].y - c.y) ** 2;
      patch = [...moving].sort((a, b) => distance(a) - distance(b)).slice(0, size);
    }
    for (const i of patch) placed[i] = 0;
    return patch;
  };

  /** Stretches (or shrinks) the movable nodes' spread: crossings stay, edges get further from nodes. */
  const spread = () => {
    let fitness = totalFitness();
    const c = centreOf(moving);
    for (const [sx, sy] of [
      [1.15, 1],
      [1, 1.15],
      [1.15, 1.15],
      [0.9, 0.9],
    ]) {
      const was = moving.map((i) => g[i]);
      for (const i of moving) g[i] = { x: c.x + (g[i].x - c.x) * sx, y: c.y + (g[i].y - c.y) * sy };
      const f = totalFitness();
      if (better(f, fitness)) fitness = f;
      else moving.forEach((i, k) => (g[i] = was[k]));
    }
    return fitness;
  };

  // Build, from the busiest node.
  for (let i = 0; i < n; i++) placed[i] = isMoving[i] ? 0 : 1;
  if (await recreate(moving, hubs[0])) {
    best = { layout: [...g], fitness: totalFitness() };
    // Then rebuild patches of it, keeping what's no worse.
    const largest = Math.max(4, Math.round(patchShare * moving.length));
    while (running() && best.fitness.flaws > 1e-9) {
      rounds++;
      const patch = ruin(2 + Math.floor(random() * (largest - 1)));
      if (!(await recreate(patch))) break;
      for (const v of patch) if (troubled(v)) improve(v);
      const fitness = totalFitness();
      if (!better(best.fitness, fitness)) best = { layout: [...g], fitness };
      else g.splice(0, n, ...best.layout);
      placed.fill(1);
      report();
      await breathe();
    }
    g.splice(0, n, ...best.layout);
    placed.fill(1);
    const fitness = spread();
    if (better(fitness, best.fitness)) best = { layout: [...g], fitness };
  }
  // Stopped while the first layout was being built: what's placed of it, the rest where it was.
  return positionsOf(best ? best.layout : g);
}
