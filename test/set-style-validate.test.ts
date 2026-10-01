import { describe, expect, it } from 'vitest';
import { emptyGraph, GraphError, STYLE_LIMITS, upsertStyle, validateStyleInput } from '../shared/model.ts';

describe('validateStyleInput (set_style)', () => {
  it('rejects a node-only field on an edge style with an actionable error', () => {
    const input = { id: 'e', target: 'edge' as const, shape: 'rectangle' };
    expect(() => validateStyleInput(input)).toThrow(GraphError);
    expect(() => validateStyleInput(input)).toThrow(
      /"shape" only applies to node styles; remove it or set target to "node"\. Edge styles accept: .*width/,
    );
  });

  it('rejects an edge-only field on a node style with an actionable error', () => {
    const input = { id: 'n', target: 'node' as const, width: 3 };
    expect(() => validateStyleInput(input)).toThrow(
      /"width" only applies to edge styles; remove it or set target to "edge"\. Node styles accept: .*shape/,
    );
  });

  it('lists every incompatible field', () => {
    expect(() => validateStyleInput({ id: 'n', target: 'node', width: 3, curve: 'taxi' })).toThrow(
      /"width", "curve" only apply to edge styles; remove them/,
    );
  });

  it('without validation the incompatible field is silently dropped (the original bug)', () => {
    const { style } = upsertStyle(emptyGraph(), { id: 'e', target: 'edge', shape: 'rectangle' });
    expect(style).toEqual({ id: 'e', target: 'edge' });
  });

  it('accepts compatible fields for each target', () => {
    expect(() =>
      validateStyleInput({ id: 'n', target: 'node', color: '#fff', shape: 'rectangle', size: 40, iconSize: 60 }),
    ).not.toThrow();
    expect(() =>
      validateStyleInput({ id: 'e', target: 'edge', color: '#fff', width: 2, lineStyle: 'dashed', curve: 'taxi' }),
    ).not.toThrow();
  });

  it('enforces numeric bounds, inclusive', () => {
    for (const [key, { min, max }] of Object.entries(STYLE_LIMITS)) {
      const target = key === 'width' ? ('edge' as const) : ('node' as const);
      expect(() => validateStyleInput({ id: 's', target, [key]: min })).not.toThrow();
      expect(() => validateStyleInput({ id: 's', target, [key]: max })).not.toThrow();
      expect(() => validateStyleInput({ id: 's', target, [key]: min - 1 })).toThrow(
        new RegExp(`"${key}" must be a number between ${min} and ${max}`),
      );
      expect(() => validateStyleInput({ id: 's', target, [key]: max + 1 })).toThrow(GraphError);
      expect(() => validateStyleInput({ id: 's', target, [key]: Number.NaN })).toThrow(GraphError);
    }
  });
});
