import { type ReactNode, useEffect, useState } from 'react';
import {
  clusterMembers,
  editEdge,
  editGraphProperties,
  editNode,
  type Graph,
  type GraphEdge,
  type GraphNode,
  removeEdge,
  removeNode,
  type Style,
} from '../../shared/model';
import { type ArrangeOp, SPACE_GAP } from '../arrange';
import type { Selection } from './GraphCanvas';
import { CopyButton } from './CopyButton';
import { PropertyEditor } from './PropertyEditor';
import { Icon } from './Icon';

interface Props {
  graph: Graph;
  selection: Selection;
  /** Applies a graph operation; errors are reported to the user. Returns success. */
  apply(op: (g: Graph) => Graph): boolean;
  onSelect(sel: Selection): void;
  onConnectFrom(nodeId: string): void;
  /** Opens the styles dialog, optionally with `styleId` selected. */
  onOpenStyles(styleId?: string): void;
  /** Aligns or distributes the given nodes on the canvas. */
  onArrange(ids: string[], op: ArrangeOp): void;
}

/** Icons are 24×24 strokes: a guide line plus the boxes being moved onto / spaced along it. */
const ARRANGE_BUTTONS: { op: ArrangeOp; tip: string; icon: string }[] = [
  { op: 'left', tip: 'Align left edges', icon: 'M4 3v18M8 6h12v4H8zM8 14h7v4H8z' },
  { op: 'center', tip: 'Align horizontal centres (stack in a column)', icon: 'M12 3v18M5 6h14v4H5zM8 14h8v4H8z' },
  { op: 'right', tip: 'Align right edges', icon: 'M20 3v18M4 6h12v4H4zM9 14h7v4H9z' },
  { op: 'top', tip: 'Align top edges', icon: 'M3 4h18M6 8h4v12H6zM14 8h4v7h-4z' },
  { op: 'middle', tip: 'Align vertical centres (line up in a row)', icon: 'M3 12h18M6 5h4v14H6zM14 8h4v8h-4z' },
  { op: 'bottom', tip: 'Align bottom edges', icon: 'M3 20h18M6 4h4v12H6zM14 9h4v7h-4z' },
];
const DISTRIBUTE_BUTTONS: { op: ArrangeOp; tip: string; icon: string }[] = [
  {
    op: 'distribute-x',
    tip: 'Distribute horizontally: equal gaps between nodes, keeping the leftmost and rightmost in place',
    icon: 'M3 3v18M21 3v18M9 7h6v10H9z',
  },
  {
    op: 'distribute-y',
    tip: 'Distribute vertically: equal gaps between nodes, keeping the top and bottom ones in place',
    icon: 'M3 3h18M3 21h18M7 9h10v6H7z',
  },
];
const SPACE_BUTTONS: { op: ArrangeOp; tip: string; icon: string }[] = [
  {
    op: 'space-x',
    tip: `Space out horizontally: a fixed ${SPACE_GAP}px gap between nodes, starting from the leftmost (separates overlapping nodes)`,
    icon: 'M2 8h5v8H2zM17 8h5v8h-5zM9 12h6M13 10l2 2-2 2M11 10l-2 2 2 2',
  },
  {
    op: 'space-y',
    tip: `Space out vertically: a fixed ${SPACE_GAP}px gap between nodes, starting from the topmost (separates overlapping nodes)`,
    icon: 'M8 2h8v5H8zM8 17h8v5H8zM12 9v6M10 13l2 2 2-2M10 11l2-2 2 2',
  },
];

/** Text input that commits on blur / Enter and reverts on Escape. */
function Field(props: {
  label: string;
  value: string;
  tip?: string;
  placeholder?: string;
  autoFocus?: boolean;
  /** Show a button that copies the committed value to the clipboard. */
  copyable?: boolean;
  onCommit(v: string): boolean | void;
}) {
  const [draft, setDraft] = useState(props.value);
  useEffect(() => setDraft(props.value), [props.value]);
  const commit = () => {
    if (draft === props.value) return;
    if (props.onCommit(draft) === false) setDraft(props.value);
  };
  const input = (
    <input
      value={draft}
      placeholder={props.placeholder}
      autoFocus={props.autoFocus}
      onFocus={(e) => props.autoFocus && e.target.select()}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          setDraft(props.value);
          setTimeout(() => (e.target as HTMLInputElement).blur());
        }
      }}
    />
  );
  return (
    <label className="field" data-tip={props.tip}>
      <span>{props.label}</span>
      {props.copyable ? (
        <div className="row">
          {input}
          <CopyButton text={props.value} what={props.label.toLowerCase()} />
        </div>
      ) : (
        input
      )}
    </label>
  );
}

function StyleSelect(props: {
  styles: Style[];
  target: Style['target'];
  value?: string;
  onChange(v: string): void;
  onManage(styleId?: string): void;
}) {
  const options = props.styles.filter((s) => s.target === props.target);
  const current = options.find((s) => s.id === props.value);
  return (
    <label className="field" data-tip={`Reusable look for this ${props.target}. Manage styles in the Styles panel.`}>
      <span>Style</span>
      <div className="row">
        {current?.color && <span className="swatch" style={{ background: current.color }} />}
        <select value={props.value ?? ''} onChange={(e) => props.onChange(e.target.value)}>
          <option value="">Default</option>
          {options.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name ? `${s.name} (${s.id})` : s.id}
            </option>
          ))}
        </select>
        <button
          className="icon-btn"
          data-tip="Edit styles"
          aria-label="Edit styles"
          onClick={() => props.onManage(props.value || undefined)}
        >
          <Icon name="palette" />
        </button>
      </div>
    </label>
  );
}

/**
 * What can be done with the selection, in the same place on every panel: its actions, then Delete
 * at the far end.
 */
function ActionBar(props: { children?: ReactNode; deleteTip: string; onDelete(): void }) {
  return (
    <div className="panel-actions" role="toolbar" aria-label="Actions">
      {props.children}
      {/* Just the icon next to other actions, so they share one line. */}
      <button
        className={`btn small danger delete${props.children ? ' icon-only' : ''}`}
        data-tip={props.deleteTip}
        aria-label={props.deleteTip}
        onClick={props.onDelete}
      >
        <Icon name="trash" />
        {!props.children && ' Delete'}
      </button>
    </div>
  );
}

function NodePanel({ node, ...p }: Props & { node: GraphNode }) {
  const connected = p.graph.edges.filter((e) => e.source === node.id || e.target === node.id);
  const labelOf = (id: string) => p.graph.nodes.find((n) => n.id === id)?.label ?? id;
  const members = clusterMembers(p.graph, node.id);
  const setCluster = (cluster: boolean) => p.apply((g) => editNode(g, { id: node.id, cluster }).graph);
  return (
    <>
      <header className="panel-head">
        <span className={`kind-badge${node.cluster ? ' cluster' : ''}`}>{node.cluster ? 'Cluster' : 'Node'}</span>
        <h2 title={node.label}>{node.label}</h2>
      </header>
      <ActionBar
        deleteTip={`Delete this ${node.cluster ? 'cluster' : 'node'} and its edges (Del)`}
        onDelete={() => p.apply((g) => removeNode(g, node.id).graph) && p.onSelect(null)}
      >
        <button className="btn small" onClick={() => p.onConnectFrom(node.id)} data-tip="Connect to another node: click the target next (E)">
          <Icon name="connect" /> Connect
        </button>
        {node.cluster ? (
          <button className="btn small" data-tip="Draw it as a node again, with its edges" onClick={() => setCluster(false)}>
            <Icon name="node" /> Convert to node
          </button>
        ) : (
          <button
            className="btn small"
            disabled={!members.length}
            data-tip={
              members.length
                ? `Draw this node as a zone around the ${members.length} node${members.length === 1 ? '' : 's'} connected to it, hiding its edges. Convert it back any time.`
                : 'Connect this node to others first: a cluster is drawn around the nodes connected to it'
            }
            onClick={() => setCluster(true)}
          >
            <Icon name="cluster" /> Convert to cluster
          </button>
        )}
      </ActionBar>
      <section>
        <Field
          label="Label"
          value={node.label}
          tip="Text shown on the canvas"
          onCommit={(label) => p.apply((g) => editNode(g, { id: node.id, label }).graph)}
        />
        <Field
          label="ID"
          value={node.id}
          copyable
          tip="Unique identifier. Renaming updates the edges connected to this node."
          onCommit={(newId) => {
            if (!newId.trim()) return false;
            const ok = p.apply((g) => editNode(g, { id: node.id, newId }).graph);
            if (ok) p.onSelect({ kind: 'node', id: newId.trim() });
            return ok;
          }}
        />
        <StyleSelect
          styles={p.graph.styles}
          target="node"
          value={node.style}
          onManage={p.onOpenStyles}
          onChange={(style) => p.apply((g) => editNode(g, { id: node.id, style }).graph)}
        />
      </section>
      {node.cluster && (
        <section>
          <h3>
            Members <span className="count">{members.length}</span>
          </h3>
          {members.length === 0 && (
            <p className="muted small">Nothing is connected to this cluster, so it is drawn as a node.</p>
          )}
          <ul className="link-list">
            {members.map((id) => (
              <li key={id}>
                <button className="link" onClick={() => p.onSelect({ kind: 'node', id })} data-tip="Select node">
                  {labelOf(id)}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section>
        <h3>Properties</h3>
        <PropertyEditor
          properties={node.properties}
          emptyHint="Attach any data to this node, e.g. status = open."
          onChange={(properties) => p.apply((g) => editNode(g, { id: node.id, properties }).graph)}
        />
      </section>
      <section>
        <h3>
          Connections <span className="count">{connected.length}</span>
        </h3>
        {connected.length === 0 && <p className="muted small">Not connected to anything yet.</p>}
        <ul className="link-list">
          {connected.map((e) => {
            const out = e.source === node.id;
            const other = out ? e.target : e.source;
            return (
              <li key={e.id}>
                <button className="link" onClick={() => p.onSelect({ kind: 'edge', id: e.id })} data-tip="Select edge">
                  <Icon name={out ? 'arrowRight' : 'arrowLeft'} /> {e.label || e.id}
                </button>
                <button className="link muted" onClick={() => p.onSelect({ kind: 'node', id: other })} data-tip="Select node">
                  {labelOf(other)}
                </button>
              </li>
            );
          })}
        </ul>
      </section>
    </>
  );
}

function EdgePanel({ edge, ...p }: Props & { edge: GraphEdge }) {
  const nodeOptions = p.graph.nodes.map((n) => (
    <option key={n.id} value={n.id}>
      {n.label === n.id ? n.id : `${n.label} (${n.id})`}
    </option>
  ));
  return (
    <>
      <header className="panel-head">
        <span className="kind-badge edge">Edge</span>
        <h2>{edge.label || edge.id}</h2>
      </header>
      <ActionBar deleteTip="Delete this edge (Del)" onDelete={() => p.apply((g) => removeEdge(g, edge.id)) && p.onSelect(null)}>
        <button
          className="btn small"
          data-tip="Swap source and target"
          onClick={() => p.apply((g) => editEdge(g, { id: edge.id, source: edge.target, target: edge.source }).graph)}
        >
          <Icon name="swap" /> Reverse direction
        </button>
      </ActionBar>
      <section>
        <Field
          label="Label"
          value={edge.label ?? ''}
          placeholder="(none)"
          tip="Optional text drawn along the edge"
          onCommit={(label) => p.apply((g) => editEdge(g, { id: edge.id, label }).graph)}
        />
        <Field
          label="ID"
          value={edge.id}
          copyable
          tip="Unique identifier of the edge"
          onCommit={(newId) => {
            if (!newId.trim()) return false;
            const ok = p.apply((g) => editEdge(g, { id: edge.id, newId }).graph);
            if (ok) p.onSelect({ kind: 'edge', id: newId.trim() });
            return ok;
          }}
        />
        <label className="field" data-tip="Node the edge starts from">
          <span>Source</span>
          <select value={edge.source} onChange={(e) => p.apply((g) => editEdge(g, { id: edge.id, source: e.target.value }).graph)}>
            {nodeOptions}
          </select>
        </label>
        <label className="field" data-tip="Node the edge points to">
          <span>Target</span>
          <select value={edge.target} onChange={(e) => p.apply((g) => editEdge(g, { id: edge.id, target: e.target.value }).graph)}>
            {nodeOptions}
          </select>
        </label>
        <StyleSelect
          styles={p.graph.styles}
          target="edge"
          value={edge.style}
          onManage={p.onOpenStyles}
          onChange={(style) => p.apply((g) => editEdge(g, { id: edge.id, style }).graph)}
        />
      </section>
      <section>
        <h3>Properties</h3>
        <PropertyEditor
          properties={edge.properties}
          emptyHint="Describe the relationship, e.g. type = blocks."
          onChange={(properties) => p.apply((g) => editEdge(g, { id: edge.id, properties }).graph)}
        />
      </section>
    </>
  );
}

function GraphPanel(p: Props) {
  const { graph } = p;
  const prop = (key: string) => graph.properties.find((x) => x.key === key);
  const title = prop('title');
  const subtitle = prop('subtitle');
  const addProps = (keys: string[]) =>
    p.apply((g) => editGraphProperties(g, { set: keys.map((key) => ({ key, value: '' })) }));
  return (
    <>
      <header className="panel-head">
        <span className="kind-badge graph">Graph</span>
        <div className="panel-titles">
          <div className="row">
            <h2 title={title?.value}>{title?.value || 'Untitled graph'}</h2>
            {title?.value && <CopyButton text={title.value} what="the graph name" />}
          </div>
          {subtitle?.value && <p className="subtitle">{subtitle.value}</p>}
        </div>
      </header>
      <section className="stats">
        <div>
          <b>{graph.nodes.length}</b> nodes
        </div>
        <div>
          <b>{graph.edges.length}</b> edges
        </div>
        <div>
          <b>{graph.styles.length}</b> styles
        </div>
      </section>
      <section>
        <h3>Graph properties</h3>
        <PropertyEditor
          properties={graph.properties}
          emptyHint="Properties of the whole graph. “title” names the graph and “subtitle” adds a line under it."
          onChange={(properties) => p.apply((g) => editGraphProperties(g, { properties }))}
        />
        {!title ? (
          <button className="btn small ghost" data-tip="Name the graph, with an optional line under it" onClick={() => addProps(['title', 'subtitle'])}>
            <Icon name="plus" /> Title &amp; subtitle
          </button>
        ) : (
          !subtitle && (
            <button className="btn small ghost" data-tip="A line shown under the title" onClick={() => addProps(['subtitle'])}>
              <Icon name="plus" /> Subtitle
            </button>
          )
        )}
      </section>
      <section>
        <h3>Styles</h3>
        <div className="style-chips">
          {graph.styles.map((s) => (
            <span key={s.id} className="chip" title={`${s.target} style`}>
              <span className={`swatch ${s.target}`} style={{ background: s.color }} />
              {s.name || s.id}
            </span>
          ))}
          {graph.styles.length === 0 && <p className="muted small">No styles yet — everything uses the theme defaults.</p>}
        </div>
        <button className="btn small" onClick={() => p.onOpenStyles()}>
          <Icon name="palette" /> Manage styles
        </button>
      </section>
      <section>
        <p className="muted small hint">
          Click a node or edge to inspect it. Double-click empty canvas to add a node. Press <kbd>?</kbd> for all
          shortcuts.
        </p>
      </section>
    </>
  );
}

function ArrangeButton(b: { tip: string; icon: string; disabled?: boolean; onClick(): void }) {
  return (
    <button type="button" className="btn ghost icon" data-tip={b.tip} aria-label={b.tip} disabled={b.disabled} onClick={b.onClick}>
      <svg className="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d={b.icon} />
      </svg>
    </button>
  );
}

function MultiNodePanel({ ids, ...p }: Props & { ids: string[] }) {
  const nodes = p.graph.nodes.filter((n) => ids.includes(n.id));
  const styles = new Set(nodes.map((n) => n.style ?? ''));
  const setStyle = (style: string) =>
    p.apply((g) => nodes.reduce((acc, n) => editNode(acc, { id: n.id, style }).graph, g));
  return (
    <>
      <header className="panel-head">
        <span className="kind-badge">Nodes</span>
        <h2>{nodes.length} nodes selected</h2>
      </header>
      <ActionBar
        deleteTip={`Delete these ${nodes.length} nodes and their edges (Del)`}
        onDelete={() => p.apply((g) => nodes.reduce((acc, n) => removeNode(acc, n.id).graph, g)) && p.onSelect(null)}
      />
      <section>
        <p className="muted small">
          Drag any of them to move them together. <kbd>Shift</kbd>/<kbd>Ctrl</kbd> + click adds or removes a node.
        </p>
        <StyleSelect
          styles={p.graph.styles}
          target="node"
          value={styles.size === 1 ? [...styles][0] : undefined}
          onChange={setStyle}
          onManage={p.onOpenStyles}
        />
      </section>
      <section>
        <h3>Arrange</h3>
        <div className="arrange-row" role="group" aria-label="Align and distribute">
          {ARRANGE_BUTTONS.map((b) => (
            <ArrangeButton key={b.op} {...b} onClick={() => p.onArrange(ids, b.op)} />
          ))}
          <span className="arrange-sep" aria-hidden="true" />
          {DISTRIBUTE_BUTTONS.map((b) => (
            <ArrangeButton
              key={b.op}
              {...b}
              tip={nodes.length < 3 ? 'Select 3 or more nodes to distribute them' : b.tip}
              disabled={nodes.length < 3}
              onClick={() => p.onArrange(ids, b.op)}
            />
          ))}
          <span className="arrange-sep" aria-hidden="true" />
          {SPACE_BUTTONS.map((b) => (
            <ArrangeButton key={b.op} {...b} onClick={() => p.onArrange(ids, b.op)} />
          ))}
        </div>
      </section>
      <section>
        <h3>
          Selected
          <CopyButton text={nodes.map((n) => n.label).join('\n')} what="the selected labels, one per line" />
        </h3>
        <ul className="link-list">
          {nodes.map((n) => (
            <li key={n.id}>
              <button className="link" onClick={() => p.onSelect({ kind: 'node', id: n.id })} data-tip="Select only this node">
                {n.label}
              </button>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

export function Inspector(props: Props) {
  const { graph, selection } = props;
  if (selection?.kind === 'nodes') {
    const ids = selection.ids.filter((id) => graph.nodes.some((n) => n.id === id));
    if (ids.length === 1) {
      const node = graph.nodes.find((n) => n.id === ids[0])!;
      return <NodePanel key={node.id} {...props} node={node} />;
    }
    if (ids.length > 1) return <MultiNodePanel {...props} ids={ids} />;
  }
  if (selection?.kind === 'node') {
    const node = graph.nodes.find((n) => n.id === selection.id);
    if (node) return <NodePanel key={node.id} {...props} node={node} />;
  }
  if (selection?.kind === 'edge') {
    const edge = graph.edges.find((e) => e.id === selection.id);
    if (edge) return <EdgePanel key={edge.id} {...props} edge={edge} />;
  }
  return <GraphPanel {...props} />;
}
