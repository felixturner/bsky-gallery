import { defineConfig } from 'vite';

// GitHub Pages serves the site at /<repo-name>/, so we need a base path.
// In dev (`npm run dev`) base is '/' for normal localhost behavior.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/bsky-gallery/' : '/',
}));
