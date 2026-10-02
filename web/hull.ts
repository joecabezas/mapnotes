import type { Position } from '../shared/model';

export interface Box {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** The outline of a cluster: a polygon, as Cytoscape's `polygon` shape wants it. */
export interface HullShape {
  /** Centre of the polygon's bounding box, where the cluster node goes. */
  center: Position;
  width: number;
  height: number;
  /** Corner points relative to the box, from -1 to 1 on both axes, as "x1 y1 x2 y2 …". */
  points: string;
}

/** Points per rounded corner of each member box. */
const ARC_STEPS = 4;
/** Gap kept between a zone's outline and the nodes that aren't in it. */
const OBSTACLE_MARGIN = 8;
/** How far the zone may wander around other nodes to join its members. */
const DETOUR = 90;
/** The zone grid has at most about this many points per side. */
const GRID_MAX = 90;
const GRID_MIN_CELL = 5;
/** Stepping next to (or onto) another node costs this much more than open space. */
const BLOCKED_COST = 60;

const cross = (o: Position, a: Position, b: Position) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

/** Convex hull (Andrew's monotone chain), counter-clockwise without repeated or collinear points. */
export function convexHull(points: Position[]): Position[] {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length < 3) return pts;
  const half = (list: Position[]) => {
    const out: Position[] = [];
    for (const p of list) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop();
      out.push(p);
    }
    out.pop();
    return out;
  };
  return [...half(pts), ...half(pts.reverse())];
}

function toShape(outline: Position[]): HullShape {
  const xs = outline.map((p) => p.x);
  const ys = outline.map((p) => p.y);
  const x1 = Math.min(...xs);
  const y1 = Math.min(...ys);
  const width = Math.max(Math.max(...xs) - x1, 1);
  const height = Math.max(Math.max(...ys) - y1, 1);
  const center = { x: x1 + width / 2, y: y1 + height / 2 };
  const rel = (v: number, c: number, size: number) => Math.round(((v - c) / (size / 2)) * 1e4) / 1e4;
  const points: string[] = [];
  let last = '';
  for (const p of outline) {
    const pair = `${rel(p.x, center.x, width)} ${rel(p.y, center.y, height)}`;
    // Repeated points would break Cytoscape's hit testing (a zero-length side has no direction).
    if (pair !== last) points.push(pair);
    last = pair;
  }
  if (points.length > 1 && points[0] === points[points.length - 1]) points.pop();
  return { center, width, height, points: points.join(' ') };
}

function convexOutline(boxes: Box[], pad: number): Position[] {
  const points: Position[] = [];
  for (const b of boxes) {
    const corners = [
      { x: b.x2, y: b.y2, from: 0 },
      { x: b.x1, y: b.y2, from: Math.PI / 2 },
      { x: b.x1, y: b.y1, from: Math.PI },
      { x: b.x2, y: b.y1, from: (3 * Math.PI) / 2 },
    ];
    for (const c of corners) {
      for (let i = 0; i <= ARC_STEPS; i++) {
        const a = c.from + (i / ARC_STEPS) * (Math.PI / 2);
        points.push({ x: c.x + pad * Math.cos(a), y: c.y + pad * Math.sin(a) });
      }
    }
  }
  return convexHull(points);
}

/**
 * A rounded convex outline around the given boxes, `pad` away from them: the hull of every box
 * with its corners rounded by `pad`.
 */
export function hullAround(boxes: Box[], pad: number): HullShape | null {
  return boxes.length ? toShape(convexOutline(boxes, pad)) : null;
}

const grow = (b: Box, by: number): Box => ({ x1: b.x1 - by, y1: b.y1 - by, x2: b.x2 + by, y2: b.y2 + by });
const overlaps = (a: Box, b: Box) => a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2;

function boxDistance(b: Box, x: number, y: number): number {
  const dx = Math.max(b.x1 - x, 0, x - b.x2);
  const dy = Math.max(b.y1 - y, 0, y - b.y2);
  return Math.hypot(dx, dy);
}

function segmentDistance(a: Position, b: Position, x: number, y: number): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / len)) : 0;
  return Math.hypot(a.x + t * dx - x, a.y + t * dy - y);
}

/** Even-odd test, as Cytoscape does it. */
export function insidePolygon(poly: Position[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Whether a segment crosses a box (Liang–Barsky clipping). */
function segmentHitsBox(a: Position, b: Position, box: Box): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const clip = (p: number, q: number) => {
    if (p === 0) return q >= 0;
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
    return true;
  };
  return clip(-dx, a.x - box.x1) && clip(dx, box.x2 - a.x) && clip(-dy, a.y - box.y1) && clip(dy, box.y2 - a.y);
}

function polygonHitsBox(poly: Position[], box: Box): boolean {
  if (insidePolygon(poly, (box.x1 + box.x2) / 2, (box.y1 + box.y2) / 2)) return true;
  return poly.some((p, i) => segmentHitsBox(p, poly[(i + 1) % poly.length], box));
}

/** Ramer–Douglas–Peucker: drops points closer than `eps` to the line through their neighbours. */
function simplify(points: Position[], eps: number): Position[] {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [from, to] = stack.pop()!;
    let worst = -1;
    let worstD = eps;
    for (let i = from + 1; i < to; i++) {
      const d = segmentDistance(points[from], points[to], points[i].x, points[i].y);
      if (d > worstD) {
        worst = i;
        worstD = d;
      }
    }
    if (worst > 0) {
      keep[worst] = 1;
      stack.push([from, worst], [worst, to]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/** A min-heap of grid indices by cost. */
class Heap {
  private items: number[] = [];
  constructor(private cost: Float64Array) {}
  get size() {
    return this.items.length;
  }
  push(i: number) {
    const a = this.items;
    a.push(i);
    let c = a.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (this.cost[a[p]] <= this.cost[a[c]]) break;
      [a[p], a[c]] = [a[c], a[p]];
      c = p;
    }
  }
  pop(): number {
    const a = this.items;
    const top = a[0];
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let p = 0;
      for (;;) {
        const l = 2 * p + 1;
        const r = l + 1;
        let m = p;
        if (l < a.length && this.cost[a[l]] < this.cost[a[m]]) m = l;
        if (r < a.length && this.cost[a[r]] < this.cost[a[m]]) m = r;
        if (m === p) break;
        [a[p], a[m]] = [a[m], a[p]];
        p = m;
      }
    }
    return top;
  }
}

/**
 * A zone around `members` that keeps out of `obstacles` (the other nodes): a padded blob per
 * member, joined by narrow bridges routed around the obstacles, traced on a grid with marching
 * squares. Obstacles the members surround become holes. Returns null when that fails.
 */
function concaveOutline(members: Box[], obstacles: Box[], pad: number): Position[] | null {
  const bounds = grow(
    members.reduce((a, b) => ({ x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1), x2: Math.max(a.x2, b.x2), y2: Math.max(a.y2, b.y2) })),
    pad + DETOUR,
  );
  const cell = Math.max(GRID_MIN_CELL, Math.max(bounds.x2 - bounds.x1, bounds.y2 - bounds.y1) / GRID_MAX);
  // Bridges, and the thin core of each that obstacles never clip, must be wide enough for the grid to see.
  const core = Math.max(4, cell * 0.75);
  const tube = Math.max(6, pad * 0.6, core);
  const cols = Math.ceil((bounds.x2 - bounds.x1) / cell) + 1;
  const rows = Math.ceil((bounds.y2 - bounds.y1) / cell) + 1;
  const n = cols * rows;
  const px = (i: number) => bounds.x1 + (i % cols) * cell;
  const py = (i: number) => bounds.y1 + Math.floor(i / cols) * cell;
  const onBorder = (i: number) => {
    const c = i % cols;
    const r = Math.floor(i / cols);
    return c < 2 || r < 2 || c >= cols - 2 || r >= rows - 2;
  };

  /** Calls `fn` for the grid points within `reach` of a box. */
  const aroundBox = (b: Box, reach: number, fn: (i: number, d: number) => void) => {
    const c1 = Math.max(0, Math.floor((b.x1 - reach - bounds.x1) / cell));
    const c2 = Math.min(cols - 1, Math.ceil((b.x2 + reach - bounds.x1) / cell));
    const r1 = Math.max(0, Math.floor((b.y1 - reach - bounds.y1) / cell));
    const r2 = Math.min(rows - 1, Math.ceil((b.y2 + reach - bounds.y1) / cell));
    for (let r = r1; r <= r2; r++) {
      for (let c = c1; c <= c2; c++) {
        const i = r * cols + c;
        const d = boxDistance(b, px(i), py(i));
        if (d <= reach) fn(i, d);
      }
    }
  };
  // Distance from each grid point to the nearest member and the nearest obstacle, as far as they
  // matter (beyond that the zone is out, or the way is clear).
  const reach = Math.max(pad, tube) + OBSTACLE_MARGIN + cell;
  const dMember = new Float64Array(n).fill(Infinity);
  const dObstacle = new Float64Array(n).fill(Infinity);
  for (const b of members) aroundBox(b, reach, (i, d) => void (dMember[i] = Math.min(dMember[i], d)));
  for (const b of obstacles) aroundBox(b, reach, (i, d) => void (dObstacle[i] = Math.min(dObstacle[i], d)));

  // Join the members along a minimum spanning tree (by the gaps between their boxes); each link is
  // the cheapest path between the two, going around obstacles when it can (A*).
  const gap = (a: Box, b: Box) => Math.hypot(Math.max(a.x1 - b.x2, b.x1 - a.x2, 0), Math.max(a.y1 - b.y2, b.y1 - a.y2, 0));
  const tree: [number, number][] = [];
  {
    const best = members.map((b) => gap(members[0], b));
    const via = members.map(() => 0);
    const inTree = members.map((_, m) => m === 0);
    for (let added = 1; added < members.length; added++) {
      let next = -1;
      for (let m = 0; m < members.length; m++) if (!inTree[m] && (next < 0 || best[m] < best[next])) next = m;
      inTree[next] = true;
      tree.push([via[next], next]);
      for (let m = 0; m < members.length; m++) {
        const d = gap(members[next], members[m]);
        if (!inTree[m] && d < best[m]) {
          best[m] = d;
          via[m] = next;
        }
      }
    }
  }
  const bridges: { path: Position[]; forced: boolean; box: Box }[] = [];
  const cost = new Float64Array(n).fill(Infinity);
  const from = new Int32Array(n).fill(-1);
  const neighbours = [-1, 1, -cols, cols, -cols - 1, -cols + 1, cols - 1, cols + 1];
  const stepLength = [1, 1, 1, 1, Math.SQRT2, Math.SQRT2, Math.SQRT2, Math.SQRT2];
  const blocked = (i: number) => dObstacle[i] < OBSTACLE_MARGIN + tube;
  for (const [a, b] of tree) {
    const target = members[b];
    const estimate = new Float64Array(n);
    const heap = new Heap(estimate);
    const touched: number[] = [];
    aroundBox(members[a], pad, (i) => {
      if (!onBorder(i)) {
        cost[i] = 0;
        estimate[i] = Math.max(0, boxDistance(target, px(i), py(i)) - pad) / cell;
        touched.push(i);
        heap.push(i);
      }
    });
    let reached = -1;
    while (heap.size) {
      const i = heap.pop();
      if (boxDistance(target, px(i), py(i)) <= pad) {
        reached = i;
        break;
      }
      for (let k = 0; k < 8; k++) {
        const j = i + neighbours[k];
        if (j < 0 || j >= n || onBorder(j) || Math.abs((j % cols) - (i % cols)) > 1) continue;
        const c = cost[i] + stepLength[k] * (blocked(j) ? BLOCKED_COST : 1);
        if (c < cost[j]) {
          if (cost[j] === Infinity) touched.push(j);
          cost[j] = c;
          from[j] = i;
          estimate[j] = c + Math.max(0, boxDistance(target, px(j), py(j)) - pad) / cell;
          heap.push(j);
        }
      }
    }
    if (reached < 0) return null;
    // From inside one member box to inside the other, so nothing comes between a bridge and its ends.
    const centre = (m: Box) => ({ x: (m.x1 + m.x2) / 2, y: (m.y1 + m.y2) / 2 });
    const path: Position[] = [centre(target)];
    let forced = false;
    for (let i = reached; i >= 0; i = from[i]) {
      path.push({ x: px(i), y: py(i) });
      forced ||= blocked(i) && dMember[i] > pad;
    }
    path.push(centre(members[a]));
    for (const i of touched) {
      cost[i] = Infinity;
      from[i] = -1;
    }
    const simple = simplify(path, cell * 0.75);
    const xs = simple.map((p) => p.x);
    const ys = simple.map((p) => p.y);
    const box = grow({ x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) }, tube + 2 * cell);
    bridges.push({ path: simple, forced, box });
  }

  // The zone is where `value` > 0: near a member or a bridge, and clear of obstacles. Member boxes
  // and a thin core along every bridge are always in, so no member is cut off; a bridge that had no
  // way around an obstacle crosses it at full width.
  const value = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const x = px(i);
    const y = py(i);
    let open = pad - dMember[i];
    let kept = Math.min(4, pad / 4) - dMember[i];
    for (const b of bridges) {
      if (x < b.box.x1 || x > b.box.x2 || y < b.box.y1 || y > b.box.y2) continue;
      for (let k = 1; k < b.path.length; k++) {
        const d = segmentDistance(b.path[k - 1], b.path[k], x, y);
        open = Math.max(open, tube - d);
        kept = Math.max(kept, (b.forced ? tube : core) - d);
      }
    }
    // Floored, so the outline between a point and its neighbours can always be interpolated.
    value[i] = Math.max(Math.min(open, dObstacle[i] - OBSTACLE_MARGIN), kept, -reach);
    if (onBorder(i)) value[i] = Math.min(value[i], -1);
  }

  // Marching squares: the outline where `value` crosses 0, linked into loops.
  const edgePoint = new Map<number, Position>();
  const links = new Map<number, number[]>();
  // Edge keys: 2 * point index for the edge to the right, + 1 for the edge below.
  const crossing = (a: number, b: number, key: number) => {
    if (!edgePoint.has(key)) {
      const t = value[a] / (value[a] - value[b]);
      edgePoint.set(key, { x: px(a) + (px(b) - px(a)) * t, y: py(a) + (py(b) - py(a)) * t });
    }
    return key;
  };
  const link = (k1: number, k2: number) => {
    links.set(k1, [...(links.get(k1) ?? []), k2]);
    links.set(k2, [...(links.get(k2) ?? []), k1]);
  };
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c;
      const b = a + 1;
      const d = a + cols;
      const e = d + 1;
      const inA = value[a] > 0;
      const inB = value[b] > 0;
      const inC = value[e] > 0;
      const inD = value[d] > 0;
      const sides: number[] = [];
      if (inA !== inB) sides.push(crossing(a, b, 2 * a)); // top
      if (inB !== inC) sides.push(crossing(b, e, 2 * b + 1)); // right
      if (inD !== inC) sides.push(crossing(d, e, 2 * d)); // bottom
      if (inA !== inD) sides.push(crossing(a, d, 2 * a + 1)); // left
      if (sides.length === 2) link(sides[0], sides[1]);
      else if (sides.length === 4) {
        const [top, right, bottom, left] = sides;
        const centreIn = value[a] + value[b] + value[d] + value[e] > 0;
        // Saddle: the centre decides which diagonal pair of corners is connected.
        if (inA === centreIn) {
          link(top, right);
          link(bottom, left);
        } else {
          link(left, top);
          link(right, bottom);
        }
      }
    }
  }
  const seen = new Set<number>();
  const loops: { points: Position[]; area: number }[] = [];
  for (const start of links.keys()) {
    if (seen.has(start)) continue;
    const loop: Position[] = [];
    let prevKey = -1;
    let key = start;
    while (!seen.has(key)) {
      seen.add(key);
      loop.push(edgePoint.get(key)!);
      const next = links.get(key)!.find((k) => k !== prevKey && !seen.has(k));
      if (next === undefined) break;
      prevKey = key;
      key = next;
    }
    const points = simplify([...loop, loop[0]], 0.6).slice(0, -1);
    if (points.length >= 3) loops.push({ points, area: signedArea(points) });
  }
  if (!loops.length) return null;
  loops.sort((a, b) => Math.abs(b.area) - Math.abs(a.area));
  const [outer, ...rest] = loops;
  // Holes (obstacles the zone surrounds) go the other way round from the outline, so they stay
  // unfilled, and are joined to it by a slit, so the zone stays one polygon.
  let outline = outer.points;
  for (const hole of rest) {
    if (!insidePolygon(outer.points, hole.points[0].x, hole.points[0].y)) continue;
    const ring = Math.sign(hole.area) === Math.sign(outer.area) ? [...hole.points].reverse() : hole.points;
    let bi = 0;
    let bj = 0;
    let bd = Infinity;
    outline.forEach((p, i) =>
      ring.forEach((q, j) => {
        const d = (p.x - q.x) ** 2 + (p.y - q.y) ** 2;
        if (d < bd) {
          bd = d;
          bi = i;
          bj = j;
        }
      }),
    );
    outline = [
      ...outline.slice(0, bi + 1),
      ...ring.slice(bj),
      ...ring.slice(0, bj + 1),
      ...outline.slice(bi),
    ];
  }
  // Every member must be in the outline (one would be cut off if the zone came apart).
  const centred = members.every((m) => insidePolygon(outline, (m.x1 + m.x2) / 2, (m.y1 + m.y2) / 2));
  return centred ? outline : null;
}

function signedArea(points: Position[]): number {
  let area = 0;
  for (let i = 0; i < points.length; i++) area += cross({ x: 0, y: 0 }, points[i], points[(i + 1) % points.length]);
  return area / 2;
}

/**
 * The outline of a cluster around `members` (padded by `pad`) that leaves out every `obstacle`
 * (the nodes that aren't members): the rounded convex hull when no obstacle is in it, otherwise a
 * concave zone that bends around them.
 */
export function zoneAround(members: Box[], obstacles: Box[], pad: number): HullShape | null {
  if (!members.length) return null;
  const convex = convexOutline(members, pad);
  const nearby = obstacles.filter((o) => polygonHitsBox(convex, grow(o, OBSTACLE_MARGIN)));
  if (!nearby.length) return toShape(convex);
  const area = grow(
    members.reduce((a, b) => ({ x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1), x2: Math.max(a.x2, b.x2), y2: Math.max(a.y2, b.y2) })),
    pad + DETOUR + OBSTACLE_MARGIN,
  );
  const concave = concaveOutline(members, obstacles.filter((o) => overlaps(o, area)), pad);
  return toShape(concave ?? convex);
}
