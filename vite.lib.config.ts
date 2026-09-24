import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist-lib',
    lib: {
      entry: resolve(import.meta.dirname, 'src/lib/index.ts'),
      formats: ['es'],
      fileName: () => 'index.js',
      cssFileName: 'agent-widget',
    },
    rollupOptions: {
      external: [
        'react',
        'react/jsx-runtime',
        'react-dom',
        '@ai-sdk/react',
        'ai',
        'lucide-react',
        'react-markdown',
        'remark-gfm',
      ],
    },
  },
});
