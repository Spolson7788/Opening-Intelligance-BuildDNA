import { execSync } from 'node:child_process'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import {photoIsolationBuildEnabled} from './photoDiagnosticBuild.js'

const base = process.env.OI_UI_BASE || '/'
// No user-configurable enable flag: only this exact Netlify candidate build.
const photoIsolation = photoIsolationBuildEnabled(process.env);

function fieldBuildSha() {
  const fromEnv = process.env.OI_FIELD_BUILD_SHA?.trim()
  if (fromEnv) return fromEnv
  try { return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim() } catch { return 'unknown' }
}

export default defineConfig({
  define: {
    __PHOTO_ISOLATION_ENABLED__: JSON.stringify(photoIsolation),
    __FIELD_BUILD_SHA__: JSON.stringify(fieldBuildSha()),
  },
  base,
  plugins: [
    react(),
    VitePWA({
      scope: base,
      registerType: 'autoUpdate',
      // App shell + JS/CSS are precached so the app still launches with no signal.
      // API responses are cached separately via our own IndexedDB layer (src/lib/db.ts),
      // not through the service worker, since that data needs app-level merge/queue logic.
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
      },
      manifest: {
        name: 'Opening Intel - Field',
        short_name: 'OpeningIntel',
        description: 'Scan and log commercial opening assets in the field',
        theme_color: '#14171a',
        background_color: '#14171a',
        display: 'standalone',
        orientation: 'portrait',
        scope: base,
        start_url: `${base}scan`,
        icons: [
          { src: `${base}icon-192.png`, sizes: '192x192', type: 'image/png' },
          { src: `${base}icon-512.png`, sizes: '512x512', type: 'image/png' },
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
