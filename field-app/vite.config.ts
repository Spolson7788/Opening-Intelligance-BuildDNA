import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // App shell + JS/CSS are precached so the app still launches with no signal.
      // API responses are cached separately via our own IndexedDB layer (src/lib/db.ts),
      // not through the service worker, since that data needs app-level merge/queue logic.
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
      },
      manifest: {
        name: 'Opening Intel — Field',
        short_name: 'OpeningIntel',
        description: 'Scan and log commercial opening assets in the field',
        theme_color: '#14171a',
        background_color: '#14171a',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/scan',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
        ],
      },
    }),
  ],
  server: {
    proxy: {
      '/api': {
        target: process.env.VITE_DEV_API_PROXY || 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
})
