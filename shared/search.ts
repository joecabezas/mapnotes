// Bounded node discovery for the MCP server: filter, sort by id, page by cursor.
import { type Graph, GraphError } from './model.ts';

export const DEFAULT_FIND_LIMIT = 50;
export const MAX_FIND_LIMIT = 200;

export interface FindNodesInput {
  /** Case-insensitive substring matched against id, label, property keys and values. */
  query?: string;
  /** Only nodes having this property key (case-insensitive)… */
  propertyKey?: string;
  /** …whose value contains this text (case-insensitive). Without a key, any property value. */
  propertyValue?: string;
  /** Only nodes using this style id (exact). */
  style?: string;
  limit?: number;
  /** `nextCursor` from a previous page. */
  cursor?: string;
}

export interface NodeSummary {
  id: string;
  label: string;
  style?: string;
  properties: number;
  edges: number;
  /** Which fields matched `query`, e.g. "label", "id", "property:owner". */
  matched?: string[];
}

export interface FindNodesResult {
  total: number;
  nodes: NodeSummary[];
  /** Pass as `cursor` to get the next page; absent on the last page. */
  nextCursor?: string;
}

/**
 * Results are ordered by node id, and the cursor is the last id returned, so
 * paging stays stable when nodes are added or removed between calls.
 */
export function findNodes(graph: Graph, input: FindNodesInput = {}): FindNodesResult {
  const limit = input.limit ?? DEFAULT_FIND_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_FIND_LIMIT) {
    throw new GraphError(`limit must be an integer from 1 to ${MAX_FIND_LIMIT}`);
  }
  const q = input.query?.trim().toLowerCase() || undefined;
  const pk = input.propertyKey?.trim().toLowerCase() || undefined;
  const pv = input.propertyValue?.toLowerCase() || undefined;

  const matches: NodeSummary[] = [];
  for (const n of graph.nodes) {
    if (input.style !== undefined && (n.style ?? '') !== input.style) continue;
    if (pk || pv) {
      const hit = n.properties.some(
        (p) => (!pk || p.key.toLowerCase() === pk) && (!pv || p.value.toLowerCase().includes(pv)),
      );
      if (!hit) continue;
    }
    let matched: string[] | undefined;
    if (q) {
      matched = [];
      if (n.id.toLowerCase().includes(q)) matched.push('id');
      if (n.label.toLowerCase().includes(q)) matched.push('label');
      for (const p of n.properties) {
        if (p.key.toLowerCase().includes(q) || p.value.toLowerCase().includes(q)) matched.push(`property:${p.key}`);
      }
      if (!matched.length) continue;
    }
    matches.push({
      id: n.id,
      label: n.label,
      ...(n.style ? { style: n.style } : {}),
      properties: n.properties.length,
      edges: 0,
      ...(matched ? { matched } : {}),
    });
  }
  matches.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const start = input.cursor === undefined ? 0 : matches.findIndex((m) => m.id > input.cursor!);
  const page = start < 0 ? [] : matches.slice(start, start + limit);

  const byId = new Map(page.map((m) => [m.id, m]));
  for (const e of graph.edges) {
    const s = byId.get(e.source);
    if (s) s.edges++;
    const t = e.target !== e.source ? byId.get(e.target) : undefined;
    if (t) t.edges++;
  }

  const last = page[page.length - 1];
  const more = start >= 0 && start + limit < matches.length;
  return { total: matches.length, nodes: page, ...(more && last ? { nextCursor: last.id } : {}) };
}
