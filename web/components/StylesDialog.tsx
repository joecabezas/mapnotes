import { useState } from 'react';
import {
  ARROW_SHAPES,
  CURVE_STYLES,
  type EdgeStyle,
  type Graph,
  LINE_STYLES,
  NODE_SHAPES,
  type NodeStyle,
  removeStyle,
  type Style,
  uniqueId,
  upsertStyle,
} from '../../shared/model';
import { SVGL_SITE, useIcons } from '../icons';
import {
  CANVAS_COLORS,
  DEFAULT_ARROW,
  DEFAULT_CURVE,
  DEFAULT_EDGE_WIDTH,
  DEFAULT_ICON_SIZE,
  DEFAULT_LINE_STYLE,
  DEFAULT_NODE_SHAPE,
  DEFAULT_NODE_SIZE,
  PALETTE,
  iconSizeCss,
  type ThemeName,
} from '../theme';

interface Props {
  graph: Graph;
  /** Current canvas theme, used to show the default colors. */
  theme: ThemeName;
  apply(op: (g: Graph) => Graph): boolean;
  onClose(): void;
}

function ColorInput(props: { label: string; value?: string; defaultValue: string; tip: string; onChange(v: string | undefined): void }) {
  return (
    <label className="field" data-tip={props.tip}>
      <span>{props.label}</span>
      <div className="row">
        <input
          type="color"
          value={props.value && /^#[0-9a-f]{6}$/i.test(props.value) ? props.value : props.defaultValue}
          onChange={(e) => props.onChange(e.target.value)}
        />
        <input
          className="mono"
          value={props.value ?? ''}
          placeholder={`${props.defaultValue} (default)`}
          onChange={(e) => props.onChange(e.target.value || undefined)}
        />
        {props.value && (
          <button className="icon-btn" data-tip="Use theme default" onClick={() => props.onChange(undefined)}>
            ↺
          </button>
        )}
      </div>
    </label>
  );
}

function Select<T extends string>(props: {
  label: string;
  value?: T;
  options: readonly T[];
  defaultValue: T;
  tip: string;
  onChange(v: T | undefined): void;
}) {
  return (
    <label className="field" data-tip={props.tip}>
      <span>{props.label}</span>
      <select value={props.value ?? ''} onChange={(e) => props.onChange((e.target.value || undefined) as T | undefined)}>
        <option value="">{props.defaultValue} (default)</option>
        {props.options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}

function IconInput(props: { value?: string; onChange(v: string | undefined): void }) {
  return (
    <label className="field" data-tip="svgl icon file name, e.g. slack, linear, obsidian, github_dark">
      <span>
        Icon ·{' '}
        <a href={SVGL_SITE} target="_blank" rel="noreferrer">
          browse
        </a>
      </span>
      <input
        className="mono"
        value={props.value ?? ''}
        placeholder="none"
        onChange={(e) => props.onChange(e.target.value.trim() || undefined)}
      />
    </label>
  );
}

function NumberInput(props: {
  label: string;
  value?: number;
  defaultValue: number;
  tip: string;
  min: number;
  max: number;
  onChange(v?: number): void;
}) {
  return (
    <label className="field" data-tip={props.tip}>
      <span>{props.label}</span>
      <input
        type="number"
        min={props.min}
        max={props.max}
        value={props.value ?? ''}
        placeholder={`${props.defaultValue} (default)`}
        onChange={(e) => props.onChange(e.target.value === '' ? undefined : Number(e.target.value))}
      />
    </label>
  );
}

function Preview({ style }: { style: Style }) {
  const icons = useIcons([style]);
  if (style.target === 'node') {
    const icon = style.icon ? icons[style.icon] : undefined;
    const size = Math.min(56, style.size ?? DEFAULT_NODE_SIZE);
    const radius: Record<string, string> = { ellipse: '50%', 'round-rectangle': '22%', barrel: '35% / 18%' };
    const clip: Record<string, string> = {
      triangle: 'polygon(50% 0, 100% 100%, 0 100%)',
      diamond: 'polygon(50% 0, 100% 50%, 50% 100%, 0 50%)',
      pentagon: 'polygon(50% 0, 100% 38%, 82% 100%, 18% 100%, 0 38%)',
      hexagon: 'polygon(25% 0, 75% 0, 100% 50%, 75% 100%, 25% 100%, 0 50%)',
      octagon: 'polygon(30% 0, 70% 0, 100% 30%, 100% 70%, 70% 100%, 30% 100%, 0 70%, 0 30%)',
      star: 'polygon(50% 0, 61% 35%, 98% 35%, 68% 57%, 79% 91%, 50% 70%, 21% 91%, 32% 57%, 2% 35%, 39% 35%)',
      tag: 'polygon(0 0, 75% 0, 100% 50%, 75% 100%, 0 100%)',
    };
    return (
      <div className="preview">
        <div
          className="preview-node"
          style={{
            width: size,
            height: size,
            background: style.color ?? 'var(--node-default)',
            borderColor: style.borderColor ?? 'var(--node-border-default)',
            borderRadius: radius[style.shape ?? DEFAULT_NODE_SHAPE] ?? '4px',
            clipPath: clip[style.shape ?? ''],
          }}
        >
          {icon && <img src={icon} alt={style.icon} style={{ width: iconSizeCss(style), height: iconSizeCss(style) }} />}
        </div>
        <small style={{ color: style.textColor }}>{style.shape ?? DEFAULT_NODE_SHAPE}</small>
      </div>
    );
  }
  const color = style.color ?? 'var(--edge-default)';
  return (
    <div className="preview">
      <svg width="120" height="40" viewBox="0 0 120 40">
        <line
          x1="6"
          y1="20"
          x2="104"
          y2="20"
          stroke={color}
          strokeWidth={style.width ?? DEFAULT_EDGE_WIDTH}
          strokeDasharray={style.lineStyle === 'dashed' ? '8 5' : style.lineStyle === 'dotted' ? '2 4' : undefined}
        />
        {style.arrow !== 'none' && <polygon points="104,13 116,20 104,27" fill={color} />}
      </svg>
      <small style={{ color: style.textColor }}>{style.lineStyle ?? DEFAULT_LINE_STYLE}</small>
    </div>
  );
}

export function StylesDialog({ graph, theme, apply, onClose }: Props) {
  const colors = CANVAS_COLORS[theme];
  const [selectedId, setSelectedId] = useState<string | null>(graph.styles[0]?.id ?? null);
  const selected = graph.styles.find((s) => s.id === selectedId) ?? null;
  const usage = (s: Style) =>
    s.target === 'node' ? graph.nodes.filter((n) => n.style === s.id).length : graph.edges.filter((e) => e.style === s.id).length;

  const save = (next: Style) => apply((g) => upsertStyle(g, next).graph);

  const create = (target: Style['target']) => {
    const id = uniqueId(`${target}-style-`, graph.styles.map((s) => s.id));
    const color = PALETTE[graph.styles.length % PALETTE.length];
    const style: Style =
      target === 'node'
        ? { id, target, name: `Node style ${graph.styles.length + 1}`, color, shape: 'ellipse' }
        : { id, target, name: `Edge style ${graph.styles.length + 1}`, color, lineStyle: 'solid', arrow: 'triangle' };
    if (save(style)) setSelectedId(id);
  };

  const patch = (p: Partial<NodeStyle> | Partial<EdgeStyle>) => selected && save({ ...selected, ...p } as Style);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal wide" role="dialog" aria-label="Styles">
        <header className="modal-head">
          <h2>Styles</h2>
          <p className="muted small">
            Styles are saved in the graph file. Assign them to nodes and edges from the inspector.
          </p>
          <button className="icon-btn close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        <div className="styles-layout">
          <aside className="style-list">
            {(['node', 'edge'] as const).map((target) => (
              <div key={target}>
                <h3>{target === 'node' ? 'Node styles' : 'Edge styles'}</h3>
                {graph.styles
                  .filter((s) => s.target === target)
                  .map((s) => (
                    <button
                      key={s.id}
                      className={`style-item${s.id === selectedId ? ' active' : ''}`}
                      onClick={() => setSelectedId(s.id)}
                    >
                      <span className={`swatch ${s.target}`} style={{ background: s.color }} />
                      <span className="grow">{s.name || s.id}</span>
                      <span className="count" title="Elements using this style">
                        {usage(s)}
                      </span>
                    </button>
                  ))}
                <button className="btn small ghost" onClick={() => create(target)}>
                  + New {target} style
                </button>
              </div>
            ))}
          </aside>
          <section className="style-editor">
            {!selected && <p className="muted">Create a style to start customising how your graph looks.</p>}
            {selected && (
              <>
                <div className="style-editor-head">
                  <Preview style={selected} />
                  <div className="grow">
                    <label className="field" data-tip="Display name of the style">
                      <span>Name</span>
                      <input value={selected.name ?? ''} onChange={(e) => patch({ name: e.target.value || undefined })} />
                    </label>
                    <div className="muted small mono">
                      id: {selected.id} · used by {usage(selected)} {selected.target}(s)
                    </div>
                  </div>
                </div>
                <div className="grid2">
                  <ColorInput
                    label={selected.target === 'node' ? 'Fill color' : 'Line color'}
                    value={selected.color}
                    defaultValue={selected.target === 'node' ? colors.node : colors.edge}
                    tip="Main color"
                    onChange={(color) => patch({ color })}
                  />
                  <ColorInput
                    label="Label color"
                    value={selected.textColor}
                    defaultValue={selected.target === 'node' ? colors.nodeText : colors.edgeText}
                    tip="Color of the label text"
                    onChange={(textColor) => patch({ textColor })}
                  />
                  {selected.target === 'node' ? (
                    <>
                      <ColorInput
                        label="Border color"
                        value={selected.borderColor}
                        defaultValue={colors.nodeBorder}
                        tip="Outline of the node"
                        onChange={(borderColor) => patch({ borderColor })}
                      />
                      <Select label="Shape" value={selected.shape} options={NODE_SHAPES} defaultValue={DEFAULT_NODE_SHAPE} tip="Node shape" onChange={(shape) => patch({ shape })} />
                      <NumberInput label="Size (px)" value={selected.size} defaultValue={DEFAULT_NODE_SIZE} min={8} max={300} tip="Node diameter" onChange={(size) => patch({ size })} />
                      <IconInput value={selected.icon} onChange={(icon) => patch({ icon })} />
                      <NumberInput
                        label="Icon size (%)"
                        value={selected.iconSize}
                        defaultValue={DEFAULT_ICON_SIZE}
                        min={10}
                        max={100}
                        tip="Icon size relative to the node"
                        onChange={(iconSize) => patch({ iconSize })}
                      />
                    </>
                  ) : (
                    <>
                      <Select label="Line" value={selected.lineStyle} options={LINE_STYLES} defaultValue={DEFAULT_LINE_STYLE} tip="Solid, dashed or dotted" onChange={(lineStyle) => patch({ lineStyle })} />
                      <Select label="Arrow" value={selected.arrow} options={ARROW_SHAPES} defaultValue={DEFAULT_ARROW} tip="Arrow head at the target" onChange={(arrow) => patch({ arrow })} />
                      <Select label="Curve" value={selected.curve} options={CURVE_STYLES} defaultValue={DEFAULT_CURVE} tip="How the edge is routed" onChange={(curve) => patch({ curve })} />
                      <NumberInput label="Width (px)" value={selected.width} defaultValue={DEFAULT_EDGE_WIDTH} min={1} max={20} tip="Line thickness" onChange={(width) => patch({ width })} />
                    </>
                  )}
                </div>
                <div className="palette" data-tip="Quick colors">
                  {PALETTE.map((c) => (
                    <button key={c} className="swatch big" style={{ background: c }} aria-label={c} onClick={() => patch({ color: c })} />
                  ))}
                </div>
                <footer className="panel-foot">
                  <button
                    className="btn danger"
                    data-tip="Elements using it go back to the default look"
                    onClick={() => {
                      if (apply((g) => removeStyle(g, selected.id))) setSelectedId(null);
                    }}
                  >
                    Delete style
                  </button>
                </footer>
              </>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
