import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  define: {__QR_READ_CHECK_BUILD__: JSON.stringify(process.env.SITE_ID==='b64bf33c-a131-4ae2-b2b0-9aec16e9f77b' && process.env.CONTEXT==='production' && process.env.BRANCH==='release/video-workflows-staging')},
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: process.env.VITE_DEV_API_PROXY || 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
})
