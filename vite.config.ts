import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { graphFileApi } from './server/graphFileApi.ts';

// The graph file shown in the browser; the MCP server should point at the same file.
const graphFile = process.env.MAPNOTES_FILE ?? 'graph.yaml';

export default defineConfig({
  root: 'web',
  plugins: [react(), graphFileApi(graphFile)],
  build: { outDir: '../dist', emptyOutDir: true, chunkSizeWarningLimit: 1500 },
  server: { port: 5173 },
});
