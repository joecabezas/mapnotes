# MapNotes

A render engine for your own graphs. Model anything as nodes and edges (pull requests → issues → projects, services → dependencies, notes → topics…), attach key/value properties, style them, and save everything as a readable YAML file.

- **Web app**: interactive canvas (drag, click to inspect, hover to preview), editing of nodes, edges, graph properties and styles (including full-color brand icons), automatic layouts, search, undo/redo, dark theme by default with a light theme toggle.
- **MCP server**: lets an AI assistant (Claude Code, Claude Desktop, …) load, query and edit a graph file. Open the same file in the web app (Chrome/Edge) to see its edits live.

## Quick start

```bash
npm install
npm run dev                          # dev server with hot reload at http://localhost:5173
npm run build                        # static site in dist/
```

The web app is a static site with no backend. How it saves depends on the browser:

- **Chrome, Edge and other Chromium browsers** can edit files on disk directly (File System Access API). **Open** a YAML/JSON file, or **Save** to create one, and every change is written back to that file. The file is also checked every second, so edits made by the MCP server or a text editor show up live. After a page reload the browser remembers the file but asks for permission again: click **Reconnect** in the status pill. **Close file** in the ▾ menu unlinks it; **New** and **Load example** also unlink it so they never overwrite your file.
- **Firefox and Safari** don't support that API, so work is kept in the browser (`localStorage`). **Open** loads a file's contents, and **Download** saves a copy.

In every browser the current graph is also kept in `localStorage`, and the ▾ menu can download YAML/JSON or export a PNG.

### Live site

Every push to `master` is built and published to GitHub Pages by `.github/workflows/deploy.yml`: https://blog.k014.net/mapnotes/

### Using the app

| Action | How |
| --- | --- |
| Add node | `N`, **+ Node**, or double-click empty canvas |
| Connect nodes | `E` / **Connect**, click source, then target |
| Inspect / edit | Click a node or edge; edit label, id, style, properties on the right |
| Delete | `Del` / `Backspace`, or the button in the inspector |
| Arrange | Drag nodes, or pick a layout from the dropdown (it applies immediately; **↻** runs it again). **Smart (layered)** puts parents above their children and minimises edge crossings; **Force-directed** spreads nodes out like springs. `F` fits the view |
| Styles | **🎨 Styles**: node color/border/shape/size/icon, edge color/width/line/arrow/curve |
| Search | `/` — matches labels, ids and property values; `Enter` jumps to the first hit |
| Undo / redo | `Ctrl+Z` / `Ctrl+Shift+Z` |
| Open / save | `Ctrl+O` / `Ctrl+S` (saves to the open file; **Download** in Firefox/Safari); Save as, JSON and PNG in the ▾ menu |
| Help | `?` |

### Icons

Node styles can show a full-color brand logo (Slack, GitHub, Linear, Obsidian, …) inside the node. Icons come from [svgl](https://svgl.app) and are fetched at runtime from jsDelivr (pinned to svgl `5.0.0`), so nothing is stored in this repo. The canvas needs network access to show them; if an icon can't be loaded, the node is simply drawn without it.

- **Pick an icon**: in **🎨 Styles**, set **Icon** to the icon's svgl file name without `.svg`, e.g. `slack`, `linear`, `obsidian`. Logos with light and dark variants have a suffix: `github_light` is the dark logo for light fills, `github_dark` is the white logo for dark fills.
- **Find a name**: search svgl.app, or query the API, e.g. `https://api.svgl.app?search=notion`, and take the file name from the returned `route`.
- **Size it**: **Icon size (%)** sets how much of the node the icon fills (default 70).
- **Make it readable**: logos are drawn over the node's shape and fill. A circle (`ellipse`) with a white fill works for most logos, with the brand color as the border. Pointed shapes such as `diamond` or `star` clip the logo.

The MCP `set_style` tool accepts the same `icon` and `iconSize` fields.

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
| `set_style`, `remove_style` | Create/replace/remove reusable node and edge styles (including `icon` / `iconSize`) |

When a file is open, every change is written to it immediately, and the file is re-read before each operation, so edits made to the file by other tools are not overwritten.

## File format

```yaml
properties:            # GraphProperty[]
  - key: title         # shown as the graph's name
    value: My graph
  - key: subtitle      # optional line shown under the title
    value: What this graph is about
styles:                # reusable looks, referenced by id
  - id: pr
    target: node       # node | edge
    color: "#7aa2f7"
    borderColor: "#c9d8ff"
    textColor: "#ffffff"
    shape: ellipse     # ellipse, rectangle, round-rectangle, triangle, diamond, pentagon, hexagon, octagon, star, tag, barrel
    size: 34
    icon: github_dark  # optional, svgl icon file name (see "Icons" above)
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
mcp/      MCP server (stdio)
web/      React + Cytoscape.js frontend
examples/ sample graphs
```

## License

[MIT](LICENSE)
