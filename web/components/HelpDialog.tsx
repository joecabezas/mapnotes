import { fileAccessSupported } from '../fileAccess';
import { Icon } from './Icon';

const SHORTCUTS: [string, string][] = [
  ['N', 'Add a node in the middle of the view'],
  ['Double-click canvas', 'Add a node at that spot'],
  ['E', 'Connect mode: click a source node, then a target node'],
  ['Del / Backspace', 'Delete the selection'],
  ['Shift/Ctrl + click', 'Add or remove a node from the selection'],
  ['Shift + drag', 'Select the nodes inside a box (drag empty canvas)'],
  ['Ctrl+A', 'Select all nodes'],
  ['+ / −', 'Expand the selection to the targets of its outgoing edges / undo the last expansion'],
  ['Arrow keys', 'Move the selected nodes to the next 10px grid line'],
  ['H / Shift+H', 'Hide the selected nodes and their edges / show all hidden nodes again'],
  ['Esc', 'Cancel connect mode / clear selection'],
  ['Ctrl+Z / Ctrl+Shift+Z', 'Undo / redo'],
  ['Ctrl+S', fileAccessSupported ? 'Save to the open file (or choose a new one)' : 'Download the graph as YAML'],
  ['Ctrl+O', 'Open a YAML or JSON graph file'],
  ['F', 'Fit the selection in view (the whole graph if nothing is selected)'],
  ['L', 'Run the layout again (on the selected nodes only, if two or more are selected)'],
  ['/', 'Search nodes'],
  ['?', 'Show this help'],
];

export function HelpDialog({
  onClose,
  onOpenMcp,
  fileName,
}: {
  onClose(): void;
  onOpenMcp(): void;
  fileName: string | null;
}) {
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label="Help">
        <header className="modal-head">
          <h2>Using MapNotes</h2>
          <button className="icon-btn close" onClick={onClose} aria-label="Close">
            <Icon name="close" />
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
              <b>Arrange</b>: drag nodes around, or pick an automatic layout (<em>Fewest crossings</em> tries several and keeps
              the one with the fewest edge crossings). With two or more nodes selected, the layout only moves those.
              Positions are saved with the graph.
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
          {!fileAccessSupported ? (
            <p>
              This browser can't edit files on disk, so your work is kept in the browser. Use <em>Download</em> to save a
              YAML file and <em>Open</em> to load one. Chrome and Edge can save to the file directly.
            </p>
          ) : fileName ? (
            <p>
              Changes are saved automatically to <code>{fileName}</code>. The file is also checked every second, so edits
              made by the MapNotes MCP server (or a text editor) appear here live.
            </p>
          ) : (
            <p>
              Not linked to a file yet: your work is kept in this browser. <em>Open</em> a YAML/JSON file or use{' '}
              <em>Save</em> to create one; from then on every change is written to it.
            </p>
          )}
          <h3>Use with an AI assistant</h3>
          <p>
            The MapNotes MCP server lets an AI assistant (Claude Code, Cursor, VS Code, …) read and edit graph files;
            edits to an open file show up here live.
          </p>
          <button className="btn" onClick={onOpenMcp}>
            Install MCP server…
          </button>
        </div>
      </div>
    </div>
  );
}
