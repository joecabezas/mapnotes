import cytoscape from 'cytoscape';
import { describe, expect, it } from 'vitest';
import { computeLayout } from '../web/layout.ts';
import {
  measureLayout,
  refineLayers,
  segmentBoxDistance,
  segmentHitsBox,
  segmentsCross,
} from '../web/layoutQuality.ts';

const box = (w = 20, h = 20) => ({ left: w / 2, right: w / 2, top: h / 2, bottom: h / 2 });

describe('segmentsCross', () => {
  it('counts a proper crossing only', () => {
    expect(segmentsCross({ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 })).toBe(true);
    expect(segmentsCross({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 5 }, { x: 10, y: 5 })).toBe(false);
    // Touching at an end, or lying on the same line, isn't a crossing.
    expect(segmentsCross({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 })).toBe(false);
    expect(segmentsCross({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 0 }, { x: 15, y: 0 })).toBe(false);
  });
});

describe('segmentHitsBox', () => {
  const b = { x1: 0, x2: 10, y1: 0, y2: 10 };
  it('detects lines through, into and past a box', () => {
    expect(segmentHitsBox({ x: -5, y: 5 }, { x: 15, y: 5 }, b)).toBe(true);
    expect(segmentHitsBox({ x: 5, y: 5 }, { x: 50, y: 50 }, b)).toBe(true);
    expect(segmentHitsBox({ x: -5, y: 20 }, { x: 15, y: 20 }, b)).toBe(false);
    expect(segmentHitsBox({ x: -5, y: 5 }, { x: -1, y: 5 }, b)).toBe(false);
  });
});

describe('segmentBoxDistance', () => {
  const b = { x1: 0, x2: 10, y1: 0, y2: 10 };
  it('measures to the nearest side or corner', () => {
    expect(segmentBoxDistance({ x: -5, y: 20 }, { x: 15, y: 20 }, b)).toBe(10);
    expect(segmentBoxDistance({ x: 13, y: -10 }, { x: 13, y: 30 }, b)).toBe(3);
    expect(segmentBoxDistance({ x: 20, y: 10 }, { x: 10, y: 20 }, b)).toBeCloseTo(Math.SQRT2 * 5);
    expect(segmentBoxDistance({ x: -5, y: 5 }, { x: 15, y: 5 }, b)).toBe(0);
    // Far away: capped at the limit.
    expect(segmentBoxDistance({ x: 500, y: 500 }, { x: 600, y: 500 }, b, 24)).toBe(24);
  });
});

describe('measureLayout', () => {
  it('counts crossings, edges through or near nodes and overlapping nodes', () => {
    // a-b and c-d cross in an X; e sits on the a-b line, 15 from a-c and ~21 from c-d; f overlaps g.
    const positions = {
      a: { x: 0, y: 0 },
      b: { x: 100, y: 100 },
      c: { x: 0, y: 100 },
      d: { x: 100, y: 0 },
      e: { x: 25, y: 25 },
      f: { x: 300, y: 300 },
      g: { x: 305, y: 305 },
    };
    const extents = Object.fromEntries(Object.keys(positions).map((id) => [id, box()]));
    const q = measureLayout(positions, extents, [
      { source: 'a', target: 'b' },
      { source: 'c', target: 'd' },
      { source: 'a', target: 'c' }, // shares a node with both: never a crossing
      { source: 'f', target: 'f' }, // self-loop: ignored
    ]);
    expect(q).toMatchObject({ crossings: 1, edgesThroughNodes: 1, overlaps: 1, nearEdges: 2 });
    // 15 and ~21 away of 24.
    expect(q.nearness).toBeCloseTo(9 / 24 + (1 - 30 / Math.SQRT2 / 24));
  });

  it('counts edges passing closer than the clearance', () => {
    // Vertical: a long level edge would be drawn as an arc, which isn't measured.
    const positions = { a: { x: 0, y: 0 }, b: { x: 0, y: 300 }, c: { x: 30, y: 150 } };
    const extents = Object.fromEntries(Object.keys(positions).map((id) => [id, box()]));
    const edges = [{ source: 'a', target: 'b' }];
    // c's box starts 20 right of the edge.
    expect(measureLayout(positions, extents, edges).nearEdges).toBe(1);
    expect(measureLayout(positions, extents, edges, 10).nearEdges).toBe(0);
    expect(measureLayout(positions, extents, edges, 0).nearEdges).toBe(0);
  });
});

describe('refineLayers', () => {
  // Two layers; each parent's edges go to the far children, so all four edges cross.
  const positions = {
    p: { x: 0, y: 0 },
    q: { x: 200, y: 0 },
    a: { x: 0, y: 100 },
    b: { x: 100, y: 100 },
    c: { x: 200, y: 100 },
    d: { x: 300, y: 100 },
  };
  const extents = Object.fromEntries(Object.keys(positions).map((id) => [id, box(40, 20)]));
  const edges = [
    { source: 'p', target: 'c' },
    { source: 'p', target: 'd' },
    { source: 'q', target: 'a' },
    { source: 'q', target: 'b' },
  ];

  it('swaps nodes within a layer to remove crossings', () => {
    const moved = refineLayers(positions, extents, edges, Object.keys(positions), 'x');
    expect(measureLayout(positions, extents, edges).crossings).toBe(4);
    expect(measureLayout({ ...positions, ...moved }, extents, edges)).toEqual({ crossings: 0, edgesThroughNodes: 0, overlaps: 0, nearEdges: 0, nearness: 0 });
    // Nodes only move along their layer.
    for (const [id, p] of Object.entries(moved)) expect(p.y).toBe(positions[id as keyof typeof positions].y);
  });

  it('leaves nodes that may not move alone', () => {
    const moved = refineLayers(positions, extents, edges, ['a', 'b', 'c', 'd'], 'x');
    expect(Object.keys(moved).every((id) => ['a', 'b', 'c', 'd'].includes(id))).toBe(true);
    expect(measureLayout({ ...positions, ...moved }, extents, edges).crossings).toBe(0);
  });
});

/** A headless canvas: nodes are `n:<id>` boxes with `refId` data, like GraphCanvas makes them. */
function canvas(nodes: Record<string, [number, number]>, edges: [string, string][]) {
  const cy = cytoscape({ headless: true, styleEnabled: true, style: [{ selector: 'node', style: { width: 40, height: 30 } }] });
  cy.add([
    ...Object.entries(nodes).map(([id, [x, y]]) => ({ group: 'nodes' as const, data: { id: `n:${id}`, refId: id }, position: { x, y } })),
    ...edges.map(([s, t], i) => ({ group: 'edges' as const, data: { id: `e:${i}`, source: `n:${s}`, target: `n:${t}` } })),
  ]);
  return cy;
}

describe('computeLayout', () => {
  // Two parents with two children each, drawn so every edge to the far child crosses.
  const tangled = () =>
    canvas(
      { p: [0, 0], q: [400, 0], a: [0, 200], b: [130, 200], c: [270, 200], d: [400, 200] },
      [
        ['p', 'a'],
        ['p', 'd'],
        ['q', 'b'],
        ['q', 'c'],
      ],
    );

  it('untangles the graph', async () => {
    const cy = tangled();
    const result = await computeLayout(cy, cy.nodes(), 'auto');
    expect(result.before.crossings).toBeGreaterThan(0);
    expect(result.after).toEqual({ crossings: 0, edgesThroughNodes: 0, overlaps: 0, nearEdges: 0, nearness: 0 });
    expect(Object.keys(result.positions).sort()).toEqual(['a', 'b', 'c', 'd', 'p', 'q']);
  });

  it('inserts the nodes one by one', async () => {
    const cy = tangled();
    const result = await computeLayout(cy, cy.nodes(), 'insertion', { insert: { budgetMs: 1000 } });
    expect(result.algorithm).toBe('insertion');
    expect(result.after).toMatchObject({ crossings: 0, edgesThroughNodes: 0, overlaps: 0 });
    expect(Object.keys(result.positions).sort()).toEqual(['a', 'b', 'c', 'd', 'p', 'q']);
  });

  it('lays out a selection only, around where it was', async () => {
    const cy = canvas(
      { a: [1000, 1000], b: [1000, 1000], c: [1000, 1000], far: [-500, -500] },
      [
        ['a', 'b'],
        ['b', 'c'],
        ['c', 'far'],
      ],
    );
    const picked = cy.nodes().filter((n) => n.data('refId') !== 'far');
    const result = await computeLayout(cy, picked, 'layered');
    expect(Object.keys(result.positions).sort()).toEqual(['a', 'b', 'c']);
    expect(result.after.overlaps).toBe(0);
    const ys = Object.values(result.positions).map((p) => p.y);
    // A chain laid out top to bottom, centred on the old spot.
    expect(new Set(ys).size).toBe(3);
    const mid = (Math.min(...ys) + Math.max(...ys)) / 2;
    expect(Math.abs(mid - 1000)).toBeLessThan(1);
  });
});
