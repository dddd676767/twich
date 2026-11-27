import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
      '/ws': {
        target: 'ws://127.0.0.1:8080',
        ws: true,
      },
      '/mtx-api': {
        target: 'http://127.0.0.1:9997',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/mtx-api/, ''),
      },
      '/mtx-webrtc': {
        target: 'http://127.0.0.1:8889',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/mtx-webrtc/, ''),
      },
      '/mtx-hls': {
        target: 'http://127.0.0.1:8888',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/mtx-hls/, ''),
      },
    },
  },
})
