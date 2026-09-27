import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// V4 is served by the FastAPI backend under /v4/ (/ redirects there).
// During development the dev server proxies /api to an isolated backend
// (never the owner's daily instance on 8487).
const backend = process.env.V4_BACKEND ?? 'http://127.0.0.1:8521'

export default defineConfig({
  base: '/v4/',
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
  },
})
