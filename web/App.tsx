import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { projectGraph, pruneViewPositions, storeNodePositions, type ViewCriteria } from '../shared/filterViews';
import { addEdge, addNode, clusterMembers, emptyGraph, type Graph, type Position, removeEdge, removeNode, uniqueId } from '../shared/model';
import { formatForPath, parseGraphText, serializeGraph, serializeGraphYaml } from '../shared/yaml';
import { GraphCanvas, type GraphCanvasHandle, type Selection } from './components/GraphCanvas';
import { LAYOUTS, layoutLabel, type LayoutName } from './layout';
import { HelpDialog } from './components/HelpDialog';
import { Inspector } from './components/Inspector';
import { McpDialog } from './components/McpDialog';
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
} from './fileAccess';
import { createFilePoll } from './filePoll';
import { writeFileText as writeTracked, writeFileTextIfUnchanged as writeTrackedIfUnchanged } from './fileSync';
import type { ThemeName } from './theme';
import logoUrl from './logo.svg';
import { FilterViewsDialog } from './components/FilterViewsDialog';
import { Icon } from './components/Icon';

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
/** The grid the arrow keys move the selected nodes along. */
const NUDGE_PX = 10;
const NUDGES: Record<string, Position> = {
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
};

/** The next grid line from `v` in direction `dir` (-1, 0 or 1); off-grid values snap to the nearest line that way. */
function nextGridLine(v: number, dir: number): number {
  if (dir > 0) return (Math.floor(v / NUDGE_PX) + 1) * NUDGE_PX;
  if (dir < 0) return (Math.ceil(v / NUDGE_PX) - 1) * NUDGE_PX;
  return v;
}
/** How often the open file is checked for changes made by other tools (e.g. the MCP server). */
const FILE_POLL_MS = 1000;
/** Edits closer together than this are written to the file once. */
const FILE_SAVE_DELAY_MS = 300;

/**
 * The file on disk the graph is linked to. `reconnect`: the browser remembered
 * the file from a previous visit but needs a click to grant access again.
 * `paused`: the file has invalid entries, so it is not overwritten until the user decides.
 * `conflict`: another tool changed the file while a browser edit was waiting to
 * be written; nothing is written until the user picks which version to keep.
 */
type FileStatus = 'saved' | 'saving' | 'error' | 'reconnect' | 'paused' | 'conflict';
interface OpenFile {
  handle: FileSystemFileHandle;
  status: FileStatus;
}

interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'error';
}
/** Invalid entries dropped while reading a graph file. */
interface Issues {
  source: string;
  list: string[];
}
/** One undo step: the graph, and which of its nodes are hidden (H). */
interface Snapshot {
  graph: Graph;
  hidden: string[];
}
interface History extends Snapshot {
  past: Snapshot[];
  future: Snapshot[];
  lastAt: number;
}
const snapshot = (h: History): Snapshot => ({ graph: h.graph, hidden: h.hidden });

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
function storageRemove(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* storage unavailable */
  }
}

function isEmptyGraph(g: Graph): boolean {
  return !g.nodes.length && !g.edges.length && !g.styles.length && !g.properties.length && !g.views?.length;
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

function conflictMessage(fileName: string): string {
  return `${fileName} was changed by another tool: choose which version to keep`;
}

function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement;
  return t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName);
}

/** Closes a toolbar panel on a click outside it or Escape, like a menu. */
function useDismiss(open: boolean, menu: React.RefObject<HTMLElement | null>, close: () => void) {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!menu.current?.contains(e.target as Node)) closeRef.current();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Escape only closes the panel: it must not also reach the shortcuts that clear the selection.
      e.stopPropagation();
      closeRef.current();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, menu]);
}

export function App() {
  const [hist, setHist] = useState<History>({ graph: emptyGraph(), hidden: [], past: [], future: [], lastAt: 0 });
  const graph = hist.graph;
  const graphRef = useRef(graph);
  graphRef.current = graph;

  const [loaded, setLoaded] = useState(false);
  const [file, setFile] = useState<OpenFile | null>(null);
  const fileRef = useRef(file);
  fileRef.current = file;
  const [selection, setSelection] = useState<Selection>(null);
  /** Nodes hidden from view (H / Shift+H). View state only: not saved with the graph, but undoable. */
  const hidden = useMemo(() => {
    const exists = new Set(graph.nodes.map((n) => n.id));
    return hist.hidden.filter((id) => exists.has(id));
  }, [graph.nodes, hist.hidden]);
  const [connect, setConnect] = useState<{ source: string | null } | null>(null);
  const [theme, setTheme] = useState<ThemeName>(() => (storageGet(THEME_KEY) === 'light' ? 'light' : 'dark'));
  const [stylesOpen, setStylesOpen] = useState(false);
  const [stylesInitialId, setStylesInitialId] = useState<string | undefined>();
  const [helpOpen, setHelpOpen] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [fileDrawerOpen, setFileDrawerOpen] = useState(false);
  const [query, setQuery] = useState('');
  /** Whether the view dialog is open to create a new view or to edit the active one. */
  const [viewDialog, setViewDialog] = useState<'create' | 'edit' | null>(null);
  const [viewsMenuOpen, setViewsMenuOpen] = useState(false);
  const viewsMenu = useRef<HTMLDivElement>(null);
  const [layoutMenuOpen, setLayoutMenuOpen] = useState(false);
  const layoutMenu = useRef<HTMLDivElement>(null);
  const [activeViewId, setActiveViewId] = useState('');
  /** Counts view switches, so that saving a view's new filter is animated like switching to it. */
  const [viewSwitches, setViewSwitches] = useState(0);
  const activeView = graph.views?.find((v) => v.id === activeViewId);
  const visibleGraph = useMemo(
    () => (activeView ? projectGraph(graph, activeView.filters, activeView.positions) : graph),
    [graph, activeView],
  );
  const visibleRef = useRef(visibleGraph);
  visibleRef.current = visibleGraph;
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [issues, setIssues] = useState<Issues | null>(null);
  const [layoutName, setLayoutName] = useState<LayoutName>('auto');
  /** Live repulsion is on: nodes push each other apart until it is switched off. */
  const [floating, setFloating] = useState(false);
  const land = useCallback((save = true) => {
    canvas.current?.land(save);
    setFloating(false);
  }, []);
  const [panelWidth, setPanelWidth] = useState(() => Number(storageGet(PANEL_WIDTH_KEY)) || PANEL_WIDTH_DEFAULT);
  const panelMax = Math.max(PANEL_WIDTH_MIN, window.innerWidth - CANVAS_MIN_WIDTH);

  const canvas = useRef<GraphCanvasHandle>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const fileDrawerButton = useRef<HTMLButtonElement>(null);
  const drawerCloseButton = useRef<HTMLButtonElement>(null);
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
  const writeFileText = useCallback(
    (handle: FileSystemFileHandle, text: string) => writeTracked(handle, text, { fileText, fileModified, writingText }),
    [],
  );

  /** Replaces the graph. `record` adds an undo step; `fromRemote` skips writing it back. */
  const setGraph = useCallback((next: Graph, opts: { record?: boolean; fromRemote?: boolean } = {}) => {
    const { record = true, fromRemote = false } = opts;
    if (fromRemote) skipSave.current = true;
    next = pruneViewPositions(next);
    graphRef.current = next;
    setHist((h) => {
      if (!record) return { ...h, graph: next };
      const now = Date.now();
      const coalesce = !fromRemote && now - h.lastAt < COALESCE_MS && h.past.length > 0;
      const past = coalesce ? h.past : [...h.past, snapshot(h)].slice(-HISTORY_LIMIT);
      return { graph: next, hidden: h.hidden, past, future: [], lastAt: fromRemote ? 0 : now };
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
      h.past.length ? { ...h.past[h.past.length - 1], past: h.past.slice(0, -1), future: [snapshot(h), ...h.future], lastAt: 0 } : h,
    );
  }, []);
  const redo = useCallback(() => {
    setHist((h) => (h.future.length ? { ...h.future[0], past: [...h.past, snapshot(h)], future: h.future.slice(1), lastAt: 0 } : h));
  }, []);

  const clearViewUi = useCallback(() => {
    // The graph is being replaced: where its nodes were floating to is not worth saving.
    land(false);
    setActiveViewId('');
  }, [land]);

  /** Replaces the graph and clears undo history, without writing it back to the file. */
  const resetGraph = useCallback(
    (next: Graph) => {
      skipSave.current = true;
      graphRef.current = next;
      clearViewUi();
      setHist({ graph: next, hidden: [], past: [], future: [], lastAt: 0 });
    },
    [clearViewUi],
  );

  /** Reads the linked file into the canvas. `fresh` (a newly opened file) also clears undo history. */
  const loadFromFile = useCallback(
    async (handle: FileSystemFileHandle, fresh: boolean): Promise<boolean> => {
      try {
        const { text, lastModified } = await readHandle(handle);
        const list: string[] = [];
        const next = parseGraphText(text, list);
        fileText.current = text;
        fileModified.current = lastModified;
        if (fresh) resetGraph(next);
        else setGraph(next, { fromRemote: true });
        setFile({ handle, status: list.length ? 'paused' : 'saved' });
        setIssues(list.length ? { source: handle.name, list } : null);
        return true;
      } catch (err) {
        toast(`Could not read ${handle.name}: ${(err as Error).message}`, 'error');
        return false;
      }
    },
    [resetGraph, setGraph, toast],
  );

  /**
   * Writes `text` to the linked file unless another tool changed the file since we
   * last read or wrote it; then the file is flagged as in conflict and left alone.
   */
  const writeLinked = useCallback(async (handle: FileSystemFileHandle, text: string): Promise<boolean> => {
    const written = await writeTrackedIfUnchanged(handle, text, { fileText, fileModified, writingText });
    setFile((f) => (f?.handle === handle ? { ...f, status: written ? 'saved' : 'conflict' } : f));
    return written;
  }, []);

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
    // An empty graph leaves nothing behind, so a deleted browser copy stays deleted.
    if (isEmptyGraph(graph)) storageRemove(LOCAL_KEY);
    else storageSet(LOCAL_KEY, serializeGraphYaml(graph));
    if (skipSave.current) {
      skipSave.current = false;
      return;
    }
    const status = fileRef.current?.status;
    // In conflict, edits stay in the browser until the user resolves it.
    const handle = status === 'reconnect' || status === 'paused' || status === 'conflict' ? null : fileRef.current?.handle;
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
        if (!(await writeLinked(handle, text))) toast(conflictMessage(handle.name), 'error');
      } catch (err) {
        setFile((f) => (f?.handle === handle ? { ...f, status: 'error' } : f));
        toast(`Could not save ${handle.name}: ${(err as Error).message}`, 'error');
      }
    }, FILE_SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [graph, loaded, toast, writeLinked]);

  // ---- Pick up changes other tools (e.g. the MCP server) make to the linked file.
  const watchedHandle = file && file.status !== 'reconnect' ? file.handle : null;
  useEffect(() => {
    if (!watchedHandle) return;
    const poll = createFilePoll({
      handle: watchedHandle,
      modified: fileModified,
      text: fileText,
      writing: writingText,
      onChange: (next, list) => {
        setGraph(next, { fromRemote: true });
        setFile((f) => (f?.handle === watchedHandle ? { ...f, status: list.length ? 'paused' : 'saved' } : f));
        setIssues(list.length ? { source: watchedHandle.name, list } : null);
      },
      // A half-written or invalid file is retried on every poll and reported once per revision.
      onUnreadable: (err) => toast(`Could not read ${watchedHandle.name}, retrying: ${err.message}`, 'error'),
      // A missing file is reported once.
      onMissing: () => {
        if (fileRef.current?.status === 'error') return;
        setFile((f) => (f?.handle === watchedHandle ? { ...f, status: 'error' } : f));
        toast(`${watchedHandle.name} was moved or deleted`, 'error');
      },
    });
    let busy = false;
    const timer = setInterval(async () => {
      if (busy || fileRef.current?.status === 'saving' || fileRef.current?.status === 'conflict') return;
      busy = true;
      try {
        await poll();
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

  // ---- Expand / shrink the node selection along edges (+ / -).
  // Each expansion is remembered so "-" can step back, as long as the selection
  // has not been changed some other way in between.
  const [expansions, setExpansions] = useState<{ before: Selection; after: string[] }[]>([]);
  const selectedNodeIds = useMemo(
    () => (selection?.kind === 'node' ? [selection.id] : selection?.kind === 'nodes' ? selection.ids : []),
    [selection],
  );
  const sameIds = (a: string[], b: string[]) => a.length === b.length && a.every((id) => b.includes(id));
  const lastExpansion = expansions.length && sameIds(expansions[expansions.length - 1].after, selectedNodeIds)
    ? expansions[expansions.length - 1]
    : null;
  const nodeSelection = (ids: string[]): Selection =>
    ids.length === 0 ? null : ids.length === 1 ? { kind: 'node', id: ids[0] } : { kind: 'nodes', ids };

  useEffect(() => {
    const ids = new Set(visibleGraph.nodes.map((n) => n.id));
    setSelection((current) => {
      if (!current) return current;
      if (current.kind === 'node') return ids.has(current.id) ? current : null;
      if (current.kind === 'edge') return visibleGraph.edges.some((e) => e.id === current.id) ? current : null;
      if (current.kind !== 'nodes') return current;
      const kept = current.ids.filter((id) => ids.has(id));
      return kept.length === current.ids.length ? current : nodeSelection(kept);
    });
    setConnect((current) => (current?.source && !ids.has(current.source) ? null : current));
  }, [visibleGraph]);

  useEffect(() => {
    if (activeViewId && !activeView) setActiveViewId('');
  }, [activeView, activeViewId]);

  useDismiss(viewsMenuOpen, viewsMenu, () => setViewsMenuOpen(false));
  useDismiss(layoutMenuOpen, layoutMenu, () => setLayoutMenuOpen(false));

  const switchView = useCallback((id: string) => {
    // Before the view changes, so the floating nodes are saved in the view they were floating in.
    land();
    setActiveViewId(id);
    setViewSwitches((n) => n + 1);
    setSelection(null);
    setConnect(null);
    setExpansions([]);
  }, [land]);

  /** Creates a view, or replaces the active one, laid out as the nodes currently appear on the canvas. */
  const saveView = useCallback(
    (name: string, criteria: ViewCriteria) => {
      const editing = viewDialog === 'edit' ? activeView : undefined;
      const id =
        editing?.id ??
        uniqueId(
          'view',
          (graphRef.current.views ?? []).map((v) => v.id),
        );
      const shown = projectGraph(graphRef.current, criteria, activeView?.positions).nodes;
      const positions = Object.fromEntries(shown.filter((n) => n.position).map((n) => [n.id, n.position!]));
      const view = { id, name, filters: structuredClone(criteria), positions };
      if (
        !apply((g) => ({
          ...g,
          views: editing ? (g.views ?? []).map((v) => (v.id === id ? view : v)) : [...(g.views ?? []), view],
        }))
      )
        return;
      switchView(id);
      setViewDialog(null);
      toast(`Saved view “${name}”`);
    },
    [activeView, apply, switchView, toast, viewDialog],
  );

  const deleteView = useCallback(() => {
    if (!activeView || !apply((g) => ({ ...g, views: (g.views ?? []).filter((v) => v.id !== activeView.id) }))) return;
    switchView('');
    setViewDialog(null);
    toast(`Deleted view “${activeView.name}”`);
  }, [activeView, apply, switchView, toast]);

  /** The selected nodes, with clusters swapped for their visible members: what moving them moves. */
  const movingNodeIds = useMemo(() => {
    if (!visibleGraph.nodes.some((n) => n.cluster && selectedNodeIds.includes(n.id))) return selectedNodeIds;
    const isHidden = new Set(hidden);
    const ids = selectedNodeIds.flatMap((id) => {
      if (!visibleGraph.nodes.find((n) => n.id === id)?.cluster) return [id];
      const members = clusterMembers(visibleGraph, id).filter((m) => !isHidden.has(m));
      // A cluster without visible members is drawn as a node, and moves like one.
      return members.length ? members : [id];
    });
    return [...new Set(ids)];
  }, [visibleGraph, hidden, selectedNodeIds]);

  // ---- Automatic layout: of the selected nodes (a cluster's members) when there are several, otherwise of the whole graph.
  const layoutScope = movingNodeIds.length >= 2 ? movingNodeIds : null;
  /** Layout runs in flight (a newer run can start before an older one finishes). */
  const [layoutsRunning, setLayoutsRunning] = useState(0);
  const runLayout = useCallback(
    async (name: LayoutName) => {
      setLayoutsRunning((n) => n + 1);
      let result;
      try {
        result = await canvas.current?.runLayout(name, layoutScope ?? undefined);
      } catch (err) {
        toast(`Layout failed: ${(err as Error).message}`, 'error');
      } finally {
        setLayoutsRunning((n) => n - 1);
      }
      if (!result) return;
      const { before, after } = result;
      const what = name === 'auto' ? `Picked ${layoutLabel(result.algorithm)}` : layoutLabel(name);
      const scope = layoutScope ? ` (${layoutScope.length} selected nodes)` : '';
      const plural = (n: number) => (n === 1 ? '' : 's');
      const crossings =
        before.crossings === after.crossings
          ? `${after.crossings} edge crossing${plural(after.crossings)}`
          : `edge crossings ${before.crossings} → ${after.crossings}`;
      toast(`${what}${scope}: ${crossings}`);
    },
    [layoutScope, toast],
  );

  /** Switches live repulsion on for the selected nodes (or all of them), or off again. */
  const toggleFloating = useCallback(() => {
    if (floating) {
      land();
      return;
    }
    const count = canvas.current?.float(layoutScope ?? undefined) ?? 0;
    if (!count) {
      toast('Repulsion needs at least two nodes', 'error');
      return;
    }
    setFloating(true);
    // Selected nodes are dragged together; unselected, each one can be dragged into the others.
    setSelection(null);
    setExpansions([]);
    toast(`Repulsion on for ${layoutScope ? `the ${count} selected` : `all ${count}`} nodes: drag one and the rest follow or make way`);
  }, [floating, land, layoutScope, toast]);

  const canExpand = useMemo(() => {
    const skip = new Set([...selectedNodeIds, ...hidden]);
    const sel = new Set(selectedNodeIds);
    return visibleGraph.edges.some((e) => sel.has(e.source) && !skip.has(e.target));
  }, [visibleGraph.edges, hidden, selectedNodeIds]);

  const expandSelection = useCallback(() => {
    const sel = new Set(selectedNodeIds);
    const skip = new Set([...selectedNodeIds, ...hidden]);
    const added = visibleGraph.edges.filter((e) => sel.has(e.source) && !skip.has(e.target)).map((e) => e.target);
    if (!added.length) return;
    const after = [...selectedNodeIds, ...new Set(added)];
    setExpansions((stack) => [...(lastExpansion ? stack : []), { before: selection, after }]);
    setSelection(nodeSelection(after));
  }, [visibleGraph.edges, lastExpansion, selectedNodeIds, selection]);

  const shrinkSelection = useCallback(() => {
    if (!lastExpansion) return;
    const exists = new Set(graph.nodes.map((n) => n.id));
    const before = lastExpansion.before;
    setExpansions((stack) => stack.slice(0, -1));
    setSelection(
      before?.kind === 'nodes'
        ? nodeSelection(before.ids.filter((id) => exists.has(id)))
        : before?.kind === 'node' && !exists.has(before.id)
          ? null
          : before,
    );
  }, [graph.nodes, lastExpansion]);

  // ---- Hide / reveal nodes (H / Shift+H), like Blender. A hidden node's edges are hidden with it.
  // Each change is its own undo step.
  const setHidden = useCallback((next: string[]) => {
    setHist((h) => ({ ...h, hidden: next, past: [...h.past, snapshot(h)].slice(-HISTORY_LIMIT), future: [], lastAt: 0 }));
  }, []);

  const hideSelection = useCallback(() => {
    if (!selectedNodeIds.length) return;
    setHidden([...new Set([...hidden, ...selectedNodeIds])]);
    setSelection(null);
  }, [hidden, selectedNodeIds, setHidden]);

  // Hidden nodes (and their edges) can't stay selected, e.g. after undoing a reveal.
  useEffect(() => {
    const isHidden = new Set(hidden);
    if (!isHidden.size || !selection) return;
    if (selection.kind === 'edge') {
      const edge = graph.edges.find((e) => e.id === selection.id);
      if (edge && (isHidden.has(edge.source) || isHidden.has(edge.target))) setSelection(null);
    } else if (selectedNodeIds.some((id) => isHidden.has(id))) {
      setSelection(nodeSelection(selectedNodeIds.filter((id) => !isHidden.has(id))));
    }
  }, [graph.edges, hidden, selectedNodeIds, selection]);

  /** Shows every hidden node again, selecting them. */
  const revealHidden = useCallback(() => {
    if (!hidden.length) return;
    setSelection(nodeSelection(hidden));
    setHidden([]);
  }, [hidden, setHidden]);

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
        const list: string[] = [];
        const next = parseGraphText(await file.text(), list);
        clearViewUi();
        setGraph(next);
        setSelection(null);
        setIssues(list.length ? { source: file.name, list } : null);
        toast(`Loaded ${file.name}: ${next.nodes.length} nodes, ${next.edges.length} edges`);
        setTimeout(() => canvas.current?.fit(), 50);
      } catch (err) {
        toast(`Could not open ${file.name}: ${(err as Error).message}`, 'error');
      }
    },
    [clearViewUi, setGraph, toast],
  );

  /** Stops writing to the linked file; the graph stays in the browser. */
  const closeFile = useCallback(() => {
    setFile(null);
    setIssues(null);
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
      setIssues(null);
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
    if (f.status === 'conflict') {
      toast(conflictMessage(f.handle.name), 'error');
      return;
    }
    try {
      if (await writeLinked(f.handle, textFor(graphRef.current, f.handle.name))) {
        setIssues(null);
        toast(`Saved to ${f.handle.name}`);
      } else toast(conflictMessage(f.handle.name), 'error');
    } catch (err) {
      setFile((cur) => (cur?.handle === f.handle ? { ...cur, status: 'error' } : cur));
      toast(`Could not save ${f.handle.name}: ${(err as Error).message}`, 'error');
    }
  }, [reconnectFile, saveAs, saveToNewFile, toast, writeLinked]);

  /**
   * Settles a conflict with the linked file. Either way the other version stays one
   * undo step away: `theirs` loads the file (Ctrl+Z restores the browser's version),
   * `mine` writes the browser's version (Ctrl+Z restores the file's).
   */
  const resolveConflict = useCallback(
    async (keep: 'mine' | 'theirs') => {
      const f = fileRef.current;
      if (f?.status !== 'conflict') return;
      const { handle } = f;
      try {
        const { text, lastModified } = await readHandle(handle);
        const theirs = parseGraphText(text);
        if (keep === 'theirs') {
          fileText.current = text;
          fileModified.current = lastModified;
          setGraph(theirs, { fromRemote: true });
          setFile((cur) => (cur?.handle === handle ? { ...cur, status: 'saved' } : cur));
          toast(`Loaded ${handle.name}; Ctrl+Z brings back your version`);
          return;
        }
        const mine = graphRef.current;
        const mineText = textFor(mine, handle.name);
        await writeFileText(handle, mineText);
        setHist((h) => ({
          graph: mine,
          hidden: h.hidden,
          past: [...h.past, { graph: theirs, hidden: h.hidden }].slice(-HISTORY_LIMIT),
          future: [],
          lastAt: 0,
        }));
        setFile((cur) => (cur?.handle === handle ? { ...cur, status: 'saved' } : cur));
        toast(`Saved your version to ${handle.name}; Ctrl+Z brings back the file's version`);
      } catch (err) {
        toast(`Could not resolve the conflict with ${handle.name}: ${(err as Error).message}`, 'error');
      }
    },
    [setGraph, toast, writeFileText],
  );

  // New graphs are unlinked first, so they never overwrite the open file.
  const newGraph = useCallback(() => {
    if (graphRef.current.nodes.length && !confirm('Start a new, empty graph? (You can undo this.)')) return;
    closeFile();
    clearViewUi();
    setGraph(emptyGraph());
    setSelection(null);
  }, [clearViewUi, closeFile, setGraph]);

  /** Erases the graph kept in this browser's local storage; there is no undo. */
  const deleteBrowserCopy = useCallback(() => {
    if (!confirm("Delete the graph stored in this browser's local storage? This can't be undone.")) return;
    storageRemove(LOCAL_KEY);
    resetGraph(emptyGraph());
    setSelection(null);
    toast('Deleted the graph from browser storage');
  }, [resetGraph, toast]);

  const closeFileDrawer = useCallback(() => {
    setFileDrawerOpen(false);
    fileDrawerButton.current?.focus();
  }, []);

  useEffect(() => {
    if (fileDrawerOpen) drawerCloseButton.current?.focus();
  }, [fileDrawerOpen]);

  const runDrawerAction = (action: () => void) => {
    closeFileDrawer();
    action();
  };

  const onNodesMoved = useCallback(
    (positions: Record<string, Position>, record: boolean) => {
      apply((g) => storeNodePositions(g, positions, activeView?.id), record);
    },
    [activeView?.id, apply],
  );

  // ---- Search.
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    return visibleGraph.nodes
      .filter(
        (n) =>
          n.label.toLowerCase().includes(q) ||
          n.id.toLowerCase().includes(q) ||
          n.properties.some((p) => p.value.toLowerCase().includes(q) || p.key.toLowerCase().includes(q)),
      )
      .map((n) => n.id);
  }, [visibleGraph.nodes, query]);

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
      if (fileDrawerOpen) {
        if (e.key === 'Escape') closeFileDrawer();
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
        const hiddenSet = new Set(hidden);
        const ids = visibleRef.current.nodes.map((n) => n.id).filter((id) => !hiddenSet.has(id));
        setSelection(ids.length ? { kind: 'nodes', ids } : null);
        return;
      }
      if (mod || e.altKey) return;
      const nudge = NUDGES[e.key];
      if (nudge) {
        if (!movingNodeIds.length) return;
        e.preventDefault();
        const moving = new Set(movingNodeIds);
        const positions: Record<string, Position> = {};
        for (const n of visibleRef.current.nodes) {
          if (n.position && moving.has(n.id)) positions[n.id] = { x: nextGridLine(n.position.x, nudge.x), y: nextGridLine(n.position.y, nudge.y) };
        }
        onNodesMoved(positions, true);
        return;
      }
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
        case '+':
        case '=':
          expandSelection();
          break;
        case '-':
          shrinkSelection();
          break;
        case 'Delete':
        case 'Backspace':
          deleteSelection();
          break;
        case 'Escape':
          if (viewDialog) setViewDialog(null);
          else if (stylesOpen) setStylesOpen(false);
          else if (helpOpen) setHelpOpen(false);
          else if (mcpOpen) setMcpOpen(false);
          else if (connect) setConnect(null);
          else setSelection(null);
          break;
        case 'h':
          hideSelection();
          break;
        case 'H':
          revealHidden();
          break;
        case 'f':
        case 'F':
          canvas.current?.fit();
          break;
        case 'l':
        case 'L':
          // Not while the nodes are repelling each other: the two would fight over them.
          if (!floating) void runLayout(layoutName);
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
  }, [addNodeInView, closeFileDrawer, connect, deleteSelection, expandSelection, fileDrawerOpen, floating, helpOpen, hidden, hideSelection, layoutName, mcpOpen, movingNodeIds, onNodesMoved, openAction, revealHidden, redo, runLayout, save, selection, shrinkSelection, startConnect, stylesOpen, undo, viewDialog]);

  return (
    <div className="app">
      <header className="toolbar">
        <button
          ref={fileDrawerButton}
          className="btn ghost icon hamburger"
          aria-label="Open file and edit menu"
          aria-expanded={fileDrawerOpen}
          aria-controls="file-drawer"
          onClick={() => setFileDrawerOpen(true)}
        >
          <span aria-hidden="true"><i /><i /><i /></span>
        </button>
        <div className="brand" data-tip="MapNotes: a render engine for your graphs">
          <img className="logo" src={logoUrl} alt="" aria-hidden="true" /> <span className="brand-name">MapNotes</span>
        </div>

        <div className="toolbar-actions">
          <button className="btn ghost icon" data-tip="Undo (Ctrl+Z)" aria-label="Undo" disabled={!hist.past.length} onClick={undo}>
            <svg className="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M9 14 4 9l5-5" />
              <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
            </svg>
          </button>
          <button className="btn ghost icon" data-tip="Redo (Ctrl+Shift+Z)" aria-label="Redo" disabled={!hist.future.length} onClick={redo}>
            <svg className="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="m15 14 5-5-5-5" />
              <path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />
            </svg>
          </button>
          <button className="btn primary compact-action" data-tip="Add a node (N) — or double-click the canvas" aria-label="Add node" onClick={addNodeInView}>
            <Icon name="plus" /><span className="action-label">Node</span>
          </button>
          <button
            className={`btn compact-action${connect ? ' active' : ''}`}
            data-tip="Connect two nodes with an edge (E): click the source, then the target"
            aria-label="Connect nodes"
            onClick={() => (connect ? setConnect(null) : startConnect(selection?.kind === 'node' ? selection.id : null))}
          >
            <svg className="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <circle cx="19" cy="5" r="2" />
              <circle cx="5" cy="19" r="2" />
              <path d="M5 17A12 12 0 0 1 17 5" />
            </svg>
            <span className="action-label">Connect</span>
          </button>
          <button
            className="btn ghost icon"
            data-tip="Expand selection (+): add the targets of edges leaving the selected nodes"
            aria-label="Expand selection to edge targets"
            disabled={!canExpand}
            onClick={expandSelection}
          >
            <svg className="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
            </svg>
          </button>
          <button
            className="btn ghost icon"
            data-tip="Shrink selection (−): undo the last expansion"
            aria-label="Undo last selection expansion"
            disabled={!lastExpansion}
            onClick={shrinkSelection}
          >
            <svg className="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7" />
            </svg>
          </button>
        </div>

        <div className="toolbar-view">
          <div className="toolbar-menu" ref={layoutMenu}>
            <button
              className={`btn${layoutScope ? ' scoped' : ''}`}
              disabled={floating}
              data-tip={layoutScope ? `Arrange the ${layoutScope.length} selected nodes automatically` : 'Arrange the graph automatically (select nodes to arrange just those)'}
              aria-expanded={layoutMenuOpen}
              aria-controls="layout-panel"
              onClick={() => setLayoutMenuOpen((open) => !open)}
            >
              <svg className="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <rect x="16" y="16" width="6" height="6" rx="1" />
                <rect x="2" y="16" width="6" height="6" rx="1" />
                <rect x="9" y="2" width="6" height="6" rx="1" />
                <path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3M12 12V8" />
              </svg>
              Layout
            </button>
            {layoutMenuOpen && !floating && (
              <div id="layout-panel" className="toolbar-panel">
                <select
                  value={layoutName}
                  aria-label="Layout algorithm"
                  onChange={(e) => {
                    const name = e.target.value as LayoutName;
                    setLayoutName(name);
                    void runLayout(name);
                  }}
                >
                  {LAYOUTS.map((l) => <option key={l.name} value={l.name}>{l.label}</option>)}
                </select>
                <button
                  className={`btn ghost icon${layoutsRunning ? ' busy' : ''}`}
                  disabled={layoutsRunning > 0}
                  data-tip="Run it again (L)"
                  aria-label={layoutScope ? 'Run layout on selected nodes' : 'Run layout again'}
                  onClick={() => void runLayout(layoutName)}
                >
                  <svg className="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                    <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8M21 3v5h-5M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16M8 16H3v5" />
                  </svg>
                </button>
                <span className="view-count">{layoutScope ? `${layoutScope.length} selected nodes` : 'Whole graph'}</span>
              </div>
            )}
          </div>
          <button
            className={`btn ghost icon${floating ? ' active' : layoutScope ? ' scoped' : ''}`}
            aria-pressed={floating}
            data-tip={
              floating
                ? 'Stop repelling'
                : `Repel: ${layoutScope ? `the ${layoutScope.length} selected nodes` : 'all nodes'} float apart, held together by their edges, also while you drag them${layoutScope ? '; the rest fade' : ''}`
            }
            aria-label="Repel"
            onClick={toggleFloating}
          >
            <svg className="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <circle cx="12" cy="12" r="1" />
              <path d="M20.2 20.2c2.04-2.03.02-7.36-4.5-11.9-4.54-4.52-9.87-6.54-11.9-4.5-2.04 2.03-.02 7.36 4.5 11.9 4.54 4.52 9.87 6.54 11.9 4.5Z" />
              <path d="M15.7 15.7c4.52-4.54 6.54-9.87 4.5-11.9-2.03-2.04-7.36-.02-11.9 4.5-4.52 4.54-6.54 9.87-4.5 11.9 2.03 2.04 7.36.02 11.9-4.5Z" />
            </svg>
          </button>
          <button className="btn ghost icon" data-tip="Fit selection, or the whole graph, to screen (F)" aria-label="Fit selection or graph to screen" onClick={() => canvas.current?.fit()}>
            <svg className="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2" />
            </svg>
          </button>
          <button className="btn" data-tip="Colors, shapes, sizes and line styles" onClick={() => { setStylesInitialId(undefined); setStylesOpen(true); }}>
            <svg className="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z" />
              <circle cx="13.5" cy="6.5" r=".5" />
              <circle cx="17.5" cy="10.5" r=".5" />
              <circle cx="8.5" cy="7.5" r=".5" />
              <circle cx="6.5" cy="12.5" r=".5" />
            </svg>
            Styles
          </button>
          <div className="toolbar-menu" ref={viewsMenu}>
            <button
              className={`btn${activeView ? ' active' : ''}`}
              data-tip={activeView ? `Showing view “${activeView.name}”` : 'Switch, create or edit saved views'}
              aria-expanded={viewsMenuOpen}
              aria-controls="views-panel"
              onClick={() => setViewsMenuOpen((open) => !open)}
            >
              <svg className="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z" />
                <path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65" />
                <path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65" />
              </svg>
              Views
            </button>
            {activeView && (
              <button className="btn icon views-clear" data-tip="Show all nodes" aria-label="Show all nodes" onClick={() => switchView('')}>
                <Icon name="close" />
              </button>
            )}
            {viewsMenuOpen && (
              <div id="views-panel" className="toolbar-panel">
                <select aria-label="Saved view" value={activeView?.id ?? ''} onChange={(e) => switchView(e.target.value)}>
                  <option value="" disabled>
                    {graph.views?.length ? 'Choose a view…' : 'No saved views'}
                  </option>
                  {(graph.views ?? []).map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                    </option>
                  ))}
                </select>
                <button
                  className="btn ghost icon"
                  data-tip="New view"
                  aria-label="New view"
                  onClick={() => {
                    setViewsMenuOpen(false);
                    setViewDialog('create');
                  }}
                >
                  <Icon name="plus" />
                </button>
                <button
                  className="btn ghost icon"
                  data-tip="Edit this view"
                  aria-label="Edit view"
                  disabled={!activeView}
                  onClick={() => {
                    setViewsMenuOpen(false);
                    setViewDialog('edit');
                  }}
                >
                  <Icon name="edit" />
                </button>
                <span className="view-count">
                  {visibleGraph.nodes.length}/{graph.nodes.length} nodes
                </span>
              </div>
            )}
          </div>
        </div>

        <div className="toolbar-end">
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
            {query && (
              <button
                className="icon-btn search-clear"
                data-tip="Clear search (Esc)"
                aria-label="Clear search"
                onClick={() => {
                  setQuery('');
                  searchInput.current?.focus();
                }}
              >
                <Icon name="close" />
              </button>
            )}
          </div>

          <div className="toolbar-utilities">
            <button className="btn ghost" data-tip="Let an AI assistant edit your graphs" onClick={() => setMcpOpen(true)}>
              Install MCP
            </button>
            <button
              className="btn ghost icon"
              data-tip={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
              aria-label="Toggle theme"
              onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
            >
              <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
            </button>
            <button className="btn ghost icon" data-tip="Help & shortcuts (?)" aria-label="Help" onClick={() => setHelpOpen(true)}>
              <Icon name="help" />
            </button>
            <a
              className="btn ghost icon github-link"
              href="https://github.com/joecabezas/mapnotes"
              target="_blank"
              rel="noopener noreferrer"
              data-tip="View MapNotes on GitHub"
              aria-label="View MapNotes on GitHub (opens in a new tab)"
            >
              <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.65 7.65 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.28.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.94-.01 2.21 0 .21.15.46.55.38A8 8 0 0 0 8 0Z" />
              </svg>
            </a>
          </div>
        </div>

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
      </header>

      <div className={`drawer-layer${fileDrawerOpen ? ' open' : ''}`} inert={!fileDrawerOpen} aria-hidden={!fileDrawerOpen}>
        <div className="drawer-backdrop" onClick={closeFileDrawer} />
        <aside
          id="file-drawer"
          className="file-drawer"
          role="dialog"
          aria-modal="true"
          aria-label="File and edit actions"
          onKeyDown={(e) => {
            if (e.key !== 'Tab') return;
            const buttons = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
            if (!buttons.length) return;
            if (e.shiftKey && document.activeElement === buttons[0]) {
              e.preventDefault();
              buttons[buttons.length - 1].focus();
            } else if (!e.shiftKey && document.activeElement === buttons[buttons.length - 1]) {
              e.preventDefault();
              buttons[0].focus();
            }
          }}
        >
          <div className="file-drawer-head">
            <strong>File & actions</strong>
            <button ref={drawerCloseButton} className="btn ghost icon" aria-label="Close menu" onClick={closeFileDrawer}>
              <Icon name="close" />
            </button>
          </div>
          <div className="file-drawer-content">
            <div className="drawer-section-title">Graph</div>
            <button onClick={() => runDrawerAction(newGraph)}>New graph</button>
            <button onClick={() => runDrawerAction(() => void openAction())}>Open file…</button>
            <button onClick={() => runDrawerAction(() => void save())}>{fileAccessSupported ? 'Save' : 'Download YAML'}</button>
            {fileAccessSupported && <button onClick={() => runDrawerAction(() => void saveToNewFile())}>Save as…</button>}
            {file && <button onClick={() => runDrawerAction(closeFile)}>Close file (keep in browser)</button>}

            <div className="drawer-section-title">Export</div>
            {fileAccessSupported && <button onClick={() => runDrawerAction(() => saveAs('yaml'))}>Download YAML</button>}
            <button onClick={() => runDrawerAction(() => saveAs('json'))}>Download JSON</button>
            <button onClick={() => runDrawerAction(() => saveAs('png'))}>Export PNG image</button>

            <div className="drawer-section-title">Edit</div>
            <button disabled={!selection} onClick={() => runDrawerAction(deleteSelection)}>Delete selection</button>
            {!file && !isEmptyGraph(graph) && (
              <button className="drawer-danger" onClick={() => runDrawerAction(deleteBrowserCopy)}>Delete browser copy</button>
            )}
          </div>
        </aside>
      </div>

      <main className="main" style={{ '--inspector-width': `${Math.min(panelWidth, panelMax)}px` } as React.CSSProperties}>
        <GraphCanvas
          ref={canvas}
          graph={visibleGraph}
          theme={theme}
          selection={selection}
          connecting={connect !== null}
          connectSource={connect?.source ?? null}
          highlight={matches}
          hidden={hidden}
          transitionKey={`${activeViewId}:${viewSwitches}`}
          onSelect={setSelection}
          onNodeTapInConnectMode={onConnectTap}
          onBackgroundDoubleTap={addNodeAt}
          onNodesMoved={onNodesMoved}
        />

        <div className="graph-status" role="status" aria-live="polite">
          {file?.status === 'reconnect' ? (
            <button
              className="sync reconnect"
              data-tip={`The browser needs your permission again to edit ${file.handle.name}`}
              onClick={() => void reconnectFile()}
            >
              <span className="dot" /> <span className="sync-label">Reconnect {file.handle.name}</span>
            </button>
          ) : file?.status === 'error' ? (
            <button
              className="sync error"
              data-tip={`The last save to ${file.handle.name} failed: click (or Ctrl+S) to try again`}
              onClick={() => void save()}
            >
              <span className="dot" /> <span className="sync-label">Save failed · Retry {file.handle.name}</span>
            </button>
          ) : file ? (
            <div
              className={`sync ${file.status}`}
              data-tip={`Changes are saved to ${file.handle.name}; edits to it from other tools (e.g. the MCP server) show up here.`}
            >
              <span className="dot" /> <span className="sync-label">
                {{ saved: 'Saved', saving: 'Saving…', paused: 'Not saving', conflict: 'Conflict' }[file.status]} · {file.handle.name}
              </span>
            </div>
          ) : (
            <div
              className="sync local"
              data-tip={
                fileAccessSupported
                  ? "Not linked to a file: the graph is kept in this browser's local storage. Open a file, or Save to create one."
                  : "This browser cannot edit files on disk: the graph is kept in its local storage. Use Download to save a copy."
              }
            >
              <span className="dot" /> <span className="sync-label">Browser storage</span>
            </div>
          )}
          {hidden.length > 0 && (
            <button
              className="hidden-count"
              data-tip="Show the hidden nodes again (Shift+H)"
              onClick={revealHidden}
            >
              <Icon name="eyeOff" /> {hidden.length} hidden
            </button>
          )}
        </div>

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

        {issues && (
          <div className="issues" role="alert">
            <div className="issues-head">
              <b>
                {issues.list.length} invalid entr{issues.list.length === 1 ? 'y' : 'ies'} skipped in {issues.source}
              </b>
              {file?.status === 'paused' && <span> — changes are not saved to it until you choose</span>}
            </div>
            <ul>
              {issues.list.map((issue, i) => (
                <li key={i}>{issue}</li>
              ))}
            </ul>
            <div className="row">
              {file?.status === 'paused' ? (
                <>
                  <button className="btn small" data-tip="Overwrite the file without the invalid entries" onClick={() => void save()}>
                    Save without them
                  </button>
                  <button className="btn small ghost" data-tip="Stop saving to the file; fix it in an editor and open it again" onClick={closeFile}>
                    Close file
                  </button>
                </>
              ) : (
                <button className="btn small ghost" onClick={() => setIssues(null)}>
                  Dismiss
                </button>
              )}
            </div>
          </div>
        )}

        {file?.status === 'conflict' && (
          <div className="banner conflict" role="alert">
            <span>
              <b>{file.handle.name}</b> was changed by another tool while you were editing
            </span>
            <button
              className="btn small"
              data-tip="Load the file's version; Ctrl+Z brings back yours"
              onClick={() => void resolveConflict('theirs')}
            >
              Use file's version
            </button>
            <button
              className="btn small"
              data-tip="Overwrite the file with your version; Ctrl+Z brings back the file's"
              onClick={() => void resolveConflict('mine')}
            >
              Keep mine
            </button>
            <button
              className="btn small ghost"
              data-tip="Save your version to a new file and leave this one as it is"
              onClick={() => void saveToNewFile()}
            >
              Save mine as…
            </button>
          </div>
        )}

        {loaded && graph.nodes.length > 0 && activeView && visibleGraph.nodes.length === 0 && (
          <div className="empty filtered-empty">
            <h2>No nodes match this view</h2>
            <p>Adjust the filter or switch back to all nodes.</p>
            <div className="row center">
              <button className="btn" onClick={() => setViewDialog('edit')}>
                Edit filter
              </button>
              <button className="btn" onClick={() => switchView('')}>
                Show all nodes
              </button>
            </div>
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
                <Icon name="plus" /> Add first node
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
            onArrange={(ids, op) => canvas.current?.arrange(ids, op)}
            onOpenStyles={(styleId) => {
              setStylesInitialId(styleId);
              setStylesOpen(true);
            }}
          />
        </aside>
      </main>

      {stylesOpen && (
        <StylesDialog
          graph={graph}
          theme={theme}
          apply={apply}
          initialId={stylesInitialId}
          onClose={() => setStylesOpen(false)}
        />
      )}
      {helpOpen && (
        <HelpDialog
          onClose={() => setHelpOpen(false)}
          onOpenMcp={() => {
            setHelpOpen(false);
            setMcpOpen(true);
          }}
          fileName={file?.handle.name ?? null}
        />
      )}
      {mcpOpen && <McpDialog onClose={() => setMcpOpen(false)} />}
      {viewDialog && (
        <FilterViewsDialog
          graph={graph}
          editing={viewDialog === 'edit' ? activeView : undefined}
          onSave={saveView}
          onDelete={deleteView}
          onClose={() => setViewDialog(null)}
        />
      )}

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
