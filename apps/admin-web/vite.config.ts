import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Society Management Web App (§78).
 *
 * The dev server proxies `/api` to the backend, so the browser only ever talks to its own
 * origin — no CORS surprises and no hard-coded host that would break behind a proxy or tunnel.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: false,
    // Accept requests from any host header so the app works behind a preview/tunnel proxy.
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
  preview: {
    host: '0.0.0.0',
    port: 5173,
    allowedHosts: true,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'es2022',
  },
});
