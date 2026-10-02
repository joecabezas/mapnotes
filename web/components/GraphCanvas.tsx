import cytoscape, { type Core, type EventObject, type NodeSingular } from 'cytoscape';
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { Graph, Position } from '../../shared/model';
import { arrange, type ArrangeOp } from '../arrange';
import { type Box, zoneAround } from '../hull';
import { computeLayout, type LayoutName, type LayoutResult } from '../layout';
import { isArced } from '../layoutQuality';
import { useIcons } from '../icons';
import { buildStylesheet, CANVAS_COLORS, clusterColor, type ThemeName } from '../theme';

// Nodes and edges share one id namespace in Cytoscape, so element ids are prefixed.
const nid = (id: string) => `n:${id}`;
const eid = (id: string) => `e:${id}`;

/** One node or edge (shown in the inspector), or several nodes (moved / deleted / styled together). */
export type Selection = { kind: 'node' | 'edge'; id: string } | { kind: 'nodes'; ids: string[] } | null;

export interface GraphCanvasHandle {
  /** Fits the selection in view, or the whole visible graph when nothing is selected. */
  fit(): void;
  /**
   * Lays out the given nodes (at least two; others stay put), or the whole graph, saving the new
   * positions as one undo step. Resolves to null when nothing was laid out or a newer run took over.
   */
  runLayout(name: LayoutName, ids?: string[]): Promise<LayoutResult | null>;
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
  /** Nodes not shown; their edges are hidden with them. */
  hidden: string[];
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

/**
 * A straight edge between two nodes in the same row runs through every node in
 * between (e.g. cross-links after a tree layout). Such edges get an `arc`
 * (see theme.ts) that bends them above the row; other edges stay straight.
 */
function updateArcs(edges: cytoscape.EdgeCollection) {
  edges.forEach((edge) => {
    const s = edge.source().position();
    const t = edge.target().position();
    const dx = t.x - s.x;
    let arc = 0;
    if (isArced(s, t)) {
      const height = Math.min(140, 30 + Math.abs(dx) * 0.08);
      // Distances are measured to the left of the source→target direction: pick the side that is "up".
      arc = dx > 0 ? -height : height;
    }
    if (arc) edge.data('arc', arc);
    // Not removeData(): it doesn't restyle the edge, which would stay bent until something else
    // (e.g. dropping the node) restyled it.
    else if (edge.data('arc') !== undefined) edge.data({ arc: undefined });
  });
}

/** Room between a cluster's members (with their labels) and its outline. */
const CLUSTER_PAD = 16;

/** The visible nodes a cluster node is drawn around (see `clusterMembers` in the model). */
function membersOf(cluster: NodeSingular): cytoscape.NodeCollection {
  return cluster.neighborhood('node').filter((m) => !m.data('isCluster') && !m.hasClass('hidden'));
}

/** Fits a cluster's outline around its members. */
const visibleBox = (n: NodeSingular): Box => n.boundingBox({ includeLabels: true, includeOverlays: false });
const boxesOverlap = (a: Box, b: Box) => a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2;

/**
 * Fits a cluster's outline around its members, bending around the nodes that aren't in it. The ids
 * of the nodes in its area are kept (scratch `zoneNear`), so it is reshaped when one of them leaves.
 */
function reshapeCluster(cluster: NodeSingular) {
  const members = membersOf(cluster);
  const others = cluster
    .cy()
    .nodes(':visible')
    .filter((n) => n !== cluster && !n.hasClass('cluster') && !members.contains(n));
  const hull = zoneAround(members.map(visibleBox), others.map(visibleBox), CLUSTER_PAD);
  if (!hull) return;
  if (cluster.data('hullPoints') !== hull.points || cluster.data('hullW') !== hull.width || cluster.data('hullH') !== hull.height) {
    cluster.data({ hullPoints: hull.points, hullW: hull.width, hullH: hull.height });
  }
  const p = cluster.position();
  if (p.x !== hull.center.x || p.y !== hull.center.y) cluster.position(hull.center);
  const area = cluster.boundingBox({ includeLabels: false, includeOverlays: false });
  cluster.scratch('zoneNear', new Set(others.filter((n) => boxesOverlap(visibleBox(n as NodeSingular), area)).map((n) => n.id())));
}

/**
 * Draws cluster nodes that have visible members as zones around them (class `cluster`), hiding their
 * edges; one without members is drawn as a plain node at its saved position.
 */
function refreshClusters(cy: Core) {
  cy.batch(() => {
    cy.nodes().forEach((n) => {
      const drawn = !!n.data('isCluster') && !n.hasClass('hidden') && membersOf(n).nonempty();
      if (drawn === n.hasClass('cluster')) return;
      n.toggleClass('cluster', drawn);
      const home = n.data('home') as Position | undefined;
      if (!drawn && home) n.position({ ...home });
    });
    cy.edges().forEach((e) => {
      e.toggleClass('cluster-edge', e.source().hasClass('cluster') || e.target().hasClass('cluster'));
    });
  });
  cy.nodes('.cluster').forEach((n) => reshapeCluster(n));
}

/** The given nodes, with clusters swapped for their members (clusters don't keep a position of their own). */
function withMembers(nodes: cytoscape.NodeCollection): cytoscape.NodeCollection {
  let out = nodes.not('.cluster');
  nodes.filter('.cluster').forEach((c) => {
    out = out.union(membersOf(c));
  });
  return out;
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
    nodes.not('.cluster').forEach((n) => {
      positions[n.data('refId')] = { ...n.position() };
    });
    if (Object.keys(positions).length) latest.current.onNodesMoved(positions, record);
  }

  /** Bumped by every layout run, so a slow one finishing late doesn't undo a newer one. */
  const layoutRun = useRef(0);

  async function runLayout(name: LayoutName, ids?: string[]): Promise<LayoutResult | null> {
    const cy = cyRef.current;
    // Hidden nodes stay where they are; clusters follow their members.
    const visible = cy?.nodes(':visible').not('.cluster');
    if (!cy || !visible?.nonempty()) return null;
    const wanted = new Set(ids);
    const subset = wanted.size >= 2 ? visible.filter((n) => wanted.has(n.data('refId'))) : null;
    const nodes = subset ?? visible;
    const run = ++layoutRun.current;
    const result = await computeLayout(cy, nodes, name);
    if (run !== layoutRun.current || cy.destroyed()) return null;
    const live = nodes.filter((n) => !n.removed() && result.positions[n.data('refId')] !== undefined);
    const layout = live.layout({
      name: 'preset',
      positions: (n: NodeSingular) => result.positions[n.data('refId')],
      animate: true,
      animationDuration: 400,
      // A partial layout stays where the nodes were, so the view stays put too.
      fit: !subset,
      padding: 40,
    } as cytoscape.LayoutOptions);
    layout.one('layoutstop', () => reportPositions(live, true));
    layout.run();
    return result;
  }

  useImperativeHandle(ref, () => ({
    fit: () => {
      const cy = cyRef.current;
      if (!cy) return;
      const selected = cy.elements(':selected');
      cy.animate({ fit: { eles: selected.nonempty() ? selected : cy.elements(':visible'), padding: 50 }, duration: 300 });
    },
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
        .filter((n) => n.nonempty() && !n.hasClass('cluster'))
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
    // Dragging a cluster drags its members along (except selected ones: Cytoscape already moves those
    // when the cluster is selected too).
    let clusterDragAt: Position | null = null;
    cy.on('grab', 'node.cluster', (e: EventObject) => {
      clusterDragAt = { ...(e.target as NodeSingular).position() };
    });
    cy.on('drag', 'node.cluster', (e: EventObject) => {
      const cluster = e.target as NodeSingular;
      const p = cluster.position();
      if (!clusterDragAt) return;
      const dx = p.x - clusterDragAt.x;
      const dy = p.y - clusterDragAt.y;
      clusterDragAt = { ...p };
      membersOf(cluster)
        .filter((m) => !m.grabbed() && !(m.selected() && cluster.selected()))
        .forEach((m) => void m.position({ x: m.position('x') + dx, y: m.position('y') + dy }));
    });
    // Dragging a selected node moves all selected nodes; save them together, once.
    let dragQueued = false;
    cy.on('dragfree', 'node', (e: EventObject) => {
      const moved = (e.target as NodeSingular).union(cy.nodes(':selected'));
      if (dragQueued) return;
      dragQueued = true;
      queueMicrotask(() => {
        dragQueued = false;
        clusterDragAt = null;
        reportPositions(withMembers(moved.union(cy.nodes(':selected'))), true);
      });
    });
    // Clusters follow their members; reshaped once per frame however many members moved.
    const dirtyClusters = new Set<NodeSingular>();
    let reshapeFrame = 0;
    cy.on('position', 'node', (e: EventObject) => {
      const node = e.target as NodeSingular;
      updateArcs(node.connectedEdges());
      if (node.hasClass('cluster')) return;
      // Its own clusters, and those it moves into or out of.
      node.neighborhood('node.cluster').forEach((c) => void dirtyClusters.add(c));
      const clusters = cy.nodes('.cluster');
      if (clusters.nonempty()) {
        const box = visibleBox(node);
        clusters.forEach((c) => {
          const near = c.scratch('zoneNear') as Set<string> | undefined;
          if (near?.has(node.id()) || boxesOverlap(box, c.boundingBox({ includeLabels: false, includeOverlays: false }))) {
            dirtyClusters.add(c);
          }
        });
      }
      if (!dirtyClusters.size || reshapeFrame) return;
      reshapeFrame = requestAnimationFrame(() => {
        reshapeFrame = 0;
        dirtyClusters.forEach((c) => !c.removed() && c.hasClass('cluster') && reshapeCluster(c));
        dirtyClusters.clear();
      });
    });
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
      cancelAnimationFrame(reshapeFrame);
      cy.destroy();
      cyRef.current = null;
    };
  }, []);

  // Keep the stylesheet in sync with graph styles, the theme and loaded icons.
  const icons = useIcons(props.graph.styles, CANVAS_COLORS[props.theme].node);
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.style(buildStylesheet(props.graph.styles, props.theme, icons));
    // Member sizes may have changed.
    cy.nodes('.cluster').forEach((n) => reshapeCluster(n));
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
        const data = {
          id: nid(node.id),
          refId: node.id,
          label: node.label,
          styleId: node.style ?? '',
          isCluster: !!node.cluster,
          // The colour it is drawn in as a cluster.
          zoneColor: clusterColor(node.label),
          // Where the node goes when it stops being drawn as a cluster.
          home: node.position,
        };
        const ele = cy.getElementById(data.id);
        if (ele.nonempty()) {
          ele.data(data);
          const p = ele.position();
          // A cluster's position is its outline's centre, not the saved one.
          if (node.position && !ele.hasClass('cluster') && !ele.grabbed() && (p.x !== node.position.x || p.y !== node.position.y)) {
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
        void runLayout('auto');
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
              m.hasClass('cluster') ||
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
    refreshClusters(cy);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.graph]);

  // Hidden nodes: not shown, and not selectable (e.g. by a box selection) until revealed.
  // Runs before the selection is reflected, so nodes revealed and selected at once can be selected.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const ids = new Set(props.hidden.map(nid));
    cy.batch(() => {
      cy.nodes().forEach((n) => {
        if (ids.has(n.id())) n.addClass('hidden').unselect().unselectify();
        else if (n.hasClass('hidden')) n.removeClass('hidden').selectify();
      });
    });
    // Hiding members reshapes their clusters; hiding all of them shows the cluster as a node.
    refreshClusters(cy);
  }, [props.hidden, props.graph]);

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
