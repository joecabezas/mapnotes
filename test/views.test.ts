import { describe, expect, it } from 'vitest';
import { editNode, normalizeGraph, removeNode } from '../shared/model';
import { filterGraph, moveNodes, nodeType, normalizeViews } from '../shared/views';
import { parseGraphText, serializeGraph } from '../shared/yaml';

function sample() {
  return normalizeGraph({
    nodes: [
      { id: 'person', label: 'Yan', properties: { type: 'person' }, position: { x: 0, y: 0 } },
      {
        id: 'pr-1',
        label: 'Build',
        style: 'pr-blocked',
        properties: { type: 'pr', status: 'blocked' },
        position: { x: 10, y: 10 },
      },
      { id: 'vendor', properties: { type: 'vendor' } },
      { id: 'source', properties: { type: 'source' } },
    ],
    edges: [
      { id: 'authored', source: 'person', target: 'pr-1', label: 'authors' },
      { id: 'vendor-pr', source: 'pr-1', target: 'vendor', label: 'contributes to' },
      { id: 'report', source: 'source', target: 'person', label: 'reports' },
    ],
    views: [
      {
        id: 'people',
        name: 'People & PRs',
        filters: { types: ['person', 'pr'] },
        positions: { person: { x: 100, y: 200 } },
      },
    ],
  });
}

describe('saved filter views', () => {
  it('shows people/PRs and only edges with visible endpoints without changing the graph', () => {
    const g = sample(),
      before = structuredClone(g);
    const v = filterGraph(g, g.views![0].filters);
    expect(v.nodes.map((n) => n.id)).toEqual(['person', 'pr-1']);
    expect(v.edges.map((e) => e.id)).toEqual(['authored']);
    expect(g).toEqual(before);
  });
  it('combines alternatives within types with text, styles and exact property conditions', () => {
    const g = sample();
    expect(
      filterGraph(g, {
        types: ['person', 'pr'],
        styles: ['pr-blocked'],
        query: 'build',
        properties: [{ key: 'status', value: 'blocked' }],
      }).nodes.map((n) => n.id),
    ).toEqual(['pr-1']);
    expect(filterGraph(g, { properties: [{ key: 'status', value: 'missing' }] }).nodes).toEqual([]);
  });
  it('treats empty selected types, styles and edge labels as no matches', () => {
    const g = sample();
    expect(filterGraph(g, { types: [] }).nodes).toEqual([]);
    expect(filterGraph(g, { styles: [] }).nodes).toEqual([]);
    expect(filterGraph(g, { edgeLabels: [] }).edges).toEqual([]);
    expect(filterGraph(g, {}).nodes).toHaveLength(4);
  });
  it('follows connections in both directions to the bounded depth', () => {
    const g = sample();
    expect(filterGraph(g, { relatedTo: ['vendor'], depth: 1 }).nodes.map((n) => n.id)).toEqual(['pr-1', 'vendor']);
    expect(filterGraph(g, { relatedTo: ['vendor'], depth: 2, types: ['person', 'pr'] }).nodes.map((n) => n.id)).toEqual(
      ['person', 'pr-1'],
    );
    expect(filterGraph(g, { relatedTo: ['missing'] }).nodes).toEqual([]);
  });
  it('filters relationships independently', () => {
    expect(filterGraph(sample(), { edgeLabels: ['authors'] }).edges.map((e) => e.id)).toEqual(['authored']);
  });
  it('adds newly matching nodes dynamically', () => {
    const g = sample();
    g.nodes.push({ id: 'new', label: 'New', properties: [{ key: 'type', value: 'person' }] });
    expect(filterGraph(g, g.views![0].filters).nodes).toHaveLength(3);
  });
  it('infers legacy PR types', () => {
    expect(nodeType({ id: 'x', label: 'x', style: 'pr-merged', properties: [] })).toBe('pr');
    expect(nodeType({ id: 'x', label: 'x', properties: [{ key: 'type', value: 'pr-blocked' }] })).toBe('pr');
  });
  it('keeps view layouts independent of master positions and other views', () => {
    const g = sample();
    g.views!.push({ id: 'other', name: 'Other', filters: {}, positions: { person: { x: 400, y: 500 } } });
    const next = moveNodes(g, { person: { x: 250, y: 300 } }, 'people');
    expect(next.nodes[0].position).toEqual({ x: 0, y: 0 });
    expect(next.views![1].positions!.person).toEqual({ x: 400, y: 500 });
    expect(filterGraph(next, {}, next.views![0].positions).nodes[0].position).toEqual({ x: 250, y: 300 });
    expect(g.views![0].positions!.person).toEqual({ x: 100, y: 200 });
  });
  it('round trips criteria and rounded layout positions in YAML and JSON', () => {
    for (const format of ['yaml', 'json'] as const) {
      const g = sample();
      g.views![0].positions!.person = { x: 1.4, y: 2.6 };
      const back = parseGraphText(serializeGraph(g, format));
      expect(back.views![0].filters).toEqual(g.views![0].filters);
      expect(back.views![0].positions!.person).toEqual({ x: 1, y: 3 });
      expect(back.nodes).toEqual(g.nodes);
    }
  });
  it('keeps legacy files unchanged when no views are supplied', () => {
    expect(normalizeGraph({ nodes: [] })).not.toHaveProperty('views');
  });
  it('reports malformed or unknown filters and duplicate ids rather than broadening views', () => {
    const issues: string[] = [];
    const valid = { id: 'ok', name: 'Valid', filters: { types: [] } };
    expect(
      normalizeViews(
        [
          valid,
          { ...valid, filters: {} },
          { id: 'unknown', name: 'Unknown', filters: { typo: ['person'] } },
          { id: 'bad', name: 'Bad', filters: { types: 'person' } },
        ],
        issues,
      ),
    ).toEqual([valid]);
    expect(issues).toHaveLength(3);
  });
  it('renames saved roots and position keys with nodes', () => {
    const g = sample();
    g.views![0].filters.relatedTo = ['person'];
    const next = editNode(g, { id: 'person', newId: 'renamed' }).graph;
    expect(next.views![0].filters.relatedTo).toEqual(['renamed']);
    expect(next.views![0].positions!.renamed).toEqual({ x: 100, y: 200 });
    expect(next.views![0].positions).not.toHaveProperty('person');
  });
  it('removing a root does not expand its view to the whole graph', () => {
    const g = sample();
    g.views![0].filters.relatedTo = ['person'];
    const next = removeNode(g, 'person').graph;
    expect(next.views![0].filters.relatedTo).toEqual([]);
    expect(filterGraph(next, next.views![0].filters).nodes).toEqual([]);
    expect(next.views![0].positions).not.toHaveProperty('person');
  });
});
