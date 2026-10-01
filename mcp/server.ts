// MapNotes MCP server (stdio).
//
// Usage: tsx mcp/server.ts [graph.yaml]
//
// When a graph file is open, every change is written to it immediately.
// Before each operation the file is re-read, so edits made in the browser are
// never overwritten with stale data.
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readGraphFile, writeGraphFile } from '../shared/fileStore.ts';
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
  LINE_STYLES,
  NODE_SHAPES,
  removeEdge,
  removeNode,
  removeStyle,
  upsertStyle,
} from '../shared/model.ts';
import { formatForPath, serializeGraph } from '../shared/yaml.ts';

let currentFile: string | undefined;
let memoryGraph: Graph = emptyGraph();

async function current(): Promise<Graph> {
  return currentFile ? readGraphFile(currentFile) : memoryGraph;
}

async function commit(graph: Graph): Promise<void> {
  memoryGraph = graph;
  if (currentFile) await writeGraphFile(currentFile, graph);
}

function where(): string {
  return currentFile ? `saved to ${currentFile}` : 'in memory only — call save_graph to persist';
}

function summary(g: Graph): string {
  return `${g.nodes.length} node(s), ${g.edges.length} edge(s), ${g.styles.length} style(s), ${g.properties.length} graph propert${g.properties.length === 1 ? 'y' : 'ies'}`;
}

const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] });
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

const server = new McpServer({ name: 'mapnotes', version: '0.1.0' });

server.registerTool(
  'load_graph',
  {
    title: 'Load graph',
    description:
      'Open a graph file (YAML, or JSON if it ends in .json). It becomes the current file: all later changes are saved to it automatically. A missing file starts an empty graph.',
    inputSchema: { path: z.string().describe('Path to the graph file') },
  },
  safe(async ({ path: p }) => {
    const file = path.resolve(p);
    const graph = await readGraphFile(file);
    currentFile = file;
    memoryGraph = graph;
    return ok(`Loaded ${file}: ${summary(graph)}`);
  }),
);

server.registerTool(
  'save_graph',
  {
    title: 'Save graph',
    description:
      'Save the current graph. With a path, saves a copy there (format from the extension: .json → JSON, otherwise YAML) and makes it the current file.',
    inputSchema: { path: z.string().optional().describe('Destination file; defaults to the current file') },
  },
  safe(async ({ path: p }) => {
    const graph = await current();
    const file = p ? path.resolve(p) : currentFile;
    if (!file) throw new Error('No current file; pass a path');
    await writeGraphFile(file, graph);
    currentFile = file;
    return ok(`Saved ${summary(graph)} to ${file} (${formatForPath(file)})`);
  }),
);

server.registerTool(
  'get_graph',
  {
    title: 'Get graph',
    description:
      'Return the whole current graph (properties, styles, nodes, edges). YAML output starts with a comment naming the current file; JSON output is plain JSON.',
    inputSchema: { format: z.enum(['yaml', 'json']).optional().describe('Output format, default yaml') },
    annotations: { readOnlyHint: true },
  },
  safe(async ({ format }) => {
    const graph = await current();
    if (format === 'json') return ok(serializeGraph(graph, 'json'));
    const header = currentFile ? `# ${currentFile}\n` : '# (unsaved graph)\n';
    return ok(header + serializeGraph(graph, 'yaml'));
  }),
);

server.registerTool(
  'get_node',
  {
    title: 'Get node',
    description: 'Return one node with its properties and all edges connected to it.',
    inputSchema: { id: z.string() },
    annotations: { readOnlyHint: true },
  },
  safe(async ({ id }) => {
    const graph = await current();
    const node = graph.nodes.find((n) => n.id === id);
    if (!node) throw new Error(`Node "${id}" does not exist`);
    const edges = graph.edges.filter((e) => e.source === id || e.target === id);
    return ok(JSON.stringify({ node, edges }, null, 2));
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
      properties: kvList.optional(),
    },
  },
  safe(async (args) => {
    const { graph, node } = addNode(await current(), args);
    await commit(graph);
    return ok(`Added node "${node.id}" (${where()})`);
  }),
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
      setProperties: kvList.optional(),
      removeProperties: z.array(z.string()).optional(),
      properties: kvList.optional(),
    },
  },
  safe(async (args) => {
    const { graph, node } = editNode(await current(), args);
    await commit(graph);
    return ok(`Updated node "${node.id}" (${where()})\n${JSON.stringify(node, null, 2)}`);
  }),
);

server.registerTool(
  'remove_node',
  {
    title: 'Remove node',
    description: 'Remove a node and every edge connected to it.',
    inputSchema: { id: z.string() },
    annotations: { destructiveHint: true },
  },
  safe(async ({ id }) => {
    const { graph, removedEdges } = removeNode(await current(), id);
    await commit(graph);
    const extra = removedEdges.length ? `, plus edge(s) ${removedEdges.join(', ')}` : '';
    return ok(`Removed node "${id}"${extra} (${where()})`);
  }),
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
  },
  safe(async (args) => {
    const { graph, edge } = addEdge(await current(), args);
    await commit(graph);
    return ok(`Added edge "${edge.id}" ${edge.source} → ${edge.target} (${where()})`);
  }),
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
  },
  safe(async (args) => {
    const { graph, edge } = editEdge(await current(), args);
    await commit(graph);
    return ok(`Updated edge "${edge.id}" (${where()})\n${JSON.stringify(edge, null, 2)}`);
  }),
);

server.registerTool(
  'remove_edge',
  {
    title: 'Remove edge',
    description: 'Remove an edge by id.',
    inputSchema: { id: z.string() },
    annotations: { destructiveHint: true },
  },
  safe(async ({ id }) => {
    await commit(removeEdge(await current(), id));
    return ok(`Removed edge "${id}" (${where()})`);
  }),
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
  },
  safe(async (args) => {
    const graph = editGraphProperties(await current(), args);
    await commit(graph);
    return ok(`Graph properties: ${JSON.stringify(graph.properties)} (${where()})`);
  }),
);

server.registerTool(
  'set_style',
  {
    title: 'Create or replace style',
    description:
      'Create or replace (by id) a reusable style in the graph styles. Assign it via the "style" field of nodes/edges. Colors are CSS colors, e.g. "#7aa2f7".',
    inputSchema: {
      id: z.string(),
      target: z.enum(['node', 'edge']),
      name: z.string().optional(),
      color: z.string().optional().describe('Node fill / edge line color'),
      textColor: z.string().optional(),
      borderColor: z.string().optional().describe('Nodes only'),
      shape: z.enum(NODE_SHAPES).optional().describe('Nodes only'),
      size: z.number().optional().describe('Nodes only, in px (default 36)'),
      icon: z
        .string()
        .optional()
        .describe(
          'Nodes only, icon drawn inside the node. A full-color brand logo from svgl by its library file name without .svg (https://svgl.app), e.g. "slack", "linear", "github_dark"; or a Lucide line icon as "lucide:<name>" (https://lucide.dev/icons), e.g. "lucide:folder", "lucide:bug"',
        ),
      iconColor: z.string().optional().describe('Nodes only, color of Lucide icons (default: black or white to suit the fill)'),
      iconSize: z.number().optional().describe('Nodes only, icon size as a percentage of the node (default 70)'),
      width: z.number().optional().describe('Edges only, line width in px'),
      lineStyle: z.enum(LINE_STYLES).optional().describe('Edges only'),
      arrow: z.enum(ARROW_SHAPES).optional().describe('Edges only, target arrow shape'),
      curve: z.enum(CURVE_STYLES).optional().describe('Edges only'),
    },
  },
  safe(async (args) => {
    const { graph, style } = upsertStyle(await current(), args);
    await commit(graph);
    return ok(`Style "${style.id}" saved (${where()})`);
  }),
);

server.registerTool(
  'remove_style',
  {
    title: 'Remove style',
    description: 'Remove a style; nodes/edges using it fall back to the default look.',
    inputSchema: { id: z.string() },
    annotations: { destructiveHint: true },
  },
  safe(async ({ id }) => {
    await commit(removeStyle(await current(), id));
    return ok(`Removed style "${id}" (${where()})`);
  }),
);

const initial = process.argv[2];
if (initial) {
  currentFile = path.resolve(initial);
  memoryGraph = await readGraphFile(currentFile);
}

await server.connect(new StdioServerTransport());
console.error(`mapnotes MCP server ready${currentFile ? ` (file: ${currentFile})` : ''}`);
