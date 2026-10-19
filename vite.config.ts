import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  root: '.',
  publicDir: 'web/public',
  plugins: [react()],
  build: { outDir: 'dist/web' },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:4780',
      '/mcp': 'http://127.0.0.1:4780',
    },
  },
  test: { environment: 'node', globals: true },
})
