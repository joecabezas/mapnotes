import { useRef } from 'react';

/**
 * Vertical drag handle on the left edge of a right-hand panel. Dragging left
 * widens the panel; arrow keys nudge it; double-click restores the default.
 */
export function PanelResizer(props: {
  width: number;
  min: number;
  max: number;
  defaultWidth: number;
  onChange(width: number): void;
  /** Called once a drag or key press is done, e.g. to remember the width. */
  onCommit(width: number): void;
}) {
  const drag = useRef<{ x: number; width: number } | null>(null);
  const clamp = (w: number) => Math.round(Math.min(props.max, Math.max(props.min, w)));

  return (
    <div
      className="panel-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize panel"
      aria-valuenow={props.width}
      aria-valuemin={props.min}
      aria-valuemax={props.max}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      onPointerDown={(e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, width: props.width };
      }}
      onPointerMove={(e) => {
        if (drag.current) props.onChange(clamp(drag.current.width + drag.current.x - e.clientX));
      }}
      onPointerUp={(e) => {
        if (!drag.current) return;
        drag.current = null;
        e.currentTarget.releasePointerCapture(e.pointerId);
        props.onCommit(props.width);
      }}
      onDoubleClick={() => {
        props.onChange(props.defaultWidth);
        props.onCommit(props.defaultWidth);
      }}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 64 : 16;
        const delta = e.key === 'ArrowLeft' ? step : e.key === 'ArrowRight' ? -step : 0;
        if (!delta) return;
        e.preventDefault();
        const width = clamp(props.width + delta);
        props.onChange(width);
        props.onCommit(width);
      }}
    />
  );
}
