import { describe, expect, it } from 'vitest';
import { GraphError, normalizeGraph } from '../shared/model.ts';

const nodes = [{ id: 'a' }, { id: 'b' }];
const idless = { source: 'a', target: 'b' };
const explicitE1 = { id: 'e1', source: 'b', target: 'a' };

function edgeIds(edges: unknown[]): string[] {
  return normalizeGraph({ nodes, edges }).edges.map((e) => e.id);
}

describe('normalizeGraph edge ids', () => {
  it('loads an id-less edge before an explicit `e1` without a duplicate-id error', () => {
    // Before the fix the id-less edge was assigned `e1`, so the later explicit `e1` threw.
    expect(() => edgeIds([idless, explicitE1])).not.toThrow();
    expect(edgeIds([idless, explicitE1])).toEqual(['e2', 'e1']);
  });

  it('loads an explicit `e1` before an id-less edge with unique ids', () => {
    expect(edgeIds([explicitE1, idless])).toEqual(['e1', 'e2']);
  });

  it('skips every explicit id, wherever it appears, when generating ids', () => {
    const ids = edgeIds([
      idless,
      { id: 'e2', source: 'a', target: 'b' },
      explicitE1,
      idless,
    ]);
    expect(ids).toEqual(['e3', 'e2', 'e1', 'e4']);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('still rejects genuinely duplicate explicit ids', () => {
    expect(() => edgeIds([explicitE1, explicitE1])).toThrow(GraphError);
    expect(() => edgeIds([explicitE1, explicitE1])).toThrow('Duplicate edge id "e1"');
  });
});
