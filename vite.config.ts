import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  // Relative base so the build works on any host / sub-path (e.g. GitHub Pages).
  base: './',
  plugins: [
    preact(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon-180.png', 'icon.svg'],
      manifest: {
        name: 'Gallery Wall',
        short_name: 'Gallery Wall',
        description: 'Mock up a gallery wall from photos of your wall and frames.',
        display: 'standalone',
        orientation: 'any',
        background_color: '#101014',
        theme_color: '#101014',
        start_url: './',
        scope: './',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: { globPatterns: ['**/*.{js,css,html,png,svg,webmanifest}'] },
    }),
  ],
});
