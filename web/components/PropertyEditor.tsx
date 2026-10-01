import { useEffect, useState } from 'react';
import type { KeyValue } from '../../shared/model';
import { CopyButton } from './CopyButton';
import { Icon } from './Icon';

interface Props {
  properties: KeyValue[];
  onChange(next: KeyValue[]): void;
  emptyHint?: string;
}

/** Keys naming an identifier, e.g. "id", "user_id", "Order ID", "nodeId", "ids". */
const isIdKey = (key: string) => /(?:^|[^a-z])ids?(?![a-z])/i.test(key) || /[a-z]Ids?(?![a-z])/.test(key);

const same = (a: KeyValue[], b: KeyValue[]) =>
  a.length === b.length && a.every((p, i) => p.key === b[i].key && p.value === b[i].value);

/** Editable key/value list. Edits are committed when a field loses focus or on Enter. */
export function PropertyEditor({ properties, onChange, emptyHint }: Props) {
  const [rows, setRows] = useState<KeyValue[]>(properties);

  useEffect(() => setRows(properties), [properties]);

  const commit = (next = rows) => {
    const clean = next.filter((r) => r.key.trim() !== '').map((r) => ({ key: r.key.trim(), value: r.value }));
    if (!same(clean, properties)) onChange(clean);
    else setRows(properties);
  };

  const update = (i: number, patch: Partial<KeyValue>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const dupes = new Set(rows.map((r) => r.key.trim()).filter((k, i, all) => k && all.indexOf(k) !== i));

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
    if (e.key === 'Escape') {
      setRows(properties);
      (e.target as HTMLInputElement).blur();
    }
  };

  return (
    <div className="props">
      {rows.length === 0 && <p className="muted small">{emptyHint ?? 'No properties yet.'}</p>}
      {rows.map((row, i) => (
        <div className={`prop-row${dupes.has(row.key.trim()) ? ' dupe' : ''}`} key={i}>
          <input
            className="prop-key"
            value={row.key}
            placeholder="key"
            aria-label="Property name"
            title={dupes.has(row.key.trim()) ? 'Duplicate key — keys should be unique' : 'Property name'}
            onChange={(e) => update(i, { key: e.target.value })}
            onBlur={() => commit()}
            onKeyDown={onKey}
          />
          <input
            className="prop-value"
            value={row.value}
            placeholder="value"
            aria-label="Property value"
            onChange={(e) => update(i, { value: e.target.value })}
            onBlur={() => commit()}
            onKeyDown={onKey}
          />
          {isIdKey(row.key) && row.value && <CopyButton text={row.value} what={row.key.trim()} />}
          {/^https?:\/\//.test(row.value) && (
            <a className="icon-btn" href={row.value} target="_blank" rel="noreferrer" data-tip="Open link">
              <svg className="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              </svg>
            </a>
          )}
          <button
            className="icon-btn danger"
            data-tip="Remove property"
            aria-label="Remove property"
            onClick={() => commit(rows.filter((_, j) => j !== i))}
          >
            <svg className="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2M10 11v6M14 11v6" />
            </svg>
          </button>
        </div>
      ))}
      <button className="btn small ghost" onClick={() => setRows((rs) => [...rs, { key: '', value: '' }])}>
        <Icon name="plus" /> Add property
      </button>
    </div>
  );
}
