import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import sampleYaml from '../examples/pr-tracking.yaml?raw';
import { addEdge, addNode, emptyGraph, type Graph, type Position, removeEdge, removeNode } from '../shared/model';
import { parseGraphText, serializeGraph, serializeGraphYaml } from '../shared/yaml';
import { GraphCanvas, type GraphCanvasHandle, LAYOUTS, type LayoutName, type Selection } from './components/GraphCanvas';
import { HelpDialog } from './components/HelpDialog';
import { Inspector } from './components/Inspector';
import { StylesDialog } from './components/StylesDialog';
import { fetchServerGraph, pushServerGraph, subscribeServerGraph } from './sync';
import type { ThemeName } from './theme';

const LOCAL_KEY = 'mapnotes:graph';
const THEME_KEY = 'mapnotes:theme';
const HISTORY_LIMIT = 200;
/** Edits closer together than this collapse into a single undo step. */
const COALESCE_MS = 600;

type Mode = { kind: 'loading' } | { kind: 'file'; file: string } | { kind: 'local' };
type SyncStatus = 'saved' | 'saving' | 'error' | 'offline';
interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'error';
}
interface History {
  graph: Graph;
  past: Graph[];
  future: Graph[];
  lastAt: number;
}

function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function storageSet(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
}

function download(name: string, href: string) {
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  a.click();
}

function downloadText(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  download(name, url);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function fileBaseName(graph: Graph): string {
  const title = graph.properties.find((p) => p.key === 'title')?.value ?? 'graph';
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'graph';
}

function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement;
  return t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName);
}

export function App() {
  const [hist, setHist] = useState<History>({ graph: emptyGraph(), past: [], future: [], lastAt: 0 });
  const graph = hist.graph;
  const graphRef = useRef(graph);
  graphRef.current = graph;

  const [mode, setMode] = useState<Mode>({ kind: 'loading' });
  const [sync, setSync] = useState<SyncStatus>('saved');
  const [selection, setSelection] = useState<Selection>(null);
  const [connect, setConnect] = useState<{ source: string | null } | null>(null);
  const [theme, setTheme] = useState<ThemeName>(() => (storageGet(THEME_KEY) === 'light' ? 'light' : 'dark'));
  const [stylesOpen, setStylesOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [layoutName, setLayoutName] = useState<LayoutName>('cose');

  const canvas = useRef<GraphCanvasHandle>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const skipSave = useRef(true);
  const lastSent = useRef<string | null>(null);

  const toast = useCallback((text: string, kind: Toast['kind'] = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 6000 : 3000);
  }, []);

  /** Replaces the graph. `record` adds an undo step; `fromRemote` skips writing it back. */
  const setGraph = useCallback((next: Graph, opts: { record?: boolean; fromRemote?: boolean } = {}) => {
    const { record = true, fromRemote = false } = opts;
    if (fromRemote) skipSave.current = true;
    graphRef.current = next;
    setHist((h) => {
      if (!record) return { ...h, graph: next };
      const now = Date.now();
      const coalesce = !fromRemote && now - h.lastAt < COALESCE_MS && h.past.length > 0;
      const past = coalesce ? h.past : [...h.past, h.graph].slice(-HISTORY_LIMIT);
      return { graph: next, past, future: [], lastAt: fromRemote ? 0 : now };
    });
  }, []);

  /** Runs a model operation on the current graph, reporting errors as toasts. */
  const apply = useCallback(
    (op: (g: Graph) => Graph, record = true): boolean => {
      try {
        setGraph(op(graphRef.current), { record });
        return true;
      } catch (err) {
        toast((err as Error).message, 'error');
        return false;
      }
    },
    [setGraph, toast],
  );

  const undo = useCallback(() => {
    setHist((h) =>
      h.past.length ? { graph: h.past[h.past.length - 1], past: h.past.slice(0, -1), future: [h.graph, ...h.future], lastAt: 0 } : h,
    );
  }, []);
  const redo = useCallback(() => {
    setHist((h) => (h.future.length ? { graph: h.future[0], past: [...h.past, h.graph], future: h.future.slice(1), lastAt: 0 } : h));
  }, []);

  // ---- Initial load: prefer the dev server's file, fall back to local storage.
  useEffect(() => {
    let unsubscribe = () => {};
    (async () => {
      const server = await fetchServerGraph();
      if (server) {
        try {
          skipSave.current = true;
          lastSent.current = server.text;
          setHist({ graph: parseGraphText(server.text), past: [], future: [], lastAt: 0 });
        } catch (err) {
          toast(`Could not read ${server.file}: ${(err as Error).message}`, 'error');
        }
        setMode({ kind: 'file', file: server.file });
        unsubscribe = subscribeServerGraph(
          (text) => {
            if (text === lastSent.current) return;
            try {
              const next = parseGraphText(text);
              lastSent.current = text;
              setGraph(next, { fromRemote: true });
            } catch {
              /* ignore invalid intermediate states */
            }
          },
          (online) => setSync((s) => (online ? (s === 'offline' ? 'saved' : s) : 'offline')),
        );
        return;
      }
      const stored = storageGet(LOCAL_KEY);
      let initial = emptyGraph();
      try {
        initial = parseGraphText(stored ?? sampleYaml);
      } catch {
        initial = parseGraphText(sampleYaml);
      }
      skipSave.current = true;
      setHist({ graph: initial, past: [], future: [], lastAt: 0 });
      setMode({ kind: 'local' });
    })();
    return () => unsubscribe();
  }, [setGraph, toast]);

  // ---- Persist every change (debounced).
  useEffect(() => {
    if (mode.kind === 'loading') return;
    if (skipSave.current) {
      skipSave.current = false;
      return;
    }
    const text = serializeGraphYaml(graph);
    if (mode.kind === 'local') {
      storageSet(LOCAL_KEY, text);
      return;
    }
    setSync('saving');
    const timer = setTimeout(async () => {
      lastSent.current = text;
      try {
        await pushServerGraph(text);
        setSync('saved');
      } catch (err) {
        setSync('error');
        toast((err as Error).message, 'error');
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [graph, mode, toast]);

  // ---- Theme.
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    storageSet(THEME_KEY, theme);
  }, [theme]);

  // ---- Actions.
  /** Without a position the canvas picks a free spot in view. */
  const addNodeAt = useCallback(
    (position?: Position) => {
      try {
        const { graph: next, node } = addNode(graphRef.current, { label: 'New node', position });
        setGraph(next);
        setSelection({ kind: 'node', id: node.id });
      } catch (err) {
        toast((err as Error).message, 'error');
      }
    },
    [setGraph, toast],
  );

  const addNodeInView = useCallback(() => addNodeAt(), [addNodeAt]);

  const deleteSelection = useCallback(() => {
    if (!selection) return;
    const ok =
      selection.kind === 'node'
        ? apply((g) => removeNode(g, selection.id).graph)
        : apply((g) => removeEdge(g, selection.id));
    if (ok) setSelection(null);
  }, [selection, apply]);

  const startConnect = useCallback((source: string | null = null) => {
    setConnect({ source });
    toast(source ? 'Click the target node' : 'Click the source node, then the target node');
  }, [toast]);

  const onConnectTap = useCallback(
    (id: string) => {
      if (!connect) return;
      if (!connect.source) {
        setConnect({ source: id });
        return;
      }
      try {
        const { graph: next, edge } = addEdge(graphRef.current, { source: connect.source, target: id });
        setGraph(next);
        setSelection({ kind: 'edge', id: edge.id });
      } catch (err) {
        toast((err as Error).message, 'error');
      }
      setConnect(null);
    },
    [connect, setGraph, toast],
  );

  const openFile = useCallback(
    async (file: File) => {
      try {
        const next = parseGraphText(await file.text());
        setGraph(next);
        setSelection(null);
        toast(`Loaded ${file.name}: ${next.nodes.length} nodes, ${next.edges.length} edges`);
        setTimeout(() => canvas.current?.fit(), 50);
      } catch (err) {
        toast(`Could not open ${file.name}: ${(err as Error).message}`, 'error');
      }
    },
    [setGraph, toast],
  );

  const saveAs = useCallback(
    (format: 'yaml' | 'json' | 'png') => {
      const base = fileBaseName(graphRef.current);
      if (format === 'png') {
        const png = canvas.current?.exportPng();
        if (png) download(`${base}.png`, png);
        return;
      }
      const text = serializeGraph(graphRef.current, format);
      downloadText(`${base}.${format === 'yaml' ? 'yaml' : 'json'}`, text, format === 'yaml' ? 'text/yaml' : 'application/json');
    },
    [],
  );

  const newGraph = useCallback(() => {
    if (graphRef.current.nodes.length && !confirm('Start a new, empty graph? (You can undo this.)')) return;
    setGraph(emptyGraph());
    setSelection(null);
  }, [setGraph]);

  const loadExample = useCallback(() => {
    setGraph(parseGraphText(sampleYaml));
    setSelection(null);
    setTimeout(() => canvas.current?.fit(), 50);
  }, [setGraph]);

  const onNodesMoved = useCallback(
    (positions: Record<string, Position>, record: boolean) => {
      apply(
        (g) => ({ ...g, nodes: g.nodes.map((n) => (positions[n.id] ? { ...n, position: positions[n.id] } : n)) }),
        record,
      );
    },
    [apply],
  );

  // ---- Search.
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    return graph.nodes
      .filter(
        (n) =>
          n.label.toLowerCase().includes(q) ||
          n.id.toLowerCase().includes(q) ||
          n.properties.some((p) => p.value.toLowerCase().includes(q) || p.key.toLowerCase().includes(q)),
      )
      .map((n) => n.id);
  }, [graph.nodes, query]);

  // ---- Keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        saveAs('yaml');
        return;
      }
      if (mod && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        fileInput.current?.click();
        return;
      }
      if (isTyping(e)) return;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
        return;
      }
      if (mod || e.altKey) return;
      switch (e.key) {
        case 'n':
        case 'N':
          addNodeInView();
          break;
        case 'e':
        case 'E':
          if (connect) setConnect(null);
          else startConnect(selection?.kind === 'node' ? selection.id : null);
          break;
        case 'Delete':
        case 'Backspace':
          deleteSelection();
          break;
        case 'Escape':
          if (stylesOpen) setStylesOpen(false);
          else if (helpOpen) setHelpOpen(false);
          else if (connect) setConnect(null);
          else setSelection(null);
          break;
        case 'f':
        case 'F':
          canvas.current?.fit();
          break;
        case '/':
          e.preventDefault();
          searchInput.current?.focus();
          break;
        case '?':
          setHelpOpen((v) => !v);
          break;
        default:
          return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [addNodeInView, connect, deleteSelection, helpOpen, redo, saveAs, selection, startConnect, stylesOpen, undo]);

  const syncLabel =
    mode.kind === 'local'
      ? { text: 'Browser only', tip: 'No file server: work is kept in this browser. Use Save to download it.' }
      : mode.kind === 'file'
        ? {
            text: { saved: 'Saved', saving: 'Saving…', error: 'Save failed', offline: 'Reconnecting…' }[sync],
            tip: `Auto-saving to ${mode.file}. Changes to the file (e.g. from the MCP server) show up live.`,
          }
        : { text: 'Loading…', tip: '' };

  return (
    <div className="app">
      <header className="toolbar">
        <div className="brand" data-tip="MapNotes: a render engine for your graphs">
          <span className="logo">◉</span> MapNotes
        </div>

        <div className="group">
          <button className="btn ghost" data-tip="Start a new, empty graph" onClick={newGraph}>
            New
          </button>
          <button className="btn ghost" data-tip="Open a YAML or JSON graph file (Ctrl+O)" onClick={() => fileInput.current?.click()}>
            Open
          </button>
          <button className="btn ghost" data-tip="Download the graph as YAML (Ctrl+S)" onClick={() => saveAs('yaml')}>
            Save
          </button>
          <details className="menu">
            <summary className="btn ghost" data-tip="More export formats" aria-label="More export formats">
              ▾
            </summary>
            <div className="menu-items" onClick={(e) => (e.currentTarget.parentElement as HTMLDetailsElement).removeAttribute('open')}>
              <button onClick={() => saveAs('yaml')}>Download YAML</button>
              <button onClick={() => saveAs('json')}>Download JSON</button>
              <button onClick={() => saveAs('png')}>Export PNG image</button>
            </div>
          </details>
          <input
            ref={fileInput}
            type="file"
            accept=".yaml,.yml,.json,application/json,text/yaml"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) openFile(f);
              e.target.value = '';
            }}
          />
        </div>

        <div className="group">
          <button className="btn ghost icon" data-tip="Undo (Ctrl+Z)" aria-label="Undo" disabled={!hist.past.length} onClick={undo}>
            ↶
          </button>
          <button className="btn ghost icon" data-tip="Redo (Ctrl+Shift+Z)" aria-label="Redo" disabled={!hist.future.length} onClick={redo}>
            ↷
          </button>
        </div>

        <div className="group">
          <button className="btn primary" data-tip="Add a node (N) — or double-click the canvas" onClick={addNodeInView}>
            + Node
          </button>
          <button
            className={`btn${connect ? ' active' : ''}`}
            data-tip="Connect two nodes with an edge (E): click the source, then the target"
            onClick={() => (connect ? setConnect(null) : startConnect(selection?.kind === 'node' ? selection.id : null))}
          >
            ⟶ Connect
          </button>
          <button className="btn ghost" data-tip="Delete the selection (Del)" disabled={!selection} onClick={deleteSelection}>
            Delete
          </button>
        </div>

        <div className="group">
          <select
            value={layoutName}
            data-tip="Automatic layout algorithm"
            aria-label="Layout algorithm"
            onChange={(e) => setLayoutName(e.target.value as LayoutName)}
          >
            {LAYOUTS.map((l) => (
              <option key={l.name} value={l.name}>
                {l.label}
              </option>
            ))}
          </select>
          <button className="btn ghost" data-tip="Re-arrange all nodes with the chosen layout" onClick={() => canvas.current?.runLayout(layoutName)}>
            Layout
          </button>
          <button className="btn ghost" data-tip="Fit graph to screen (F)" onClick={() => canvas.current?.fit()}>
            Fit
          </button>
          <button className="btn ghost" data-tip="Colors, shapes, sizes and line styles" onClick={() => setStylesOpen(true)}>
            🎨 Styles
          </button>
        </div>

        <div className="search" data-tip="Search nodes by label, id or property (/)">
          <input
            ref={searchInput}
            value={query}
            placeholder="Search…"
            aria-label="Search nodes"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setQuery('');
                e.currentTarget.blur();
              }
              if (e.key === 'Enter' && matches?.length) {
                const sel = { kind: 'node' as const, id: matches[0] };
                setSelection(sel);
                canvas.current?.center(sel);
              }
            }}
          />
          {matches && <span className="count">{matches.length}</span>}
        </div>

        <div className="spacer" />
        <div className={`sync ${mode.kind === 'file' ? sync : 'local'}`} data-tip={syncLabel.tip}>
          <span className="dot" /> {syncLabel.text}
        </div>
        <button
          className="btn ghost icon"
          data-tip={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          aria-label="Toggle theme"
          onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
        >
          {theme === 'dark' ? '☀' : '☾'}
        </button>
        <button className="btn ghost icon" data-tip="Help & shortcuts (?)" aria-label="Help" onClick={() => setHelpOpen(true)}>
          ?
        </button>
      </header>

      <main className="main">
        <GraphCanvas
          ref={canvas}
          graph={graph}
          theme={theme}
          selection={selection}
          connecting={connect !== null}
          connectSource={connect?.source ?? null}
          highlight={matches}
          onSelect={setSelection}
          onNodeTapInConnectMode={onConnectTap}
          onBackgroundDoubleTap={addNodeAt}
          onNodesMoved={onNodesMoved}
        />

        {connect && (
          <div className="banner">
            {connect.source ? (
              <>
                Connecting from <b>{graph.nodes.find((n) => n.id === connect.source)?.label ?? connect.source}</b> — click the
                target node
              </>
            ) : (
              <>Click the source node</>
            )}
            <button className="btn small ghost" onClick={() => setConnect(null)}>
              Cancel (Esc)
            </button>
          </div>
        )}

        {mode.kind !== 'loading' && graph.nodes.length === 0 && (
          <div className="empty">
            <h2>Your graph is empty</h2>
            <p>
              Press <kbd>N</kbd> or double-click anywhere to add a node, then <kbd>E</kbd> to connect nodes.
            </p>
            <div className="row center">
              <button className="btn primary" onClick={addNodeInView}>
                + Add first node
              </button>
              <button className="btn" onClick={() => fileInput.current?.click()}>
                Open a file
              </button>
              <button className="btn ghost" onClick={loadExample}>
                Load example
              </button>
            </div>
          </div>
        )}

        <aside className="inspector">
          <Inspector
            graph={graph}
            selection={selection}
            apply={apply}
            onSelect={(sel) => {
              setSelection(sel);
              if (sel) canvas.current?.center(sel);
            }}
            onConnectFrom={(id) => startConnect(id)}
            onOpenStyles={() => setStylesOpen(true)}
          />
        </aside>
      </main>

      {stylesOpen && <StylesDialog graph={graph} theme={theme} apply={apply} onClose={() => setStylesOpen(false)} />}
      {helpOpen && <HelpDialog onClose={() => setHelpOpen(false)} fileMode={mode.kind === 'file' ? mode.file : null} />}

      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}
