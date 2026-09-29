import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiTarget = `http://127.0.0.1:${process.env.PORT ?? 8787}`;

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: '../dist/web', emptyOutDir: true, sourcemap: false },
  server: {
    host: '0.0.0.0',
    port: 5173,
    allowedHosts: true,
    proxy: { '/api': { target: apiTarget, changeOrigin: false } },
  },
});
