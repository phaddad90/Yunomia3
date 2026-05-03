import { defineConfig } from 'vite';

// Vite hosts the frontend at :1420 in dev, builds static bundle to v3/dist for
// release. Tauri's `frontendDist` points at ../dist relative to src-tauri.
export default defineConfig({
  root: 'src',
  publicDir: false,
  server: {
    port: 1420,
    strictPort: true,
    host: '127.0.0.1',
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    target: 'es2022',
  },
  clearScreen: false,
});
