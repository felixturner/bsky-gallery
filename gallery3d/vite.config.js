import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

export default defineConfig(({ command }) => ({
  // Deployed as a sub-path of the 2D gallery's GitHub Pages site
  base: command === 'build' ? '/bsky-gallery/3d/' : '/',
  // Self-signed HTTPS for the dev server so the LAN origin is a secure context
  // — required for WebGPU on phones (http://<lan-ip> is not secure; only
  // localhost/https are). Opt out with NO_HTTPS=1 (plain http on localhost,
  // no cert prompt). No effect on the production build.
  plugins: command === 'serve' && process.env.NO_HTTPS !== '1' ? [basicSsl()] : [],
  server: {
    proxy: {
      '/cdn-bsky': {
        target: 'https://cdn.bsky.app',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/cdn-bsky/, ''),
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes) => {
            proxyRes.headers['access-control-allow-origin'] = '*';
          });
        },
      },
      '/video-bsky': {
        target: 'https://video.bsky.app',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/video-bsky/, ''),
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes) => {
            proxyRes.headers['access-control-allow-origin'] = '*';
          });
        },
      },
    },
  },
}));
