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
 * A genetic algorithm that evolves node positions to minimise edge crossings.
 *
 * - A genome is a whole layout: a position for every node (fixed nodes keep theirs in every genome).
 * - Fitness is scored like `qualityScore` (crossings + 2 × edges through nodes + 3 × overlaps, plus up
 *   to 1 for each edge passing a node closer than the clearance, more the closer it is), with a gap
 *   around nodes so the result isn't cramped, and a little for edges much longer than an ideal length
 *   (so it doesn't just spread out); on equal scores, edges closer to the ideal length win.
 * - Crossover keeps part of one parent (a neighbourhood in the graph, or one side of a line) and takes
 *   the rest from the other, turned and scaled to match the first.
 * - Mutations swap or nudge nodes, or put a hub's neighbours on a ring around it ("sun and planets").
 * - Each child is then repaired a little: nodes on crossing edges try a few better spots (a memetic GA).
 * - It explores first, then refines. A population soon settles in one valley (a layout it can't improve
 *   in small steps), and which one is mostly luck, so while exploring, whenever it stops improving it keeps
 *   that valley's best aside and starts over from fresh copies of the seeds. For the rest of the time the
 *   best of every valley breed and get polished.
 */

/** The knobs a user can turn. */
export interface EvolveSettings {
  /** Stops after this long. */
  budgetMs: number;
  populationSize: number;
  /** How often a child mixes two parents (0–1); otherwise it's a copy of one. */
  crossover: number;
  /** Blind mutations per child, on average. */
  mutations: number;
  /** Repair moves tried on each child. */
  repair: number;
  /** Room kept free between nodes. */
  gap: number;
  /** Use the "sun and planets" mutation and seeds. */
  planets: boolean;
  /** Edges passing closer than this to a node (other than their ends) are pushed away. */
  clearance: number;
  /** The share of the time spent exploring (starting over when stuck) before refining (0–1). */
  explore: number;
}

export const EVOLVE_DEFAULTS: EvolveSettings = {
  budgetMs: 6000,
  populationSize: 24,
  crossover: 0.3,
  mutations: 1,
  repair: 8,
  gap: 30,
  planets: true,
  clearance: CLEARANCE,
  explore: 0.6,
};

export interface EvolveProgress {
  generation: number;
  /** Of the layout shown: while exploring, the current generation's best; then the best found. */
  score: number;
  /** Still exploring (the layout shown can be worse than the best found). */
  exploring: boolean;
  /** The best layout found so far, and its score. */
  best: Record<string, Position>;
  bestScore: number;
}

export interface EvolveOptions extends Partial<EvolveSettings> {
  /** Seeds the random numbers, for repeatable runs. */
  seed?: number;
  /** Called (at most every `progressMs`) with the generation's best layout, to watch it evolve. */
  onProgress?(positions: Record<string, Position>, progress: EvolveProgress): void;
  progressMs?: number;
  /** Ends the evolution early; the best layout so far is returned. */
  signal?: AbortSignal;
}

type Genome = Position[];
interface Fitness {
  score: number;
  /** How far edges are from the ideal length; only breaks ties. */
  stretch: number;
}
interface Individual {
  genome: Genome;
  fitness: Fitness;
}

/** Generations without real improvement before exploring starts over. */
const PATIENCE = 6;

const better = (a: Fitness, b: Fitness) => a.score < b.score || (a.score === b.score && a.stretch < b.stretch - 1e-9);

/** Small fast random numbers (mulberry32). */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

/** The 2×2 matrices of the four rotations by quarter turns, and of their mirror images. */
const SYMMETRIES = [
  [1, 0, 0, 1],
  [0, -1, 1, 0],
  [-1, 0, 0, -1],
  [0, 1, -1, 0],
  [-1, 0, 0, 1],
  [0, -1, -1, 0],
  [1, 0, 0, -1],
  [0, 1, 1, 0],
];

/**
 * Evolves new positions for the `movable` nodes, starting from `seeds` (layouts of those nodes, e.g.
 * what other algorithms made). Other nodes in `positions` stay put but count towards the score.
 * Returns positions for the movable nodes.
 */
export async function evolveLayout(
  positions: Record<string, Position>,
  extents: Record<string, Extent>,
  edges: QualityEdge[],
  movable: Iterable<string>,
  seeds: Record<string, Position>[],
  options: EvolveOptions = {},
): Promise<Record<string, Position>> {
  const {
    budgetMs,
    populationSize,
    crossover: crossoverRate,
    mutations: mutationRate,
    repair: repairSteps,
    gap,
    planets,
    clearance,
    explore,
  } = {
    ...EVOLVE_DEFAULTS,
    ...options,
  };
  const { seed = Date.now(), onProgress, progressMs = 150, signal } = options;
  const start = performance.now();
  const deadline = start + budgetMs;
  const running = () => performance.now() < deadline && !signal?.aborted;
  const exploreUntil = start + explore * budgetMs;
  const random = rng(seed);
  const pick = <T>(list: T[]) => list[Math.floor(random() * list.length)];

  const ids = Object.keys(positions);
  const index = new Map(ids.map((id, i) => [id, i]));
  const n = ids.length;
  const movableSet = new Set(movable);
  const moving = ids.flatMap((id, i) => (movableSet.has(id) ? [i] : []));
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
  const width = (i: number) => ext[i].left + ext[i].right;
  const height = (i: number) => ext[i].top + ext[i].bottom;
  const ideal = moving.reduce((sum, i) => sum + (width(i) + height(i)) / 2, 0) / moving.length + 2 * gap;

  // ---- Fitness. `local` scores what changes when the nodes in `set` move, so it can compare moves
  // cheaply; over all nodes it's the whole score.
  const inSet = new Int32Array(n).fill(-1);
  const incMark = new Uint8Array(m);
  /** What edge `e` costs node `k`: 2 when it runs through it, otherwise up to 1 the closer it passes. */
  const edgeNode = (g: Genome, e: number, k: number): number => {
    const [a, b] = ends[e];
    if (k === a || k === b) return 0;
    const p = g[k];
    const x = ext[k];
    const box = { x1: p.x - x.left, x2: p.x + x.right, y1: p.y - x.top, y2: p.y + x.bottom };
    const d = clearance > 0 ? segmentBoxDistance(g[a], g[b], box, clearance) : 0;
    if (clearance > 0 && d >= clearance) return 0;
    const inside = { x1: box.x1 + SLACK, x2: box.x2 - SLACK, y1: box.y1 + SLACK, y2: box.y2 - SLACK };
    if (segmentHitsBox(g[a], g[b], inside)) return 2;
    return clearance > 0 ? 1 - d / clearance : 0;
  };
  const overlap = (g: Genome, i: number, j: number) => {
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
  const local = (g: Genome, set: number[]): Fitness => {
    let score = 0;
    let stretch = 0;
    set.forEach((i, k) => (inSet[i] = k));
    const inc: number[] = [];
    for (const i of set)
      for (const e of incident[i])
        if (!incMark[e]) {
          incMark[e] = 1;
          inc.push(e);
        }
    for (const e of inc) {
      const [a, b] = ends[e];
      const pa = g[a];
      const pb = g[b];
      if (pa.x === pb.x && pa.y === pb.y) continue;
      for (let f = 0; f < m; f++) {
        if (incMark[f] && f <= e) continue;
        const [c, d] = ends[f];
        if (a === c || a === d || b === c || b === d) continue;
        if (segmentsCross(pa, pb, g[c], g[d])) score += 1;
      }
      if (!isArced(pa, pb)) for (let k = 0; k < n; k++) score += edgeNode(g, e, k);
      const ratio = Math.hypot(pb.x - pa.x, pb.y - pa.y) / ideal;
      stretch += (ratio - 1) ** 2;
      // Spreading everything out keeps edges clear of nodes but shrinks the graph on screen: long edges cost a little.
      if (ratio > 1.5) score += 0.1 * (ratio - 1.5);
    }
    for (let f = 0; f < m; f++) {
      if (incMark[f]) continue;
      const [c, d] = ends[f];
      if (isArced(g[c], g[d])) continue;
      for (const k of set) score += edgeNode(g, f, k);
    }
    set.forEach((i, k) => {
      for (let j = 0; j < n; j++) {
        // Each overlapping pair once, also when both nodes are in the set.
        if (j === i || (inSet[j] >= 0 && inSet[j] >= k)) continue;
        if (overlap(g, i, j)) score += 3;
      }
    });
    for (const i of set) inSet[i] = -1;
    for (const e of inc) incMark[e] = 0;
    return { score, stretch };
  };
  const everyNode = ids.map((_, i) => i);
  const evaluate = (genome: Genome): Individual => ({ genome, fitness: local(genome, everyNode) });

  const base: Genome = ids.map((id) => ({ ...positions[id] }));
  const clone = (g: Genome): Genome => g.map((p) => ({ ...p }));
  const centroid = (g: Genome) => {
    let x = 0;
    let y = 0;
    for (const i of moving) {
      x += g[i].x;
      y += g[i].y;
    }
    return { x: x / moving.length, y: y / moving.length };
  };
  const barycentre = (g: Genome, i: number): Position | null => {
    if (!neighbours[i].length) return null;
    let x = 0;
    let y = 0;
    for (const j of neighbours[i]) {
      x += g[j].x;
      y += g[j].y;
    }
    return { x: x / neighbours[i].length, y: y / neighbours[i].length };
  };
  const around = (p: Position, r: number): Position => {
    const t = random() * 2 * Math.PI;
    return { x: p.x + r * Math.cos(t), y: p.y + r * Math.sin(t) };
  };

  // ---- Local repair: moves that lower the score are kept.
  /** Moves `i` to the best of `spots` if that's better than where it is. */
  const tryMove = (g: Genome, i: number, spots: Position[]) => {
    const home = g[i];
    let best = local(g, [i]);
    let bestSpot = home;
    for (const spot of spots) {
      g[i] = spot;
      const f = local(g, [i]);
      if (better(f, best)) {
        best = f;
        bestSpot = spot;
      }
    }
    g[i] = bestSpot;
  };
  const trySwap = (g: Genome, i: number, j: number) => {
    const before = local(g, [i, j]);
    [g[i], g[j]] = [g[j], g[i]];
    if (!better(local(g, [i, j]), before)) [g[i], g[j]] = [g[j], g[i]];
  };
  /** An edge (not arced) that runs through or close to node `i`. */
  const edgeNear = (g: Genome, i: number): number => {
    for (let e = 0; e < m; e++) if (!isArced(g[ends[e][0]], g[ends[e][1]]) && edgeNode(g, e, i) > 0) return e;
    return -1;
  };
  /** A node on a crossing edge or too close to an edge, if a few tries find one; otherwise any movable node. */
  const troubled = (g: Genome): number => {
    if (random() < 0.3) {
      for (let tries = 0; tries < 6; tries++) {
        const i = pick(moving);
        if (edgeNear(g, i) >= 0) return i;
      }
    }
    for (let tries = 0; tries < 6; tries++) {
      const e = Math.floor(random() * m);
      if (!m) break;
      const [a, b] = ends[e];
      for (let f = 0; f < m; f++) {
        const [c, d] = ends[f];
        if (a === c || a === d || b === c || b === d) continue;
        if (segmentsCross(g[a], g[b], g[c], g[d])) {
          const candidates = [a, b, c, d].filter((k) => movableSet.has(ids[k]));
          if (candidates.length) return pick(candidates);
        }
      }
    }
    return pick(moving);
  };
  const repair = (g: Genome, steps: number) => {
    for (let s = 0; s < steps; s++) {
      const i = troubled(g);
      if (random() < 0.25) {
        trySwap(g, i, pick(moving));
        continue;
      }
      const centre = barycentre(g, i) ?? g[i];
      const spots = [around(centre, random() * gap)];
      for (let k = 0; k < 4; k++) spots.push(around(centre, ideal * (0.7 + random() * 0.6)));
      for (let k = 0; k < 2; k++) spots.push(around(g[i], random() * ideal));
      // Away from an edge it's too close to.
      const e = edgeNear(g, i);
      if (e >= 0) {
        const [a, b] = ends[e];
        const dx = g[b].x - g[a].x;
        const dy = g[b].y - g[a].y;
        const t = Math.max(
          0,
          Math.min(1, ((g[i].x - g[a].x) * dx + (g[i].y - g[a].y) * dy) / (dx * dx + dy * dy || 1)),
        );
        let ux = g[i].x - (g[a].x + t * dx);
        let uy = g[i].y - (g[a].y + t * dy);
        // On the edge: off to one side.
        if (!ux && !uy) [ux, uy] = [-dy, dx];
        const length = Math.hypot(ux, uy) || 1;
        const push = clearance + Math.max(width(i), height(i)) / 2 + random() * gap;
        spots.push({ x: g[a].x + t * dx + (ux / length) * push, y: g[a].y + t * dy + (uy / length) * push });
      }
      tryMove(g, i, spots);
    }
  };

  /** `size` movable nodes, grown breadth-first in the graph from a random one (carrying on in another part when that runs out). */
  const neighbourhood = (size: number): Set<number> => {
    const keep = new Set<number>();
    const queue = [pick(moving)];
    keep.add(queue[0]);
    while (queue.length && keep.size < size) {
      for (const j of neighbours[queue.shift()!]) {
        if (keep.size >= size) break;
        if (!keep.has(j) && movableSet.has(ids[j])) {
          keep.add(j);
          queue.push(j);
        }
      }
      if (!queue.length && keep.size < size) {
        const next = pick(moving.filter((i) => !keep.has(i)));
        keep.add(next);
        queue.push(next);
      }
    }
    return keep;
  };

  // ---- Mutations: blind changes, kept or dropped by selection.
  /** Sun and planets: a hub's movable neighbours go on a ring around it, in the order they were around it. */
  const hubs = moving.filter((i) => neighbours[i].length >= 3);
  const pickHub = () => {
    let total = 0;
    for (const i of hubs) total += neighbours[i].length ** 2;
    let r = random() * total;
    for (const i of hubs) if ((r -= neighbours[i].length ** 2) <= 0) return i;
    return hubs[hubs.length - 1];
  };
  const ringAround = (g: Genome, hub: number) => {
    const planets = neighbours[hub].filter((j) => movableSet.has(ids[j]));
    if (!planets.length) return;
    const c = g[hub];
    const angle = (j: number) => Math.atan2(g[j].y - c.y, g[j].x - c.x);
    planets.sort((a, b) => angle(a) - angle(b));
    const circumference = planets.reduce((sum, j) => sum + Math.max(width(j), height(j)) + gap, 0);
    const r = Math.max(ideal, circumference / (2 * Math.PI));
    const turn = random() * 2 * Math.PI;
    planets.forEach((j, k) => {
      const t = turn + (2 * Math.PI * k) / planets.length;
      g[j] = { x: c.x + r * Math.cos(t), y: c.y + r * Math.sin(t) };
    });
  };
  /** Stretches (or shrinks) the movable nodes' spread: crossings stay, edges get further from nodes. */
  const scale = (g: Genome, sx: number, sy: number) => {
    const c = centroid(g);
    for (const i of moving) g[i] = { x: c.x + (g[i].x - c.x) * sx, y: c.y + (g[i].y - c.y) * sy };
  };
  const mutate = (g: Genome) => {
    const r = random();
    if (r < 0.25 && planets && hubs.length) ringAround(g, pickHub());
    else if (r < 0.5) {
      const i = pick(moving);
      const j = pick(moving);
      [g[i], g[j]] = [g[j], g[i]];
    } else if (r < 0.85) {
      const i = pick(moving);
      g[i] = around(g[i], random() * ideal);
    } else {
      // Along one axis or both.
      const f = 0.85 + random() * 0.45;
      const axis = random();
      scale(g, axis < 0.67 ? f : 1, axis > 0.33 ? f : 1);
    }
  };

  // ---- Crossover.
  /** `b`'s movable nodes turned, mirrored, scaled and moved to best match `a`'s. */
  const aligned = (a: Genome, b: Genome): Genome => {
    const ca = centroid(a);
    const cb = centroid(b);
    let ra = 0;
    let rb = 0;
    for (const i of moving) {
      ra += (a[i].x - ca.x) ** 2 + (a[i].y - ca.y) ** 2;
      rb += (b[i].x - cb.x) ** 2 + (b[i].y - cb.y) ** 2;
    }
    const s = rb > 0 ? Math.sqrt(ra / rb) : 1;
    let best = SYMMETRIES[0];
    let bestDistance = Infinity;
    for (const t of SYMMETRIES) {
      let d = 0;
      for (const i of moving) {
        const x = b[i].x - cb.x;
        const y = b[i].y - cb.y;
        d += (ca.x + s * (t[0] * x + t[1] * y) - a[i].x) ** 2 + (ca.y + s * (t[2] * x + t[3] * y) - a[i].y) ** 2;
      }
      if (d < bestDistance) {
        bestDistance = d;
        best = t;
      }
    }
    const out = clone(b);
    for (const i of moving) {
      const x = b[i].x - cb.x;
      const y = b[i].y - cb.y;
      out[i] = { x: ca.x + s * (best[0] * x + best[1] * y), y: ca.y + s * (best[2] * x + best[3] * y) };
    }
    return out;
  };
  /** Which movable nodes the child takes from the first parent. */
  const fromFirst = (a: Genome): Set<number> => {
    const target = Math.max(1, Math.round(moving.length * (0.3 + random() * 0.4)));
    // A neighbourhood in the graph.
    if (random() < 0.5) return neighbourhood(target);
    // One side of a random line through the middle.
    const c = centroid(a);
    const t = random() * Math.PI;
    const side = (i: number) => (a[i].x - c.x) * Math.cos(t) + (a[i].y - c.y) * Math.sin(t);
    return new Set([...moving].sort((x, y) => side(x) - side(y)).slice(0, target));
  };
  const crossover = (a: Genome, b: Genome): Genome => {
    const other = aligned(a, b);
    const keep = fromFirst(a);
    const child = clone(a);
    for (const i of moving) if (!keep.has(i)) child[i] = { ...other[i] };
    return child;
  };

  // ---- Seeds: the given layouts, plus "solar" ones: the busiest node in the middle, each node's
  // neighbours on an arc around it, facing away from the node it was placed from.
  const solar = (root: number): Genome => {
    const g = clone(seeds.length ? withSeed(seeds[0]) : base);
    const c = centroid(g);
    const placed = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (!movableSet.has(ids[i])) placed[i] = 1;
    const order = [root, ...[...moving].sort((x, y) => neighbours[y].length - neighbours[x].length)];
    let shift = 0;
    for (const start of order) {
      if (placed[start]) continue;
      const component: number[] = [start];
      g[start] = { x: c.x + shift, y: c.y };
      placed[start] = 1;
      const queue: { i: number; angle: number; spread: number }[] = [{ i: start, angle: 0, spread: 2 * Math.PI }];
      while (queue.length) {
        const { i, angle, spread } = queue.shift()!;
        const next = neighbours[i]
          .filter((j) => !placed[j])
          .sort((x, y) => neighbours[y].length - neighbours[x].length);
        if (!next.length) continue;
        const arc = next.reduce((sum, j) => sum + Math.max(width(j), height(j)) + gap, 0);
        const r = Math.max(ideal, arc / spread);
        next.forEach((j, k) => {
          const t = angle - spread / 2 + (spread * (k + 0.5)) / next.length;
          g[j] = { x: g[i].x + r * Math.cos(t), y: g[i].y + r * Math.sin(t) };
          placed[j] = 1;
          component.push(j);
          queue.push({ i: j, angle: t, spread: Math.min(Math.PI * 0.8, (spread / next.length) * 3) });
        });
      }
      // The next component goes to the right of this one.
      shift = Math.max(...component.map((i) => g[i].x + ext[i].right)) - c.x + ideal;
    }
    return g;
  };
  function withSeed(seedPositions: Record<string, Position>): Genome {
    const g = clone(base);
    for (const i of moving) {
      const p = seedPositions[ids[i]];
      if (p) g[i] = { ...p };
    }
    return g;
  }

  const seeded = seeds.map((s) => evaluate(withSeed(s)));
  const roots = planets ? [...moving].sort((x, y) => neighbours[y].length - neighbours[x].length).slice(0, 3) : [];
  for (const root of roots) seeded.push(evaluate(solar(root)));
  if (!seeded.length) seeded.push(evaluate(clone(base)));
  /** A starting population: the seeds (some of them, after the first) and mutated copies of them. */
  const founders = (some: boolean): Individual[] => {
    const chosen = some ? seeded.filter(() => random() < 0.5) : [...seeded];
    if (!chosen.length) chosen.push(pick(seeded));
    const founded = [...chosen];
    while (founded.length < populationSize) {
      const g = clone(pick(chosen).genome);
      for (let k = 0; k < 3; k++) mutate(g);
      repair(g, 10);
      founded.push(evaluate(g));
    }
    return founded;
  };
  let population = founders(false);

  const fittest = () => population.reduce((x, y) => (better(y.fitness, x.fitness) ? y : x));
  /** The best layout found; while exploring the population may wander away from it. */
  let best = fittest();
  const positionsOf = (individual: Individual) => {
    const result: Record<string, Position> = {};
    for (const i of moving)
      result[ids[i]] = { x: Math.round(individual.genome[i].x), y: Math.round(individual.genome[i].y) };
    return result;
  };
  let generation = 0;
  let exploring = explore > 0;
  let shown: Fitness | null = null;
  let shownAt = -Infinity;
  const report = (force = false) => {
    if (!onProgress) return;
    const leader = exploring ? fittest() : best;
    // While refining, only improvements.
    if (!exploring && shown && !better(leader.fitness, shown)) return;
    if (!force && performance.now() - shownAt < progressMs) return;
    shown = leader.fitness;
    shownAt = performance.now();
    onProgress(positionsOf(leader), {
      generation,
      score: leader.fitness.score,
      exploring,
      best: positionsOf(best),
      bestScore: best.fitness.score,
    });
  };
  report(true);

  // ---- Evolution: tournament selection, the two best always survive.
  const tournament = () => {
    let winner = pick(population);
    for (let k = 1; k < 3; k++) {
      const other = pick(population);
      if (better(other.fitness, winner.fitness)) winner = other;
    }
    return winner;
  };
  let lastYield = performance.now();
  /** Lets the page breathe. */
  const breathe = async () => {
    if (performance.now() - lastYield < 30) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
    lastYield = performance.now();
  };
  /** Generations since the population's best improved. */
  let stale = 0;
  let leading = best.fitness;
  /** The best of each valley explored. */
  const champions: Individual[] = [];
  while (running()) {
    if (exploring && (performance.now() >= exploreUntil || best.fitness.score === 0)) {
      // Done exploring: refine the best found.
      exploring = false;
      population.push(...(champions.length ? champions : [best]));
      shown = null;
      stale = 0;
    } else if (exploring && stale >= PATIENCE) {
      // Stuck in a valley: keep its best, start over.
      champions.push(fittest());
      population = founders(true);
      await breathe();
      leading = fittest().fitness;
      stale = 0;
    }
    population.sort((a, b) => (better(a.fitness, b.fitness) ? -1 : better(b.fitness, a.fitness) ? 1 : 0));
    const next = population.slice(0, 2);
    // The best one gets extra repair.
    const polished = clone(next[0].genome);
    repair(polished, 30);
    let spread = evaluate(polished);
    // Spreading it out moves edges away from nodes without adding crossings.
    for (const [sx, sy] of [
      [1.15, 1],
      [1, 1.15],
      [1.15, 1.15],
      [0.9, 0.9],
    ]) {
      const g = clone(spread.genome);
      scale(g, sx, sy);
      const stretched = evaluate(g);
      if (better(stretched.fitness, spread.fitness)) spread = stretched;
    }
    next.push(spread);
    while (next.length < populationSize && running()) {
      const a = tournament();
      const child = random() < crossoverRate ? crossover(a.genome, tournament().genome) : clone(a.genome);
      // Between none and twice the average.
      const mutations = Math.floor(random() * (2 * mutationRate + 1));
      for (let k = 0; k < mutations; k++) mutate(child);
      repair(child, repairSteps);
      next.push(evaluate(child));
      await breathe();
    }
    population = next;
    generation++;
    const leader = fittest();
    if (better(leader.fitness, best.fitness)) best = leader;
    // Shaving off fractions (an edge a little further from a node) isn't getting out of the valley.
    if (leader.fitness.score < leading.score - 0.5) {
      leading = leader.fitness;
      stale = 0;
    } else stale++;
    report();
    // Nothing left to fix and the shape stopped improving.
    if (!exploring && best.fitness.score === 0 && stale > 20) break;
  }

  return positionsOf(best);
}
