import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react()],
    server: {
      port: 6370,
      strictPort: true,
      proxy: {
        '/api': {
          target: 'http://127.0.0.1:3789',
          changeOrigin: true
        }
      }
    }
  }
})
