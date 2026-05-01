// Bluesky feed source resolution + paginated media fetching.
// Pure data layer — no Three.js, no DOM access.

const IS_DEV = import.meta.env.DEV;
const CORS_WORKER = 'https://bsky-cors.felixturner.workers.dev';

const XRPC = 'https://public.api.bsky.app/xrpc';
const ENDPOINT = {
  handle: { path: 'app.bsky.feed.getAuthorFeed', param: 'actor' },
  feed:   { path: 'app.bsky.feed.getFeed',       param: 'feed'  },
  list:   { path: 'app.bsky.feed.getListFeed',   param: 'list'  },
};

// Dev: route through Vite's local proxy.
// Prod: route through a Cloudflare Worker that adds CORS headers to
// cdn.bsky.app + video.bsky.app responses. The Worker maps:
//   <WORKER>/cdn/...   → https://cdn.bsky.app/...
//   <WORKER>/video/... → https://video.bsky.app/...
// Relative URLs inside the HLS playlist resolve against the worker domain
// correctly, so video playback works end-to-end.
function proxyUrl(url) {
  if (!url) return url;
  if (IS_DEV) {
    return url
      .replace(/^https:\/\/cdn\.bsky\.app/, '/cdn-bsky')
      .replace(/^https:\/\/video\.bsky\.app/, '/video-bsky');
  }
  return url
    .replace(/^https:\/\/cdn\.bsky\.app/,   `${CORS_WORKER}/cdn`)
    .replace(/^https:\/\/video\.bsky\.app/, `${CORS_WORKER}/video`);
}

// Detect handle / profile URL / feed URL / list URL / AT-URI
export function parseSource(input) {
  const s = (input || '').trim();

  let m = s.match(/bsky\.app\/profile\/([^\/]+)\/feed\/([^\/?#]+)/i);
  if (m) return { type: 'feed', handle: m[1], rkey: m[2] };

  m = s.match(/bsky\.app\/profile\/([^\/]+)\/lists\/([^\/?#]+)/i);
  if (m) return { type: 'list', handle: m[1], rkey: m[2] };

  m = s.match(/bsky\.app\/profile\/([^\/?#]+)/i);
  if (m) return { type: 'handle', actor: m[1] };

  if (s.startsWith('at://')) {
    if (s.includes('/app.bsky.feed.generator/')) return { type: 'feed', uri: s };
    if (s.includes('/app.bsky.graph.list/'))     return { type: 'list', uri: s };
  }

  return { type: 'handle', actor: s.replace(/^@/, '') };
}

async function resolveHandleToDid(handle) {
  if (handle.startsWith('did:')) return handle;
  const url = new URL(`${XRPC}/com.atproto.identity.resolveHandle`);
  url.searchParams.set('handle', handle);
  const res = await fetch(url);
  if (!res.ok) throw new Error('PROFILE_NOT_FOUND');
  return (await res.json()).did;
}

export async function resolveSource(parsed) {
  if (parsed.type === 'handle') return { type: 'handle', uri: parsed.actor };
  if (parsed.uri) return parsed;
  const did = await resolveHandleToDid(parsed.handle);
  const collection = parsed.type === 'feed'
    ? 'app.bsky.feed.generator'
    : 'app.bsky.graph.list';
  return { type: parsed.type, uri: `at://${did}/${collection}/${parsed.rkey}` };
}

function parseFeedToMedia(feed, out, includeReposts) {
  for (const fi of feed) {
    if (!includeReposts && fi.reason?.$type === 'app.bsky.feed.defs#reasonRepost') continue;
    const post = fi.post;
    let embed = post.embed;
    if (!embed) continue;
    if (embed.$type === 'app.bsky.embed.recordWithMedia#view') embed = embed.media;
    if (!embed) continue;

    const rkey = post.uri.split('/').pop();
    const authorHandle = post.author.handle;
    const displayName = post.author.displayName || authorHandle;
    const postUrl = `https://bsky.app/profile/${authorHandle}/post/${rkey}`;
    const postText = (post.record && post.record.text) || '';
    const date = new Date(post.indexedAt).toLocaleDateString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
    });

    // groupId: stable per-post key so multi-image posts can share frame
    // styling and target sizing in the gallery.
    const meta = { authorHandle, displayName, postUrl, postText, date, groupId: post.uri };

    if (embed.$type === 'app.bsky.embed.images#view') {
      for (const img of embed.images) {
        out.push({
          type: 'image',
          thumb: proxyUrl(img.thumb),
          full: proxyUrl(img.fullsize),
          aspectRatio: img.aspectRatio,
          alt: img.alt || '',
          ...meta,
        });
      }
    } else if (embed.$type === 'app.bsky.embed.video#view') {
      out.push({
        type: 'video',
        thumb: proxyUrl(embed.thumbnail),
        full: proxyUrl(embed.playlist),
        aspectRatio: embed.aspectRatio,
        alt: embed.alt || '',
        ...meta,
      });
    }
  }
}

export function createPaginator(source, { includeReposts = true } = {}) {
  let cursor = null;
  let exhausted = false;

  async function fetchNextPage() {
    if (exhausted) return [];
    const cfg = ENDPOINT[source.type];
    const url = new URL(`${XRPC}/${cfg.path}`);
    url.searchParams.set(cfg.param, source.uri);
    url.searchParams.set('limit', 100);
    if (cursor) url.searchParams.set('cursor', cursor);

    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text();
      if (res.status === 400 && /not found|could not find/i.test(body)) {
        throw new Error('PROFILE_NOT_FOUND');
      }
      throw new Error(`API ${res.status}`);
    }
    const data = await res.json();
    cursor = data.cursor || null;
    if (!cursor) exhausted = true;
    const out = [];
    parseFeedToMedia(data.feed, out, includeReposts);
    return out;
  }

  return { fetchNextPage, get isExhausted() { return exhausted; } };
}

// Pull pages until we have at least minCount items (or the feed runs out).
export async function fetchInitialMedia(source, minCount, opts) {
  const paginator = createPaginator(source, opts);
  const items = [];
  while (items.length < minCount && !paginator.isExhausted) {
    const more = await paginator.fetchNextPage();
    items.push(...more);
    if (more.length === 0) break;
  }
  return { paginator, items };
}
