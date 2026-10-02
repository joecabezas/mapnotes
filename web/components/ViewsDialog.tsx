import { useState } from 'react';
import { Icon } from './Icon';
import type { Graph } from '../../shared/model';
import { filterGraph, nodeType, type GraphView, type ViewFilters } from '../../shared/views';

interface Props {
  graph: Graph;
  filters: ViewFilters;
  view?: GraphView;
  onApply(filters: ViewFilters): void;
  onSave(name: string, filters: ViewFilters, replace: boolean): void;
  onDelete(): void;
  onClose(): void;
}

function Choices({
  title,
  options,
  value,
  onChange,
}: {
  title: string;
  options: { id: string; label: string }[];
  value?: string[];
  onChange(value?: string[]): void;
}) {
  return (
    <fieldset className="view-choices">
      <legend>{title}</legend>
      <div className="row">
        <button className="btn small" onClick={() => onChange(undefined)}>
          All
        </button>
        <button className="btn small" onClick={() => onChange([])}>
          None
        </button>
      </div>
      <div className="view-options">
        {options.map((o) => (
          <label key={o.id}>
            <input
              type="checkbox"
              checked={value === undefined || value.includes(o.id)}
              onChange={(e) => {
                const selected = value ?? options.map((option) => option.id);
                onChange(e.target.checked ? [...selected, o.id] : selected.filter((id) => id !== o.id));
              }}
            />{' '}
            {o.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function ViewsDialog(p: Props) {
  const [filters, setFilters] = useState<ViewFilters>(() => structuredClone(p.filters));
  const [name, setName] = useState(p.view?.name ?? '');
  const set = (patch: Partial<ViewFilters>) => setFilters((f) => ({ ...f, ...patch }));
  const options = (values: string[]) => [...new Set(values)].sort().map((id) => ({ id, label: id || '(unlabeled)' }));
  const types = options([...p.graph.nodes.map(nodeType), ...(filters.types ?? [])]);
  const styles = options([...p.graph.nodes.map((n) => n.style ?? ''), ...(filters.styles ?? [])]).map((o) => ({
    ...o,
    label: p.graph.styles.find((s) => s.id === o.id)?.name ?? (o.id || '(no style)'),
  }));
  const labels = options([...p.graph.edges.map((e) => e.label ?? ''), ...(filters.edgeLabels ?? [])]);
  const visible = filterGraph(p.graph, filters);
  return (
    <div
      className="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) p.onClose();
      }}
    >
      <div
        className="modal wide views-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="views-title"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            p.onClose();
          }
        }}
      >
        <header className="modal-head">
          <h2 id="views-title">Filters & saved views</h2>
          <p className="muted small">Show a focused part of the same graph. Edits stay shared across views.</p>
          <button className="icon-btn close" aria-label="Close filters" onClick={p.onClose}>
            <Icon name="close" />
          </button>
        </header>
        <div className="views-body">
          <label className="field">
            <span>Contains text</span>
            <input
              autoFocus
              value={filters.query ?? ''}
              placeholder="Search labels, ids and properties"
              onChange={(e) => set({ query: e.target.value })}
            />
          </label>
          <Choices title="Entity types" options={types} value={filters.types} onChange={(types) => set({ types })} />
          <details>
            <summary>Styles & status colors</summary>
            <Choices
              title="Node styles"
              options={styles}
              value={filters.styles}
              onChange={(styles) => set({ styles })}
            />
          </details>
          <div className="view-scope">
            <label className="field">
              <span>Connected to</span>
              <select
                value={filters.relatedTo?.[0] ?? ''}
                onChange={(e) => set({ relatedTo: e.target.value ? [e.target.value] : undefined })}
              >
                <option value="">Anywhere in graph</option>
                {p.graph.nodes.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.label}
                  </option>
                ))}
                {filters.relatedTo
                  ?.filter((id) => !p.graph.nodes.some((n) => n.id === id))
                  .map((id) => (
                    <option key={id} value={id}>
                      Missing node: {id}
                    </option>
                  ))}
              </select>
            </label>
            <label className="field">
              <span>Connection distance</span>
              <select value={filters.depth ?? 2} onChange={(e) => set({ depth: Number(e.target.value) })}>
                <option value={1}>1 connection</option>
                <option value={2}>2 connections</option>
                <option value={3}>3 connections</option>
              </select>
            </label>
          </div>
          <details>
            <summary>Exact property filters</summary>
            <p>Each property must match. Types and styles allow any selected value.</p>
            {(filters.properties ?? []).map((property, i) => (
              <div className="view-property" key={i}>
                <input
                  aria-label={`Property key ${i + 1}`}
                  placeholder="Property key (e.g. status)"
                  value={property.key}
                  onChange={(e) =>
                    set({
                      properties: filters.properties!.map((v, j) => (j === i ? { ...v, key: e.target.value } : v)),
                    })
                  }
                />
                <input
                  aria-label={`Property value ${i + 1}`}
                  placeholder="Exact value"
                  value={property.value}
                  onChange={(e) =>
                    set({
                      properties: filters.properties!.map((v, j) => (j === i ? { ...v, value: e.target.value } : v)),
                    })
                  }
                />
                <button
                  className="btn small"
                  aria-label={`Remove property ${i + 1}`}
                  onClick={() => set({ properties: filters.properties!.filter((_, j) => j !== i) })}
                >
                  Remove
                </button>
              </div>
            ))}
            <button
              className="btn small"
              onClick={() => set({ properties: [...(filters.properties ?? []), { key: '', value: '' }] })}
            >
              Add property filter
            </button>
          </details>
          <details>
            <summary>Relationships</summary>
            <Choices
              title="Edge labels"
              options={labels}
              value={filters.edgeLabels}
              onChange={(edgeLabels) => set({ edgeLabels })}
            />
          </details>
          <p role="status">
            {visible.nodes.length} of {p.graph.nodes.length} nodes · {visible.edges.length} of {p.graph.edges.length}{' '}
            connections
          </p>
          <label className="field">
            <span>View name</span>
            <input value={name} placeholder="People & PRs" onChange={(e) => setName(e.target.value)} />
          </label>
          <div className="row view-actions">
            <button className="btn" onClick={() => setFilters({})}>
              Reset filters
            </button>
            <button
              className="btn"
              disabled={filters.properties?.some((v) => !v.key.trim())}
              onClick={() => p.onApply(filters)}
            >
              Apply filters
            </button>
            <button
              className="btn primary"
              disabled={!name.trim() || filters.properties?.some((v) => !v.key.trim())}
              onClick={() => p.onSave(name.trim(), filters, false)}
            >
              Save new view
            </button>
            {p.view && (
              <>
                <button
                  className="btn"
                  disabled={!name.trim() || filters.properties?.some((v) => !v.key.trim())}
                  onClick={() => p.onSave(name.trim(), filters, true)}
                >
                  Update view
                </button>
                <button className="btn danger" onClick={p.onDelete}>
                  Delete view
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
