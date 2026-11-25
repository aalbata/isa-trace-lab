import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The relative base makes the build independent of the path it is served from,
// so the same files work at a domain root and under a repository path on GitHub Pages.
// Routing uses the URL fragment, which survives direct visits and refreshes on static hosting.
export default defineConfig({
  base: './',
  plugins: [react()],
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    outDir: 'dist',
    chunkSizeWarningLimit: 1200,
  },
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
});
