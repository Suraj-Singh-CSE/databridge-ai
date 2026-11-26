/// <reference types="vitest/config" />
import { fileURLToPath, URL } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const RADIX = [
  'radix-ui',
  '@radix-ui/[^/\\\\]+',
  '@floating-ui/[^/\\\\]+',
  'aria-hidden',
  'react-remove-scroll',
  'react-remove-scroll-bar',
  'react-style-singleton',
  'use-callback-ref',
  'use-sidecar',
  'get-nonce',
  'detect-node-es',
  'tslib',
];

/**
 * Named vendor chunks, highest priority first. `first` groups take only modules the first
 * page needs (Rolldown's `$initial` tag); the rest of a library, used only by lazy pages,
 * falls through to a later group, so it is downloaded when such a page opens.
 */
const VENDOR_GROUPS: { name: string; packages: string[]; first?: boolean }[] = [
  { name: 'react', packages: ['react', 'react-dom', 'scheduler'], first: true },
  { name: 'router', packages: ['react-router', 'cookie', 'set-cookie-parser'], first: true },
  { name: 'query', packages: ['@tanstack/query-core', '@tanstack/react-query'], first: true },
  { name: 'radix', packages: RADIX, first: true },
  {
    name: 'ui-utils',
    packages: ['sonner', 'clsx', 'class-variance-authority', 'tailwind-merge'],
    first: true,
  },
  { name: 'icons', packages: ['lucide-react'], first: true },
  { name: 'zod', packages: ['zod'], first: true },
  { name: 'forms', packages: ['react-hook-form', '@hookform/resolvers', 'zod'] },
  { name: 'radix-extra', packages: RADIX },
  { name: 'icons-extra', packages: ['lucide-react'] },
];

function nodeModules(packages: readonly string[]): RegExp {
  return new RegExp(`[\\\\/]node_modules[\\\\/](?:${packages.join('|')})[\\\\/]`);
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    rolldownOptions: {
      output: {
        // Vendor groups (Rolldown's successor to Rollup `manualChunks`): the app entry stays
        // small, and libraries that change rarely keep their hashed file names between
        // releases, so browsers reuse them from cache. Plain files only; the CSP stays intact.
        codeSplitting: {
          groups: VENDOR_GROUPS.map(({ name, packages, first }, index) => ({
            name,
            test: nodeModules(packages),
            priority: VENDOR_GROUPS.length - index,
            ...(first ? { tags: ['$initial' as const] } : {}),
          })),
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:4000',
    },
  },
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
  },
});
