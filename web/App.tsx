import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { addEdge, addNode, emptyGraph, type Graph, type Position, removeEdge, removeNode } from '../shared/model';
import { formatForPath, parseGraphText, serializeGraph, serializeGraphYaml } from '../shared/yaml';
import { GraphCanvas, type GraphCanvasHandle, LAYOUTS, type LayoutName, type Selection } from './components/GraphCanvas';
import { HelpDialog } from './components/HelpDialog';
import { Inspector } from './components/Inspector';
import { PanelResizer } from './components/PanelResizer';
import { StylesDialog } from './components/StylesDialog';
import {
  fileAccessSupported,
  hasPermission,
  pickFileToOpen,
  pickFileToSave,
  readHandle,
  recallHandle,
  rememberHandle,
  writeHandle,
} from './fileAccess';
import type { ThemeName } from './theme';

const LOCAL_KEY = 'mapnotes:graph';
const THEME_KEY = 'mapnotes:theme';
const PANEL_WIDTH_KEY = 'mapnotes:panelWidth';
const PANEL_WIDTH_DEFAULT = 330;
const PANEL_WIDTH_MIN = 260;
/** The canvas always keeps at least this much room. */
const CANVAS_MIN_WIDTH = 320;
const HISTORY_LIMIT = 200;
/** Edits closer together than this collapse into a single undo step. */
const COALESCE_MS = 600;
/** How often the open file is checked for changes made by other tools (e.g. the MCP server). */
const FILE_POLL_MS = 1000;
/** Edits closer together than this are written to the file once. */
const FILE_SAVE_DELAY_MS = 300;

/**
 * The file on disk the graph is linked to. `reconnect`: the browser remembered
 * the file from a previous visit but needs a click to grant access again.
 */
type FileStatus = 'saved' | 'saving' | 'error' | 'reconnect';
interface OpenFile {
  handle: FileSystemFileHandle;
  status: FileStatus;
}

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

/** Graph text in the format implied by the file's extension (.json or YAML). */
function textFor(graph: Graph, fileName: string): string {
  return serializeGraph(graph, formatForPath(fileName));
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

  const [loaded, setLoaded] = useState(false);
  const [file, setFile] = useState<OpenFile | null>(null);
  const fileRef = useRef(file);
  fileRef.current = file;
  const [selection, setSelection] = useState<Selection>(null);
  const [connect, setConnect] = useState<{ source: string | null } | null>(null);
  const [theme, setTheme] = useState<ThemeName>(() => (storageGet(THEME_KEY) === 'light' ? 'light' : 'dark'));
  const [stylesOpen, setStylesOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [layoutName, setLayoutName] = useState<LayoutName>('elk');
  const [panelWidth, setPanelWidth] = useState(() => Number(storageGet(PANEL_WIDTH_KEY)) || PANEL_WIDTH_DEFAULT);
  const panelMax = Math.max(PANEL_WIDTH_MIN, window.innerWidth - CANVAS_MIN_WIDTH);

  const canvas = useRef<GraphCanvasHandle>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const skipSave = useRef(true);
  /** File contents as last read or written by us, to tell our own writes from other tools' edits. */
  const fileText = useRef<string | null>(null);
  const fileModified = useRef(0);
  /** Text of a write still in flight, so the file watcher doesn't mistake it for another tool's edit. */
  const writingText = useRef<string | null>(null);

  const toast = useCallback((text: string, kind: Toast['kind'] = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 6000 : 3000);
  }, []);

  /** Writes `text` to the file; only a successful write counts as what's on disk. */
  const writeFileText = useCallback(async (handle: FileSystemFileHandle, text: string) => {
    writingText.current = text;
    try {
      fileModified.current = await writeHandle(handle, text);
      fileText.current = text;
    } finally {
      writingText.current = null;
    }
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

  /** Replaces the graph and clears undo history, without writing it back to the file. */
  const resetGraph = useCallback((next: Graph) => {
    skipSave.current = true;
    graphRef.current = next;
    setHist({ graph: next, past: [], future: [], lastAt: 0 });
  }, []);

  /** Reads the linked file into the canvas. `fresh` (a newly opened file) also clears undo history. */
  const loadFromFile = useCallback(
    async (handle: FileSystemFileHandle, fresh: boolean): Promise<boolean> => {
      try {
        const { text, lastModified } = await readHandle(handle);
        const next = parseGraphText(text);
        fileText.current = text;
        fileModified.current = lastModified;
        if (fresh) resetGraph(next);
        else setGraph(next, { fromRemote: true });
        setFile({ handle, status: 'saved' });
        return true;
      } catch (err) {
        toast(`Could not read ${handle.name}: ${(err as Error).message}`, 'error');
        return false;
      }
    },
    [resetGraph, setGraph, toast],
  );

  // ---- Initial load: the browser copy first, then the file linked last time (if any).
  useEffect(() => {
    let initial = emptyGraph();
    const saved = storageGet(LOCAL_KEY);
    if (saved) {
      try {
        initial = parseGraphText(saved);
      } catch {
        // Unreadable browser copy: start empty.
      }
    }
    resetGraph(initial);
    setLoaded(true);
    if (!fileAccessSupported) return;
    void (async () => {
      const handle = await recallHandle();
      if (!handle) return;
      if (await hasPermission(handle)) await loadFromFile(handle, true);
      else setFile({ handle, status: 'reconnect' });
    })();
  }, [loadFromFile, resetGraph]);

  // ---- Keep every change in the browser, and write it to the linked file.
  useEffect(() => {
    if (!loaded) return;
    storageSet(LOCAL_KEY, serializeGraphYaml(graph));
    if (skipSave.current) {
      skipSave.current = false;
      return;
    }
    const handle = fileRef.current?.status === 'reconnect' ? null : fileRef.current?.handle;
    if (!handle) return;
    const text = textFor(graph, handle.name);
    if (text === fileText.current) {
      // e.g. undone back to what's on disk while a write was still pending
      setFile((f) => (f?.status === 'saving' ? { ...f, status: 'saved' } : f));
      return;
    }
    setFile((f) => f && { ...f, status: 'saving' });
    const timer = setTimeout(async () => {
      try {
        await writeFileText(handle, text);
        setFile((f) => (f?.handle === handle ? { ...f, status: 'saved' } : f));
      } catch (err) {
        setFile((f) => (f?.handle === handle ? { ...f, status: 'error' } : f));
        toast(`Could not save ${handle.name}: ${(err as Error).message}`, 'error');
      }
    }, FILE_SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [graph, loaded, toast, writeFileText]);

  // ---- Pick up changes other tools (e.g. the MCP server) make to the linked file.
  const watchedHandle = file && file.status !== 'reconnect' ? file.handle : null;
  useEffect(() => {
    if (!watchedHandle) return;
    let busy = false;
    const timer = setInterval(async () => {
      if (busy || fileRef.current?.status === 'saving') return;
      busy = true;
      try {
        const current = await watchedHandle.getFile();
        if (current.lastModified === fileModified.current) return;
        fileModified.current = current.lastModified;
        const text = await current.text();
        if (text === fileText.current || text === writingText.current) return;
        const next = parseGraphText(text);
        fileText.current = text;
        setGraph(next, { fromRemote: true });
        setFile((f) => (f?.handle === watchedHandle ? { ...f, status: 'saved' } : f));
      } catch (err) {
        // A half-written or invalid file is skipped until the next change; a missing one is reported once.
        if ((err as DOMException).name === 'NotFoundError' && fileRef.current?.status !== 'error') {
          setFile((f) => (f?.handle === watchedHandle ? { ...f, status: 'error' } : f));
          toast(`${watchedHandle.name} was moved or deleted`, 'error');
        }
      } finally {
        busy = false;
      }
    }, FILE_POLL_MS);
    return () => clearInterval(timer);
  }, [watchedHandle, setGraph, toast]);

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
      selection.kind === 'nodes'
        ? apply((g) => selection.ids.reduce((acc, id) => removeNode(acc, id).graph, g))
        : selection.kind === 'node'
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

  /** Stops writing to the linked file; the graph stays in the browser. */
  const closeFile = useCallback(() => {
    setFile(null);
    fileText.current = null;
    void rememberHandle(null);
  }, []);

  const openAction = useCallback(async () => {
    if (!fileAccessSupported) {
      fileInput.current?.click();
      return;
    }
    try {
      const handle = await pickFileToOpen();
      if (!handle || !(await loadFromFile(handle, true))) return;
      void rememberHandle(handle);
      setSelection(null);
      toast(`Opened ${handle.name}: changes are saved to it automatically`);
      setTimeout(() => canvas.current?.fit(), 50);
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  }, [loadFromFile, toast]);

  /** Writes the graph to a new file of the user's choice and links to it. */
  const saveToNewFile = useCallback(async () => {
    try {
      const handle = await pickFileToSave(`${fileBaseName(graphRef.current)}.yaml`);
      if (!handle) return;
      await writeFileText(handle, textFor(graphRef.current, handle.name));
      setFile({ handle, status: 'saved' });
      void rememberHandle(handle);
      toast(`Saved to ${handle.name}: further changes are saved automatically`);
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  }, [toast, writeFileText]);

  /** Asks again for access to the file linked on a previous visit (needs a click). */
  const reconnectFile = useCallback(async () => {
    const handle = fileRef.current?.handle;
    if (!handle) return;
    try {
      if (!(await hasPermission(handle, true))) {
        toast(`No access to ${handle.name}`, 'error');
        return;
      }
      if (await loadFromFile(handle, false)) toast(`Reconnected to ${handle.name}`);
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  }, [loadFromFile, toast]);

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

  /** Ctrl+S: write the linked file now, or pick a file to save to (download where unsupported). */
  const save = useCallback(async () => {
    const f = fileRef.current;
    if (!f) {
      if (fileAccessSupported) await saveToNewFile();
      else saveAs('yaml');
      return;
    }
    if (f.status === 'reconnect') {
      await reconnectFile();
      return;
    }
    try {
      await writeFileText(f.handle, textFor(graphRef.current, f.handle.name));
      setFile((cur) => (cur?.handle === f.handle ? { ...cur, status: 'saved' } : cur));
      toast(`Saved to ${f.handle.name}`);
    } catch (err) {
      setFile((cur) => (cur?.handle === f.handle ? { ...cur, status: 'error' } : cur));
      toast(`Could not save ${f.handle.name}: ${(err as Error).message}`, 'error');
    }
  }, [reconnectFile, saveAs, saveToNewFile, toast, writeFileText]);

  // New graphs are unlinked first, so they never overwrite the open file.
  const newGraph = useCallback(() => {
    if (graphRef.current.nodes.length && !confirm('Start a new, empty graph? (You can undo this.)')) return;
    closeFile();
    setGraph(emptyGraph());
    setSelection(null);
  }, [closeFile, setGraph]);

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
        void save();
        return;
      }
      if (mod && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        void openAction();
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
      if (mod && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        const ids = graphRef.current.nodes.map((n) => n.id);
        setSelection(ids.length ? { kind: 'nodes', ids } : null);
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
  }, [addNodeInView, connect, deleteSelection, helpOpen, openAction, redo, save, selection, startConnect, stylesOpen, undo]);

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
          <button
            className="btn ghost"
            data-tip={
              fileAccessSupported
                ? 'Open a YAML or JSON graph file; changes are saved back to it (Ctrl+O)'
                : 'Open a YAML or JSON graph file (Ctrl+O)'
            }
            onClick={() => void openAction()}
          >
            Open
          </button>
          {fileAccessSupported ? (
            <button
              className="btn ghost"
              data-tip={file ? `Save to ${file.handle.name} (Ctrl+S)` : 'Save the graph to a file on disk (Ctrl+S)'}
              onClick={() => void save()}
            >
              Save
            </button>
          ) : (
            <button className="btn ghost" data-tip="Download the graph as YAML (Ctrl+S)" onClick={() => saveAs('yaml')}>
              Download
            </button>
          )}
          <details className="menu">
            <summary className="btn ghost" data-tip="More save and export options" aria-label="More save and export options">
              ▾
            </summary>
            <div className="menu-items" onClick={(e) => (e.currentTarget.parentElement as HTMLDetailsElement).removeAttribute('open')}>
              {fileAccessSupported && <button onClick={() => void saveToNewFile()}>Save as…</button>}
              {file && <button onClick={closeFile}>Close file (keep in browser)</button>}
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
            onChange={(e) => {
              const name = e.target.value as LayoutName;
              setLayoutName(name);
              canvas.current?.runLayout(name);
            }}
          >
            {LAYOUTS.map((l) => (
              <option key={l.name} value={l.name}>
                {l.label}
              </option>
            ))}
          </select>
          <button
            className="btn ghost icon"
            data-tip="Run the chosen layout again"
            aria-label="Run the layout again"
            onClick={() => canvas.current?.runLayout(layoutName)}
          >
            ↻
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
        {file?.status === 'reconnect' ? (
          <button
            className="sync reconnect"
            data-tip={`The browser needs your permission again to edit ${file.handle.name}`}
            onClick={() => void reconnectFile()}
          >
            <span className="dot" /> Reconnect {file.handle.name}
          </button>
        ) : file?.status === 'error' ? (
          <button
            className="sync error"
            data-tip={`The last save to ${file.handle.name} failed: click (or Ctrl+S) to try again`}
            onClick={() => void save()}
          >
            <span className="dot" /> Save failed · Retry {file.handle.name}
          </button>
        ) : file ? (
          <div
            className={`sync ${file.status}`}
            data-tip={`Changes are saved to ${file.handle.name}; edits to it from other tools (e.g. the MCP server) show up here.`}
          >
            <span className="dot" /> {{ saved: 'Saved', saving: 'Saving…' }[file.status]} · {file.handle.name}
          </div>
        ) : (
          <div
            className="sync local"
            data-tip={
              fileAccessSupported
                ? 'Not linked to a file: work is kept in this browser. Open a file, or Save to create one.'
                : 'This browser cannot edit files on disk: work is kept here. Use Download to save a copy.'
            }
          >
            <span className="dot" /> Browser only
          </div>
        )}
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

      <main className="main" style={{ '--inspector-width': `${Math.min(panelWidth, panelMax)}px` } as React.CSSProperties}>
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

        {loaded && graph.nodes.length === 0 && (
          <div className="empty">
            <h2>Your graph is empty</h2>
            <p>
              Press <kbd>N</kbd> or double-click anywhere to add a node, then <kbd>E</kbd> to connect nodes.
            </p>
            <div className="row center">
              <button className="btn primary" onClick={addNodeInView}>
                + Add first node
              </button>
              <button className="btn" onClick={() => void openAction()}>
                Open a file
              </button>
            </div>
          </div>
        )}

        <PanelResizer
          width={Math.min(panelWidth, panelMax)}
          min={PANEL_WIDTH_MIN}
          max={panelMax}
          defaultWidth={PANEL_WIDTH_DEFAULT}
          onChange={setPanelWidth}
          onCommit={(w) => storageSet(PANEL_WIDTH_KEY, String(w))}
        />
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
      {helpOpen && <HelpDialog onClose={() => setHelpOpen(false)} fileName={file?.handle.name ?? null} />}

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
