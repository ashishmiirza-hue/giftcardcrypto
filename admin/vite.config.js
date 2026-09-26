import { defineConfig } from 'vite';

// Local testing: backend runs on :3001, this dev server proxies /api to it.
// On Netlify, netlify.toml does the same proxying to your Render backend.
export default defineConfig({
  // Relative asset paths, so the admin works both at its own domain (Netlify)
  // and under /admin/ when the backend serves everything (Render, one service).
  base: './',
  server: {
    port: 3002,
    proxy: { '/api': 'http://localhost:3001' },
  },
});
