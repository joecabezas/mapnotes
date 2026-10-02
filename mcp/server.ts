// MapNotes MCP server (stdio).
//
// Usage: tsx mcp/server.ts [graph-file]
//
// When a graph file is open, every change is written to it immediately.
// Before each operation the file is re-read, so edits made in the browser are
// never overwritten with stale data. If the file disappears after it has been
// read or written, operations fail instead of recreating it with only the new
// change; the last known graph is kept so save_graph can recover it.
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readGraphFileIfExists, writeGraphFile } from '../shared/fileStore.ts';
import {
  ARROW_SHAPES,
  CURVE_STYLES,
  addEdge,
  addNode,
  editEdge,
  editGraphProperties,
  editNode,
  emptyGraph,
  type Graph,
  type GraphEdge,
  type GraphNode,
  type KeyValue,
  LINE_STYLES,
  NODE_SHAPES,
  STYLE_LIMITS,
  removeEdge,
  removeNode,
  removeStyle,
  upsertStyle,
  validateStyleInput,
} from '../shared/model.ts';
import { DEFAULT_FIND_LIMIT, MAX_FIND_LIMIT, findNodes } from '../shared/search.ts';
import { formatForPath, serializeGraph } from '../shared/yaml.ts';

let currentFile: string | undefined;
let memoryGraph: Graph = emptyGraph();
/** True once currentFile has existed on disk (read or written); its disappearance is then an error. */
let linked = false;

class MissingFileError extends Error {}

/** Entries of the current file that could not be read (and would be lost if it were rewritten). */
let fileIssues: string[] = [];

/** Makes `file` the current file. A missing file starts an empty graph. */
async function open(file: string): Promise<Graph> {
  const issues: string[] = [];
  const graph = await readGraphFileIfExists(file, issues);
  currentFile = file;
  linked = graph !== undefined;
  memoryGraph = graph ?? emptyGraph();
  fileIssues = issues;
  return memoryGraph;
}

// Tool calls can arrive concurrently. Every handler that reads the graph and
// then writes a replacement (or switches the current file) runs through this
// queue, so two calls never read the same revision and the later write never
// discards the earlier edit.
let queue: Promise<unknown> = Promise.resolve();

/** Wraps a handler so it runs only after all previously queued handlers finish. */
function exclusive<A, R>(fn: (args: A) => Promise<R>) {
  return (args: A): Promise<R> => {
    const run = queue.then(() => fn(args));
    queue = run.catch(() => {});
    return run;
  };
}

async function current(): Promise<Graph> {
  if (!currentFile) return memoryGraph;
  const issues: string[] = [];
  const graph = await readGraphFileIfExists(currentFile, issues);
  if (graph) {
    linked = true;
    memoryGraph = graph;
    fileIssues = issues;
    return graph;
  }
  if (linked) {
    throw new MissingFileError(
      `${currentFile} was moved or deleted. The last known graph (${summary(memoryGraph)}) is kept in memory: call save_graph to write it back (optionally to a new path), or load_graph to open another file.`,
    );
  }
  return memoryGraph;
}

function issueList(issues: string[]): string {
  return issues.map((i) => `\n- ${i}`).join('');
}

// Automatic saves never drop entries silently: an explicit save_graph is needed to overwrite such a file.
async function commit(graph: Graph): Promise<void> {
  if (currentFile && fileIssues.length) {
    throw new Error(
      `Not saved: ${currentFile} has ${fileIssues.length} invalid entr${fileIssues.length === 1 ? 'y' : 'ies'} that would be lost:${issueList(fileIssues)}\nFix the file, or call save_graph to overwrite it without them.`,
    );
  }
  memoryGraph = graph;
  if (currentFile) {
    await writeGraphFile(currentFile, graph);
    linked = true;
  }
}

function where(): string {
  return currentFile ? `saved to ${currentFile}` : 'in memory only — call save_graph to persist';
}

function summary(g: Graph): string {
  return `${g.nodes.length} node(s), ${g.edges.length} edge(s), ${g.styles.length} style(s), ${g.properties.length} graph propert${g.properties.length === 1 ? 'y' : 'ies'}`;
}

function props(list: KeyValue[]): string {
  return list.map((p) => `${p.key}=${p.value}`).join(', ');
}

function describeEdge(e: GraphEdge): string {
  const label = e.label ? ` "${e.label}"` : '';
  const style = e.style ? ` [style ${e.style}]` : '';
  const extra = e.properties.length ? ` {${props(e.properties)}}` : '';
  return `"${e.id}" ${e.source} → ${e.target}${label}${style}${extra}`;
}

function describeNode(n: GraphNode): string {
  const style = n.style ? ` [style ${n.style}]` : '';
  const pos = n.position ? ` at (${n.position.x}, ${n.position.y})` : '';
  const cluster = n.cluster ? ' [cluster]' : '';
  const extra = n.properties.length ? ` {${props(n.properties)}}` : '';
  return `"${n.id}" "${n.label}"${style}${cluster}${pos}${extra}`;
}

function counts(g: Graph) {
  return { nodes: g.nodes.length, edges: g.edges.length, styles: g.styles.length, properties: g.properties.length };
}

/** A tool result: concise text for people plus the same data as structured content. */
const ok = (text: string, data: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text }],
  structuredContent: data,
});
const fail = (err: unknown) => ({
  content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }],
  isError: true,
});

/** Wraps a handler so thrown errors become MCP tool errors. */
function safe<A>(fn: (args: A) => Promise<ReturnType<typeof ok>>) {
  return async (args: A) => {
    try {
      return await fn(args);
    } catch (err) {
      return fail(err);
    }
  };
}

const kv = z.object({ key: z.string(), value: z.string() });
const kvList = z.array(kv);
const position = z.object({ x: z.number(), y: z.number() });

// Output schemas: the structured content returned alongside each tool's text.
const fileOut = z.string().nullable().describe('Current graph file; null when the graph is in memory only');
const issuesOut = z.array(z.string()).describe('Invalid file entries that were skipped when reading it');
const countsOut = z.object({ nodes: z.number(), edges: z.number(), styles: z.number(), properties: z.number() });
const nodeOut = z.object({
  id: z.string(),
  label: z.string(),
  style: z.string().optional(),
  position: position.optional(),
  cluster: z.boolean().optional(),
  properties: kvList,
});
const edgeOut = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  label: z.string().optional(),
  style: z.string().optional(),
  properties: kvList,
});
const styleOut = z.looseObject({ id: z.string(), target: z.enum(['node', 'edge']) });
const graphOut = z.object({
  properties: kvList,
  styles: z.array(styleOut),
  nodes: z.array(nodeOut),
  edges: z.array(edgeOut),
});

const server = new McpServer({ name: 'mapnotes', version: '0.1.0' });

server.registerTool(
  'load_graph',
  {
    title: 'Load graph',
    description:
      'Open a graph file (YAML, or JSON if it ends in .json). It becomes the current file: all later changes are saved to it automatically. A missing file starts an empty graph.',
    inputSchema: { path: z.string().describe('Path to the graph file') },
    outputSchema: { file: z.string(), counts: countsOut, issues: issuesOut },
  },
  safe(exclusive(async ({ path: p }) => {
    const file = path.resolve(p);
    const graph = await open(file);
    const issues = fileIssues;
    const data = { file, counts: counts(graph), issues };
    if (!issues.length) return ok(`Loaded ${file}: ${summary(graph)}`, data);
    return ok(
      `Loaded ${file}: ${summary(graph)}\nWarning: ${issues.length} invalid entr${issues.length === 1 ? 'y was' : 'ies were'} skipped:${issueList(issues)}\nChanges will not be saved automatically until the file is fixed or save_graph is called to overwrite it without them.`,
      data,
    );
  })),
);

server.registerTool(
  'save_graph',
  {
    title: 'Save graph',
    description:
      'Save the current graph. With a path, saves a copy there (format from the extension: .json → JSON, otherwise YAML) and makes it the current file.',
    inputSchema: { path: z.string().optional().describe('Destination file; defaults to the current file') },
    outputSchema: { file: z.string(), format: z.enum(['yaml', 'json']), counts: countsOut, dropped: issuesOut },
  },
  safe(exclusive(async ({ path: p }) => {
    // A vanished current file is recovered from the last known graph.
    const graph = await current().catch((err) => {
      if (err instanceof MissingFileError) return memoryGraph;
      throw err;
    });
    const dropped = currentFile ? fileIssues : [];
    const file = p ? path.resolve(p) : currentFile;
    if (!file) throw new Error('No current file; pass a path');
    await writeGraphFile(file, graph);
    currentFile = file;
    linked = true;
    memoryGraph = graph;
    fileIssues = [];
    const format = formatForPath(file);
    const note = dropped.length ? `\nDropped ${dropped.length} invalid entr${dropped.length === 1 ? 'y' : 'ies'}:${issueList(dropped)}` : '';
    return ok(`Saved ${summary(graph)} to ${file} (${format})${note}`, { file, format, counts: counts(graph), dropped });
  })),
);

server.registerTool(
  'get_graph',
  {
    title: 'Get graph',
    description:
      'Return the whole current graph (properties, styles, nodes, edges). YAML output starts with a comment naming the current file; JSON output is plain JSON.',
    inputSchema: { format: z.enum(['yaml', 'json']).optional().describe('Output format, default yaml') },
    outputSchema: { file: fileOut, graph: graphOut, issues: issuesOut },
    annotations: { readOnlyHint: true },
  },
  safe(async ({ format }) => {
    const graph = await current();
    const issues = currentFile ? fileIssues : [];
    const data = { file: currentFile ?? null, graph, issues };
    if (format === 'json') return ok(serializeGraph(graph, 'json'), data);
    const warnings = issues.map((i) => `# Warning: ${i}\n`).join('');
    const header = (currentFile ? `# ${currentFile}\n` : '# (unsaved graph)\n') + warnings;
    return ok(header + serializeGraph(graph, 'yaml'), data);
  }),
);

server.registerTool(
  'get_node',
  {
    title: 'Get node',
    description: 'Return one node with its properties and all edges connected to it.',
    inputSchema: { id: z.string() },
    outputSchema: { node: nodeOut, edges: z.array(edgeOut) },
    annotations: { readOnlyHint: true },
  },
  safe(async ({ id }) => {
    const graph = await current();
    const node = graph.nodes.find((n) => n.id === id);
    if (!node) throw new Error(`Node "${id}" does not exist`);
    const edges = graph.edges.filter((e) => e.source === id || e.target === id);
    const lines = [`Node ${describeNode(node)}`, `${edges.length} connected edge(s)`, ...edges.map((e) => `- ${describeEdge(e)}`)];
    return ok(lines.join('\n'), { node, edges });
  }),
);

server.registerTool(
  'find_nodes',
  {
    title: 'Find nodes',
    description:
      'Search or list nodes without fetching the whole graph. Returns ids with brief summaries (label, style, property and edge counts, matched fields), sorted by id; call get_node for details. All filters are optional and combine with AND; with none, lists every node. If nextCursor is returned, pass it as cursor to get the next page.',
    inputSchema: {
      query: z.string().optional().describe('Case-insensitive text matched against id, label, property keys and values'),
      propertyKey: z.string().optional().describe('Only nodes with this property key (case-insensitive, exact)'),
      propertyValue: z
        .string()
        .optional()
        .describe('Only nodes with a property value containing this text (of propertyKey, if given)'),
      style: z.string().optional().describe('Only nodes with this style id; "" for nodes without a style'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_FIND_LIMIT)
        .optional()
        .describe(`Page size, default ${DEFAULT_FIND_LIMIT}, max ${MAX_FIND_LIMIT}`),
      cursor: z.string().optional().describe('nextCursor from the previous page'),
    },
    outputSchema: {
      total: z.number(),
      nodes: z.array(
        z.object({
          id: z.string(),
          label: z.string(),
          style: z.string().optional(),
          properties: z.number(),
          edges: z.number(),
          matched: z.array(z.string()).optional(),
        }),
      ),
      nextCursor: z.string().optional(),
    },
    annotations: { readOnlyHint: true },
  },
  safe(async (args) => {
    const result = findNodes(await current(), args);
    return ok(JSON.stringify(result, null, 2), { ...result });
  }),
);

server.registerTool(
  'add_node',
  {
    title: 'Add node',
    description: 'Add a node. The id is generated if omitted; the label defaults to the id.',
    inputSchema: {
      id: z.string().optional(),
      label: z.string().optional(),
      style: z.string().optional().describe('Id of a node style from the graph styles'),
      position: position
        .optional()
        .describe('Usually omit: the web app places new nodes next to their neighbours, and lays out graphs that have no positions at all'),
      cluster: z.boolean().optional().describe('true draws the node as a zone (cluster) around the nodes connected to it, hiding its own edges; false draws it as a node again'),
      properties: kvList.optional(),
    },
    outputSchema: { node: nodeOut, file: fileOut },
  },
  safe(exclusive(async (args) => {
    const { graph, node } = addNode(await current(), args);
    await commit(graph);
    return ok(`Added node "${node.id}" (${where()})`, { node, file: currentFile ?? null });
  })),
);

server.registerTool(
  'edit_node',
  {
    title: 'Edit node',
    description:
      'Edit a node. Only the given fields change. setProperties adds/overwrites keys, removeProperties deletes keys, properties replaces the whole list. Renaming (newId) updates connected edges. style "" clears the style.',
    inputSchema: {
      id: z.string(),
      newId: z.string().optional(),
      label: z.string().optional(),
      style: z.string().optional(),
      position: position.optional(),
      cluster: z.boolean().optional().describe('true draws the node as a zone (cluster) around the nodes connected to it, hiding its own edges; false draws it as a node again'),
      setProperties: kvList.optional(),
      removeProperties: z.array(z.string()).optional(),
      properties: kvList.optional(),
    },
    outputSchema: { node: nodeOut, file: fileOut },
  },
  safe(exclusive(async (args) => {
    const { graph, node } = editNode(await current(), args);
    await commit(graph);
    return ok(`Updated node ${describeNode(node)} (${where()})`, { node, file: currentFile ?? null });
  })),
);

server.registerTool(
  'remove_node',
  {
    title: 'Remove node',
    description: 'Remove a node and every edge connected to it.',
    inputSchema: { id: z.string() },
    outputSchema: { removedNode: z.string(), removedEdges: z.array(z.string()), file: fileOut },
    annotations: { destructiveHint: true },
  },
  safe(exclusive(async ({ id }) => {
    const { graph, removedEdges } = removeNode(await current(), id);
    await commit(graph);
    const extra = removedEdges.length ? `, plus edge(s) ${removedEdges.join(', ')}` : '';
    return ok(`Removed node "${id}"${extra} (${where()})`, { removedNode: id, removedEdges, file: currentFile ?? null });
  })),
);

server.registerTool(
  'add_edge',
  {
    title: 'Add edge',
    description: 'Connect two existing nodes. The id is generated if omitted.',
    inputSchema: {
      source: z.string().describe('Source node id'),
      target: z.string().describe('Target node id'),
      id: z.string().optional(),
      label: z.string().optional(),
      style: z.string().optional().describe('Id of an edge style from the graph styles'),
      properties: kvList.optional(),
    },
    outputSchema: { edge: edgeOut, file: fileOut },
  },
  safe(exclusive(async (args) => {
    const { graph, edge } = addEdge(await current(), args);
    await commit(graph);
    return ok(`Added edge "${edge.id}" ${edge.source} → ${edge.target} (${where()})`, { edge, file: currentFile ?? null });
  })),
);

server.registerTool(
  'edit_edge',
  {
    title: 'Edit edge',
    description:
      'Edit an edge: endpoints, label, style, id or properties. Only the given fields change; "" clears label/style.',
    inputSchema: {
      id: z.string(),
      newId: z.string().optional(),
      source: z.string().optional(),
      target: z.string().optional(),
      label: z.string().optional(),
      style: z.string().optional(),
      setProperties: kvList.optional(),
      removeProperties: z.array(z.string()).optional(),
      properties: kvList.optional(),
    },
    outputSchema: { edge: edgeOut, file: fileOut },
  },
  safe(exclusive(async (args) => {
    const { graph, edge } = editEdge(await current(), args);
    await commit(graph);
    return ok(`Updated edge ${describeEdge(edge)} (${where()})`, { edge, file: currentFile ?? null });
  })),
);

server.registerTool(
  'remove_edge',
  {
    title: 'Remove edge',
    description: 'Remove an edge by id.',
    inputSchema: { id: z.string() },
    outputSchema: { removedEdge: z.string(), file: fileOut },
    annotations: { destructiveHint: true },
  },
  safe(exclusive(async ({ id }) => {
    await commit(removeEdge(await current(), id));
    return ok(`Removed edge "${id}" (${where()})`, { removedEdge: id, file: currentFile ?? null });
  })),
);

server.registerTool(
  'edit_graph_properties',
  {
    title: 'Edit graph properties',
    description:
      'Edit the key/value properties of the graph itself. set adds/overwrites keys, remove deletes keys, properties replaces the whole list. "title" names the graph (keep it short) and "subtitle" is shown under it.',
    inputSchema: {
      set: kvList.optional(),
      remove: z.array(z.string()).optional(),
      properties: kvList.optional(),
    },
    outputSchema: { properties: kvList, file: fileOut },
  },
  safe(exclusive(async (args) => {
    const graph = editGraphProperties(await current(), args);
    await commit(graph);
    return ok(`Graph properties: ${JSON.stringify(graph.properties)} (${where()})`, {
      properties: graph.properties,
      file: currentFile ?? null,
    });
  })),
);

server.registerTool(
  'set_style',
  {
    title: 'Create or replace style',
    description:
      'Create or replace (by id) a reusable style in the graph styles. Assign it via the "style" field of nodes/edges. Colors are CSS colors, e.g. "#7aa2f7". Fields marked "Nodes only" / "Edges only" are rejected for the other target.',
    inputSchema: {
      id: z.string(),
      target: z.enum(['node', 'edge']),
      name: z.string().optional(),
      color: z.string().optional().describe('Node fill / edge line color'),
      textColor: z.string().optional(),
      borderColor: z.string().optional().describe('Nodes only'),
      borderWidth: z
        .number()
        .min(STYLE_LIMITS.borderWidth.min)
        .max(STYLE_LIMITS.borderWidth.max)
        .optional()
        .describe(`Nodes only, outline width in px, ${STYLE_LIMITS.borderWidth.min}-${STYLE_LIMITS.borderWidth.max} (default 2)`),
      shape: z.enum(NODE_SHAPES).optional().describe('Nodes only'),
      size: z
        .number()
        .min(STYLE_LIMITS.size.min)
        .max(STYLE_LIMITS.size.max)
        .optional()
        .describe(`Nodes only, in px, ${STYLE_LIMITS.size.min}-${STYLE_LIMITS.size.max} (default 36)`),
      icon: z
        .string()
        .optional()
        .describe(
          'Nodes only, icon drawn inside the node. A full-color brand logo from svgl by its library file name without .svg (https://svgl.app), e.g. "slack", "linear", "github_dark"; or a Lucide line icon as "lucide:<name>" (https://lucide.dev/icons), e.g. "lucide:folder", "lucide:bug"',
        ),
      iconColor: z.string().optional().describe('Nodes only, color of Lucide icons (default: black or white to suit the fill)'),
      iconSize: z
        .number()
        .min(STYLE_LIMITS.iconSize.min)
        .max(STYLE_LIMITS.iconSize.max)
        .optional()
        .describe(
          `Nodes only, icon size as a percentage of the node, ${STYLE_LIMITS.iconSize.min}-${STYLE_LIMITS.iconSize.max} (default 70)`,
        ),
      width: z
        .number()
        .min(STYLE_LIMITS.width.min)
        .max(STYLE_LIMITS.width.max)
        .optional()
        .describe(`Edges only, line width in px, ${STYLE_LIMITS.width.min}-${STYLE_LIMITS.width.max}`),
      lineStyle: z.enum(LINE_STYLES).optional().describe('Edges only'),
      arrow: z.enum(ARROW_SHAPES).optional().describe('Edges only, target arrow shape'),
      curve: z.enum(CURVE_STYLES).optional().describe('Edges only'),
    },
    outputSchema: { style: styleOut, file: fileOut },
  },
  safe(exclusive(async (args) => {
    validateStyleInput(args);
    const { graph, style } = upsertStyle(await current(), args);
    await commit(graph);
    return ok(`Style "${style.id}" saved (${where()})`, { style, file: currentFile ?? null });
  })),
);

server.registerTool(
  'remove_style',
  {
    title: 'Remove style',
    description: 'Remove a style; nodes/edges using it fall back to the default look.',
    inputSchema: { id: z.string() },
    outputSchema: { removedStyle: z.string(), file: fileOut },
    annotations: { destructiveHint: true },
  },
  safe(exclusive(async ({ id }) => {
    await commit(removeStyle(await current(), id));
    return ok(`Removed style "${id}" (${where()})`, { removedStyle: id, file: currentFile ?? null });
  })),
);

const initial = process.argv[2];
if (initial) {
  await open(path.resolve(initial));
  for (const issue of fileIssues) console.error(`Warning: ${currentFile}: ${issue}`);
}

await server.connect(new StdioServerTransport());
console.error(`mapnotes MCP server ready${currentFile ? ` (file: ${currentFile})` : ''}`);
