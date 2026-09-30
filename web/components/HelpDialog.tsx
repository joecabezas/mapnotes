const SHORTCUTS: [string, string][] = [
  ['N', 'Add a node in the middle of the view'],
  ['Double-click canvas', 'Add a node at that spot'],
  ['E', 'Connect mode: click a source node, then a target node'],
  ['Del / Backspace', 'Delete the selected node or edge'],
  ['Esc', 'Cancel connect mode / clear selection'],
  ['Ctrl+Z / Ctrl+Shift+Z', 'Undo / redo'],
  ['Ctrl+S', 'Download the graph as YAML'],
  ['Ctrl+O', 'Open a YAML or JSON graph file'],
  ['F', 'Fit the whole graph in view'],
  ['/', 'Search nodes'],
  ['?', 'Show this help'],
];

export function HelpDialog({ onClose, fileMode }: { onClose(): void; fileMode: string | null }) {
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label="Help">
        <header className="modal-head">
          <h2>Using MapNotes</h2>
          <button className="icon-btn close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        <div className="help">
          <ol className="steps">
            <li>
              <b>Add nodes</b> with <kbd>N</kbd>, the <em>+ Node</em> button, or by double-clicking empty space.
            </li>
            <li>
              <b>Connect them</b>: press <kbd>E</kbd> (or <em>Connect</em>), click the source node, then the target.
            </li>
            <li>
              <b>Inspect &amp; edit</b>: click anything to edit its label, id, style and key/value properties in the right
              panel. Hover to preview properties.
            </li>
            <li>
              <b>Arrange</b>: drag nodes around, or pick an automatic layout. Positions are saved with the graph.
            </li>
            <li>
              <b>Style</b>: create reusable node/edge styles (color, shape, size, line, arrow) in <em>Styles</em>.
            </li>
          </ol>
          <h3>Keyboard shortcuts</h3>
          <table className="shortcuts">
            <tbody>
              {SHORTCUTS.map(([k, v]) => (
                <tr key={k}>
                  <td>
                    <kbd>{k}</kbd>
                  </td>
                  <td>{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h3>Saving</h3>
          {fileMode ? (
            <p>
              Changes are saved automatically to <code>{fileMode}</code>. The file is also watched, so edits made by the
              MapNotes MCP server (or a text editor) appear here live.
            </p>
          ) : (
            <p>
              Running without the file server: your work is kept in this browser. Use <em>Save</em> to download a YAML
              file and <em>Open</em> to load one.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
