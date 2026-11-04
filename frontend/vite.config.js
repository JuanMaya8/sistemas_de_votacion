import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development, /api and /ws are proxied to the backend (Docker Compose on :80 or a single
// instance on :3000). Override with VITE_PROXY_TARGET.
const target = process.env.VITE_PROXY_TARGET || 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target, changeOrigin: true },
      '/health': { target, changeOrigin: true },
      '/ws': { target, ws: true, changeOrigin: true },
    },
  },
  build: { target: 'es2019', sourcemap: false },
});
