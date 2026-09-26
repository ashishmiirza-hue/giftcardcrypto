import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Local testing: backend runs on :3001, this dev server proxies /api to it.
// On Netlify, netlify.toml does the same proxying to your Render backend.
export default defineConfig({
  server: {
    port: 3000,
    proxy: { '/api': 'http://localhost:3001' },
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        ai: resolve(__dirname, 'ai.html'),
      },
    },
  },
});
