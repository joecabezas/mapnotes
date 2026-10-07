import type { Graph, GraphNode, KeyValue, Position } from './model';

/** Saved filter criteria; omitted fields impose no restriction. */
export interface ViewCriteria {
  types?: string[];
  styles?: string[];
  query?: string;
  properties?: KeyValue[];
  relatedTo?: string[];
  depth?: number;
  edgeLabels?: string[];
}

export interface SavedView {
  id: string;
  name: string;
  filters: ViewCriteria;
  positions?: Record<string, Position>;
}

const CRITERIA_KEYS = new Set(['types', 'styles', 'query', 'properties', 'relatedTo', 'depth', 'edgeLabels']);

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Classifies a node for type-based filtering (from `type` property, style, or id). */
export function inferNodeKind(node: GraphNode): string {
  const prop = node.properties.find((p) => p.key === 'type')?.value;
  if (prop) return prop === 'pr' || prop.startsWith('pr-') ? 'pr' : prop;
  if (node.id.startsWith('pr-') || node.style === 'pr' || node.style?.startsWith('pr-')) return 'pr';
  return node.style ?? 'node';
}

function matchesText(node: GraphNode, needle: string): boolean {
  const hay = [node.id, node.label, ...node.properties.flatMap((p) => [p.key, p.value])];
  return hay.some((s) => s.toLowerCase().includes(needle));
}

function matchesProperties(node: GraphNode, required: KeyValue[]): boolean {
  return required.every((want) => node.properties.some((p) => p.key === want.key && p.value === want.value));
}

/** Nodes within `depth` hops of any seed, following edges in both directions. */
function reachableFrom(graph: Graph, seeds: string[], depth: number): Set<string> {
  const known = new Set(graph.nodes.map((n) => n.id));
  const result = new Set(seeds.filter((id) => known.has(id)));
  let frontier = new Set(result);
  for (let hop = 0; hop < depth; hop++) {
    const next = new Set<string>();
    for (const edge of graph.edges) {
      if (frontier.has(edge.source) && !result.has(edge.target)) next.add(edge.target);
      if (frontier.has(edge.target) && !result.has(edge.source)) next.add(edge.source);
    }
    for (const id of next) result.add(id);
    frontier = next;
  }
  return result;
}

function listIncludes(list: string[] | undefined, value: string): boolean {
  return list === undefined || list.includes(value);
}

/** Returns a canvas-only projection; the underlying graph is unchanged. */
export function projectGraph(graph: Graph, criteria: ViewCriteria, layout?: Record<string, Position>): Graph {
  const text = criteria.query?.trim().toLowerCase();
  const near =
    criteria.relatedTo !== undefined
      ? reachableFrom(graph, criteria.relatedTo, criteria.depth ?? 2)
      : undefined;

  const nodes = graph.nodes
    .filter((n) => {
      if (near && !near.has(n.id)) return false;
      if (!listIncludes(criteria.types, inferNodeKind(n))) return false;
      if (!listIncludes(criteria.styles, n.style ?? '')) return false;
      if (text && !matchesText(n, text)) return false;
      if (criteria.properties && !matchesProperties(n, criteria.properties)) return false;
      return true;
    })
    .map((n) => (layout?.[n.id] ? { ...n, position: layout[n.id] } : n));

  const shown = new Set(nodes.map((n) => n.id));
  const edges = graph.edges.filter((e) => {
    if (!shown.has(e.source) || !shown.has(e.target)) return false;
    return listIncludes(criteria.edgeLabels, e.label ?? '');
  });

  return { ...graph, nodes, edges };
}

function parseCriteria(raw: unknown): ViewCriteria {
  if (!isRecord(raw)) throw new Error('filters must be a mapping');
  const unknown = Object.keys(raw).filter((k) => !CRITERIA_KEYS.has(k));
  if (unknown.length) throw new Error(`unknown filter field: ${unknown[0]}`);

  const criteria: ViewCriteria = {};
  for (const key of ['types', 'styles', 'relatedTo', 'edgeLabels'] as const) {
    const v = raw[key];
    if (v === undefined) continue;
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) throw new Error(`invalid ${key}`);
    criteria[key] = [...new Set(v)];
  }
  if (raw.query !== undefined) {
    if (typeof raw.query !== 'string') throw new Error('invalid query');
    criteria.query = raw.query;
  }
  if (raw.depth !== undefined) {
    if (typeof raw.depth !== 'number' || !Number.isInteger(raw.depth) || raw.depth < 1 || raw.depth > 3) {
      throw new Error('depth must be 1–3');
    }
    criteria.depth = raw.depth;
  }
  if (raw.properties !== undefined) {
    if (
      !Array.isArray(raw.properties) ||
      !raw.properties.every((p) => isRecord(p) && typeof p.key === 'string' && p.key.trim() && typeof p.value === 'string')
    ) {
      throw new Error('invalid property filters');
    }
    criteria.properties = raw.properties.map((p) => ({ key: p.key as string, value: p.value as string }));
  }
  return criteria;
}

function parseLayout(raw: unknown): Record<string, Position> {
  if (!isRecord(raw)) throw new Error('invalid positions');
  const out: Record<string, Position> = Object.create(null);
  for (const [id, pos] of Object.entries(raw)) {
    if (!isRecord(pos) || typeof pos.x !== 'number' || typeof pos.y !== 'number' || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) {
      throw new Error('invalid position');
    }
    out[id] = { x: pos.x, y: pos.y };
  }
  return out;
}

/** Parses the optional `views` section from a graph file. */
export function parseSavedViews(input: unknown, issues?: string[]): SavedView[] {
  if (input === undefined) return [];
  if (!Array.isArray(input)) {
    issues?.push('"views" must be a list; it was ignored');
    return [];
  }
  const views: SavedView[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of input.entries()) {
    try {
      if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id.trim() || typeof raw.name !== 'string' || !raw.name.trim()) {
        throw new Error('needs an id, name and filters');
      }
      if (seen.has(raw.id)) throw new Error('duplicate view id');
      const view: SavedView = { id: raw.id, name: raw.name, filters: parseCriteria(raw.filters) };
      if (raw.positions !== undefined) view.positions = parseLayout(raw.positions);
      seen.add(view.id);
      views.push(view);
    } catch (err) {
      issues?.push(`views[${index}] was dropped: ${(err as Error).message}`);
    }
  }
  return views;
}

/** Keeps each view's positions only for the nodes it shows, so a layout never outlives its nodes. */
export function pruneViewPositions(graph: Graph): Graph {
  let changed = false;
  const views = graph.views?.map((view) => {
    if (!view.positions) return view;
    const shown = new Set(projectGraph(graph, view.filters).nodes.map((n) => n.id));
    const kept = Object.entries(view.positions).filter(([id]) => shown.has(id));
    if (kept.length === Object.keys(view.positions).length) return view;
    changed = true;
    return { ...view, positions: Object.fromEntries(kept) };
  });
  return changed ? { ...graph, views } : graph;
}

/** Writes node positions into the base graph or a saved view's layout. */
export function storeNodePositions(graph: Graph, positions: Record<string, Position>, viewId?: string): Graph {
  if (viewId && graph.views?.some((v) => v.id === viewId)) {
    return {
      ...graph,
      views: graph.views.map((v) =>
        v.id === viewId ? { ...v, positions: { ...v.positions, ...positions } } : v,
      ),
    };
  }
  return {
    ...graph,
    nodes: graph.nodes.map((n) => (positions[n.id] ? { ...n, position: positions[n.id] } : n)),
  };
}

/** Keeps saved views consistent when a node is renamed. */
export function viewsAfterNodeRename(views: SavedView[], oldId: string, newId: string): SavedView[] {
  return views.map((v) => {
    const positions = v.positions ? { ...v.positions } : undefined;
    if (positions?.[oldId]) {
      positions[newId] = positions[oldId];
      delete positions[oldId];
    }
    const relatedTo = v.filters.relatedTo?.map((id) => (id === oldId ? newId : id));
    return {
      ...v,
      filters: relatedTo ? { ...v.filters, relatedTo } : v.filters,
      ...(positions ? { positions } : {}),
    };
  });
}

/** Keeps saved views consistent when a node is removed. */
export function viewsAfterNodeRemoval(views: SavedView[], id: string): SavedView[] {
  return views.map((v) => {
    const positions = v.positions ? { ...v.positions } : undefined;
    if (positions) delete positions[id];
    return {
      ...v,
      filters:
        v.filters.relatedTo !== undefined
          ? { ...v.filters, relatedTo: v.filters.relatedTo.filter((root) => root !== id) }
          : v.filters,
      ...(positions ? { positions } : {}),
    };
  });
}

/** True when every filter field is unset (show all nodes). */
export function criteriaIsEmpty(criteria: ViewCriteria): boolean {
  return (
    criteria.types === undefined &&
    criteria.styles === undefined &&
    criteria.query === undefined &&
    criteria.properties === undefined &&
    criteria.relatedTo === undefined &&
    criteria.edgeLabels === undefined
  );
}
