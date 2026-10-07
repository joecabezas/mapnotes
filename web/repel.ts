// Live repulsion: nodes float apart as if they pushed each other away, until there is room between them,
// while edges hold their ends together like the bonds of a molecule.

/** A node in the simulation: where it is, how fast it moves, and how much room it takes. */
export interface Body {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Half the node's size, label included. */
  radius: number;
  /** Held in place (e.g. being dragged): it pushes the others but isn't pushed. */
  pinned: boolean;
}

/** Bodies push each other while the gap between them is smaller than this. */
export const REPEL_GAP = 60;
/** Acceleration (px/s²) of two bodies that touch; it fades to nothing as the gap opens to REPEL_GAP. */
const STRENGTH = 2600;
/** How quickly a body slows down when nothing pushes it: higher stops sooner, lower floats further. */
const DRAG = 4.5;
const MAX_SPEED = 1500;
/** The gap an edge keeps between its ends: beyond the reach of the push, so the two don't fight. */
export const LINK_GAP = REPEL_GAP + 40;
/** Acceleration (px/s²) pulling the ends of an edge together, per px it is stretched beyond LINK_GAP. */
const PULL = 28;
/** The most an edge pulls, however far it is stretched, so distant ends don't slam together. */
const MAX_PULL = 3000;

/**
 * Moves the bodies `dt` seconds on, in place, and returns the speed of the fastest one (px/s).
 * The push only reaches REPEL_GAP, so bodies drift apart and come to rest instead of fleeing forever.
 * `links` are pairs of indexes into `bodies` joined by an edge: stretched ones pull their ends together,
 * so dragging a body drags along what it is connected to.
 */
export function stepRepulsion(bodies: Body[], dt: number, links: [number, number][] = []): number {
  const ax = new Array<number>(bodies.length).fill(0);
  const ay = new Array<number>(bodies.length).fill(0);
  for (const [i, j] of links) {
    const a = bodies[i];
    const b = bodies[j];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const distance = Math.hypot(dx, dy);
    const stretch = distance - a.radius - b.radius - LINK_GAP;
    if (i === j || stretch <= 0) continue;
    const pull = Math.min(MAX_PULL, PULL * stretch);
    const px = (dx / distance) * pull;
    const py = (dy / distance) * pull;
    ax[i] += px;
    ay[i] += py;
    ax[j] -= px;
    ay[j] -= py;
  }
  for (let i = 0; i < bodies.length; i++) {
    for (let j = i + 1; j < bodies.length; j++) {
      const a = bodies[i];
      const b = bodies[j];
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      let distance = Math.hypot(dx, dy);
      const gap = distance - a.radius - b.radius;
      if (gap >= REPEL_GAP) continue;
      if (distance < 0.01) {
        // On top of each other: there is no direction to push in, so pick one that differs per pair.
        const angle = (i * 7 + j * 13) % 360;
        dx = Math.cos(angle);
        dy = Math.sin(angle);
        distance = 1;
      }
      // Overlapping bodies are pushed harder, up to twice the strength.
      const push = STRENGTH * Math.min(2, 1 - gap / REPEL_GAP);
      const px = (dx / distance) * push;
      const py = (dy / distance) * push;
      ax[i] -= px;
      ay[i] -= py;
      ax[j] += px;
      ay[j] += py;
    }
  }
  const slow = Math.exp(-DRAG * dt);
  let fastest = 0;
  bodies.forEach((body, i) => {
    if (body.pinned) {
      body.vx = 0;
      body.vy = 0;
      return;
    }
    body.vx = (body.vx + ax[i] * dt) * slow;
    body.vy = (body.vy + ay[i] * dt) * slow;
    const speed = Math.hypot(body.vx, body.vy);
    if (speed > MAX_SPEED) {
      body.vx *= MAX_SPEED / speed;
      body.vy *= MAX_SPEED / speed;
    }
    body.x += body.vx * dt;
    body.y += body.vy * dt;
    fastest = Math.max(fastest, Math.min(speed, MAX_SPEED));
  });
  return fastest;
}
