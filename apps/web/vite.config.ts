import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

// Dev-only overrides so an isolated test instance (e.g. a review-preview or a
// runtime-debug server on alternate ports) can be driven without editing this
// file. Default to the production dev ports when unset.
const WEB_PORT = Number(process.env.PC_DEV_WEB_PORT ?? 5173);
const API_PORT = Number(process.env.PC_DEV_API_PORT ?? 4040);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    host: '127.0.0.1',
    port: WEB_PORT,
    strictPort: true,
    proxy: {
      '/api': { target: `http://127.0.0.1:${API_PORT}`, changeOrigin: true },
      '/ws': { target: `ws://127.0.0.1:${API_PORT}`, ws: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
