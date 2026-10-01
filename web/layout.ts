import cytoscape, { type Core, type NodeCollection, type NodeSingular } from 'cytoscape';
import fcose from 'cytoscape-fcose';
import type { Position } from '../shared/model';
import { type Extent, type LayoutQuality, measureLayout, type QualityEdge, qualityScore, refineLayers } from './layoutQuality';

/** ELK is large (~1.5 MB), so it's only downloaded the first time an ELK layout runs. */
let elkReady: Promise<void> | null = null;
function loadElk(): Promise<void> {
  // @ts-expect-error cytoscape-elk ships no types; it's a standard Cytoscape extension.
  elkReady ??= import('cytoscape-elk').then((m: { default: cytoscape.Ext }) => void cytoscape.use(m.default));
  return elkReady;
}
cytoscape.use(fcose);

export const LAYOUTS = [
  { name: 'auto', label: 'Fewest crossings' },
  { name: 'layered', label: 'Layered ↓' },
  { name: 'layered-right', label: 'Layered →' },
  { name: 'tree', label: 'Tree' },
  { name: 'stress', label: 'Stress' },
  { name: 'fcose', label: 'Force-directed' },
  { name: 'concentric', label: 'Concentric' },
  { name: 'circle', label: 'Circle' },
  { name: 'grid', label: 'Grid' },
] as const;
export type LayoutName = (typeof LAYOUTS)[number]['name'];
type Algorithm = Exclude<LayoutName, 'auto'>;

export const layoutLabel = (name: LayoutName) => LAYOUTS.find((l) => l.name === name)!.label;

/**
 * What `auto` tries, best first: on equal scores the earlier one wins. Force-directed starts from
 * random positions, so it gets a few tries. Stress is left out: it's slow (seconds) and overlaps nodes.
 */
const AUTO_CANDIDATES: Algorithm[] = ['tree', 'layered', 'layered-right', 'fcose', 'fcose', 'fcose'];
const ELK_LAYOUTS = new Set<Algorithm>(['layered', 'layered-right', 'tree', 'stress']);
/** Layouts that put nodes in layers, and the axis each layer runs along (see refineLayers). */
const LAYER_AXIS: Partial<Record<Algorithm, 'x' | 'y'>> = { layered: 'x', 'layered-right': 'y', tree: 'x' };

export interface LayoutResult {
  /** New positions of the laid-out nodes, by node id. */
  positions: Record<string, Position>;
  /** The algorithm used (what `auto` picked). */
  algorithm: Algorithm;
  before: LayoutQuality;
  after: LayoutQuality;
}

function elkLayered(direction: 'DOWN' | 'RIGHT') {
  // Sugiyama-style: nodes in layers along the edge direction, the order within each layer chosen by
  // sweeping the layers repeatedly to minimise crossings, then improved by swapping neighbours.
  return {
    algorithm: 'layered',
    'elk.direction': direction,
    'elk.spacing.nodeNode': 45,
    'elk.layered.spacing.nodeNodeBetweenLayers': 60,
    'elk.layered.spacing.edgeNodeBetweenLayers': 25,
    'elk.spacing.componentComponent': 70,
    'elk.layered.thoroughness': 40,
    'elk.layered.cycleBreaking.strategy': 'GREEDY',
    'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
    'elk.layered.crossingMinimization.greedySwitch.type': 'TWO_SIDED',
    'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
    'elk.layered.nodePlacement.bk.fixedAlignment': 'BALANCED',
  };
}

function layoutOptions(name: Algorithm): cytoscape.LayoutOptions {
  // The sandbox nodes are already as big as node + label, so labels need no extra room here.
  const common = { animate: false, fit: false, padding: 0, nodeDimensionsIncludeLabels: false };
  switch (name) {
    case 'layered':
      return { name: 'elk', ...common, elk: elkLayered('DOWN') } as cytoscape.LayoutOptions;
    case 'layered-right':
      return { name: 'elk', ...common, elk: elkLayered('RIGHT') } as cytoscape.LayoutOptions;
    case 'tree':
      // Layered too, but over the spanning forest only (see spanningForest), so each node sits next to its parent.
      return { name: 'elk', ...common, elk: { ...elkLayered('DOWN'), 'elk.layered.thoroughness': 7 } } as cytoscape.LayoutOptions;
    case 'stress':
      // Stress majorisation: places nodes so on-screen distances match graph distances; tends to untangle well.
      return {
        name: 'elk',
        ...common,
        elk: { algorithm: 'stress', 'elk.stress.desiredEdgeLength': 160 },
      } as cytoscape.LayoutOptions;
    case 'fcose':
      // Physics simulation: nodes repel each other, edges pull their ends together like springs.
      return {
        name,
        ...common,
        quality: 'proof',
        randomize: true,
        nodeRepulsion: () => 20000,
        idealEdgeLength: () => 140,
        nodeSeparation: 120,
        packComponents: true,
      } as cytoscape.LayoutOptions;
    default:
      return { name, ...common, avoidOverlap: true, spacingFactor: 1.1 } as cytoscape.LayoutOptions;
  }
}

/**
 * Every node plus one incoming edge per node (its "main parent"), found walking
 * breadth-first from the roots. Laying out only these keeps each node next to
 * its parent and the tree edges crossing-free; other edges (cross-links) are
 * still drawn, they just don't pull nodes away from their parent.
 */
function spanningForest(cy: Core): cytoscape.CollectionReturnValue {
  const tree = cy.collection();
  const seen = new Set<string>();
  const visit = (start: NodeSingular) => {
    seen.add(start.id());
    const queue = [start];
    while (queue.length) {
      queue.shift()!.outgoers('edge').forEach((edge) => {
        const target = edge.target();
        if (seen.has(target.id())) return;
        seen.add(target.id());
        tree.merge(edge);
        queue.push(target);
      });
    }
  };
  cy.nodes().filter((n) => n.indegree(false) === 0).forEach(visit);
  // Nodes only reachable through cycles: start from any one not placed yet.
  cy.nodes().forEach((n) => {
    if (!seen.has(n.id())) visit(n);
  });
  return cy.nodes().union(tree);
}

/** Centre of the boxes `positions` + `extents` cover. */
function centreOf(positions: Record<string, Position>, extents: Record<string, Extent>): Position {
  let x1 = Infinity;
  let x2 = -Infinity;
  let y1 = Infinity;
  let y2 = -Infinity;
  for (const [id, p] of Object.entries(positions)) {
    const e = extents[id];
    x1 = Math.min(x1, p.x - e.left);
    x2 = Math.max(x2, p.x + e.right);
    y1 = Math.min(y1, p.y - e.top);
    y2 = Math.max(y2, p.y + e.bottom);
  }
  return { x: (x1 + x2) / 2, y: (y1 + y2) / 2 };
}

/**
 * Lays out `nodes` (all of `cy`'s nodes, or just some) without touching the canvas, and returns where
 * they should go. Only edges between the given nodes shape the layout; nodes left out stay where they
 * are, and a partial layout is centred where the nodes were. Quality is measured over the whole graph.
 */
export async function computeLayout(cy: Core, nodes: NodeCollection, name: LayoutName): Promise<LayoutResult> {
  const candidates: Algorithm[] = name === 'auto' ? AUTO_CANDIDATES : [name];
  if (candidates.some((c) => ELK_LAYOUTS.has(c))) await loadElk();

  // What's visible of each node, measured on the real canvas (labels can be much wider than nodes).
  const extents: Record<string, Extent> = {};
  const current: Record<string, Position> = {};
  cy.nodes().forEach((n) => {
    const id = n.data('refId') as string;
    const p = n.position();
    const bb = n.boundingBox({ includeLabels: true, includeOverlays: false });
    current[id] = { x: p.x, y: p.y };
    extents[id] = { left: p.x - bb.x1, right: bb.x2 - p.x, top: p.y - bb.y1, bottom: bb.y2 - p.y };
  });
  const allEdges: QualityEdge[] = cy.edges().map((e) => ({
    source: e.source().data('refId') as string,
    target: e.target().data('refId') as string,
  }));

  // A headless copy where each node is a plain box the size of node + label, centred on that box.
  // It keeps the canvas's element ids (`n:` / `e:` prefixed), so nodes and edges can't clash.
  const ids = new Set(nodes.map((n) => n.data('refId') as string));
  const boxCentre = (id: string) => {
    const e = extents[id];
    return { x: current[id].x + (e.right - e.left) / 2, y: current[id].y + (e.bottom - e.top) / 2 };
  };
  const sandbox = cytoscape({
    headless: true,
    styleEnabled: true,
    style: [{ selector: 'node', style: { shape: 'rectangle', width: 'data(w)', height: 'data(h)' } }],
    elements: [
      ...[...ids].map((id) => ({
        group: 'nodes' as const,
        data: { id: `n:${id}`, refId: id, w: extents[id].left + extents[id].right, h: extents[id].top + extents[id].bottom },
        position: boxCentre(id),
      })),
      ...cy
        .edges()
        .filter((e) => ids.has(e.source().data('refId')) && ids.has(e.target().data('refId')))
        .map((e) => ({
          group: 'edges' as const,
          data: { id: e.id(), source: e.data('source'), target: e.data('target') },
        })),
    ],
  });

  const oldCentre = centreOf(Object.fromEntries([...ids].map((id) => [id, current[id]])), extents);
  let best: { algorithm: Algorithm; positions: Record<string, Position>; quality: LayoutQuality; score: number } | null =
    null;
  try {
    for (const algorithm of candidates) {
      sandbox.nodes().forEach((n) => void n.position(boxCentre(n.data('refId'))));
      const eles = algorithm === 'tree' ? spanningForest(sandbox) : sandbox.elements();
      const layout = eles.layout(layoutOptions(algorithm));
      const done = layout.promiseOn('layoutstop');
      layout.run();
      await done;

      // Back from box centres to node positions, then onto where the nodes were.
      const positions: Record<string, Position> = {};
      sandbox.nodes().forEach((n) => {
        const id = n.data('refId') as string;
        const e = extents[id];
        const p = n.position();
        positions[id] = { x: p.x - (e.right - e.left) / 2, y: p.y - (e.bottom - e.top) / 2 };
      });
      const newCentre = centreOf(positions, extents);
      for (const p of Object.values(positions)) {
        p.x = Math.round(p.x + oldCentre.x - newCentre.x);
        p.y = Math.round(p.y + oldCentre.y - newCentre.y);
      }

      const axis = LAYER_AXIS[algorithm];
      if (axis) Object.assign(positions, refineLayers({ ...current, ...positions }, extents, allEdges, ids, axis));

      const quality = measureLayout({ ...current, ...positions }, extents, allEdges);
      const score = qualityScore(quality);
      if (!best || score < best.score) best = { algorithm, positions, quality, score };
      if (score === 0) break; // Can't do better.
    }
  } finally {
    sandbox.destroy();
  }

  return {
    positions: best!.positions,
    algorithm: best!.algorithm,
    before: measureLayout(current, extents, allEdges),
    after: best!.quality,
  };
}
