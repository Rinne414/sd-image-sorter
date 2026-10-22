import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Vopus is served by the FastAPI backend under /vopus/, and the new interface
// (next.html, docs/DESIGN.md §redesign-2026-10) under /next/; / is the classic
// interface unless Settings chose Vopus, and old /v4/ addresses lead here.
// During development the dev server proxies /api to an isolated backend
// (never the owner's daily instance on 8487).
const backend = process.env.V4_BACKEND ?? 'http://127.0.0.1:8521'

export default defineConfig({
  base: '/vopus/',
  plugins: [react()],
  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      '/api': { target: backend, changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: { main: 'index.html', next: 'next.html' },
    },
  },
})
