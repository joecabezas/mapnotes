import type { Position } from '../shared/model';

/** Lines nodes up on one of their edges / centres, or spreads them out with equal or fixed gaps. */
export type ArrangeOp =
  | 'left'
  | 'center'
  | 'right'
  | 'top'
  | 'middle'
  | 'bottom'
  | 'distribute-x'
  | 'distribute-y'
  | 'space-x'
  | 'space-y';

/** The empty space the `space-*` ops leave between neighbouring boxes. */
export const SPACE_GAP = 40;

/** A node's position (its centre) and the box it occupies on the canvas. */
export interface ArrangeItem {
  id: string;
  position: Position;
  box: { x1: number; x2: number; y1: number; y2: number };
}

const AXIS = { x: ['x1', 'x2'], y: ['y1', 'y2'] } as const;

/**
 * New positions for `items` after `op`. Aligning moves every box onto the outermost edge (or the
 * centre of the overall extent); distributing keeps the first and last box (by centre) in place and
 * makes the empty space between neighbouring boxes equal. Spacing keeps only the first box in place and
 * leaves `SPACE_GAP` after each box, wherever the last one was — it pulls overlapping nodes apart.
 */
export function arrange(items: ArrangeItem[], op: ArrangeOp): Record<string, Position> {
  const axis = op === 'left' || op === 'center' || op === 'right' || op === 'distribute-x' || op === 'space-x' ? 'x' : 'y';
  const [lo, hi] = AXIS[axis];
  const shifts = new Map<string, number>();

  if (op.startsWith('distribute') || op.startsWith('space')) {
    const fixed = op.startsWith('space');
    if (items.length < (fixed ? 2 : 3)) return {};
    const sorted = [...items].sort((a, b) => a.box[lo] + a.box[hi] - (b.box[lo] + b.box[hi]));
    const first = sorted[0].box;
    const last = sorted[sorted.length - 1].box;
    const used = sorted.reduce((sum, it) => sum + it.box[hi] - it.box[lo], 0);
    const gap = fixed ? SPACE_GAP : (last[hi] - first[lo] - used) / (sorted.length - 1);
    let next = first[hi] + gap;
    for (const it of fixed ? sorted.slice(1) : sorted.slice(1, -1)) {
      shifts.set(it.id, next - it.box[lo]);
      next += it.box[hi] - it.box[lo] + gap;
    }
  } else {
    if (items.length < 2) return {};
    const min = Math.min(...items.map((it) => it.box[lo]));
    const max = Math.max(...items.map((it) => it.box[hi]));
    for (const it of items) {
      const { [lo]: a, [hi]: b } = it.box;
      const shift = op === 'left' || op === 'top' ? min - a : op === 'right' || op === 'bottom' ? max - b : (min + max - a - b) / 2;
      shifts.set(it.id, shift);
    }
  }

  const positions: Record<string, Position> = {};
  for (const it of items) {
    const shift = shifts.get(it.id);
    if (shift) positions[it.id] = { ...it.position, [axis]: it.position[axis] + shift };
  }
  return positions;
}
