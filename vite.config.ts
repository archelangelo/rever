import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const root = process.cwd();

export default defineConfig({
  root: path.resolve(root, 'src/web'),
  plugins: [react()],
  build: {
    outDir: path.resolve(root, 'dist/web'),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/health': 'http://localhost:7910',
      '/api': 'http://localhost:7910',
      '/mcp': 'http://localhost:7910',
    },
  },
});
