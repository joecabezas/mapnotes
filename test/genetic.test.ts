import { describe, expect, it } from 'vitest';
import { evolveLayout } from '../web/genetic.ts';
import { measureLayout } from '../web/layoutQuality.ts';

const box = { left: 20, right: 20, top: 10, bottom: 10 };

describe('evolveLayout', () => {
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

  it('evolves away the crossings', async () => {
    const before = measureLayout(tangled, extents, edges);
    const positions = await evolveLayout(tangled, extents, edges, order, [tangled], { budgetMs: 1500, seed: 1 });
    const after = measureLayout({ ...tangled, ...positions }, extents, edges);
    expect(before.crossings).toBeGreaterThan(0);
    expect(after.crossings).toBeLessThan(before.crossings);
    expect(after.overlaps).toBe(0);
  });

  it('moves nodes away from edges they are too close to', async () => {
    // c sits just right of the a-b edge.
    const positions = { a: { x: 0, y: 0 }, b: { x: 0, y: 400 }, c: { x: 35, y: 200 }, d: { x: 250, y: 330 } };
    const edges = [
      { source: 'a', target: 'b' },
      { source: 'c', target: 'd' },
    ];
    const extents = Object.fromEntries(Object.keys(positions).map((id) => [id, box]));
    expect(measureLayout(positions, extents, edges).nearEdges).toBe(1);
    const moved = await evolveLayout(positions, extents, edges, ['c', 'd'], [positions], { budgetMs: 500, seed: 3 });
    expect(measureLayout({ ...positions, ...moved }, extents, edges)).toMatchObject({
      crossings: 0,
      nearEdges: 0,
      overlaps: 0,
    });
  });

  it('only moves the movable nodes, and shows its progress', async () => {
    const shown: { score: number; bestScore: number; exploring: boolean }[] = [];
    const positions = await evolveLayout(tangled, extents, edges, ['a', 'b', 'c', 'd'], [tangled], {
      budgetMs: 600,
      seed: 2,
      progressMs: 0,
      onProgress: (_, { score, bestScore, exploring }) => shown.push({ score, bestScore, exploring }),
    });
    expect(Object.keys(positions).sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(shown.length).toBeGreaterThan(0);
    // The best found only gets better.
    const best = shown.map((p) => p.bestScore);
    expect([...best].sort((x, y) => y - x)).toEqual(best);
    // Exploring comes first; once refining, only improvements are shown, and they're the best found.
    const refined = shown.findIndex((p) => !p.exploring);
    expect(refined).toBeGreaterThan(0);
    const refining = shown.slice(refined);
    expect(refining.every((p) => !p.exploring && p.score === p.bestScore)).toBe(true);
  });

  it('can skip exploring', async () => {
    const shown: boolean[] = [];
    await evolveLayout(tangled, extents, edges, order, [tangled], {
      budgetMs: 200,
      seed: 4,
      explore: 0,
      onProgress: (_, { exploring }) => shown.push(exploring),
    });
    expect(shown).not.toContain(true);
  });
});
