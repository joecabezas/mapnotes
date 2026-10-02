import { describe, expect, it } from 'vitest';
import {
  addEdge,
  addNode,
  clusterMembers,
  editEdge,
  editNode,
  emptyGraph,
  type Graph,
  GraphError,
  normalizeGraph,
  normalizeKeyValues,
  removeNode,
  removeStyle,
  uniqueId,
  upsertStyle,
} from '../shared/model.ts';

function sample(): Graph {
  return normalizeGraph({
    styles: [
      { id: 'big', target: 'node', size: 80 },
      { id: 'dashed', target: 'edge', lineStyle: 'dashed' },
    ],
    nodes: [{ id: 'a' }, { id: 'b', style: 'big' }],
    edges: [{ id: 'ab', source: 'a', target: 'b', style: 'dashed' }],
  });
}

describe('normalizeGraph', () => {
  it('treats empty input as an empty graph', () => {
    expect(normalizeGraph(undefined)).toEqual(emptyGraph());
    expect(normalizeGraph(null)).toEqual(emptyGraph());
  });

  it('rejects a non-mapping top level', () => {
    expect(() => normalizeGraph([])).toThrow(GraphError);
    expect(() => normalizeGraph('text')).toThrow(GraphError);
  });

  it('defaults labels to ids and coerces scalars to strings', () => {
    const g = normalizeGraph({ nodes: [{ id: 1, properties: { n: 2, b: true, z: null } }] });
    expect(g.nodes).toEqual([
      {
        id: '1',
        label: '1',
        properties: [
          { key: 'n', value: '2' },
          { key: 'b', value: 'true' },
          { key: 'z', value: '' },
        ],
      },
    ]);
  });

  it('keeps a position only when both coordinates are numbers', () => {
    const g = normalizeGraph({
      nodes: [
        { id: 'a', position: { x: 1, y: '2' } },
        { id: 'b', position: { x: 1 } },
        { id: 'c', position: { x: 'left', y: 2 } },
      ],
    });
    expect(g.nodes.map((n) => n.position)).toEqual([{ x: 1, y: 2 }, undefined, undefined]);
  });

  it('rejects duplicate node ids', () => {
    expect(() => normalizeGraph({ nodes: [{ id: 'a' }, { id: 'a' }] })).toThrow(/Duplicate node id "a"/);
  });

  it('rejects duplicate edge ids', () => {
    expect(() =>
      normalizeGraph({
        nodes: [{ id: 'a' }, { id: 'b' }],
        edges: [
          { id: 'x', source: 'a', target: 'b' },
          { id: 'x', source: 'b', target: 'a' },
        ],
      }),
    ).toThrow(/Duplicate edge id "x"/);
  });

  it('rejects edges that reference a missing node', () => {
    expect(() => normalizeGraph({ nodes: [{ id: 'a' }], edges: [{ source: 'a', target: 'zz' }] })).toThrow(
      /a->zz references a missing node/,
    );
  });

  it('generates sequential ids for id-less edges', () => {
    const g = normalizeGraph({
      nodes: [{ id: 'a' }, { id: 'b' }],
      edges: [
        { source: 'a', target: 'b' },
        { source: 'b', target: 'a' },
      ],
    });
    expect(g.edges.map((e) => e.id)).toEqual(['e1', 'e2']);
  });

  it('skips generated ids already used by an earlier explicit edge', () => {
    const g = normalizeGraph({
      nodes: [{ id: 'a' }, { id: 'b' }],
      edges: [
        { id: 'e1', source: 'a', target: 'b' },
        { source: 'b', target: 'a' },
      ],
    });
    expect(g.edges.map((e) => e.id)).toEqual(['e1', 'e2']);
  });

  it('does not generate an id that a later explicit edge uses (id-less edge before `id: e1`)', () => {
    const g = normalizeGraph({
      nodes: [{ id: 'a' }, { id: 'b' }],
      edges: [
        { source: 'a', target: 'b' },
        { id: 'e1', source: 'b', target: 'a' },
      ],
    });
    expect(g.edges.map((e) => e.id)).toEqual(['e2', 'e1']);
  });

  it('normalizes styles and drops unknown enum values and bad icons', () => {
    const g = normalizeGraph({
      styles: [
        { id: 'n', shape: 'blob', size: '40', icon: 'lucide:house' },
        { id: 'm', icon: '../evil' },
        { id: 'e', target: 'edge', width: 'wide', arrow: 'vee', curve: 'taxi' },
      ],
    });
    expect(g.styles).toEqual([
      { id: 'n', target: 'node', size: 40, icon: 'lucide:house' },
      { id: 'm', target: 'node' },
      { id: 'e', target: 'edge', arrow: 'vee', curve: 'taxi' },
    ]);
  });

  it('keeps a node border width, including 0, and parses numeric strings', () => {
    const g = normalizeGraph({
      styles: [
        { id: 'thick', borderWidth: '6' },
        { id: 'none', borderWidth: 0 },
        { id: 'bad', borderWidth: 'thin' },
      ],
    });
    expect(g.styles).toEqual([
      { id: 'thick', target: 'node', borderWidth: 6 },
      { id: 'none', target: 'node', borderWidth: 0 },
      { id: 'bad', target: 'node' },
    ]);
  });

  // The dropped entries are reported as diagnostics; see the tests below and test/validation.test.ts.
  it('currently drops malformed entries and keeps the first duplicate style', () => {
    const g = normalizeGraph({
      styles: [{ id: 's', color: 'red' }, { id: 's', color: 'blue' }, { color: 'green' }],
      nodes: [{ id: 'a' }, { label: 'no id' }, 'junk'],
      edges: [{ source: 'a' }, 42],
    });
    expect(g.styles).toEqual([{ id: 's', target: 'node', color: 'red' }]);
    expect(g.nodes.map((n) => n.id)).toEqual(['a']);
    expect(g.edges).toEqual([]);
  });

  it('reports an invalid node as a diagnostic (TODO.md: report invalid graph entries)', () => {
    const issues: string[] = [];
    normalizeGraph({ nodes: [{ id: 'a' }, { label: 'no id' }] }, issues);
    expect(issues).toEqual(['nodes[1] was dropped: it has no "id"']);
  });
  it('reports an invalid edge as a diagnostic (TODO.md: report invalid graph entries)', () => {
    const issues: string[] = [];
    normalizeGraph({ nodes: [{ id: 'a' }], edges: [{ id: 'x', source: 'a' }] }, issues);
    expect(issues).toEqual(['edges[0] ("x") was dropped: it needs both a "source" and a "target"']);
  });
  it('reports a duplicate style id as a diagnostic (TODO.md: report invalid graph entries)', () => {
    const issues: string[] = [];
    normalizeGraph({ styles: [{ id: 's' }, { id: 's' }] }, issues);
    expect(issues).toEqual(['styles[1] ("s") was dropped: duplicate style id "s" (the first one is kept)']);
  });
});

describe('normalizeKeyValues', () => {
  it('accepts a list of pairs, skipping entries without a key', () => {
    expect(normalizeKeyValues([{ key: 'a', value: 1 }, { key: '' }, { value: 'x' }, 'junk', { key: 'b' }])).toEqual([
      { key: 'a', value: '1' },
      { key: 'b', value: '' },
    ]);
  });

  it('accepts a plain mapping', () => {
    expect(normalizeKeyValues({ a: 1, b: 'two' })).toEqual([
      { key: 'a', value: '1' },
      { key: 'b', value: 'two' },
    ]);
  });

  it('returns nothing for other input', () => {
    expect(normalizeKeyValues('x')).toEqual([]);
    expect(normalizeKeyValues(undefined)).toEqual([]);
  });
});

describe('generated ids', () => {
  it('uniqueId picks the lowest free number', () => {
    expect(uniqueId('n', [])).toBe('n1');
    expect(uniqueId('n', ['n1', 'n2', 'n4'])).toBe('n3');
  });

  it('addNode and addEdge generate ids that do not collide', () => {
    let g = normalizeGraph({ nodes: [{ id: 'n1' }, { id: 'n2' }], edges: [{ id: 'e1', source: 'n1', target: 'n2' }] });
    const added = addNode(g, {});
    expect(added.node).toEqual({ id: 'n3', label: 'n3', properties: [] });
    g = added.graph;
    const edge = addEdge(g, { source: 'n3', target: 'n1' }).edge;
    expect(edge.id).toBe('e2');
  });

  it('addNode trims an explicit id and rejects an existing one', () => {
    const g = sample();
    expect(addNode(g, { id: '  c ' }).node.id).toBe('c');
    expect(() => addNode(g, { id: 'a' })).toThrow(/already exists/);
  });
});

describe('graph operations', () => {
  it('never mutate their input', () => {
    const g = sample();
    const before = structuredClone(g);
    addNode(g, { id: 'c', properties: [{ key: 'k', value: 'v' }] });
    editNode(g, { id: 'a', newId: 'z', setProperties: [{ key: 'k', value: 'v' }] });
    removeNode(g, 'a');
    addEdge(g, { source: 'b', target: 'a' });
    editEdge(g, { id: 'ab', label: 'x' });
    upsertStyle(g, { id: 'new' });
    removeStyle(g, 'big');
    expect(g).toEqual(before);
  });

  it('renaming a node rewrites edge endpoints', () => {
    const { graph } = editNode(sample(), { id: 'a', newId: 'z' });
    expect(graph.edges[0]).toMatchObject({ source: 'z', target: 'b' });
  });

  it('removing a node removes its edges', () => {
    const { graph, removedEdges } = removeNode(sample(), 'a');
    expect(removedEdges).toEqual(['ab']);
    expect(graph.edges).toEqual([]);
  });

  it('rejects styles with the wrong target or that do not exist', () => {
    const g = sample();
    expect(() => addNode(g, { style: 'dashed' })).toThrow(/is a edge style, not a node style/);
    expect(() => addEdge(g, { source: 'a', target: 'b', style: 'big' })).toThrow(/not an edge style/);
    expect(() => addNode(g, { style: 'nope' })).toThrow(/does not exist/);
  });

  it('refuses to retarget a style that is in use', () => {
    expect(() => upsertStyle(sample(), { id: 'big', target: 'edge' })).toThrow(/in use by nodes/);
  });

  it('removing a style detaches it from nodes and edges', () => {
    const g = removeStyle(removeStyle(sample(), 'big'), 'dashed');
    expect(g.nodes.every((n) => !('style' in n))).toBe(true);
    expect(g.edges.every((e) => !('style' in e))).toBe(true);
  });
});

describe('clusters', () => {
  const g = normalizeGraph({
    nodes: [{ id: 'hub', position: { x: 5, y: 6 } }, { id: 'a' }, { id: 'b' }, { id: 'far' }, { id: 'zone', cluster: true }],
    edges: [
      { id: 'out', source: 'hub', target: 'a', label: 'keep me' },
      { id: 'in', source: 'b', target: 'hub' },
      { id: 'again', source: 'a', target: 'hub' },
      { id: 'away', source: 'a', target: 'far' },
      { id: 'zz', source: 'zone', target: 'hub' },
    ],
  });

  it('reads the cluster flag from files and leaves it off other nodes', () => {
    expect(g.nodes.find((n) => n.id === 'zone')?.cluster).toBe(true);
    expect('cluster' in g.nodes.find((n) => n.id === 'hub')!).toBe(false);
  });

  it('takes the nodes connected in either direction as members, once each, without other clusters', () => {
    expect(clusterMembers(g, 'hub').sort()).toEqual(['a', 'b']);
    expect(clusterMembers(g, 'zone')).toEqual(['hub']);
    const both = editNode(g, { id: 'hub', cluster: true }).graph;
    expect(clusterMembers(both, 'zone')).toEqual([]);
    expect(clusterMembers(both, 'hub').sort()).toEqual(['a', 'b']);
  });

  it('converts a node to a cluster and back without changing anything else', () => {
    const clustered = editNode(g, { id: 'hub', cluster: true }).graph;
    expect(clustered.nodes.find((n) => n.id === 'hub')?.cluster).toBe(true);
    expect(clustered.edges).toEqual(g.edges);
    const back = editNode(clustered, { id: 'hub', cluster: false }).graph;
    expect(back).toEqual(g);
  });
});
