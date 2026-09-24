import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    emptyOutDir: false,
    lib: {
      entry: resolve(import.meta.dirname, 'src/embed/loader.ts'),
      formats: ['iife'],
      name: 'AgentWidgetLoader',
      fileName: () => 'embed.js',
    },
    rollupOptions: {
      output: { extend: true },
    },
  },
});
