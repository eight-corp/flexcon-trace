import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig(() => {
  const base = process.env.GITHUB_ACTIONS === 'true' ? '/flexcon-trace/' : '/'

  return {
    base,
    plugins: [
      react(),
      VitePWA({
        registerType: 'autoUpdate',
        manifest: {
          name: 'フレコントレース',
          short_name: 'フレコン',
          description: '玄米フレコンのQR出荷管理',
          lang: 'ja',
          theme_color: '#236640',
          background_color: '#f3f5f2',
          display: 'standalone',
          icons: [{ src: `${base}app-icon.svg`, sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }],
        },
      }),
    ],
  }
})
