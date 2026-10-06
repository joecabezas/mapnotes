import { useMemo, useState } from 'react';
import type { Graph } from '../../shared/model';
import { criteriaIsEmpty, inferNodeKind, projectGraph, type SavedView, type ViewCriteria } from '../../shared/filterViews';
import { Icon } from './Icon';

interface Props {
  graph: Graph;
  criteria: ViewCriteria;
  editing?: SavedView;
  onApply(criteria: ViewCriteria): void;
  onSave(name: string, criteria: ViewCriteria, replace: boolean): void;
  onDelete(): void;
  onClose(): void;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

function MultiPick({
  legend,
  options,
  selected,
  onChange,
}: {
  legend: string;
  options: { value: string; label: string }[];
  selected?: string[];
  onChange(next?: string[]): void;
}) {
  const all = options.map((o) => o.value);
  const active = selected ?? all;
  return (
    <fieldset className="filter-pick">
      <legend>{legend}</legend>
      <div className="row">
        <button type="button" className="btn small" onClick={() => onChange(undefined)}>
          All
        </button>
        <button type="button" className="btn small" onClick={() => onChange([])}>
          None
        </button>
      </div>
      <div className="filter-pick-options">
        {options.map((o) => (
          <label key={o.value}>
            <input
              type="checkbox"
              checked={selected === undefined || active.includes(o.value)}
              onChange={(e) => {
                const base = selected ?? all;
                onChange(e.target.checked ? [...base, o.value] : base.filter((v) => v !== o.value));
              }}
            />{' '}
            {o.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function FilterViewsDialog({ graph, criteria: initial, editing, onApply, onSave, onDelete, onClose }: Props) {
  const [criteria, setCriteria] = useState<ViewCriteria>(() => structuredClone(initial));
  const [name, setName] = useState(editing?.name ?? '');
  const patch = (part: Partial<ViewCriteria>) => setCriteria((c) => ({ ...c, ...part }));

  const cleaned = (): ViewCriteria => {
    const c = structuredClone(criteria);
    const props = c.properties?.filter((p) => p.key.trim());
    c.properties = props?.length ? props : undefined;
    return c;
  };

  const typeOptions = useMemo(() => {
    const kinds = uniqueStrings([...graph.nodes.map(inferNodeKind), ...(criteria.types ?? [])]);
    return kinds.map((value) => ({ value, label: value }));
  }, [graph.nodes, criteria.types]);

  const styleOptions = useMemo(() => {
    const ids = uniqueStrings([...graph.nodes.map((n) => n.style ?? ''), ...(criteria.styles ?? [])]);
    return ids.map((value) => ({
      value,
      label: graph.styles.find((s) => s.id === value)?.name ?? (value || '(no style)'),
    }));
  }, [graph.nodes, graph.styles, criteria.styles]);

  const labelOptions = useMemo(() => {
    const labels = uniqueStrings([...graph.edges.map((e) => e.label ?? ''), ...(criteria.edgeLabels ?? [])]);
    return labels.map((value) => ({ value, label: value || '(unlabeled)' }));
  }, [graph.edges, criteria.edgeLabels]);

  const preview = projectGraph(graph, cleaned());
  const propertyRows = criteria.properties ?? [];

  return (
    <div
      className="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="modal wide filter-views-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="filter-views-title"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <header className="modal-head">
          <h2 id="filter-views-title">Filters & saved views</h2>
          <p className="muted small">Focus the canvas on part of the graph. Edits still apply to the whole graph.</p>
          <button type="button" className="icon-btn close" aria-label="Close" onClick={onClose}>
            <Icon name="close" />
          </button>
        </header>

        <div className="filter-views-body">
          <label className="field">
            <span>Contains text</span>
            <input
              autoFocus
              value={criteria.query ?? ''}
              placeholder="Search labels, ids and properties"
              onChange={(e) => patch({ query: e.target.value || undefined })}
            />
          </label>

          <MultiPick legend="Entity types" options={typeOptions} selected={criteria.types} onChange={(types) => patch({ types })} />

          <details>
            <summary>Styles</summary>
            <MultiPick legend="Node styles" options={styleOptions} selected={criteria.styles} onChange={(styles) => patch({ styles })} />
          </details>

          <div className="filter-scope">
            <label className="field">
              <span>Near node</span>
              <select
                value={criteria.relatedTo?.[0] ?? ''}
                onChange={(e) => patch({ relatedTo: e.target.value ? [e.target.value] : undefined })}
              >
                <option value="">Anywhere</option>
                {graph.nodes.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Hop distance</span>
              <select value={criteria.depth ?? 2} onChange={(e) => patch({ depth: Number(e.target.value) })}>
                <option value={1}>1 hop</option>
                <option value={2}>2 hops</option>
                <option value={3}>3 hops</option>
              </select>
            </label>
          </div>

          <details>
            <summary>Exact properties</summary>
            <p className="muted small">Every listed property must match.</p>
            {propertyRows.map((row, i) => (
              <div className="filter-property-row" key={i}>
                <input
                  aria-label={`Property key ${i + 1}`}
                  placeholder="Key"
                  value={row.key}
                  onChange={(e) =>
                    patch({
                      properties: propertyRows.map((p, j) => (j === i ? { ...p, key: e.target.value } : p)),
                    })
                  }
                />
                <input
                  aria-label={`Property value ${i + 1}`}
                  placeholder="Value"
                  value={row.value}
                  onChange={(e) =>
                    patch({
                      properties: propertyRows.map((p, j) => (j === i ? { ...p, value: e.target.value } : p)),
                    })
                  }
                />
                <button
                  type="button"
                  className="btn small"
                  aria-label={`Remove property ${i + 1}`}
                  onClick={() => patch({ properties: propertyRows.filter((_, j) => j !== i) })}
                >
                  Remove
                </button>
              </div>
            ))}
            <button type="button" className="btn small" onClick={() => patch({ properties: [...propertyRows, { key: '', value: '' }] })}>
              Add property
            </button>
          </details>

          <details>
            <summary>Edge labels</summary>
            <MultiPick
              legend="Relationship labels"
              options={labelOptions}
              selected={criteria.edgeLabels}
              onChange={(edgeLabels) => patch({ edgeLabels })}
            />
          </details>

          <p className="filter-preview muted small">
            Preview: {preview.nodes.length} node{preview.nodes.length === 1 ? '' : 's'}, {preview.edges.length} edge
            {preview.edges.length === 1 ? '' : 's'}
          </p>
        </div>

        <footer className="filter-views-foot row">
          <button type="button" className="btn" onClick={() => onApply(cleaned())}>
            Apply filters
          </button>
          <label className="field grow">
            <span>View name</span>
            <input value={name} placeholder="e.g. People & PRs" onChange={(e) => setName(e.target.value)} />
          </label>
          <button
            type="button"
            className="btn primary"
            disabled={!name.trim()}
            onClick={() => onSave(name.trim(), cleaned(), !!editing)}
          >
            {editing ? 'Update view' : 'Save view'}
          </button>
          {editing && (
            <button type="button" className="btn danger" onClick={onDelete}>
              Delete
            </button>
          )}
          <button type="button" className="btn ghost" onClick={() => setCriteria({})}>
            Reset
          </button>
        </footer>
      </div>
    </div>
  );
}

export { criteriaIsEmpty };
