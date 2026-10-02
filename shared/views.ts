import type { Graph, GraphNode, KeyValue, Position } from './model';

export interface ViewFilters {
  types?: string[];
  styles?: string[];
  query?: string;
  properties?: KeyValue[];
  relatedTo?: string[];
  depth?: number;
  edgeLabels?: string[];
}
export interface GraphView {
  id: string;
  name: string;
  filters: ViewFilters;
  positions?: Record<string, Position>;
}

export function nodeType(node: GraphNode): string {
  const type = node.properties.find((p) => p.key === 'type')?.value;
  if (type) return type === 'pr' || type.startsWith('pr-') ? 'pr' : type;
  if (node.id.startsWith('pr-') || node.style === 'pr' || node.style?.startsWith('pr-')) return 'pr';
  return node.style ?? 'node';
}

/** Project the canvas, never the persisted graph. Missing filter values remain restrictive. */
export function filterGraph(graph: Graph, filters: ViewFilters, positions?: Record<string, Position>): Graph {
  let related: Set<string> | undefined;
  if (filters.relatedTo !== undefined) {
    related = new Set(filters.relatedTo.filter((id) => graph.nodes.some((n) => n.id === id)));
    let frontier = new Set(related);
    for (let hop = 0; hop < (filters.depth ?? 2); hop++) {
      const next = new Set<string>();
      for (const edge of graph.edges) {
        if (frontier.has(edge.source) && !related.has(edge.target)) next.add(edge.target);
        if (frontier.has(edge.target) && !related.has(edge.source)) next.add(edge.source);
      }
      for (const id of next) related.add(id);
      frontier = next;
    }
  }
  const query = filters.query?.trim().toLowerCase();
  const nodes = graph.nodes
    .filter(
      (n) =>
        (!related || related.has(n.id)) &&
        (filters.types === undefined || filters.types.includes(nodeType(n))) &&
        (filters.styles === undefined || filters.styles.includes(n.style ?? '')) &&
        (!query ||
          [n.id, n.label, ...n.properties.flatMap((p) => [p.key, p.value])].some((s) =>
            s.toLowerCase().includes(query),
          )) &&
        (!filters.properties ||
          filters.properties.every((p) => n.properties.some((v) => v.key === p.key && v.value === p.value))),
    )
    .map((n) => (positions?.[n.id] ? { ...n, position: positions[n.id] } : n));
  const visible = new Set(nodes.map((n) => n.id));
  return {
    ...graph,
    nodes,
    edges: graph.edges.filter(
      (e) =>
        visible.has(e.source) &&
        visible.has(e.target) &&
        (filters.edgeLabels === undefined || filters.edgeLabels.includes(e.label ?? '')),
    ),
  };
}

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const fields = new Set(['types', 'styles', 'query', 'properties', 'relatedTo', 'depth', 'edgeLabels']);
/** Reject malformed view criteria instead of accidentally displaying a broader graph. */
export function normalizeViews(input: unknown, issues?: string[]): GraphView[] {
  if (!Array.isArray(input)) {
    issues?.push('"views" must be a list; it was ignored');
    return [];
  }
  const views: GraphView[] = [],
    seen = new Set<string>();
  for (const [index, raw] of input.entries()) {
    try {
      if (
        !object(raw) ||
        typeof raw.id !== 'string' ||
        !raw.id.trim() ||
        typeof raw.name !== 'string' ||
        !raw.name.trim() ||
        !object(raw.filters)
      )
        throw Error('needs an id, name and filter mapping');
      if (seen.has(raw.id)) throw Error('duplicate view id');
      const f = raw.filters,
        filters: ViewFilters = {};
      if (Object.keys(f).some((key) => !fields.has(key))) throw Error('unknown filter field');
      for (const key of ['types', 'styles', 'relatedTo', 'edgeLabels'] as const) {
        if (f[key] === undefined) continue;
        if (!Array.isArray(f[key]) || !f[key].every((v) => typeof v === 'string')) throw Error(`invalid ${key}`);
        filters[key] = [...new Set(f[key])];
      }
      if (f.query !== undefined) {
        if (typeof f.query !== 'string') throw Error('invalid query');
        filters.query = f.query;
      }
      if (f.depth !== undefined) {
        if (typeof f.depth !== 'number' || !Number.isInteger(f.depth) || f.depth < 1 || f.depth > 3)
          throw Error('depth must be 1–3');
        filters.depth = f.depth;
      }
      if (f.properties !== undefined) {
        if (
          !Array.isArray(f.properties) ||
          !f.properties.every(
            (p) => object(p) && typeof p.key === 'string' && !!p.key.trim() && typeof p.value === 'string',
          )
        )
          throw Error('invalid property filters');
        filters.properties = f.properties.map((p) => ({ key: p.key as string, value: p.value as string }));
      }
      const view: GraphView = { id: raw.id, name: raw.name, filters };
      if (raw.positions !== undefined) {
        if (!object(raw.positions)) throw Error('invalid positions');
        const positions: Record<string, Position> = Object.create(null);
        for (const [id, p] of Object.entries(raw.positions)) {
          if (
            !object(p) ||
            typeof p.x !== 'number' ||
            typeof p.y !== 'number' ||
            !Number.isFinite(p.x) ||
            !Number.isFinite(p.y)
          )
            throw Error('invalid position');
          positions[id] = { x: p.x, y: p.y };
        }
        view.positions = positions;
      }
      seen.add(raw.id);
      views.push(view);
    } catch (error) {
      issues?.push(`views[${index}] was dropped: ${(error as Error).message}`);
    }
  }
  return views;
}

export function moveNodes(graph: Graph, positions: Record<string, Position>, viewId?: string): Graph {
  if (viewId && graph.views?.some((v) => v.id === viewId))
    return {
      ...graph,
      views: graph.views.map((v) => (v.id === viewId ? { ...v, positions: { ...v.positions, ...positions } } : v)),
    };
  return { ...graph, nodes: graph.nodes.map((n) => (positions[n.id] ? { ...n, position: positions[n.id] } : n)) };
}
