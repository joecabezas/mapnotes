# MapNotes

A render engine for your own graphs. Model anything as nodes and edges (pull requests → issues → projects, services → dependencies, notes → topics…), attach key/value properties, style them, and save everything as a readable YAML file.

- **Web app**: interactive canvas (drag, click to inspect, hover to preview), editing of nodes, edges, graph properties and styles, automatic layouts, search, undo/redo, dark theme by default with a light theme toggle.
- **MCP server**: lets an AI assistant (Claude Code, Claude Desktop, …) load, query and edit the same graph file. Changes show up live in the open web app.

## Quick start

```bash
npm install
npm run dev                          # opens http://localhost:5173, file: ./graph.yaml
MAPNOTES_FILE=examples/pr-tracking.yaml npm run dev   # any other file
```

The web app auto-saves every change to the file (`MAPNOTES_FILE`, default `graph.yaml`, created if missing) and watches it, so edits made by the MCP server or a text editor appear immediately.

If the app is served as static files (`npm run build`, then host `dist/`), there is no file server. Work is then kept in the browser, and you use **Open** / **Save** to load and download YAML files.

### Using the app

| Action | How |
| --- | --- |
| Add node | `N`, **+ Node**, or double-click empty canvas |
| Connect nodes | `E` / **Connect**, click source, then target |
| Inspect / edit | Click a node or edge; edit label, id, style, properties on the right |
| Delete | `Del` / `Backspace`, or the button in the inspector |
| Arrange | Drag nodes; or choose a layout and press **Layout**; `F` fits the view |
| Styles | **🎨 Styles**: node color/border/shape/size/icon, edge color/width/line/arrow/curve |
| Search | `/` — matches labels, ids and property values; `Enter` jumps to the first hit |
| Undo / redo | `Ctrl+Z` / `Ctrl+Shift+Z` |
| Open / save | `Ctrl+O` / `Ctrl+S` (YAML); JSON and PNG export in the ▾ menu |
| Help | `?` |

## MCP server

```bash
npx tsx mcp/server.ts graph.yaml     # stdio transport
```

This repo includes `.mcp.json`, so Claude Code opened in this folder offers the `mapnotes` server automatically (pointing at `graph.yaml`). For other clients:

```json
{
  "mcpServers": {
    "mapnotes": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/mapnotes/mcp/server.ts", "/absolute/path/to/graph.yaml"]
    }
  }
}
```

| Tool | Purpose |
| --- | --- |
| `load_graph` | Open a YAML/JSON file; it becomes the current file |
| `save_graph` | Save to the current file, or "save as" to a new path (`.json` → JSON) |
| `get_graph`, `get_node` | Read the graph, or one node with its edges |
| `add_node`, `edit_node`, `remove_node` | Node CRUD (rename via `newId` updates edges; removing a node removes its edges) |
| `add_edge`, `edit_edge`, `remove_edge` | Edge CRUD (label, endpoints, style, properties) |
| `edit_graph_properties` | Set/remove/replace graph-level key/value properties |
| `set_style`, `remove_style` | Create/replace/remove reusable node and edge styles |

When a file is open, every change is written to it immediately, and the file is re-read before each operation, so the MCP server and the web app can be used at the same time without overwriting each other.

## File format

```yaml
properties:            # GraphProperty[]
  - key: title
    value: My graph
styles:                # reusable looks, referenced by id
  - id: pr
    target: node       # node | edge
    color: "#7aa2f7"
    borderColor: "#c9d8ff"
    textColor: "#ffffff"
    shape: ellipse     # ellipse, rectangle, round-rectangle, triangle, diamond, pentagon, hexagon, octagon, star, tag, barrel
    size: 34
    icon: github_dark  # optional, svgl icon file name (https://svgl.app), loaded from jsDelivr
    iconSize: 70       # optional, icon size as % of the node (default 70)
  - id: fixes
    target: edge
    color: "#7dcfff"
    width: 2
    lineStyle: dashed  # solid | dashed | dotted
    arrow: triangle    # triangle, vee, circle, square, diamond, tee, none
    curve: bezier      # bezier | straight | taxi
nodes:
  - id: pr-101
    label: PR 101
    style: pr                    # optional
    position: { x: 0, y: 120 }   # optional; saved when you drag
    properties:
      - key: author
        value: sam
edges:
  - id: e1
    source: pr-101
    target: issue-12
    label: fixes                 # optional
    style: fixes                 # optional
    properties: []
```

For hand-written files, `properties` may also be a plain mapping (`properties: { author: sam }`), and edge ids may be left out (they're generated). JSON with the same structure is accepted too. See `examples/pr-tracking.yaml`.

## Project layout

```
shared/   data model, graph operations, YAML/JSON (used by everything)
server/   Vite plugin: file API + change stream for the web app
mcp/      MCP server (stdio)
web/      React + Cytoscape.js frontend
examples/ sample graphs
```

## License

[MIT](LICENSE)
