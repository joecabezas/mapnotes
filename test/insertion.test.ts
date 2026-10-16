import { describe, expect, it } from 'vitest';
import { insertLayout } from '../web/insertion.ts';
import { measureLayout } from '../web/layoutQuality.ts';

const box = { left: 20, right: 20, top: 10, bottom: 10 };

describe('insertLayout', () => {
  // A cube (planar) drawn as a tangle: every node on a circle in a scrambled order.
  const cube: [string, string][] = [
    ['a', 'b'],
    ['b', 'c'],
    ['c', 'd'],
    ['d', 'a'],
    ['e', 'f'],
    ['f', 'g'],
    ['g', 'h'],
    ['h', 'e'],
    ['a', 'e'],
    ['b', 'f'],
    ['c', 'g'],
    ['d', 'h'],
  ];
  const edges = cube.map(([source, target]) => ({ source, target }));
  const order = ['a', 'g', 'b', 'h', 'c', 'e', 'd', 'f'];
  const tangled = Object.fromEntries(
    order.map((id, k) => [
      id,
      { x: Math.round(300 * Math.cos((k * Math.PI) / 4)), y: Math.round(300 * Math.sin((k * Math.PI) / 4)) },
    ]),
  );
  const extents = Object.fromEntries(order.map((id) => [id, box]));

  it('lays out the tangle with fewer crossings', async () => {
    const before = measureLayout(tangled, extents, edges);
    const positions = await insertLayout(tangled, extents, edges, order, { budgetMs: 1000, seed: 1 });
    const after = measureLayout({ ...tangled, ...positions }, extents, edges);
    expect(before.crossings).toBeGreaterThan(0);
    expect(after.crossings).toBeLessThan(before.crossings);
    expect(after.overlaps).toBe(0);
  });

  it('lays out a tree without crossings, and stops as soon as nothing is wrong', async () => {
    // Three hubs in a row, each with five leaves, all piled on one spot.
    const tree: { source: string; target: string }[] = [
      { source: 'h0', target: 'h1' },
      { source: 'h1', target: 'h2' },
    ];
    for (let h = 0; h < 3; h++) for (let k = 0; k < 5; k++) tree.push({ source: `h${h}`, target: `l${h}_${k}` });
    const ids = [...new Set(tree.flatMap((e) => [e.source, e.target]))];
    const piled = Object.fromEntries(ids.map((id) => [id, { x: 0, y: 0 }]));
    const ext = Object.fromEntries(ids.map((id) => [id, box]));
    const t0 = performance.now();
    const positions = await insertLayout(piled, ext, tree, ids, { budgetMs: 5000, seed: 2 });
    expect(performance.now() - t0).toBeLessThan(5000);
    expect(measureLayout(positions, ext, tree)).toMatchObject({ crossings: 0, edgesThroughNodes: 0, overlaps: 0 });
  });

  it('only moves the movable nodes, and shows the layout growing, then improving', async () => {
    const shown: { placed: number; total: number; rounds: number; score: number; ids: string[] }[] = [];
    const positions = await insertLayout(tangled, extents, edges, ['a', 'b', 'c', 'd'], {
      budgetMs: 600,
      seed: 3,
      progressMs: 0,
      onProgress: (p, { placed, total, rounds, score }) => shown.push({ placed, total, rounds, score, ids: Object.keys(p) }),
    });
    expect(Object.keys(positions).sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(shown.length).toBeGreaterThan(0);
    // While building, only what's placed so far, one more node each time.
    const building = shown.filter((p) => p.placed < p.total);
    expect(building.map((p) => p.placed)).toEqual(building.map((_, k) => k + 1));
    for (const p of building) expect(p.ids.length).toBe(p.placed);
    // Then only improvements of the whole layout.
    const repairing = shown.filter((p) => p.placed === p.total);
    for (const p of repairing) expect(p.ids.sort()).toEqual(['a', 'b', 'c', 'd']);
    const scores = repairing.map((p) => p.score);
    expect([...scores].sort((x, y) => y - x)).toEqual(scores);
    expect(new Set(scores).size).toBe(scores.length);
  });

  it('stops when asked, with the best layout so far', async () => {
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 100);
    const t0 = performance.now();
    const positions = await insertLayout(tangled, extents, edges, order, { budgetMs: 10000, seed: 4, signal: abort.signal });
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(Object.keys(positions).sort()).toEqual([...order].sort());
  });
});
