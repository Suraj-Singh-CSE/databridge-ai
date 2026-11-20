import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    env: { NODE_ENV: 'test' },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // index.ts only wires real infrastructure together (env, Mongo, listen, signals).
      exclude: ['src/index.ts', 'src/types/**'],
      reporter: ['text', 'text-summary'],
      thresholds: { lines: 80 },
    },
  },
});
