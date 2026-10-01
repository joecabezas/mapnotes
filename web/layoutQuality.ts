import type { Position } from '../shared/model';

/** How far a node's visible box (shape + label) reaches from its position, in each direction. */
export interface Extent {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface QualityEdge {
  source: string;
  target: string;
}

/** What a layout gets wrong, as drawn on the canvas (edges are straight lines between node centres). */
export interface LayoutQuality {
  /** Pairs of edges that cross each other (edges sharing a node never count). */
  crossings: number;
  /** Edges drawn through a node other than their own ends. */
  edgesThroughNodes: number;
  /** Pairs of nodes whose boxes overlap. */
  overlaps: number;
}

/** One number to compare layouts by; lower is better. Overlaps and edges hidden under nodes read worse than crossings. */
export function qualityScore(q: LayoutQuality): number {
  return q.crossings + 2 * q.edgesThroughNodes + 3 * q.overlaps;
}

/**
 * A straight edge between two nodes in the same row would run through every node in between, so
 * the canvas bends such edges into an arc above the row (see GraphCanvas). Arced edges never count
 * as running through nodes.
 */
export const ARC_MAX_DY = 30;
export const ARC_MIN_DX = 100;
export const isArced = (a: Position, b: Position) => Math.abs(b.y - a.y) < ARC_MAX_DY && Math.abs(b.x - a.x) > ARC_MIN_DX;

/** Box edges are pulled in by this much before testing, so lines that only graze a node don't count. */
const SLACK = 4;

type Segment = { a: Position; b: Position; source: string; target: string };

function cross(o: Position, a: Position, b: Position): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

/** True when the segments cross at a single point inside both (touching or collinear overlap doesn't count). */
export function segmentsCross(p1: Position, p2: Position, q1: Position, q2: Position): boolean {
  const d1 = cross(q1, q2, p1);
  const d2 = cross(q1, q2, p2);
  const d3 = cross(p1, p2, q1);
  const d4 = cross(p1, p2, q2);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** True when the segment passes through the inside of the box (Liang–Barsky clipping). */
export function segmentHitsBox(a: Position, b: Position, box: { x1: number; x2: number; y1: number; y2: number }): boolean {
  if (box.x1 >= box.x2 || box.y1 >= box.y2) return false;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let t0 = 0;
  let t1 = 1;
  const clip = (p: number, q: number) => {
    if (p === 0) return q > 0;
    const t = q / p;
    if (p < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
    return true;
  };
  return (
    clip(-dx, a.x - box.x1) && clip(dx, box.x2 - a.x) && clip(-dy, a.y - box.y1) && clip(dy, box.y2 - a.y) && t0 < t1
  );
}

/**
 * Measures `positions` against `edges`. Nodes without a position are skipped, as are
 * self-loops and edges whose ends sit on the same spot.
 */
export function measureLayout(
  positions: Record<string, Position>,
  extents: Record<string, Extent>,
  edges: QualityEdge[],
): LayoutQuality {
  const segments: Segment[] = [];
  for (const e of edges) {
    const a = positions[e.source];
    const b = positions[e.target];
    if (!a || !b || e.source === e.target || (a.x === b.x && a.y === b.y)) continue;
    segments.push({ a, b, source: e.source, target: e.target });
  }

  let crossings = 0;
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    for (let j = i + 1; j < segments.length; j++) {
      const t = segments[j];
      if (s.source === t.source || s.source === t.target || s.target === t.source || s.target === t.target) continue;
      if (segmentsCross(s.a, s.b, t.a, t.b)) crossings++;
    }
  }

  const boxes: { id: string; x1: number; x2: number; y1: number; y2: number }[] = [];
  for (const [id, p] of Object.entries(positions)) {
    const ext = extents[id] ?? { left: 0, right: 0, top: 0, bottom: 0 };
    boxes.push({ id, x1: p.x - ext.left, x2: p.x + ext.right, y1: p.y - ext.top, y2: p.y + ext.bottom });
  }

  let edgesThroughNodes = 0;
  for (const s of segments) {
    if (isArced(s.a, s.b)) continue;
    const hit = boxes.some(
      (box) =>
        box.id !== s.source &&
        box.id !== s.target &&
        segmentHitsBox(s.a, s.b, { x1: box.x1 + SLACK, x2: box.x2 - SLACK, y1: box.y1 + SLACK, y2: box.y2 - SLACK }),
    );
    if (hit) edgesThroughNodes++;
  }

  let overlaps = 0;
  for (let i = 0; i < boxes.length; i++) {
    const a = boxes[i];
    for (let j = i + 1; j < boxes.length; j++) {
      const b = boxes[j];
      if (a.x1 + SLACK < b.x2 && b.x1 + SLACK < a.x2 && a.y1 + SLACK < b.y2 && b.y1 + SLACK < a.y2) overlaps++;
    }
  }

  return { crossings, edgesThroughNodes, overlaps };
}

/**
 * Improves a layered layout as it is actually drawn: layered algorithms count crossings of edges
 * routed with bends, but the canvas draws edges straight, so long edges cross more than planned.
 * Nodes in the same layer (overlapping along the other axis) swap places, along `axis`, whenever
 * that lowers the crossings, edges through nodes and overlaps around them. Only `movable` nodes
 * move; stops after `budgetMs`. Returns new positions for the nodes that moved.
 */
export function refineLayers(
  positions: Record<string, Position>,
  extents: Record<string, Extent>,
  edges: QualityEdge[],
  movable: Iterable<string>,
  axis: 'x' | 'y',
  budgetMs = 250,
): Record<string, Position> {
  const deadline = Date.now() + budgetMs;
  const pos: Record<string, Position> = {};
  for (const [id, p] of Object.entries(positions)) pos[id] = { ...p };
  const ext = (id: string) => extents[id] ?? { left: 0, right: 0, top: 0, bottom: 0 };
  const boxOf = (id: string) => {
    const p = pos[id];
    const e = ext(id);
    return { x1: p.x - e.left + SLACK, x2: p.x + e.right - SLACK, y1: p.y - e.top + SLACK, y2: p.y + e.bottom - SLACK };
  };
  const live = edges.filter((e) => e.source !== e.target && pos[e.source] && pos[e.target]);
  const incident = new Map<string, number[]>();
  live.forEach((e, i) => {
    for (const id of [e.source, e.target]) incident.set(id, [...(incident.get(id) ?? []), i]);
  });
  const ids = Object.keys(pos);

  const hits = (e: QualityEdge, id: string) =>
    id !== e.source && id !== e.target && !isArced(pos[e.source], pos[e.target]) && segmentHitsBox(pos[e.source], pos[e.target], boxOf(id));

  /**
   * The part of the score that changes when `moved` move (scored like qualityScore), so comparing it
   * before and after a move compares the whole layout.
   */
  const local = (moved: string[]): number => {
    const inc = new Set(moved.flatMap((id) => incident.get(id) ?? []));
    let score = 0;
    for (const i of inc) {
      const e = live[i];
      const a = pos[e.source];
      const b = pos[e.target];
      for (let j = 0; j < live.length; j++) {
        if (inc.has(j) && j <= i) continue;
        const f = live[j];
        if (e.source === f.source || e.source === f.target || e.target === f.source || e.target === f.target) continue;
        if (segmentsCross(a, b, pos[f.source], pos[f.target])) score += 1;
      }
      if (ids.some((id) => hits(e, id))) score += 2;
    }
    // Other edges count as running through a node only if the moved nodes are the only ones in their way.
    for (let j = 0; j < live.length; j++) {
      if (inc.has(j)) continue;
      const f = live[j];
      if (moved.some((id) => hits(f, id)) && !ids.some((id) => !moved.includes(id) && hits(f, id))) score += 2;
    }
    moved.forEach((id, k) => {
      const a = boxOf(id);
      for (const other of ids) {
        // Each overlapping pair once, also when both nodes moved.
        if (other === id || moved.indexOf(other) >= k) continue;
        const b = boxOf(other);
        if (a.x1 < b.x2 + SLACK && b.x1 < a.x2 + SLACK && a.y1 < b.y2 + SLACK && b.y1 < a.y2 + SLACK) score += 3;
      }
    });
    return score;
  };

  // Layers: nodes whose boxes overlap the first one's across `axis`.
  const across = axis === 'x' ? 'y' : 'x';
  const lo = (id: string) => (across === 'y' ? pos[id].y - ext(id).top : pos[id].x - ext(id).left);
  const hi = (id: string) => (across === 'y' ? pos[id].y + ext(id).bottom : pos[id].x + ext(id).right);
  const layers: string[][] = [];
  let end = -Infinity;
  for (const id of [...movable].filter((id) => pos[id]).sort((a, b) => lo(a) - lo(b))) {
    // Compared with the layer's first node only, so neighbouring layers can't chain together.
    if (layers.length && lo(id) < end) layers[layers.length - 1].push(id);
    else {
      layers.push([id]);
      end = hi(id);
    }
  }

  // Swapping two nodes swaps the centres of their boxes along `axis`.
  const centre = (id: string) => (axis === 'x' ? pos[id].x + (ext(id).right - ext(id).left) / 2 : pos[id].y + (ext(id).bottom - ext(id).top) / 2);
  const placeAt = (id: string, c: number) => {
    if (axis === 'x') pos[id].x = c - (ext(id).right - ext(id).left) / 2;
    else pos[id].y = c - (ext(id).bottom - ext(id).top) / 2;
  };
  const swap = (u: string, v: string) => {
    const cu = centre(u);
    placeAt(u, centre(v));
    placeAt(v, cu);
  };

  for (let improved = true; improved && Date.now() < deadline; ) {
    improved = false;
    for (const layer of layers) {
      for (let i = 0; i < layer.length; i++) {
        for (let j = i + 1; j < layer.length; j++) {
          if (Date.now() >= deadline) break;
          const pair = [layer[i], layer[j]];
          const before = local(pair);
          swap(layer[i], layer[j]);
          if (local(pair) < before) improved = true;
          else swap(layer[i], layer[j]);
        }
      }
    }
  }

  const moved: Record<string, Position> = {};
  for (const id of movable) {
    if (pos[id] && (pos[id].x !== positions[id].x || pos[id].y !== positions[id].y)) moved[id] = pos[id];
  }
  return moved;
}
