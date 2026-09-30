import { useEffect, useState } from 'react';
import {
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
import type { Selection } from './GraphCanvas';
import { PropertyEditor } from './PropertyEditor';

interface Props {
  graph: Graph;
  selection: Selection;
  /** Applies a graph operation; errors are reported to the user. Returns success. */
  apply(op: (g: Graph) => Graph): boolean;
  onSelect(sel: Selection): void;
  onConnectFrom(nodeId: string): void;
  onOpenStyles(): void;
}

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
  const [copied, setCopied] = useState(false);
  useEffect(() => setDraft(props.value), [props.value]);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(t);
  }, [copied]);
  const commit = () => {
    if (draft === props.value) return;
    if (props.onCommit(draft) === false) setDraft(props.value);
  };
  const copy = () => {
    void navigator.clipboard.writeText(props.value).then(() => setCopied(true));
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
          <button
            type="button"
            className="icon-btn"
            data-tip={copied ? 'Copied!' : `Copy ${props.label.toLowerCase()}`}
            aria-label={`Copy ${props.label.toLowerCase()}`}
            onClick={copy}
          >
            {copied ? '✓' : '⧉'}
          </button>
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
  onManage(): void;
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
        <button className="icon-btn" data-tip="Edit styles" aria-label="Edit styles" onClick={props.onManage}>
          🎨
        </button>
      </div>
    </label>
  );
}

function NodePanel({ node, ...p }: Props & { node: GraphNode }) {
  const connected = p.graph.edges.filter((e) => e.source === node.id || e.target === node.id);
  const labelOf = (id: string) => p.graph.nodes.find((n) => n.id === id)?.label ?? id;
  return (
    <>
      <header className="panel-head">
        <span className="kind-badge">Node</span>
        <h2 title={node.label}>{node.label}</h2>
      </header>
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
                  {out ? '→' : '←'} {e.label || e.id}
                </button>
                <button className="link muted" onClick={() => p.onSelect({ kind: 'node', id: other })} data-tip="Select node">
                  {labelOf(other)}
                </button>
              </li>
            );
          })}
        </ul>
        <button className="btn small" onClick={() => p.onConnectFrom(node.id)} data-tip="Then click the target node (E)">
          + Connect to…
        </button>
      </section>
      <footer className="panel-foot">
        <button
          className="btn danger"
          data-tip="Delete this node and its edges (Del)"
          onClick={() => p.apply((g) => removeNode(g, node.id).graph) && p.onSelect(null)}
        >
          Delete node
        </button>
      </footer>
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
        <button
          className="btn small ghost"
          data-tip="Swap source and target"
          onClick={() => p.apply((g) => editEdge(g, { id: edge.id, source: edge.target, target: edge.source }).graph)}
        >
          ⇄ Reverse direction
        </button>
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
      <footer className="panel-foot">
        <button
          className="btn danger"
          data-tip="Delete this edge (Del)"
          onClick={() => p.apply((g) => removeEdge(g, edge.id)) && p.onSelect(null)}
        >
          Delete edge
        </button>
      </footer>
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
          <h2 title={title?.value}>{title?.value || 'Untitled graph'}</h2>
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
            + Title &amp; subtitle
          </button>
        ) : (
          !subtitle && (
            <button className="btn small ghost" data-tip="A line shown under the title" onClick={() => addProps(['subtitle'])}>
              + Subtitle
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
        <button className="btn small" onClick={p.onOpenStyles}>
          🎨 Manage styles
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

export function Inspector(props: Props) {
  const { graph, selection } = props;
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
