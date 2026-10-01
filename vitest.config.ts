import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts, whose `root: 'web'` is for the app build.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
