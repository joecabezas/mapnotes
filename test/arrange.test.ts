import { describe, expect, it } from 'vitest';
import { arrange, type ArrangeItem, SPACE_GAP } from '../web/arrange.ts';

/** A node centred at (x, y) whose box is w × h. */
function item(id: string, x: number, y: number, w = 20, h = 20): ArrangeItem {
  return { id, position: { x, y }, box: { x1: x - w / 2, x2: x + w / 2, y1: y - h / 2, y2: y + h / 2 } };
}

describe('align', () => {
  const items = [item('a', 0, 0, 20), item('b', 100, 50, 40), item('c', 50, 30, 10)];

  it('moves boxes onto the outermost edge', () => {
    expect(arrange(items, 'left')).toEqual({ b: { x: 10, y: 50 }, c: { x: -5, y: 30 } });
    expect(arrange(items, 'right')).toEqual({ a: { x: 110, y: 0 }, c: { x: 115, y: 30 } });
  });

  it('centres boxes on the middle of the overall extent', () => {
    // Extent is -10..120, centre 55.
    expect(arrange(items, 'center')).toEqual({ a: { x: 55, y: 0 }, b: { x: 55, y: 50 }, c: { x: 55, y: 30 } });
    expect(arrange(items, 'top')).toEqual({ b: { x: 100, y: 0 }, c: { x: 50, y: 0 } });
  });

  it('needs two nodes', () => {
    expect(arrange([item('a', 5, 5)], 'left')).toEqual({});
  });
});

describe('distribute', () => {
  it('makes the gaps between boxes equal, keeping the outer ones in place', () => {
    // Boxes: a -10..10, b 20..80 (w 60), c 85..95, d 190..210. Total span 220, used 110, gap 110/3.
    const items = [item('d', 200, 0), item('a', 0, 0), item('c', 90, 0, 10), item('b', 50, 0, 60)];
    const out = arrange(items, 'distribute-x');
    const gap = 110 / 3;
    expect(Object.keys(out).sort()).toEqual(['b', 'c']);
    expect(out.b.x).toBeCloseTo(10 + gap + 30);
    expect(out.c.x).toBeCloseTo(10 + gap + 60 + gap + 5);
    expect(out.b.y).toBe(0);
  });

  it('works vertically and needs three nodes', () => {
    expect(arrange([item('a', 0, 0), item('b', 0, 10), item('c', 0, 100)], 'distribute-y')).toEqual({ b: { x: 0, y: 50 } });
    expect(arrange([item('a', 0, 0), item('b', 0, 10)], 'distribute-y')).toEqual({});
  });
});

describe('space', () => {
  it('leaves a fixed gap after the first box, pulling overlapping nodes apart', () => {
    // All three overlap around x = 0; widths 20, 40, 20.
    const out = arrange([item('a', 0, 5), item('b', 2, 5, 40), item('c', 4, 5)], 'space-x');
    expect(out).toEqual({ b: { x: 10 + SPACE_GAP + 20, y: 5 }, c: { x: 10 + SPACE_GAP + 40 + SPACE_GAP + 10, y: 5 } });
  });

  it('ignores where the last node was and works with two nodes', () => {
    expect(arrange([item('a', 0, 0), item('b', 0, 500)], 'space-y')).toEqual({ b: { x: 0, y: 10 + SPACE_GAP + 10 } });
  });
});
