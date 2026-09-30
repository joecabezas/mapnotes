import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'web',
  // Relative asset URLs, so the build works under any path (e.g. GitHub Pages' /mapnotes/).
  base: './',
  plugins: [react()],
  build: { outDir: '../dist', emptyOutDir: true, chunkSizeWarningLimit: 1500 },
  server: { port: 5173 },
});
