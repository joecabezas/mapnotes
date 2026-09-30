import cytoscape, { type Core, type EventObject, type NodeSingular } from 'cytoscape';
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { Graph, Position } from '../../shared/model';
import { useIcons } from '../icons';
import { buildStylesheet, type ThemeName } from '../theme';

// Nodes and edges share one id namespace in Cytoscape, so element ids are prefixed.
const nid = (id: string) => `n:${id}`;
const eid = (id: string) => `e:${id}`;

export type Selection = { kind: 'node' | 'edge'; id: string } | null;

export const LAYOUTS = [
  { name: 'cose', label: 'Force-directed' },
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
  const common = { animate: true, animationDuration: 400, padding: 40, fit: true };
  switch (name) {
    case 'cose':
      return { name, ...common, nodeRepulsion: () => 9000, idealEdgeLength: () => 110, randomize: false } as cytoscape.LayoutOptions;
    case 'breadthfirst':
      return { name, ...common, directed: true, spacingFactor: 1.2 } as cytoscape.LayoutOptions;
    default:
      return { name, ...common } as cytoscape.LayoutOptions;
  }
}

export const GraphCanvas = forwardRef<GraphCanvasHandle, Props>(function GraphCanvas(props, ref) {
  const container = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  // Handlers change every render; the Cytoscape listeners read the latest ones.
  const latest = useRef(props);
  latest.current = props;

  function reportPositions(nodes: cytoscape.NodeCollection, record: boolean) {
    const positions: Record<string, Position> = {};
    nodes.forEach((n) => {
      positions[n.data('refId')] = { ...n.position() };
    });
    if (Object.keys(positions).length) latest.current.onNodesMoved(positions, record);
  }

  function runLayout(name: LayoutName) {
    const cy = cyRef.current;
    if (!cy || cy.nodes().empty()) return;
    const layout = cy.layout(layoutOptions(name));
    layout.one('layoutstop', () => reportPositions(cy.nodes(), true));
    layout.run();
  }

  useImperativeHandle(ref, () => ({
    fit: () => cyRef.current?.animate({ fit: { eles: cyRef.current.elements(), padding: 50 }, duration: 300 }),
    runLayout,
    center(sel) {
      const cy = cyRef.current;
      if (!cy || !sel) return;
      const ele = cy.getElementById(sel.kind === 'node' ? nid(sel.id) : eid(sel.id));
      if (ele.nonempty()) cy.animate({ center: { eles: ele }, zoom: Math.max(cy.zoom(), 1), duration: 300 });
    },
    exportPng() {
      const cy = cyRef.current!;
      const bg = getComputedStyle(document.documentElement).getPropertyValue('--canvas-bg').trim();
      return cy.png({ full: true, scale: 2, bg: bg || undefined });
    },
  }));

  // Create the Cytoscape instance once.
  useEffect(() => {
    const cy = cytoscape({
      container: container.current,
      style: buildStylesheet(latest.current.graph.styles, latest.current.theme),
      boxSelectionEnabled: false,
      selectionType: 'single',
      minZoom: 0.1,
      maxZoom: 4,
    });
    cyRef.current = cy;

    cy.on('tap', 'node', (e: EventObject) => {
      const id = e.target.data('refId') as string;
      if (latest.current.connecting) latest.current.onNodeTapInConnectMode(id);
      else latest.current.onSelect({ kind: 'node', id });
    });
    cy.on('tap', 'edge', (e: EventObject) => {
      if (latest.current.connecting) return;
      latest.current.onSelect({ kind: 'edge', id: e.target.data('refId') });
    });
    cy.on('tap', (e: EventObject) => {
      if (e.target === cy) latest.current.onSelect(null);
    });
    cy.on('dbltap', (e: EventObject) => {
      if (e.target === cy) latest.current.onBackgroundDoubleTap({ ...e.position });
    });
    cy.on('dragfree', 'node', (e: EventObject) => reportPositions(e.target as NodeSingular, true));

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

    return () => {
      cy.destroy();
      cyRef.current = null;
    };
  }, []);

  // Keep the stylesheet in sync with graph styles, the theme and loaded icons.
  const icons = useIcons(props.graph.styles);
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
        runLayout('cose');
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
    const target = sel ? cy.getElementById(sel.kind === 'node' ? nid(sel.id) : eid(sel.id)) : cy.collection();
    cy.elements(':selected').difference(target).unselect();
    target.select();
  }, [props.selection, props.graph]);

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
