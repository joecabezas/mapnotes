import { useEffect, useState } from 'react';
import { Icon } from './Icon';

const NAME = 'mapnotes';
const COMMAND = 'npm';
const ARGS = ['exec', '--yes', '--package=github:joecabezas/mapnotes', '--', 'mapnotes-mcp'];

const CLAUDE_CODE = `claude mcp add --scope user ${NAME} -- ${COMMAND} ${ARGS.join(' ')}`;
const JSON_CONFIG = JSON.stringify({ mcpServers: { [NAME]: { command: COMMAND, args: ARGS } } }, null, 2);
const AGENT_PROMPT = `Install the MapNotes MCP server for me:
1. Register a stdio MCP server named "${NAME}" with command "${COMMAND}" and arguments:
   ${ARGS.join(' ')}
   In Claude Code: ${CLAUDE_CODE}
2. Tell me how to reload MCP servers in this client, then call mapnotes get_graph to check it works.
3. When I want to see edits in https://joecabezas.github.io/mapnotes/, ask me where to save the graph, call save_graph with that absolute path, and tell me to open the same file in Chrome or Edge. If I already have a graph file, call load_graph with its path instead.`;

// One-click install links handled by the editors themselves.
const VSCODE_LINK = `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: NAME, command: COMMAND, args: ARGS }))}`;
const CURSOR_LINK = `cursor://anysphere.cursor-deeplink/mcp/install?name=${NAME}&config=${btoa(
  JSON.stringify({ command: COMMAND, args: ARGS }),
)}`;

/** A command or config block with a button that copies it. */
function Snippet({ text, what }: { text: string; what: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <div className="snippet">
      <pre className="help-command">
        <code>{text}</code>
      </pre>
      <button
        type="button"
        className="btn small snippet-copy"
        aria-label={`Copy ${what}`}
        onClick={() => void navigator.clipboard.writeText(text).then(() => setCopied(true))}
      >
        <Icon name={copied ? 'check' : 'copy'} />
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

export function McpDialog({ onClose }: { onClose(): void }) {
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label="Install the MCP server">
        <header className="modal-head">
          <h2>Install the MCP server</h2>
          <p>Let an AI assistant read and edit your graphs.</p>
          <button className="icon-btn close" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </header>
        <div className="help">
          <p>
            The server runs on your computer, not on this website. Install{' '}
            <a href="https://nodejs.org/" target="_blank" rel="noreferrer">
              Node.js
            </a>{' '}
            (20.6 or newer) and Git first. You don't need to clone the repository or choose a graph file.
          </p>

          <h3>One click</h3>
          <div className="mcp-links">
            <a className="btn" href={VSCODE_LINK}>
              Add to VS Code
            </a>
            <a className="btn" href={CURSOR_LINK}>
              Add to Cursor
            </a>
          </div>

          <h3>Claude Code</h3>
          <p>Run this in a terminal:</p>
          <Snippet text={CLAUDE_CODE} what="the Claude Code command" />

          <h3>Other MCP clients</h3>
          <p>Add this to the client's MCP configuration (adjust it to the client's format):</p>
          <Snippet text={JSON_CONFIG} what="the MCP configuration" />

          <h3>Or ask your agent</h3>
          <p>Paste this into Claude Code, Codex, Cursor or any agent that can run commands:</p>
          <Snippet text={AGENT_PROMPT} what="the install prompt" />

          <h3>Then</h3>
          <p>
            Restart or reload the client and ask it to call <code>get_graph</code>. To see the agent's edits here, have
            it call <code>save_graph</code> with an absolute file path, then <em>Open</em> that file in Chrome or Edge.
            If you already saved a file here, have the agent call <code>load_graph</code> with its path. The website and
            the server never talk to each other; each reads the same file. Save before restarting the agent: a graph
            kept only in MCP memory is lost.
          </p>
          <p>
            <a href="https://github.com/joecabezas/mapnotes#mcp-server" target="_blank" rel="noreferrer">
              Full MCP setup instructions
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}
