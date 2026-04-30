# bsky-cors Worker

A Cloudflare Worker that proxies `cdn.bsky.app` and `video.bsky.app` with
`Access-Control-Allow-Origin: *` so the 3D gallery can sample images as WebGL
textures and play HLS video.

## Deploy (one-time)

### Option A — `wrangler` CLI

```sh
cd worker
npx wrangler login              # opens browser, signs into Cloudflare
npx wrangler deploy             # deploys, prints the live URL
```

The URL will be `https://bsky-cors.<YOUR-SUBDOMAIN>.workers.dev`.

### Option B — Cloudflare dashboard

1. Sign in at <https://dash.cloudflare.com>.
2. **Workers & Pages → Create → Create Worker**.
3. Name it `bsky-cors`, click **Deploy** (default hello-world).
4. Open the new Worker → **Edit code** → paste the contents of `index.js` →
   **Deploy**.

Either way, copy the worker URL afterwards.

## Wire it into the 3D gallery

Open `gallery3d/main.js` and update:

```js
const CORS_WORKER = 'https://bsky-cors.YOUR-SUBDOMAIN.workers.dev';
```

…then push. The gallery will use this worker in production builds.

## Test

```sh
curl -I "https://bsky-cors.YOUR-SUBDOMAIN.workers.dev/cdn/img/feed_thumbnail/plain/did:plc:7zcuweiwh3hyoo5xpoha3req/bafkreibmnyb53q2hnxe6vq4aatshjdk2jhwjsmmokiep4d3cnfgu7ardki"
```

You should see `access-control-allow-origin: *` in the response.

## Routes

| Worker URL                               | Proxied target                          |
|------------------------------------------|-----------------------------------------|
| `/cdn/<path>`                            | `https://cdn.bsky.app/<path>`           |
| `/video/<path>`                          | `https://video.bsky.app/<path>`         |

## Quotas

- **Free tier**: 100,000 requests/day, no bandwidth limit.
- **Paid ($5/mo)**: 10M requests included + $0.30 per additional million.

Each image load = 1 request. A typical 50-piece gallery session = ~50 requests
plus a few per video segment. Free tier comfortably covers casual usage.
