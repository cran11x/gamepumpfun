import { defineConfig } from 'vite';

const SERVER_PORT = Number(process.env.PORT ?? 8787);

export default defineConfig({
  root: 'client',
  publicDir: 'public',
  build: {
    outDir: '../dist/client',
    emptyOutDir: true,
    target: 'es2022',
  },
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/api': `http://localhost:${SERVER_PORT}`,
      '/ws': { target: `ws://localhost:${SERVER_PORT}`, ws: true },
    },
  },
});
