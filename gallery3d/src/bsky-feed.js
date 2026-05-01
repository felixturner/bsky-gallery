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

// Accepts:
//   https://bsky.app/profile/handle/feed/RKEY    (full feed URL)
//   https://bsky.app/profile/handle/lists/RKEY   (full list URL)
//   https://bsky.app/profile/handle              (full profile URL)
//   handle/feed/RKEY                              (shorthand)
//   handle/lists/RKEY                             (shorthand)
//   at://did/...                                  (AT-URI)
//   @handle  /  handle.tld                        (bare handle)
export function parseSource(input) {
  const s = (input || '').trim();

  let m = s.match(/bsky\.app\/profile\/([^\/]+)\/feed\/([^\/?#]+)/i);
  if (m) return { type: 'feed', handle: m[1], rkey: m[2] };

  m = s.match(/bsky\.app\/profile\/([^\/]+)\/lists\/([^\/?#]+)/i);
  if (m) return { type: 'list', handle: m[1], rkey: m[2] };

  m = s.match(/bsky\.app\/profile\/([^\/?#]+)/i);
  if (m) return { type: 'handle', actor: m[1] };

  // Shorthand forms — match the path of the bsky.app URL without the host.
  m = s.match(/^([^\/\s]+)\/feed\/([^\/?#]+)$/i);
  if (m) return { type: 'feed', handle: m[1], rkey: m[2] };

  m = s.match(/^([^\/\s]+)\/lists\/([^\/?#]+)$/i);
  if (m) return { type: 'list', handle: m[1], rkey: m[2] };

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
  // Lists hit a server-side cap on getListFeed (the AppView only indexes a
  // shallow window of recent posts from list members). Bypass it by
  // fetching each member's getAuthorFeed individually and merging.
  if (source.type === 'list') {
    return createListPaginator(source.uri, { includeReposts });
  }
  return createSinglePaginator(source, { includeReposts });
}

function createSinglePaginator(source, { includeReposts }) {
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

// Walk app.bsky.graph.getList pages and collect every member's DID.
async function fetchAllListMembers(listUri) {
  const dids = [];
  let cursor = null;
  for (let safety = 0; safety < 20; safety++) {
    const url = new URL(`${XRPC}/app.bsky.graph.getList`);
    url.searchParams.set('list', listUri);
    url.searchParams.set('limit', 100);
    if (cursor) url.searchParams.set('cursor', cursor);
    const res = await fetch(url);
    if (!res.ok) break;
    const data = await res.json();
    for (const item of (data.items || [])) {
      if (item.subject?.did) dids.push(item.subject.did);
    }
    cursor = data.cursor || null;
    if (!cursor) break;
  }
  return dids;
}

// Fisher-Yates in place.
function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Multi-author "list" paginator: bypasses the getListFeed cap by calling
// getAuthorFeed per list member. First fetchNextPage fans out to every
// member in parallel for breadth and shuffles the result so consecutive
// rooms aren't all one artist. Subsequent calls advance a small batch of
// per-author cursors at a time (also shuffled) so mid-walk prefetches stay
// mixed too.
const LIST_BATCH_SIZE = 5;
function createListPaginator(listUri, { includeReposts }) {
  let states = null;          // [{did, cursor, exhausted}]
  let initialized = false;    // first parallel fan-out done
  let memberIdx = 0;
  let allExhausted = false;

  async function ensureInit() {
    if (states) return;
    const dids = await fetchAllListMembers(listUri);
    states = dids.map((did) => ({ did, cursor: null, exhausted: false }));
    if (states.length === 0) allExhausted = true;
  }

  async function fetchAuthorPage(s) {
    if (s.exhausted) return [];
    const url = new URL(`${XRPC}/app.bsky.feed.getAuthorFeed`);
    url.searchParams.set('actor', s.did);
    url.searchParams.set('limit', 100);
    if (s.cursor) url.searchParams.set('cursor', s.cursor);
    try {
      const res = await fetch(url);
      if (!res.ok) { s.exhausted = true; return []; }
      const data = await res.json();
      s.cursor = data.cursor || null;
      if (!s.cursor) s.exhausted = true;
      const out = [];
      parseFeedToMedia(data.feed, out, includeReposts);
      return out;
    } catch {
      s.exhausted = true;
      return [];
    }
  }

  async function fetchNextPage() {
    await ensureInit();
    if (allExhausted) return [];

    // First call: fan out to every member in parallel, shuffle so
    // consecutive rooms get a mix of artists rather than 100 posts from
    // member 0, then 100 from member 1, etc.
    if (!initialized) {
      initialized = true;
      const results = await Promise.all(states.map(fetchAuthorPage));
      allExhausted = states.every((s) => s.exhausted);
      return shuffleInPlace([].concat(...results));
    }

    // Subsequent calls: pull a small batch of members at a time (so
    // prefetched rooms keep mixing artists), advance the round-robin
    // pointer, and shuffle the batch's combined media items.
    const batch = [];
    let attempts = 0;
    while (batch.length < LIST_BATCH_SIZE && attempts < states.length) {
      if (!states[memberIdx].exhausted) batch.push(states[memberIdx]);
      memberIdx = (memberIdx + 1) % states.length;
      attempts++;
    }
    if (batch.length === 0) {
      allExhausted = true;
      return [];
    }
    const results = await Promise.all(batch.map(fetchAuthorPage));
    allExhausted = states.every((s) => s.exhausted);
    return shuffleInPlace([].concat(...results));
  }

  return { fetchNextPage, get isExhausted() { return allExhausted; } };
}

// Pull pages until we have at least minCount items (or the feed runs out).
// `getListFeed` / `getFeed` pages can contain 100 posts but zero with
// image/video embeds (text-only, reposts, link previews) — so a single
// empty media page doesn't mean the feed is exhausted. Cap iterations
// instead, to avoid spinning if every page is empty.
const MAX_INITIAL_PAGES = 20;
export async function fetchInitialMedia(source, minCount, opts) {
  const paginator = createPaginator(source, opts);
  const items = [];
  let pages = 0;
  while (items.length < minCount && !paginator.isExhausted && pages < MAX_INITIAL_PAGES) {
    const more = await paginator.fetchNextPage();
    items.push(...more);
    pages++;
  }
  return { paginator, items };
}
