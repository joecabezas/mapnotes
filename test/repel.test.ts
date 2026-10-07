import { describe, expect, it } from 'vitest';
import { type Body, LINK_GAP, REPEL_GAP, stepRepulsion } from '../web/repel';

const body = (x: number, y: number, pinned = false): Body => ({ x, y, vx: 0, vy: 0, radius: 20, pinned });
const gap = (a: Body, b: Body) => Math.hypot(b.x - a.x, b.y - a.y) - a.radius - b.radius;

/** Runs the simulation until nothing moves, at 60 frames a second. */
function settle(bodies: Body[], links?: [number, number][]) {
  for (let i = 0; i < 2000; i++) {
    if (stepRepulsion(bodies, 1 / 60, links) < 1 && i > 0) return i;
  }
  throw new Error('did not settle');
}

describe('stepRepulsion', () => {
  it('pushes close bodies apart until there is room between them, then rests', () => {
    const bodies = [body(0, 0), body(30, 0), body(15, 20)];
    settle(bodies);
    for (const [a, b] of [[0, 1], [0, 2], [1, 2]]) expect(gap(bodies[a], bodies[b])).toBeGreaterThanOrEqual(REPEL_GAP - 1);
  });

  it('leaves bodies that already have room where they are', () => {
    const bodies = [body(0, 0), body(40 + REPEL_GAP, 0)];
    expect(stepRepulsion(bodies, 1 / 60)).toBe(0);
    expect(bodies.map((b) => b.x)).toEqual([0, 40 + REPEL_GAP]);
  });

  it('separates bodies that sit on the same spot', () => {
    const bodies = [body(5, 5), body(5, 5)];
    settle(bodies);
    expect(gap(bodies[0], bodies[1])).toBeGreaterThanOrEqual(REPEL_GAP - 1);
  });

  it('keeps a pinned body in place while it pushes the others away', () => {
    const bodies = [body(0, 0, true), body(30, 0)];
    settle(bodies);
    expect(bodies[0]).toMatchObject({ x: 0, y: 0 });
    expect(bodies[1].x).toBeGreaterThanOrEqual(40 + REPEL_GAP - 1);
    expect(bodies[1].y).toBe(0);
  });

  it('pulls the ends of a stretched edge together, and no closer than the edge is long', () => {
    const bodies = [body(0, 0), body(900, 0), body(900, 400)];
    settle(bodies, [[0, 1]]);
    expect(gap(bodies[0], bodies[1])).toBeGreaterThan(REPEL_GAP);
    expect(gap(bodies[0], bodies[1])).toBeLessThanOrEqual(LINK_GAP + 1);
    // Not connected, and with room around it: it stays.
    expect(bodies[2]).toMatchObject({ x: 900, y: 400 });
  });

  it('drags along what a moved body is connected to, down a chain', () => {
    const bodies = [body(0, 0, true), body(140, 0), body(280, 0)];
    const links: [number, number][] = [[0, 1], [1, 2]];
    settle(bodies, links);
    const before = bodies.map((b) => b.x);
    bodies[0].x = -600;
    settle(bodies, links);
    expect(bodies[1].x).toBeLessThan(before[1] - 500);
    expect(bodies[2].x).toBeLessThan(before[2] - 500);
  });
});
