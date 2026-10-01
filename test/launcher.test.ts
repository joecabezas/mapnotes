import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { describe, expect, it } from 'vitest';

const launcher = path.resolve(import.meta.dirname, '../bin/mapnotes-mcp.mjs');

describe('installable MCP launcher', () => {
  it('starts without a graph path', async () => {
    const client = new Client({ name: 'launcher-test', version: '0' });
    try {
      await client.connect(new StdioClientTransport({ command: process.execPath, args: [launcher], stderr: 'ignore' }));
      const result = await client.callTool({ name: 'get_graph', arguments: {} });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ file: null, graph: { nodes: [], edges: [] } });
    } finally {
      await client.close();
    }
  });

  it('starts over stdio and passes the graph path to the server', async () => {
    const graphPath = path.resolve(import.meta.dirname, '../examples/layering-100.yaml');
    const client = new Client({ name: 'launcher-test', version: '0' });
    try {
      await client.connect(new StdioClientTransport({ command: process.execPath, args: [launcher, graphPath], stderr: 'ignore' }));
      const result = await client.callTool({ name: 'get_graph', arguments: {} });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ file: graphPath });
    } finally {
      await client.close();
    }
  });
});
