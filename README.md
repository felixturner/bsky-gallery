# Bluesky Gallery

Two ways to look at a Bluesky user's media: a **2D masonry web gallery** and a **3D WebGL carousel**.

![2D gallery screenshot](docs/2dgallery-screenshot.jpg)

## Live demo

The 2D gallery is deployed via GitHub Pages: <https://felixturner.github.io/bsky-gallery/>

## Repo layout

```
gallery2d/   — Vite + vanilla JS masonry gallery (deployed to GitHub Pages)
gallery3d/   — Vite + Three.js spike: planes around a circular carousel,
               WASD / pointer-lock first-person controls
docs/        — screenshots
```

Each subfolder is an independent Vite project with its own `package.json`.

## Run locally

```sh
# 2D
cd gallery2d
npm install
npm run dev

# 3D
cd gallery3d
npm install
npm run dev
```

## What it does

Both apps fetch a user's media via the public Bluesky AppView API
(`app.bsky.feed.getAuthorFeed`) and render whatever embeds the post contains:

- **Images** (`app.bsky.embed.images`) — direct CDN URLs from `cdn.bsky.app`
- **Videos** (`app.bsky.embed.video`) — HLS playlists from `video.bsky.app`,
  played via [hls.js](https://github.com/video-dev/hls.js) (or native HLS on Safari)
- **Externals** (`app.bsky.embed.external`) — YouTube embeds, Tenor GIFs,
  link previews

The 2D gallery does inline auto-playing muted-looped videos with
`IntersectionObserver`-gated HLS attach/detach so dozens of videos don't all
stream at once. Click any thumbnail to open it in a lightbox modal.

The 3D spike loads textures via `THREE.TextureLoader` and `THREE.VideoTexture`.
A Vite dev proxy bypasses CORS for `cdn.bsky.app` (which doesn't send
`Access-Control-Allow-Origin`) so textures aren't tainted for WebGL.

## Built by

[Airtight](https://airtight.cc)
