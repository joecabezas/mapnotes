import { describe, expect, it } from 'vitest';
import type { Position } from '../shared/model.ts';
import { type Box, convexHull, hullAround, type HullShape, insidePolygon, zoneAround } from '../web/hull.ts';

const box = (x: number, y: number, size = 20): Box => ({ x1: x - size / 2, y1: y - size / 2, x2: x + size / 2, y2: y + size / 2 });

/** The shape's outline back in canvas coordinates. */
function outline(s: HullShape): Position[] {
  const v = s.points.split(' ').map(Number);
  const out: Position[] = [];
  for (let i = 0; i < v.length; i += 2) out.push({ x: s.center.x + (v[i] * s.width) / 2, y: s.center.y + (v[i + 1] * s.height) / 2 });
  return out;
}
const covers = (s: HullShape, b: Box) => {
  const poly = outline(s);
  const corners = [
    [b.x1, b.y1],
    [b.x2, b.y1],
    [b.x2, b.y2],
    [b.x1, b.y2],
    [(b.x1 + b.x2) / 2, (b.y1 + b.y2) / 2],
  ];
  return corners.map(([x, y]) => insidePolygon(poly, x, y));
};

describe('convexHull', () => {
  it('drops inner and collinear points', () => {
    const hull = convexHull([
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 2 },
      { x: 0, y: 2 },
      { x: 1, y: 1 },
    ]);
    expect(hull).toHaveLength(4);
    expect(hull).not.toContainEqual({ x: 1, y: 1 });
    expect(hull).not.toContainEqual({ x: 1, y: 0 });
  });
});

describe('hullAround', () => {
  it('is null without boxes', () => {
    expect(hullAround([], 10)).toBeNull();
  });

  it('surrounds every box with the padding, in relative points within -1..1', () => {
    const shape = hullAround(
      [
        { x1: 0, y1: 0, x2: 20, y2: 20 },
        { x1: 100, y1: 50, x2: 120, y2: 80 },
      ],
      10,
    )!;
    expect(shape.center).toEqual({ x: 60, y: 40 });
    expect(shape.width).toBeCloseTo(140);
    expect(shape.height).toBeCloseTo(100);
    const values = shape.points.split(' ').map(Number);
    expect(values.length % 2).toBe(0);
    expect(values.every((v) => v >= -1 && v <= 1)).toBe(true);
  });
});

describe('zoneAround', () => {
  const triangle = [box(0, 0), box(300, 0), box(150, 250)];

  it('is the convex hull when no other node is in the way', () => {
    expect(zoneAround(triangle, [box(600, 600)], 16)).toEqual(hullAround(triangle, 16));
  });

  it('leaves out a node that sits between the members, and keeps every member in', () => {
    const intruder = box(150, 90, 30);
    const zone = zoneAround(triangle, [intruder], 16)!;
    expect(covers(zone, intruder).some(Boolean)).toBe(false);
    for (const m of triangle) expect(covers(zone, m).every(Boolean)).toBe(true);
  });

  it('lets out a node that the members surround on every side', () => {
    const ring = [box(0, 0), box(100, 0), box(200, 0), box(200, 100), box(200, 200), box(100, 200), box(0, 200), box(0, 100)];
    const inside = box(100, 100, 30);
    const zone = zoneAround(ring, [inside], 16)!;
    expect(covers(zone, inside).some(Boolean)).toBe(false);
    for (const m of ring) expect(covers(zone, m).every(Boolean)).toBe(true);
  });

  it('gives relative points without repeats', () => {
    const zone = zoneAround(triangle, [box(150, 90, 30)], 16)!;
    const pairs = zone.points.match(/\S+ \S+/g)!;
    pairs.forEach((p, i) => expect(p).not.toBe(pairs[(i + 1) % pairs.length]));
    expect(zone.points.split(' ').map(Number).every((v) => v >= -1 && v <= 1)).toBe(true);
  });
});
