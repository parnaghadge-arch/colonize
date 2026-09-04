import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Super Admin Panel (§79).
 *
 * Runs on its own port beside the society console. `/api` is proxied to the backend so the browser
 * only ever talks to its own origin — no CORS configuration and no hard-coded host that would break
 * behind a preview proxy or a tunnel.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5174,
    strictPort: false,
    allowedHosts: true,
    proxy: {
      '/api': {
        target: process.env.VITE_API_PROXY_TARGET ?? 'http://127.0.0.1:4000',
        changeOrigin: true,
      },
      '/docs': {
        target: process.env.VITE_API_PROXY_TARGET ?? 'http://127.0.0.1:4000',
        changeOrigin: true,
      },
    },
  },
  preview: { host: '0.0.0.0', port: 5174, allowedHosts: true },
  build: { outDir: 'dist', sourcemap: true, target: 'es2022' },
});
