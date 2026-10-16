/**
 * Compares the layouts on a few graphs, headless: `npx tsx scripts/layout-bench.ts [layout ...]`.
 * Nodes are 110×40 boxes, roughly a node plus a short label. Prints the score (crossings / edges through
 * nodes / overlaps / edges near nodes) and the time each layout took. `GRAPHS` (a regex) picks graphs, `EVOLVE`
 * and `INSERT` (JSON) the genetic and insertion settings.
 */
import { readFileSync } from 'node:fs';
import cytoscape from 'cytoscape';
import { parseGraphText } from '../shared/yaml.ts';
import { computeLayout, LAYOUTS, type LayoutName } from '../web/layout.ts';
import { qualityScore } from '../web/layoutQuality.ts';

type Edges = [string, string][];

/** Deterministic random numbers, so every run benchmarks the same graphs. */
function rng(seed: number) {
  return () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}

function randomGraph(n: number, m: number, seed: number): Edges {
  const r = rng(seed);
  const edges: Edges = [];
  // A random tree keeps it connected, then extra random edges.
  for (let i = 1; i < n; i++) edges.push([`v${Math.floor(r() * i)}`, `v${i}`]);
  while (edges.length < m) {
    const a = Math.floor(r() * n);
    const b = Math.floor(r() * n);
    if (a !== b) edges.push([`v${a}`, `v${b}`]);
  }
  return edges;
}

/** A few hubs ("suns"), each with its own planets, some planets shared between hubs. */
function hubGraph(hubs: number, planets: number, shared: number, seed: number): Edges {
  const r = rng(seed);
  const edges: Edges = [];
  for (let h = 0; h < hubs; h++) {
    if (h > 0) edges.push([`h${Math.floor(r() * h)}`, `h${h}`]);
    for (let p = 0; p < planets; p++) edges.push([`h${h}`, `p${h}_${p}`]);
  }
  for (let s = 0; s < shared; s++) {
    const h = Math.floor(r() * hubs);
    const other = Math.floor(r() * hubs);
    edges.push([`h${h}`, `p${other}_${Math.floor(r() * planets)}`]);
  }
  return edges;
}

/** A planar grid: 0 crossings is possible. */
function gridGraph(w: number, h: number): Edges {
  const edges: Edges = [];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (x + 1 < w) edges.push([`g${x}_${y}`, `g${x + 1}_${y}`]);
      if (y + 1 < h) edges.push([`g${x}_${y}`, `g${x}_${y + 1}`]);
    }
  return edges;
}

function exampleGraph(file: string): Edges {
  const g = parseGraphText(readFileSync(file, 'utf8'));
  return g.edges.map((e) => [e.source, e.target]);
}

function canvas(edges: Edges) {
  const ids = [...new Set(edges.flat())];
  const r = rng(7);
  const cy = cytoscape({
    headless: true,
    styleEnabled: true,
    style: [{ selector: 'node', style: { width: 110, height: 40 } }],
  });
  cy.add([
    // Scattered start, like a graph whose nodes have no saved positions.
    ...ids.map((id) => ({
      group: 'nodes' as const,
      data: { id: `n:${id}`, refId: id },
      position: { x: r() * 2000, y: r() * 2000 },
    })),
    ...edges.map(([s, t], i) => ({
      group: 'edges' as const,
      data: { id: `e:${i}`, source: `n:${s}`, target: `n:${t}` },
    })),
  ]);
  return cy;
}

const graphs: Record<string, Edges> = {
  'layering-100': exampleGraph(new URL('../examples/layering-100.yaml', import.meta.url).pathname),
  'random-40/60': randomGraph(40, 60, 1),
  'random-60/100': randomGraph(60, 100, 2),
  'hubs-5x8': hubGraph(5, 8, 12, 3),
  'grid-6x6': gridGraph(6, 6),
};

const names = (process.argv.slice(2) as LayoutName[]).filter(Boolean);
const layouts = names.length ? names : LAYOUTS.map((l) => l.name).filter((n) => n !== 'stress');

console.log(`${'graph'.padEnd(16)}${layouts.map((l) => l.padEnd(22)).join('')}`);
const only = process.env.GRAPHS ? new RegExp(process.env.GRAPHS) : null;
// Genetic settings to try, as JSON: EVOLVE='{"explore":0}'.
const evolve = JSON.parse(process.env.EVOLVE ?? '{}');
// Insertion settings to try, as JSON: INSERT='{"makeRoom":false}'.
const insert = JSON.parse(process.env.INSERT ?? '{}');
for (const [name, edges] of Object.entries(graphs)) {
  if (only && !only.test(name)) continue;
  const cells: string[] = [];
  for (const layout of layouts) {
    const cy = canvas(edges);
    const t0 = performance.now();
    const res = await computeLayout(cy, cy.nodes(), layout, { evolve, insert });
    const ms = performance.now() - t0;
    const q = res.after;
    cells.push(
      `${Math.round(qualityScore(q))} (${q.crossings}/${q.edgesThroughNodes}/${q.overlaps}/${q.nearEdges}) ${(ms / 1000).toFixed(1)}s`.padEnd(
        22,
      ),
    );
    cy.destroy();
  }
  console.log(`${name.padEnd(16)}${cells.join('')}`);
}
