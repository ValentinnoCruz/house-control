import { defineConfig } from 'vite';

const backendPort = Number(process.env.BACKEND_PORT) || 5200;

export default defineConfig({
  base: './',
  // 5199 by default; PORT overrides it when that one is taken.
  server: {
    host: true,
    port: Number(process.env.PORT) || 5199,
    strictPort: true,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${backendPort}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    target: 'safari17',
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
  },
});
