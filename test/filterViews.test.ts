import { describe, expect, it } from 'vitest';
import {
  criteriaIsEmpty,
  inferNodeKind,
  parseSavedViews,
  projectGraph,
  storeNodePositions,
  viewsAfterNodeRemoval,
  viewsAfterNodeRename,
} from '../shared/filterViews.ts';
import { editNode, emptyGraph, normalizeGraph, removeNode } from '../shared/model.ts';
import { parseGraphYaml, serializeGraphYaml } from '../shared/yaml.ts';

function sampleGraph() {
  return normalizeGraph({
    properties: [{ key: 'title', value: 'Test' }],
    nodes: [
      { id: 'alice', label: 'Alice', style: 'person', properties: [{ key: 'type', value: 'person' }] },
      { id: 'pr-1', label: 'PR 1', style: 'pr', properties: [{ key: 'type', value: 'pr' }] },
      { id: 'bob', label: 'Bob', properties: [{ key: 'team', value: 'core' }] },
    ],
    edges: [
      { id: 'e1', source: 'alice', target: 'pr-1', label: 'authors' },
      { id: 'e2', source: 'bob', target: 'pr-1', label: 'reviews' },
    ],
    views: [
      {
        id: 'people',
        name: 'People',
        filters: { types: ['person'] },
        positions: { alice: { x: 10, y: 20 } },
      },
    ],
  });
}

describe('inferNodeKind', () => {
  it('uses the type property and groups pull requests', () => {
    const g = sampleGraph();
    expect(inferNodeKind(g.nodes[0])).toBe('person');
    expect(inferNodeKind(g.nodes[1])).toBe('pr');
  });

  it('falls back to style and id', () => {
    const g = sampleGraph();
    expect(inferNodeKind(g.nodes[2])).toBe('node');
  });
});

describe('projectGraph', () => {
  it('filters nodes by type', () => {
    const g = sampleGraph();
    expect(projectGraph(g, { types: ['person'] }).nodes.map((n) => n.id)).toEqual(['alice']);
  });

  it('filters edges by label when both endpoints are visible', () => {
    const g = sampleGraph();
    const visible = projectGraph(g, { edgeLabels: ['authors'] });
    expect(visible.edges.map((e) => e.id)).toEqual(['e1']);
  });

  it('applies proximity in both directions', () => {
    const g = sampleGraph();
    const visible = projectGraph(g, { relatedTo: ['pr-1'], depth: 1 });
    expect(visible.nodes.map((n) => n.id).sort()).toEqual(['alice', 'bob', 'pr-1']);
  });

  it('overlays per-view positions without mutating the source graph', () => {
    const g = sampleGraph();
    const visible = projectGraph(g, { types: ['person'] }, { alice: { x: 99, y: 88 } });
    expect(visible.nodes[0].position).toEqual({ x: 99, y: 88 });
    expect(g.nodes.find((n) => n.id === 'alice')?.position).toBeUndefined();
  });

  it('applies a saved layout even when filter criteria are empty', () => {
    const g = sampleGraph();
    const visible = projectGraph(g, {}, { alice: { x: 42, y: 24 } });
    expect(visible.nodes.find((n) => n.id === 'alice')?.position).toEqual({ x: 42, y: 24 });
    expect(visible.nodes).toHaveLength(g.nodes.length);
  });

  it('treats an empty type list as matching nothing', () => {
    const g = sampleGraph();
    expect(projectGraph(g, { types: [] }).nodes).toEqual([]);
  });
});

describe('parseSavedViews', () => {
  it('accepts valid views and drops bad entries', () => {
    const issues: string[] = [];
    const views = parseSavedViews(
      [
        { id: 'a', name: 'A', filters: { query: 'x' } },
        { id: 'a', name: 'Dup', filters: {} },
        { name: 'No id', filters: {} },
      ],
      issues,
    );
    expect(views).toHaveLength(1);
    expect(issues).toHaveLength(2);
  });
});

describe('storeNodePositions', () => {
  it('writes to a saved view layout when a view id is given', () => {
    const g = sampleGraph();
    const next = storeNodePositions(g, { alice: { x: 5, y: 6 } }, 'people');
    expect(next.views?.[0].positions?.alice).toEqual({ x: 5, y: 6 });
    expect(next.nodes.find((n) => n.id === 'alice')?.position).toBeUndefined();
  });

  it('writes to base nodes when no view is active', () => {
    const g = sampleGraph();
    const next = storeNodePositions(g, { bob: { x: 1, y: 2 } });
    expect(next.nodes.find((n) => n.id === 'bob')?.position).toEqual({ x: 1, y: 2 });
  });
});

describe('view maintenance on node edits', () => {
  it('renames layout keys and proximity seeds', () => {
    const views = viewsAfterNodeRename(sampleGraph().views!, 'alice', 'ann');
    expect(views[0].positions?.ann).toEqual({ x: 10, y: 20 });
    expect(views[0].positions?.alice).toBeUndefined();
  });

  it('removes layout keys and proximity seeds when a node is deleted', () => {
    let g = normalizeGraph({
      nodes: [{ id: 'alice' }, { id: 'bob' }, { id: 'pr-1' }],
      edges: [{ id: 'e1', source: 'alice', target: 'pr-1' }],
      views: [{ id: 'near', name: 'Near alice', filters: { relatedTo: ['alice'] }, positions: { alice: { x: 10, y: 20 } } }],
    });
    g = editNode(g, { id: 'alice', newId: 'ann' }).graph;
    expect(g.views?.[0].positions?.ann).toEqual({ x: 10, y: 20 });
    expect(g.views?.[0].filters.relatedTo).toEqual(['ann']);
    g = removeNode(g, 'ann').graph;
    expect(g.views?.[0].positions?.ann).toBeUndefined();
    expect(g.views?.[0].filters.relatedTo).toEqual([]);
    expect(projectGraph(g, g.views![0].filters).nodes).toEqual([]);
  });
});

describe('yaml round trip', () => {
  it('preserves views through serialize and parse', () => {
    const g = sampleGraph();
    const again = parseGraphYaml(serializeGraphYaml(g));
    expect(again.views).toEqual(g.views);
  });
});

describe('criteriaIsEmpty', () => {
  it('detects an unrestricted view', () => {
    expect(criteriaIsEmpty({})).toBe(true);
    expect(criteriaIsEmpty({ types: ['person'] })).toBe(false);
  });
});

describe('normalizeGraph views', () => {
  it('loads views from file data', () => {
    const g = normalizeGraph({ nodes: [{ id: 'a' }], views: [{ id: 'v1', name: 'One', filters: { query: 'a' } }] });
    expect(g.views?.[0].name).toBe('One');
  });

  it('works on graphs without views', () => {
    expect(normalizeGraph({ nodes: [{ id: 'a' }] }).views).toBeUndefined();
    expect(emptyGraph().views).toBeUndefined();
  });
});
