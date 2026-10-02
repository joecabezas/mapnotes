import { normalizeViews, type GraphView } from './views';

// Core data model shared by the web app, the dev file API and the MCP server.

export interface KeyValue {
  key: string;
  value: string;
}

export type NodeProperty = KeyValue;
export type EdgeProperty = KeyValue;
export type GraphProperty = KeyValue;

export interface Position {
  x: number;
  y: number;
}

export interface GraphNode {
  id: string;
  label: string;
  /** Id of a node style defined in `graph.styles`. */
  style?: string;
  /** Saved canvas position; nodes without one are placed by the layout. */
  position?: Position;
  properties: NodeProperty[];
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  /** Id of an edge style defined in `graph.styles`. */
  style?: string;
  properties: EdgeProperty[];
}

export const NODE_SHAPES = [
  'ellipse',
  'rectangle',
  'round-rectangle',
  'triangle',
  'diamond',
  'pentagon',
  'hexagon',
  'octagon',
  'star',
  'tag',
  'barrel',
] as const;
export type NodeShape = (typeof NODE_SHAPES)[number];

export const LINE_STYLES = ['solid', 'dashed', 'dotted'] as const;
export type LineStyle = (typeof LINE_STYLES)[number];

export const ARROW_SHAPES = ['triangle', 'vee', 'circle', 'square', 'diamond', 'tee', 'none'] as const;
export type ArrowShape = (typeof ARROW_SHAPES)[number];

export const CURVE_STYLES = ['bezier', 'straight', 'taxi'] as const;
export type CurveStyle = (typeof CURVE_STYLES)[number];

export interface NodeStyle {
  id: string;
  target: 'node';
  name?: string;
  color?: string;
  borderColor?: string;
  /** Outline width in px (default 2); 0 hides the outline. */
  borderWidth?: number;
  textColor?: string;
  shape?: NodeShape;
  size?: number;
  /**
   * Icon drawn inside the node: an svgl logo by its library file name ("slack",
   * "github_dark"; see svgl.app) or a Lucide icon as "lucide:<name>" (see lucide.dev).
   */
  icon?: string;
  /** Color of single-color (Lucide) icons; defaults to black or white to suit the fill. */
  iconColor?: string;
  /** Icon size as a percentage of the node (default 70). */
  iconSize?: number;
}

export interface EdgeStyle {
  id: string;
  target: 'edge';
  name?: string;
  color?: string;
  textColor?: string;
  width?: number;
  lineStyle?: LineStyle;
  arrow?: ArrowShape;
  curve?: CurveStyle;
}

export type Style = NodeStyle | EdgeStyle;

/** Style fields that only apply to one target. */
export const NODE_ONLY_STYLE_FIELDS = [
  'borderColor',
  'borderWidth',
  'shape',
  'size',
  'icon',
  'iconColor',
  'iconSize',
] as const;
export const EDGE_ONLY_STYLE_FIELDS = ['width', 'lineStyle', 'arrow', 'curve'] as const;

/** Accepted ranges for numeric style values. */
export const STYLE_LIMITS = {
  size: { min: 8, max: 300 },
  borderWidth: { min: 0, max: 20 },
  iconSize: { min: 10, max: 100 },
  width: { min: 1, max: 20 },
} as const;

export interface Graph {
  /** Saved filters and independent layouts; nodes and edges stay shared. */
  views?: GraphView[];
  properties: GraphProperty[];
  styles: Style[];
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export function emptyGraph(): Graph {
  return { properties: [], styles: [], nodes: [], edges: [] };
}

export class GraphError extends Error {}

// ---------------------------------------------------------------------------
// Normalisation / validation of untrusted input (files, MCP arguments).
// ---------------------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  return String(v);
}

function num(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[]): T | undefined {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : undefined;
}

/**
 * Accepts either a list of `{key, value}` pairs or a plain mapping
 * (`{a: 1}`), which is friendlier to write by hand in YAML.
 */
export function normalizeKeyValues(v: unknown): KeyValue[] {
  if (Array.isArray(v)) {
    return v
      .filter(isObject)
      .filter((p) => p.key !== undefined && p.key !== null && String(p.key) !== '')
      .map((p) => ({ key: String(p.key), value: str(p.value) ?? '' }));
  }
  if (isObject(v)) {
    return Object.entries(v).map(([key, value]) => ({ key, value: str(value) ?? '' }));
  }
  return [];
}

function stripUndefined<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k];
  return o;
}

/** Icon names are file names like "github_dark", optionally prefixed "lucide:"; anything else is dropped. */
function iconName(v: unknown): string | undefined {
  const s = str(v)?.trim();
  return s && /^(lucide:)?[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(s) ? s : undefined;
}

export function normalizeStyle(v: unknown): Style | undefined {
  if (!isObject(v) || !str(v.id)) return undefined;
  const id = str(v.id)!;
  if (v.target === 'edge') {
    return stripUndefined<EdgeStyle>({
      id,
      target: 'edge',
      name: str(v.name),
      color: str(v.color),
      textColor: str(v.textColor),
      width: num(v.width),
      lineStyle: oneOf(v.lineStyle, LINE_STYLES),
      arrow: oneOf(v.arrow, ARROW_SHAPES),
      curve: oneOf(v.curve, CURVE_STYLES),
    });
  }
  return stripUndefined<NodeStyle>({
    id,
    target: 'node',
    name: str(v.name),
    color: str(v.color),
    borderColor: str(v.borderColor),
    borderWidth: num(v.borderWidth),
    textColor: str(v.textColor),
    shape: oneOf(v.shape, NODE_SHAPES),
    size: num(v.size),
    icon: iconName(v.icon),
    iconColor: str(v.iconColor),
    iconSize: num(v.iconSize),
  });
}

/** Describes an entry `where` (e.g. "nodes[2]") for diagnostics, using its id when it has one. */
function entryName(section: string, index: number, raw: unknown): string {
  const id = isObject(raw) ? str(raw.id) : undefined;
  return id ? `${section}[${index}] ("${id}")` : `${section}[${index}]`;
}

/** Returns the section as a list; anything else present is reported and treated as empty. */
function section(input: Record<string, unknown>, key: string, issues?: string[]): unknown[] {
  const v = input[key];
  if (Array.isArray(v)) return v;
  if (v !== undefined && v !== null) issues?.push(`"${key}" must be a list; it was ignored`);
  return [];
}

/**
 * Normalises untrusted graph data. Entries that cannot be kept (malformed
 * nodes, styles or edges, duplicate style ids) are dropped and described in
 * `issues`, so callers can show them before the cleaned-up graph is saved.
 */
export function normalizeGraph(input: unknown, issues?: string[]): Graph {
  if (input === undefined || input === null) return emptyGraph();
  if (!isObject(input)) throw new GraphError('Graph file must contain a mapping at the top level');

  const graph: Graph = {
    properties: normalizeKeyValues(input.properties),
    styles: [],
    nodes: [],
    edges: [],
  };

  if (input.views !== undefined) graph.views = normalizeViews(input.views, issues);

  const seenStyles = new Set<string>();
  section(input, 'styles', issues).forEach((raw, i) => {
    const s = normalizeStyle(raw);
    if (!s) {
      issues?.push(
        `${entryName('styles', i, raw)} was dropped: ${isObject(raw) ? 'it has no "id"' : 'it is not a mapping'}`,
      );
      return;
    }
    if (seenStyles.has(s.id)) {
      issues?.push(`${entryName('styles', i, raw)} was dropped: duplicate style id "${s.id}" (the first one is kept)`);
      return;
    }
    seenStyles.add(s.id);
    graph.styles.push(s);
  });

  const seenNodes = new Set<string>();
  section(input, 'nodes', issues).forEach((raw, i) => {
    if (!isObject(raw) || !str(raw.id)) {
      issues?.push(
        `${entryName('nodes', i, raw)} was dropped: ${isObject(raw) ? 'it has no "id"' : 'it is not a mapping'}`,
      );
      return;
    }
    const id = str(raw.id)!;
    if (seenNodes.has(id)) throw new GraphError(`Duplicate node id "${id}"`);
    seenNodes.add(id);
    const pos = isObject(raw.position) ? raw.position : undefined;
    const x = num(pos?.x);
    const y = num(pos?.y);
    graph.nodes.push(
      stripUndefined<GraphNode>({
        id,
        label: str(raw.label) ?? id,
        style: str(raw.style),
        position: x !== undefined && y !== undefined ? { x, y } : undefined,
        properties: normalizeKeyValues(raw.properties),
      }),
    );
  });

  const rawEdges = section(input, 'edges', issues);
  // Generated IDs must avoid every explicit ID, including ones that appear later.
  const explicitEdgeIds = new Set<string>();
  for (const raw of rawEdges) {
    const id = isObject(raw) ? str(raw.id) : undefined;
    if (id) explicitEdgeIds.add(id);
  }
  const seenEdges = new Set<string>();
  let auto = 0;
  rawEdges.forEach((raw, i) => {
    if (!isObject(raw)) {
      issues?.push(`${entryName('edges', i, raw)} was dropped: it is not a mapping`);
      return;
    }
    const source = str(raw.source);
    const target = str(raw.target);
    if (!source || !target) {
      issues?.push(`${entryName('edges', i, raw)} was dropped: it needs both a "source" and a "target"`);
      return;
    }
    if (!seenNodes.has(source) || !seenNodes.has(target)) {
      throw new GraphError(`Edge ${str(raw.id) ?? `${source}->${target}`} references a missing node`);
    }
    let id = str(raw.id);
    if (!id) {
      do id = `e${++auto}`;
      while (explicitEdgeIds.has(id) || seenEdges.has(id));
    }
    if (seenEdges.has(id)) throw new GraphError(`Duplicate edge id "${id}"`);
    seenEdges.add(id);
    graph.edges.push(
      stripUndefined<GraphEdge>({
        id,
        source,
        target,
        label: str(raw.label),
        style: str(raw.style),
        properties: normalizeKeyValues(raw.properties),
      }),
    );
  });

  return graph;
}

// ---------------------------------------------------------------------------
// Operations. All of them return a new Graph and never mutate their input.
// ---------------------------------------------------------------------------

export function uniqueId(prefix: string, taken: Iterable<string>): string {
  const set = new Set(taken);
  let i = 1;
  while (set.has(`${prefix}${i}`)) i++;
  return `${prefix}${i}`;
}

/** Applies `set` on top of `props` and removes the keys listed in `remove`. */
export function mergeProperties(props: KeyValue[], set?: KeyValue[], remove?: string[]): KeyValue[] {
  let out = props.map((p) => ({ ...p }));
  for (const { key, value } of set ?? []) {
    const existing = out.find((p) => p.key === key);
    if (existing) existing.value = value;
    else out.push({ key, value });
  }
  if (remove?.length) out = out.filter((p) => !remove.includes(p.key));
  return out;
}

function requireNode(g: Graph, id: string): GraphNode {
  const node = g.nodes.find((n) => n.id === id);
  if (!node) throw new GraphError(`Node "${id}" does not exist`);
  return node;
}

function requireEdge(g: Graph, id: string): GraphEdge {
  const edge = g.edges.find((e) => e.id === id);
  if (!edge) throw new GraphError(`Edge "${id}" does not exist`);
  return edge;
}

function checkStyle(g: Graph, id: string | undefined, target: Style['target']) {
  if (!id) return;
  const style = g.styles.find((s) => s.id === id);
  if (!style) throw new GraphError(`Style "${id}" does not exist`);
  if (style.target !== target)
    throw new GraphError(
      `Style "${id}" is a ${style.target} style, not ${target === 'edge' ? 'an' : 'a'} ${target} style`,
    );
}

export interface AddNodeInput {
  id?: string;
  label?: string;
  style?: string;
  position?: Position;
  properties?: KeyValue[];
}

export function addNode(g: Graph, input: AddNodeInput): { graph: Graph; node: GraphNode } {
  const id =
    input.id?.trim() ||
    uniqueId(
      'n',
      g.nodes.map((n) => n.id),
    );
  if (g.nodes.some((n) => n.id === id)) throw new GraphError(`Node "${id}" already exists`);
  checkStyle(g, input.style, 'node');
  const node: GraphNode = stripUndefined({
    id,
    label: input.label ?? id,
    style: input.style || undefined,
    position: input.position,
    properties: mergeProperties([], input.properties),
  });
  return { graph: { ...g, nodes: [...g.nodes, node] }, node };
}

export interface EditNodeInput {
  id: string;
  newId?: string;
  label?: string;
  /** Style id; an empty string clears the style. */
  style?: string;
  position?: Position;
  setProperties?: KeyValue[];
  removeProperties?: string[];
  /** Replaces the whole property list (applied before set/remove). */
  properties?: KeyValue[];
}

export function editNode(g: Graph, input: EditNodeInput): { graph: Graph; node: GraphNode } {
  const old = requireNode(g, input.id);
  const newId = input.newId?.trim();
  if (newId && newId !== old.id && g.nodes.some((n) => n.id === newId)) {
    throw new GraphError(`Node "${newId}" already exists`);
  }
  if (input.style) checkStyle(g, input.style, 'node');

  const node: GraphNode = { ...old, properties: input.properties ?? old.properties };
  if (newId) node.id = newId;
  if (input.label !== undefined) node.label = input.label;
  if (input.style !== undefined) {
    if (input.style) node.style = input.style;
    else delete node.style;
  }
  if (input.position) node.position = input.position;
  node.properties = mergeProperties(node.properties, input.setProperties, input.removeProperties);

  const renamed = node.id !== old.id;
  return {
    graph: {
      ...g,
      nodes: g.nodes.map((n) => (n.id === old.id ? node : n)),
      ...(renamed && g.views
        ? {
            views: g.views.map((v) => {
              const positions = v.positions ? { ...v.positions } : undefined;
              if (positions && positions[old.id]) {
                positions[node.id] = positions[old.id];
                delete positions[old.id];
              }
              return {
                ...v,
                filters: {
                  ...v.filters,
                  ...(v.filters.relatedTo
                    ? { relatedTo: v.filters.relatedTo.map((id) => (id === old.id ? node.id : id)) }
                    : {}),
                },
                ...(positions ? { positions } : {}),
              };
            }),
          }
        : {}),
      edges: renamed
        ? g.edges.map((e) => ({
            ...e,
            source: e.source === old.id ? node.id : e.source,
            target: e.target === old.id ? node.id : e.target,
          }))
        : g.edges,
    },
    node,
  };
}

export function removeNode(g: Graph, id: string): { graph: Graph; removedEdges: string[] } {
  requireNode(g, id);
  const removedEdges = g.edges.filter((e) => e.source === id || e.target === id).map((e) => e.id);
  return {
    graph: {
      ...g,
      nodes: g.nodes.filter((n) => n.id !== id),
      ...(g.views
        ? {
            views: g.views.map((v) => {
              const positions = v.positions ? { ...v.positions } : undefined;
              if (positions) delete positions[id];
              return {
                ...v,
                filters: {
                  ...v.filters,
                  ...(v.filters.relatedTo ? { relatedTo: v.filters.relatedTo.filter((root) => root !== id) } : {}),
                },
                ...(positions ? { positions } : {}),
              };
            }),
          }
        : {}),
      edges: g.edges.filter((e) => !removedEdges.includes(e.id)),
    },
    removedEdges,
  };
}

export interface AddEdgeInput {
  id?: string;
  source: string;
  target: string;
  label?: string;
  style?: string;
  properties?: KeyValue[];
}

export function addEdge(g: Graph, input: AddEdgeInput): { graph: Graph; edge: GraphEdge } {
  requireNode(g, input.source);
  requireNode(g, input.target);
  const id =
    input.id?.trim() ||
    uniqueId(
      'e',
      g.edges.map((e) => e.id),
    );
  if (g.edges.some((e) => e.id === id)) throw new GraphError(`Edge "${id}" already exists`);
  checkStyle(g, input.style, 'edge');
  const edge: GraphEdge = stripUndefined({
    id,
    source: input.source,
    target: input.target,
    label: input.label || undefined,
    style: input.style || undefined,
    properties: mergeProperties([], input.properties),
  });
  return { graph: { ...g, edges: [...g.edges, edge] }, edge };
}

export interface EditEdgeInput {
  id: string;
  newId?: string;
  source?: string;
  target?: string;
  /** Empty string clears the label. */
  label?: string;
  /** Style id; an empty string clears the style. */
  style?: string;
  setProperties?: KeyValue[];
  removeProperties?: string[];
  properties?: KeyValue[];
}

export function editEdge(g: Graph, input: EditEdgeInput): { graph: Graph; edge: GraphEdge } {
  const old = requireEdge(g, input.id);
  const newId = input.newId?.trim();
  if (newId && newId !== old.id && g.edges.some((e) => e.id === newId)) {
    throw new GraphError(`Edge "${newId}" already exists`);
  }
  if (input.source) requireNode(g, input.source);
  if (input.target) requireNode(g, input.target);
  if (input.style) checkStyle(g, input.style, 'edge');

  const edge: GraphEdge = { ...old, properties: input.properties ?? old.properties };
  if (newId) edge.id = newId;
  if (input.source) edge.source = input.source;
  if (input.target) edge.target = input.target;
  if (input.label !== undefined) {
    if (input.label) edge.label = input.label;
    else delete edge.label;
  }
  if (input.style !== undefined) {
    if (input.style) edge.style = input.style;
    else delete edge.style;
  }
  edge.properties = mergeProperties(edge.properties, input.setProperties, input.removeProperties);
  return { graph: { ...g, edges: g.edges.map((e) => (e.id === old.id ? edge : e)) }, edge };
}

export function removeEdge(g: Graph, id: string): Graph {
  requireEdge(g, id);
  return { ...g, edges: g.edges.filter((e) => e.id !== id) };
}

export function editGraphProperties(
  g: Graph,
  input: { set?: KeyValue[]; remove?: string[]; properties?: KeyValue[] },
): Graph {
  return { ...g, properties: mergeProperties(input.properties ?? g.properties, input.set, input.remove) };
}

/**
 * Rejects style input that `normalizeStyle` would silently drop or render
 * badly: fields meant for the other target and out-of-range numbers.
 */
export function validateStyleInput(input: { target: Style['target'] } & Record<string, unknown>): void {
  const foreign = (input.target === 'edge' ? NODE_ONLY_STYLE_FIELDS : EDGE_ONLY_STYLE_FIELDS).filter(
    (k) => input[k] !== undefined,
  );
  if (foreign.length) {
    const other = input.target === 'edge' ? 'node' : 'edge';
    const allowed = input.target === 'edge' ? EDGE_ONLY_STYLE_FIELDS : NODE_ONLY_STYLE_FIELDS;
    throw new GraphError(
      `${foreign.map((k) => `"${k}"`).join(', ')} only appl${foreign.length === 1 ? 'ies' : 'y'} to ${other} styles; ` +
        `remove ${foreign.length === 1 ? 'it' : 'them'} or set target to "${other}". ` +
        `${input.target[0].toUpperCase()}${input.target.slice(1)} styles accept: name, color, textColor, ${allowed.join(', ')}`,
    );
  }
  for (const [k, { min, max }] of Object.entries(STYLE_LIMITS)) {
    const v = input[k];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
      throw new GraphError(`"${k}" must be a number between ${min} and ${max} (got ${JSON.stringify(v)})`);
    }
  }
}

/** Creates or replaces a style (matched by id). */
export function upsertStyle(g: Graph, raw: unknown): { graph: Graph; style: Style } {
  const style = normalizeStyle(raw);
  if (!style) throw new GraphError('A style needs at least an "id"');
  const existing = g.styles.find((s) => s.id === style.id);
  if (existing && existing.target !== style.target) {
    const users =
      style.target === 'node' ? g.edges.some((e) => e.style === style.id) : g.nodes.some((n) => n.style === style.id);
    if (users) throw new GraphError(`Style "${style.id}" is in use by ${existing.target}s; cannot change its target`);
  }
  const styles = existing ? g.styles.map((s) => (s.id === style.id ? style : s)) : [...g.styles, style];
  return { graph: { ...g, styles }, style };
}

/** Removes a style and detaches it from every node/edge that used it. */
export function removeStyle(g: Graph, id: string): Graph {
  if (!g.styles.some((s) => s.id === id)) throw new GraphError(`Style "${id}" does not exist`);
  const detach = <T extends { style?: string }>(item: T): T => {
    if (item.style !== id) return item;
    const { style: _style, ...rest } = item;
    return rest as T;
  };
  return {
    ...g,
    styles: g.styles.filter((s) => s.id !== id),
    nodes: g.nodes.map(detach),
    edges: g.edges.map(detach),
  };
}
