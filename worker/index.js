// Cloudflare Worker: CORS proxy for Bluesky's CDN + video service.
//
//   <WORKER>/cdn/<rest>    →  https://cdn.bsky.app/<rest>
//   <WORKER>/video/<rest>  →  https://video.bsky.app/<rest>
//
// Adds Access-Control-Allow-Origin: * to every response so WebGL can sample
// the bytes as textures, and so hls.js can fetch m3u8 segments from another
// origin. Since hls.js follows relative URLs inside m3u8s, the proxy domain
// becomes the base — no segment-URL rewriting is needed.

const ROUTES = {
  '/cdn/':   'https://cdn.bsky.app',
  '/video/': 'https://video.bsky.app',
};

function corsHeaders(extra = {}) {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Max-Age':       '86400',
    ...extra,
  };
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    let target = null;
    for (const [prefix, origin] of Object.entries(ROUTES)) {
      if (url.pathname.startsWith(prefix)) {
        const rest = url.pathname.slice(prefix.length - 1); // keep leading /
        target = origin + rest + url.search;
        break;
      }
    }
    if (!target) {
      return new Response('Not found. Use /cdn/* or /video/*', {
        status: 404,
        headers: corsHeaders({ 'Content-Type': 'text/plain' }),
      });
    }

    const upstream = await fetch(target, {
      method:  request.method,
      headers: { 'User-Agent': request.headers.get('User-Agent') || 'bsky-gallery-cors' },
    });

    // Build a fresh response so we can mutate headers
    const headers = new Headers(upstream.headers);
    Object.entries(corsHeaders()).forEach(([k, v]) => headers.set(k, v));

    return new Response(upstream.body, {
      status:     upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  },
};
