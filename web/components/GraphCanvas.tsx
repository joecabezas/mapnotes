import cytoscape, { type Core, type EventObject, type NodeSingular } from 'cytoscape';
import fcose from 'cytoscape-fcose';
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { Graph, Position } from '../../shared/model';
import { arrange, type ArrangeOp } from '../arrange';
import { useIcons } from '../icons';
import { buildStylesheet, CANVAS_COLORS, type ThemeName } from '../theme';

// Nodes and edges share one id namespace in Cytoscape, so element ids are prefixed.
const nid = (id: string) => `n:${id}`;
const eid = (id: string) => `e:${id}`;

/** One node or edge (shown in the inspector), or several nodes (moved / deleted / styled together). */
export type Selection = { kind: 'node' | 'edge'; id: string } | { kind: 'nodes'; ids: string[] } | null;


/** ELK is large (~1.5 MB), so it's only downloaded the first time the smart layout runs. */
let elkReady: Promise<void> | null = null;
function loadElk(): Promise<void> {
  // @ts-expect-error cytoscape-elk ships no types; it's a standard Cytoscape extension.
  elkReady ??= import('cytoscape-elk').then((m: { default: cytoscape.Ext }) => void cytoscape.use(m.default));
  return elkReady;
}
cytoscape.use(fcose);

export const LAYOUTS = [
  { name: 'elk', label: 'Smart (layered)' },
  { name: 'fcose', label: 'Force-directed' },
  { name: 'breadthfirst', label: 'Hierarchy' },
  { name: 'concentric', label: 'Concentric' },
  { name: 'circle', label: 'Circle' },
  { name: 'grid', label: 'Grid' },
] as const;
export type LayoutName = (typeof LAYOUTS)[number]['name'];

export interface GraphCanvasHandle {
  fit(): void;
  runLayout(name: LayoutName): void;
  center(sel: Selection): void;
  exportPng(): string;
  /** Aligns or distributes the given nodes, saving their new positions as one undo step. */
  arrange(ids: string[], op: ArrangeOp): void;
}

interface Props {
  graph: Graph;
  theme: ThemeName;
  selection: Selection;
  /** Connect mode: taps on nodes pick edge endpoints instead of selecting. */
  connecting: boolean;
  connectSource: string | null;
  highlight: string[] | null;
  onSelect(sel: Selection): void;
  onNodeTapInConnectMode(id: string): void;
  onBackgroundDoubleTap(pos: Position): void;
  /** `record` is false for automatic placement, true for user drags / layouts. */
  onNodesMoved(positions: Record<string, Position>, record: boolean): void;
}

interface Hover {
  x: number;
  y: number;
  title: string;
  subtitle?: string;
  props: { key: string; value: string }[];
}

function layoutOptions(name: LayoutName): cytoscape.LayoutOptions {
  // Labels sit under the nodes and can be much wider than them, so every layout spaces nodes by node + label.
  const common = { animate: true, animationDuration: 400, padding: 40, fit: true, nodeDimensionsIncludeLabels: true };
  switch (name) {
    case 'elk':
      // ELK's layered (Sugiyama) layout: parents above children, node order chosen to minimise edge
      // crossings, each parent centred over its children.
      return {
        name,
        ...common,
        elk: {
          algorithm: 'layered',
          'elk.direction': 'DOWN',
          'elk.spacing.nodeNode': 45,
          'elk.layered.spacing.nodeNodeBetweenLayers': 60,
          'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
          'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
          'elk.layered.nodePlacement.bk.fixedAlignment': 'BALANCED',
        },
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
    case 'breadthfirst':
      return { name, ...common, directed: true, spacingFactor: 1.2 } as cytoscape.LayoutOptions;
    default:
      return { name, ...common } as cytoscape.LayoutOptions;
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

/**
 * A straight edge between two nodes in the same row runs through every node in
 * between (e.g. cross-links after the smart layout). Such edges get an `arc`
 * (see theme.ts) that bends them above the row; other edges stay straight.
 */
const ARC_MAX_DY = 30;
const ARC_MIN_DX = 100;
function updateArcs(edges: cytoscape.EdgeCollection) {
  edges.forEach((edge) => {
    const s = edge.source().position();
    const t = edge.target().position();
    const dx = t.x - s.x;
    const dy = t.y - s.y;
    let arc = 0;
    if (Math.abs(dy) < ARC_MAX_DY && Math.abs(dx) > ARC_MIN_DX) {
      const height = Math.min(140, 30 + Math.abs(dx) * 0.08);
      // Distances are measured to the left of the source→target direction: pick the side that is "up".
      arc = dx > 0 ? -height : height;
    }
    if (arc) edge.data('arc', arc);
    else if (edge.data('arc') !== undefined) edge.removeData('arc');
  });
}

/** The app-level selection matching what is selected on the canvas. */
function selectionOf(cy: Core): Selection {
  const nodes = cy.nodes(':selected');
  const edges = cy.edges(':selected');
  if (nodes.length > 1) return { kind: 'nodes', ids: nodes.map((n) => n.data('refId') as string) };
  if (nodes.length === 1 && edges.empty()) return { kind: 'node', id: nodes.data('refId') };
  if (nodes.empty() && edges.length === 1) return { kind: 'edge', id: edges.data('refId') };
  if (nodes.length === 1) return { kind: 'nodes', ids: [nodes.data('refId')] };
  return edges.nonempty() ? { kind: 'edge', id: edges.last().data('refId') } : null;
}

export const GraphCanvas = forwardRef<GraphCanvasHandle, Props>(function GraphCanvas(props, ref) {
  const container = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  // Handlers change every render; the Cytoscape listeners read the latest ones.
  const latest = useRef(props);
  latest.current = props;
  /** True while we apply the app's selection to Cytoscape, so those changes aren't reported back. */
  const syncingSelection = useRef(false);

  function reportPositions(nodes: cytoscape.NodeCollection, record: boolean) {
    const positions: Record<string, Position> = {};
    nodes.forEach((n) => {
      positions[n.data('refId')] = { ...n.position() };
    });
    if (Object.keys(positions).length) latest.current.onNodesMoved(positions, record);
  }

  async function runLayout(name: LayoutName) {
    if (name === 'elk') await loadElk();
    const cy = cyRef.current;
    if (!cy || cy.nodes().empty()) return;
    const eles = name === 'elk' ? spanningForest(cy) : cy.elements();
    const layout = eles.layout(layoutOptions(name));
    layout.one('layoutstop', () => reportPositions(cy.nodes(), true));
    layout.run();
  }

  useImperativeHandle(ref, () => ({
    fit: () => cyRef.current?.animate({ fit: { eles: cyRef.current.elements(), padding: 50 }, duration: 300 }),
    runLayout,
    center(sel) {
      const cy = cyRef.current;
      if (!cy || !sel || sel.kind === 'nodes') return;
      const ele = cy.getElementById(sel.kind === 'node' ? nid(sel.id) : eid(sel.id));
      if (ele.nonempty()) cy.animate({ center: { eles: ele }, zoom: Math.max(cy.zoom(), 1), duration: 300 });
    },
    exportPng() {
      const cy = cyRef.current!;
      const bg = getComputedStyle(document.documentElement).getPropertyValue('--canvas-bg').trim();
      return cy.png({ full: true, scale: 2, bg: bg || undefined });
    },
    arrange(ids, op) {
      const cy = cyRef.current;
      if (!cy) return;
      // Align by the node shapes; distribute by what's visible, so labels count towards the gaps.
      const withLabels = op.startsWith('distribute') || op.startsWith('space');
      const items = ids
        .map((id) => cy.getElementById(nid(id)))
        .filter((n) => n.nonempty())
        .map((n) => ({
          id: n.data('refId') as string,
          position: { ...n.position() },
          box: n.boundingBox({ includeLabels: withLabels, includeOverlays: false }),
        }));
      const positions = arrange(items, op);
      if (Object.keys(positions).length) latest.current.onNodesMoved(positions, true);
    },
  }));

  // Create the Cytoscape instance once.
  useEffect(() => {
    const cy = cytoscape({
      container: container.current,
      style: buildStylesheet(latest.current.graph.styles, latest.current.theme),
      // Shift/Ctrl + click adds to the selection; Shift + drag on the background draws a selection box.
      boxSelectionEnabled: true,
      selectionType: 'single',
      minZoom: 0.1,
      maxZoom: 4,
    });
    cyRef.current = cy;

    cy.on('tap', 'node', (e: EventObject) => {
      if (latest.current.connecting) latest.current.onNodeTapInConnectMode(e.target.data('refId') as string);
    });

    // Cytoscape does the selecting (click, Shift/Ctrl + click, box); report the result once per burst
    // of events (a box selection fires one per element). Changes we make ourselves are ignored.
    let reportQueued = false;
    cy.on('select unselect', () => {
      if (syncingSelection.current || reportQueued) return;
      reportQueued = true;
      queueMicrotask(() => {
        reportQueued = false;
        latest.current.onSelect(selectionOf(cy));
      });
    });
    cy.on('dbltap', (e: EventObject) => {
      if (e.target === cy) latest.current.onBackgroundDoubleTap({ ...e.position });
    });
    // Dragging a selected node moves all selected nodes; save them together, once.
    let dragQueued = false;
    cy.on('dragfree', 'node', (e: EventObject) => {
      const moved = (e.target as NodeSingular).union(cy.nodes(':selected'));
      if (dragQueued) return;
      dragQueued = true;
      queueMicrotask(() => {
        dragQueued = false;
        reportPositions(moved.union(cy.nodes(':selected')), true);
      });
    });
    cy.on('position', 'node', (e: EventObject) => updateArcs((e.target as NodeSingular).connectedEdges()));
    cy.on('add', 'edge', (e: EventObject) => updateArcs(e.target as cytoscape.EdgeCollection));

    cy.on('mouseover', 'node, edge', (e: EventObject) => {
      const g = latest.current.graph;
      const refId = e.target.data('refId') as string;
      const pos = e.renderedPosition ?? e.target.renderedMidpoint?.() ?? { x: 0, y: 0 };
      if (e.target.isNode()) {
        const node = g.nodes.find((n) => n.id === refId);
        if (node) setHover({ x: pos.x, y: pos.y, title: node.label, subtitle: node.id, props: node.properties });
      } else {
        const edge = g.edges.find((ed) => ed.id === refId);
        if (edge) {
          setHover({
            x: pos.x,
            y: pos.y,
            title: edge.label || edge.id,
            subtitle: `${edge.source} → ${edge.target}`,
            props: edge.properties,
          });
        }
      }
    });
    cy.on('mouseout', 'node, edge', () => setHover(null));
    cy.on('pan zoom drag', () => setHover(null));

    // Cytoscape only notices window resizes; also follow the container (e.g. when the side panel is resized).
    const resizeObserver = new ResizeObserver(() => cy.resize());
    if (container.current) resizeObserver.observe(container.current);

    return () => {
      resizeObserver.disconnect();
      cy.destroy();
      cyRef.current = null;
    };
  }, []);

  // Keep the stylesheet in sync with graph styles, the theme and loaded icons.
  const icons = useIcons(props.graph.styles, CANVAS_COLORS[props.theme].node);
  useEffect(() => {
    cyRef.current?.style(buildStylesheet(props.graph.styles, props.theme, icons));
  }, [props.graph.styles, props.theme, icons]);

  // Diff the graph into Cytoscape.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const { graph } = props;
    const wasEmpty = cy.nodes().empty();
    const unplaced: string[] = [];

    cy.batch(() => {
      const nodeIds = new Set(graph.nodes.map((n) => nid(n.id)));
      const edgeIds = new Set(graph.edges.map((e) => eid(e.id)));
      cy.edges().filter((e) => !edgeIds.has(e.id())).remove();
      cy.nodes().filter((n) => !nodeIds.has(n.id())).remove();

      for (const node of graph.nodes) {
        const data = { id: nid(node.id), refId: node.id, label: node.label, styleId: node.style ?? '' };
        const ele = cy.getElementById(data.id);
        if (ele.nonempty()) {
          ele.data(data);
          const p = ele.position();
          if (node.position && !ele.grabbed() && (p.x !== node.position.x || p.y !== node.position.y)) {
            ele.position(node.position);
          }
        } else {
          cy.add({ group: 'nodes', data, position: node.position ? { ...node.position } : { x: 0, y: 0 } });
          if (!node.position) unplaced.push(node.id);
        }
      }

      for (const edge of graph.edges) {
        const data = {
          id: eid(edge.id),
          refId: edge.id,
          source: nid(edge.source),
          target: nid(edge.target),
          label: edge.label ?? '',
          styleId: edge.style ?? '',
        };
        const ele = cy.getElementById(data.id);
        if (ele.empty()) {
          cy.add({ group: 'edges', data });
          continue;
        }
        if (ele.data('source') !== data.source || ele.data('target') !== data.target) {
          (ele as cytoscape.EdgeSingular).move({ source: data.source, target: data.target });
        }
        ele.data({ label: data.label, styleId: data.styleId });
      }
    });

    if (unplaced.length) {
      if (unplaced.length === graph.nodes.length) {
        // Nothing has a position yet: lay out the whole graph.
        runLayout('elk');
      } else {
        // Drop new nodes next to their placed neighbours, or in view.
        const center = (() => {
          const ext = cy.extent();
          return { x: (ext.x1 + ext.x2) / 2, y: (ext.y1 + ext.y2) / 2 };
        })();
        const unplacedSet = new Set(unplaced);
        const moved = cy.collection();
        const isFree = (p: Position) =>
          cy.nodes().toArray().every(
            (m) =>
              (unplacedSet.has(m.data('refId')) && !moved.contains(m)) ||
              Math.hypot((m as NodeSingular).position('x') - p.x, (m as NodeSingular).position('y') - p.y) > 70,
          );
        for (const id of unplaced) {
          const n = cy.getElementById(nid(id));
          const anchors = n.neighborhood('node').filter((m) => !unplacedSet.has(m.data('refId')));
          const base = anchors.nonempty()
            ? {
                x: anchors.toArray().reduce((s, m) => s + (m as NodeSingular).position('x'), 0) / anchors.length,
                y: anchors.toArray().reduce((s, m) => s + (m as NodeSingular).position('y'), 0) / anchors.length + 90,
              }
            : center;
          // Walk outwards on a spiral until there is room.
          let spot = base;
          for (let i = 0; i < 200 && !isFree(spot); i++) {
            const angle = i * 2.4;
            const r = 40 + 8 * i;
            spot = { x: base.x + r * Math.cos(angle), y: base.y + r * Math.sin(angle) };
          }
          n.position(spot);
          moved.merge(n);
        }
        reportPositions(moved, false);
        if (wasEmpty) cy.fit(undefined, 50);
      }
    } else if (wasEmpty && graph.nodes.length) {
      cy.fit(undefined, 50);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.graph]);

  // Reflect the app's selection.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const sel = props.selection;
    let target = cy.collection();
    if (sel?.kind === 'nodes') sel.ids.forEach((id) => (target = target.union(cy.getElementById(nid(id)))));
    else if (sel) target = cy.getElementById(sel.kind === 'node' ? nid(sel.id) : eid(sel.id));
    syncingSelection.current = true;
    cy.elements(':selected').difference(target).unselect();
    target.select();
    syncingSelection.current = false;
  }, [props.selection, props.graph]);

  // In connect mode clicks pick edge endpoints, so they must not change the selection.
  useEffect(() => {
    cyRef.current?.autounselectify(props.connecting);
  }, [props.connecting]);

  // Connect-mode source marker.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.nodes('.connect-source').removeClass('connect-source');
    if (props.connectSource) cy.getElementById(nid(props.connectSource)).addClass('connect-source');
    container.current?.classList.toggle('connecting', props.connecting);
  }, [props.connecting, props.connectSource, props.graph]);

  // Search highlight.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.batch(() => {
      cy.elements().removeClass('dimmed match');
      if (props.highlight) {
        const ids = new Set(props.highlight.map(nid));
        const hits = cy.nodes().filter((n) => ids.has(n.id()));
        cy.elements().difference(hits).addClass('dimmed');
        hits.addClass('match');
      }
    });
  }, [props.highlight, props.graph]);

  return (
    <div className="canvas-wrap">
      <div ref={container} className="canvas" />
      {hover && (
        <div className="hover-card" style={{ left: hover.x + 16, top: hover.y + 16 }}>
          <div className="hover-title">{hover.title}</div>
          {hover.subtitle && <div className="hover-sub">{hover.subtitle}</div>}
          {hover.props.length > 0 && (
            <dl>
              {hover.props.slice(0, 8).map((p) => (
                <div key={p.key}>
                  <dt>{p.key}</dt>
                  <dd>{p.value}</dd>
                </div>
              ))}
              {hover.props.length > 8 && <div className="muted">+{hover.props.length - 8} more</div>}
            </dl>
          )}
        </div>
      )}
    </div>
  );
});
