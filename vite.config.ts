import { defineConfig } from 'vite';

// Deliberately minimal: no plugins, no extra pipeline. `npm install && npm run dev` is the whole story.
export default defineConfig({
  server: { port: 5173, strictPort: true, host: '127.0.0.1' },
  build: { target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 4096 },
});
