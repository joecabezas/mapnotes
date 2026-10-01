import { describe, expect, it } from 'vitest';
import { type Graph, GraphError, normalizeGraph } from '../shared/model.ts';
import { formatForPath, parseGraphText, serializeGraph } from '../shared/yaml.ts';

const graph: Graph = normalizeGraph({
  properties: [{ key: 'title', value: 'Demo: "quoted" #hash' }],
  styles: [
    { id: 'svc', target: 'node', name: 'Service', color: '#336699', shape: 'round-rectangle', size: 60, icon: 'lucide:server' },
    { id: 'call', target: 'edge', width: 2, lineStyle: 'dashed', arrow: 'vee', curve: 'bezier' },
  ],
  nodes: [
    { id: 'api', label: 'API', style: 'svc', position: { x: 10, y: -20 }, properties: [{ key: 'owner', value: 'team: core' }] },
    { id: 'db', label: 'Multi\nline', properties: [{ key: 'empty', value: '' }, { key: 'yes', value: 'yes' }] },
  ],
  edges: [{ id: 'e1', source: 'api', target: 'db', label: 'reads', style: 'call', properties: [{ key: '001', value: '1.0' }] }],
});

describe('round trips', () => {
  it.each(['yaml', 'json'] as const)('%s serialization parses back to the same graph', (format) => {
    const text = serializeGraph(graph, format);
    expect(parseGraphText(text)).toEqual(graph);
    // Stable: serializing the parsed graph gives the same text.
    expect(serializeGraph(parseGraphText(text), format)).toBe(text);
  });

  it('JSON output is valid JSON ending in a newline', () => {
    const text = serializeGraph(graph, 'json');
    expect(text.endsWith('\n')).toBe(true);
    expect(JSON.parse(text)).toEqual(graph);
  });

  it('rounds positions when serializing', () => {
    const g = normalizeGraph({ nodes: [{ id: 'a', position: { x: 1.4, y: 2.6 } }] });
    for (const format of ['yaml', 'json'] as const) {
      expect(parseGraphText(serializeGraph(g, format)).nodes[0].position).toEqual({ x: 1, y: 3 });
    }
  });

  it('parses hand-written YAML with mapping properties', () => {
    const g = parseGraphText(`
properties:
  title: Hand written
nodes:
  - id: a
    properties: { size: 3 }
  - id: b
edges:
  - source: a
    target: b
`);
    expect(g.properties).toEqual([{ key: 'title', value: 'Hand written' }]);
    expect(g.nodes[0].properties).toEqual([{ key: 'size', value: '3' }]);
    expect(g.edges[0]).toEqual({ id: 'e1', source: 'a', target: 'b', properties: [] });
  });

  it('parses an empty document as an empty graph', () => {
    for (const text of ['{}', 'null\n', '---\n']) {
      expect(parseGraphText(text)).toEqual({ properties: [], styles: [], nodes: [], edges: [] });
    }
  });

  // Current behavior: js-yaml 5 rejects input with no document at all.
  it('rejects a file with no document (empty or comments only)', () => {
    expect(() => parseGraphText('')).toThrow(/Invalid YAML/);
    expect(() => parseGraphText('# just a comment\n')).toThrow(/Invalid YAML/);
  });
});

describe('parse failures', () => {
  it('wraps YAML syntax errors in GraphError', () => {
    expect(() => parseGraphText('nodes: [')).toThrow(GraphError);
    expect(() => parseGraphText('nodes: [')).toThrow(/^Invalid YAML/);
  });

  it('rejects a non-mapping document', () => {
    expect(() => parseGraphText('- a\n- b\n')).toThrow(/mapping at the top level/);
  });

  it('rejects a truncated JSON file', () => {
    const text = serializeGraph(graph, 'json');
    expect(() => parseGraphText(text.slice(0, text.length / 2))).toThrow(GraphError);
  });
});

describe('formatForPath', () => {
  it('uses JSON only for .json files', () => {
    expect(formatForPath('g.json')).toBe('json');
    expect(formatForPath('G.JSON')).toBe('json');
    expect(formatForPath('g.yaml')).toBe('yaml');
    expect(formatForPath('g.yml')).toBe('yaml');
    expect(formatForPath('g.json.bak')).toBe('yaml');
  });
});
