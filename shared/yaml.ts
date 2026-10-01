import { dump, load } from 'js-yaml';
import { type Graph, GraphError, normalizeGraph } from './model.ts';

/** Entries that had to be dropped are described in `issues` (see `normalizeGraph`). */
export function parseGraphYaml(text: string, issues?: string[]): Graph {
  let data: unknown;
  try {
    data = load(text);
  } catch (err) {
    throw new GraphError(`Invalid YAML: ${(err as Error).message}`);
  }
  return normalizeGraph(data, issues);
}

// Round positions so dragging does not produce noisy diffs.
function roundPositions(graph: Graph): Graph {
  return {
    ...graph,
    nodes: graph.nodes.map((n) =>
      n.position ? { ...n, position: { x: Math.round(n.position.x), y: Math.round(n.position.y) } } : n,
    ),
  };
}

export function serializeGraphYaml(graph: Graph): string {
  return dump(roundPositions(graph), { noRefs: true, lineWidth: -1, sortKeys: false });
}

export type GraphFormat = 'yaml' | 'json';

export function formatForPath(file: string): GraphFormat {
  return /\.json$/i.test(file) ? 'json' : 'yaml';
}

/** Parses YAML or JSON (JSON is valid YAML, so YAML parsing handles both). */
export function parseGraphText(text: string, issues?: string[]): Graph {
  return parseGraphYaml(text, issues);
}

export function serializeGraph(graph: Graph, format: GraphFormat): string {
  if (format === 'yaml') return serializeGraphYaml(graph);
  return `${JSON.stringify(roundPositions(graph), null, 2)}\n`;
}
