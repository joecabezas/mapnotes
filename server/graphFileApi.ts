// Vite plugin that exposes the graph file on disk to the browser:
//   GET  /api/graph   -> { file, text }
//   PUT  /api/graph   <- YAML text (validated before writing)
//   GET  /api/events  -> Server-Sent Events, `graph` event whenever the file
//                        changes on disk (e.g. edited by the MCP server)
import { promises as fs, unwatchFile, watchFile } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import type { Connect, Plugin } from 'vite';
import { writeGraphFile, writeGraphText } from '../shared/fileStore.ts';
import { emptyGraph } from '../shared/model.ts';
import { parseGraphYaml } from '../shared/yaml.ts';

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

export function graphFileApi(fileArg: string): Plugin {
  const file = path.resolve(fileArg);
  const clients = new Set<ServerResponse>();
  let lastText: string | undefined;

  async function readText(): Promise<string> {
    try {
      return await fs.readFile(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      return writeGraphFile(file, emptyGraph());
    }
  }

  function broadcast(text: string) {
    const payload = `event: graph\ndata: ${JSON.stringify({ text })}\n\n`;
    for (const res of clients) res.write(payload);
  }

  // Polling works on every filesystem (including WSL's /mnt/c) and survives
  // the rename-based atomic writes used by the MCP server.
  const onChange = async () => {
    try {
      const text = await fs.readFile(file, 'utf8');
      if (text === lastText) return;
      parseGraphYaml(text); // don't push files that are mid-edit / invalid
      lastText = text;
      broadcast(text);
    } catch {
      /* ignore missing or invalid file, wait for the next change */
    }
  };

  const middleware: Connect.NextHandleFunction = async (req, res, next) => {
    const url = req.url?.split('?')[0];
    try {
      if (url === '/api/graph' && req.method === 'GET') {
        lastText = await readText();
        return json(res, 200, { file, text: lastText });
      }
      if (url === '/api/graph' && req.method === 'PUT') {
        const text = await readBody(req);
        parseGraphYaml(text); // throws on invalid content
        lastText = text;
        await writeGraphText(file, text);
        // Let other open tabs know as well.
        broadcast(text);
        return json(res, 200, { ok: true });
      }
      if (url === '/api/events' && req.method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.write(': connected\n\n');
        clients.add(res);
        const ping = setInterval(() => res.write(': ping\n\n'), 25000);
        req.on('close', () => {
          clearInterval(ping);
          clients.delete(res);
        });
        return;
      }
    } catch (err) {
      return json(res, 400, { error: (err as Error).message });
    }
    next();
  };

  const setup = (server: { middlewares: Connect.Server; httpServer?: { on(ev: 'close', cb: () => void): unknown } | null }) => {
    watchFile(file, { interval: 400 }, onChange);
    server.httpServer?.on('close', () => unwatchFile(file, onChange));
    server.middlewares.use(middleware);
  };

  return {
    name: 'mapnotes-graph-file-api',
    configureServer: setup,
    configurePreviewServer: setup,
  };
}
