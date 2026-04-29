import { defineConfig } from 'vite';

export default defineConfig({
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
});
