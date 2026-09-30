import { useEffect, useState } from 'react';
import { type IconChoice, type IconSource, iconUrl, LUCIDE_SITE, parseIcon, searchLucide, searchSvgl, SVGL_SITE } from '../icons';

const RESULT_LIMIT = 120;
const SEARCH_DELAY_MS = 250;

const SOURCES: { id: IconSource; label: string; site: string; hint: string }[] = [
  { id: 'lucide', label: 'Lucide', site: LUCIDE_SITE, hint: 'Line icons in one color' },
  { id: 'svgl', label: 'Brands', site: SVGL_SITE, hint: 'Full-color logos from svgl' },
];

/** Small preview of an icon choice. Lucide icons are masks so they take the text color. */
function Thumb({ icon, onFail }: { icon: string; onFail(): void }) {
  const url = iconUrl(icon);
  if (parseIcon(icon).source === 'lucide') {
    return <span className="icon-thumb mask" style={{ WebkitMaskImage: `url("${url}")`, maskImage: `url("${url}")` }} />;
  }
  return <img className="icon-thumb" src={url} alt="" loading="lazy" onError={onFail} />;
}

/**
 * Icon field for node styles: type an icon name directly, or browse and search
 * Lucide icons and svgl brand logos.
 */
export function IconPicker(props: { value?: string; onChange(v: string | undefined): void }) {
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState<IconSource>(() => (props.value ? parseIcon(props.value).source : 'lucide'));
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<IconChoice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Logos listed by svgl's API that the pinned release doesn't have. */
  const [broken, setBroken] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setError(null);
    const timer = setTimeout(async () => {
      try {
        const found = await (source === 'lucide' ? searchLucide : searchSvgl)(query, RESULT_LIMIT);
        if (alive) setResults(found);
      } catch (err) {
        if (alive) {
          setResults([]);
          setError((err as Error).message);
        }
      }
    }, SEARCH_DELAY_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [open, source, query]);

  const shown = results?.filter((r) => !broken.has(r.icon)) ?? null;
  const current = SOURCES.find((s) => s.id === source)!;

  return (
    <div className="field icon-picker">
      <span>Icon</span>
      <div className="row">
        <input
          className="mono"
          value={props.value ?? ''}
          placeholder="none"
          aria-label="Icon name"
          data-tip='A brand logo name ("slack") or "lucide:<name>"'
          onChange={(e) => props.onChange(e.target.value.trim() || undefined)}
        />
        {props.value && (
          <button type="button" className="icon-btn" data-tip="Remove the icon" aria-label="Remove the icon" onClick={() => props.onChange(undefined)}>
            ×
          </button>
        )}
        <button type="button" className={`btn small${open ? ' active' : ''}`} onClick={() => setOpen((o) => !o)}>
          {open ? 'Close' : 'Browse…'}
        </button>
      </div>
      {open && (
        <div className="icon-browser">
          <div className="row">
            <div className="tabs" role="tablist">
              {SOURCES.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  role="tab"
                  aria-selected={s.id === source}
                  className={`tab${s.id === source ? ' active' : ''}`}
                  data-tip={s.hint}
                  onClick={() => {
                    setSource(s.id);
                    setResults(null);
                  }}
                >
                  {s.label}
                </button>
              ))}
            </div>
            <input
              className="grow"
              autoFocus
              value={query}
              placeholder={source === 'lucide' ? 'Search icons, e.g. folder, bug, user…' : 'Search brands, e.g. slack, figma…'}
              aria-label="Search icons"
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          {error && <p className="small error-text">{error}</p>}
          {!shown && !error && <p className="muted small">Loading…</p>}
          {shown?.length === 0 && !error && <p className="muted small">No icons match “{query}”.</p>}
          {shown && shown.length > 0 && (
            <div className="icon-grid">
              {shown.map((r) => (
                <button
                  key={r.icon}
                  type="button"
                  className={`icon-choice${r.icon === props.value ? ' active' : ''}`}
                  title={r.title}
                  aria-label={r.title}
                  onClick={() => props.onChange(r.icon)}
                >
                  <Thumb icon={r.icon} onFail={() => setBroken((b) => new Set(b).add(r.icon))} />
                </button>
              ))}
            </div>
          )}
          <p className="muted small">
            {shown && shown.length >= RESULT_LIMIT ? `First ${RESULT_LIMIT} results; search to narrow down. ` : ''}
            Browse all on{' '}
            <a href={current.site} target="_blank" rel="noreferrer">
              {current.site.replace(/^https:\/\//, '')}
            </a>
          </p>
        </div>
      )}
    </div>
  );
}
