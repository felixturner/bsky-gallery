import Hls from 'hls.js';
import imagesLoaded from 'imagesloaded';

const API = 'https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed';
const PAGE_SIZE = 50;

const form = document.getElementById('form');
const handleInput = document.getElementById('handle');
const statusEl = document.getElementById('status');
const feedEl = document.getElementById('feed');
const moreBtn = document.getElementById('more');
const externalToggle = document.getElementById('external');
const linkedToggle = document.getElementById('linked');
const repostsToggle = document.getElementById('reposts');
const masonryToggle = document.getElementById('masonry-layout');
const lightboxEl = document.getElementById('lightbox');
const lightboxContent = document.getElementById('lightbox-content');
const lightboxClose = document.getElementById('lightbox-close');

const LIGHTBOX_PADDING = 16;

function computeFrameSize(aspectRatio) {
  if (!aspectRatio) return null;
  const maxW = window.innerWidth - LIGHTBOX_PADDING * 2;
  const maxH = window.innerHeight - LIGHTBOX_PADDING * 2;
  const ar = aspectRatio.width / aspectRatio.height;
  let w = maxW;
  let h = w / ar;
  if (h > maxH) { h = maxH; w = h * ar; }
  return { w, h };
}

function openLightbox(node, aspectRatio) {
  lightboxContent.innerHTML = '';

  const frame = document.createElement('div');
  frame.className = 'lightbox-frame';
  const size = computeFrameSize(aspectRatio);
  if (size) {
    frame.style.width = `${size.w}px`;
    frame.style.height = `${size.h}px`;
    node.classList.add('fill');
  } else {
    // No aspect ratio info — cap the media itself; frame shrink-wraps to it.
    const maxW = window.innerWidth - LIGHTBOX_PADDING * 2;
    const maxH = window.innerHeight - LIGHTBOX_PADDING * 2;
    node.style.maxWidth = `${maxW}px`;
    node.style.maxHeight = `${maxH}px`;
  }

  const ring = document.createElement('div');
  ring.className = 'ring';
  frame.appendChild(ring);

  node.classList.add('lightbox-media');
  const onReady = () => {
    ring.remove();
    node.classList.add('loaded');
  };
  if (node.tagName === 'IMG') {
    if (node.complete && node.naturalWidth) onReady();
    else node.addEventListener('load', onReady, { once: true });
  } else if (node.tagName === 'VIDEO') {
    node.addEventListener('loadeddata', onReady, { once: true });
  } else if (node.tagName === 'IFRAME') {
    node.addEventListener('load', onReady, { once: true });
  } else {
    onReady();
  }

  frame.appendChild(node);
  lightboxContent.appendChild(frame);
  lightboxEl.hidden = false;
  document.body.style.overflow = 'hidden';

  if (node.tagName === 'VIDEO') {
    // Force playback — autoplay attribute alone is unreliable on a freshly-
    // created element. If the browser blocks unmuted, retry muted.
    node.play().catch(() => {
      node.muted = true;
      node.play().catch(() => {});
    });
  }
}

function closeLightbox() {
  lightboxEl.hidden = true;
  lightboxContent.innerHTML = '';
  document.body.style.overflow = '';
}

lightboxEl.addEventListener('click', (e) => {
  // Close when clicking the backdrop or the close button (or its SVG children)
  if (e.target === lightboxEl || e.target.closest('#lightbox-close')) closeLightbox();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !lightboxEl.hidden) closeLightbox();
});

[externalToggle, linkedToggle, repostsToggle, masonryToggle].forEach((el) =>
  el.addEventListener('change', render)
);

// Debounced resize for masonry mode: hide items + show spinner during resize,
// then re-run our custom layout once it settles.
let resizeTimer = null;
window.addEventListener('resize', () => {
  if (!masonryToggle.checked) return;
  document.body.classList.add('resizing');
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    layoutMasonry();
    document.body.classList.remove('resizing');
  }, 200);
});

let currentActor = null;
let cursor = null;
const rawItems = []; // raw feed items from API, append-only
let renderedCount = 0; // index into rawItems of how many have been rendered
let isLoading = false;

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const handle = handleInput.value.trim().replace(/^@/, '');
  if (!handle) return;
  currentActor = handle;
  cursor = null;
  rawItems.length = 0;
  renderedCount = 0;
  moreBtn.hidden = true;
  loadPage(true);
});

moreBtn.addEventListener('click', () => loadPage(false));

// Infinite scroll: auto-load when the "Load more" button enters the viewport
const moreObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (entry.isIntersecting && cursor && !isLoading) {
      loadPage(false);
    }
  }
}, { rootMargin: '300px' });
moreObserver.observe(moreBtn);

async function loadPage(isInitial) {
  if (isLoading) return;
  isLoading = true;
  setStatus('');
  moreBtn.disabled = true;
  try {
    const startCount = rawItems.length;
    let added = 0;
    while (added < PAGE_SIZE) {
      const url = new URL(API);
      url.searchParams.set('actor', currentActor);
      url.searchParams.set('limit', 100);
      if (cursor) url.searchParams.set('cursor', cursor);

      const res = await fetch(url);
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
      const data = await res.json();
      cursor = data.cursor || null;

      for (const item of data.feed) {
        if (countMedia(item) > 0) {
          rawItems.push(item);
          added += countMedia(item);
        }
      }
      if (!cursor) break;
    }

    if (isInitial) render();
    else appendNew();

    if (rawItems.length === 0 && !cursor && startCount === 0) {
      setStatus('No media found.');
    }
    moreBtn.hidden = !cursor;
    moreBtn.disabled = false;
  } catch (err) {
    console.error(err);
    setStatus(`Error: ${err.message}`, true);
    moreBtn.disabled = false;
  } finally {
    isLoading = false;
  }
}

function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.classList.toggle('error', isError);
}

function postUrl(post) {
  const rkey = post.uri.split('/').pop();
  return `https://bsky.app/profile/${post.author.handle}/post/${rkey}`;
}

function getEmbed(post) {
  let embed = post.embed;
  if (!embed) return null;
  if (embed.$type === 'app.bsky.embed.recordWithMedia#view') embed = embed.media;
  return embed || null;
}

function countMedia(item) {
  const e = getEmbed(item.post);
  if (!e) return 0;
  if (e.$type === 'app.bsky.embed.images#view') return e.images.length;
  if (e.$type === 'app.bsky.embed.video#view') return 1;
  if (e.$type === 'app.bsky.embed.external#view') return 1;
  return 0;
}

// ----- Custom masonry (shortest-column row-flow) -----

const MASONRY_GUTTER = 8;
function masonryColumns(containerWidth) {
  if (containerWidth < 500) return 1;
  if (containerWidth < 800) return 2;
  if (containerWidth < 1200) return 3;
  if (containerWidth < 1600) return 4;
  return 5;
}

function layoutMasonry() {
  const cards = Array.from(feedEl.querySelectorAll('.item'));
  if (!cards.length) { feedEl.style.height = ''; return; }

  // Absolute-positioned children are placed relative to the parent's PADDING
  // edge, so we must add padding-left/top to each item's offset to land them
  // inside the content area.
  const cs = getComputedStyle(feedEl);
  const padL = parseFloat(cs.paddingLeft);
  const padR = parseFloat(cs.paddingRight);
  const padT = parseFloat(cs.paddingTop);
  const padB = parseFloat(cs.paddingBottom);

  const containerW = feedEl.clientWidth - padL - padR;
  const cols = masonryColumns(containerW);
  const colW = (containerW - MASONRY_GUTTER * (cols - 1)) / cols;
  const colHeights = new Array(cols).fill(0);

  for (const card of cards) {
    card.style.width = `${colW}px`;
    card.style.position = 'absolute';
    // Force reflow read after width set so we measure correct height
    const h = card.offsetHeight;
    // Find shortest column
    let col = 0;
    for (let i = 1; i < cols; i++) if (colHeights[i] < colHeights[col]) col = i;
    card.style.left = `${padL + col * (colW + MASONRY_GUTTER)}px`;
    card.style.top = `${padT + colHeights[col]}px`;
    colHeights[col] += h + MASONRY_GUTTER;
  }
  const tallestCol = Math.max(...colHeights) - MASONRY_GUTTER;
  feedEl.style.height = `${padT + tallestCol + padB}px`;
}

function clearMasonry() {
  for (const card of feedEl.querySelectorAll('.item')) {
    card.style.width = '';
    card.style.position = '';
    card.style.left = '';
    card.style.top = '';
  }
  feedEl.style.height = '';
}

// ----- Rendering -----

function getOpts() {
  return {
    showExternal: externalToggle.checked,
    showLinked: linkedToggle.checked,
    showReposts: repostsToggle.checked,
    useMasonry: masonryToggle.checked,
  };
}

function renderItemsInto(items, opts, container) {
  const before = container.children.length;
  let count = 0;
  for (const item of items) {
    const isRepost = item.reason?.$type === 'app.bsky.feed.defs#reasonRepost';
    if (isRepost && !opts.showReposts) continue;
    count += renderPost(item.post, { isRepost, ...opts }, container);
  }
  // Return the new card elements that were appended
  return Array.from(container.children).slice(before);
}

function render() {
  // Full re-render: tear down any active HLS players first, then wipe DOM
  for (const v of feedEl.querySelectorAll('.video-thumb video')) {
    videoVisibilityObserver.unobserve(v);
    detachHls(v);
  }
  feedEl.innerHTML = '';

  const opts = getOpts();
  const sorted = rawItems
    .slice()
    .sort((a, b) => new Date(b.post.indexedAt) - new Date(a.post.indexedAt));

  renderItemsInto(sorted, opts, feedEl);
  renderedCount = rawItems.length;

  document.body.classList.toggle('layout-masonry', opts.useMasonry);

  if (opts.useMasonry) {
    layoutMasonry();
    // Re-layout after each image loads so the container height keeps up with
    // late-arriving heights — otherwise scroll gets capped at an early estimate.
    imagesLoaded(feedEl).on('progress', () => layoutMasonry());
    for (const v of feedEl.querySelectorAll('video')) {
      v.addEventListener('loadedmetadata', () => layoutMasonry(), { once: true });
    }
    for (const f of feedEl.querySelectorAll('iframe')) {
      f.addEventListener('load', () => layoutMasonry(), { once: true });
    }
  } else {
    clearMasonry();
  }

  // Only show status at end of feed
  if (!cursor) setStatus(`End of feed · ${feedEl.querySelectorAll('.item').length} items`);
  else setStatus('');
}

function appendNew() {
  // Append-only: render new rawItems entries without disturbing existing layout
  const opts = getOpts();
  const newRaw = rawItems.slice(renderedCount);
  renderedCount = rawItems.length;

  // New items are older than already-rendered (API returns newest-first), so
  // appending in API order keeps overall order date-descending.
  const newCards = renderItemsInto(newRaw, opts, feedEl);

  if (opts.useMasonry && newCards.length) {
    layoutMasonry();
    imagesLoaded(newCards).on('progress', () => layoutMasonry());
    for (const card of newCards) {
      for (const v of card.querySelectorAll('video')) {
        v.addEventListener('loadedmetadata', () => layoutMasonry(), { once: true });
      }
      for (const f of card.querySelectorAll('iframe')) {
        f.addEventListener('load', () => layoutMasonry(), { once: true });
      }
    }
  }

  // Only show status at end of feed
  if (!cursor) setStatus(`End of feed · ${feedEl.querySelectorAll('.item').length} items`);
  else setStatus('');
}

function renderPost(post, { isRepost, showExternal, showLinked }, container) {
  const embed = getEmbed(post);
  if (!embed) return 0;

  const link = postUrl(post);
  const date = new Date(post.indexedAt).toLocaleDateString();
  const append = (card) => {
    if (isRepost) card.classList.add('repost');
    container.appendChild(card);
  };

  switch (embed.$type) {
    case 'app.bsky.embed.images#view':
      for (const img of embed.images) {
        append(makeCard(imgEl(img), { link, date, alt: img.alt }));
      }
      return embed.images.length;

    case 'app.bsky.embed.video#view':
      append(makeCard(videoEl(embed), { link, date, alt: embed.alt }));
      return 1;

    case 'app.bsky.embed.external#view': {
      const result = externalEl(embed.external);
      if (!result) return 0;
      if (result.kind === 'external' && !showExternal) return 0;
      if (result.kind === 'linked' && !showLinked) return 0;
      const card = makeCard(result.node, { link, date });
      card.classList.add(result.kind);
      append(card);
      return 1;
    }

    default:
      return 0;
  }
}

function makeCard(mediaNode, { link, date }) {
  const card = document.createElement('div');
  card.className = 'item';
  card.appendChild(mediaNode);
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.innerHTML = `
    <span class="date">${date}</span>
    <a href="${link}" target="_blank" rel="noopener" title="View on Bluesky" aria-label="View post on Bluesky">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
        <polyline points="15 3 21 3 21 9"/>
        <line x1="10" y1="14" x2="21" y2="3"/>
      </svg>
    </a>`;
  card.appendChild(meta);
  return card;
}

function imgEl(img) {
  const el = document.createElement('img');
  el.src = img.thumb;
  el.dataset.full = img.fullsize;
  el.alt = img.alt || '';
  el.loading = 'lazy';
  if (img.aspectRatio) {
    el.style.aspectRatio = `${img.aspectRatio.width} / ${img.aspectRatio.height}`;
  }
  el.style.cursor = 'zoom-in';
  el.addEventListener('click', () => {
    const full = document.createElement('img');
    full.src = img.fullsize;
    full.alt = img.alt || '';
    openLightbox(full, img.aspectRatio);
  });
  return el;
}

function createVideoEl(embed, { autoplay = false } = {}) {
  const el = document.createElement('video');
  el.controls = true;
  el.playsInline = true;
  el.loop = true;
  el.preload = autoplay ? 'auto' : 'metadata';
  if (autoplay) el.autoplay = true;
  el.poster = embed.thumbnail || '';
  if (embed.aspectRatio) {
    el.style.aspectRatio = `${embed.aspectRatio.width} / ${embed.aspectRatio.height}`;
  }
  const src = embed.playlist;
  if (el.canPlayType('application/vnd.apple.mpegurl')) {
    el.src = src;
  } else if (Hls.isSupported()) {
    const hls = new Hls();
    hls.loadSource(src);
    hls.attachMedia(el);
  } else {
    el.src = src;
  }
  return el;
}

function makePlayOverlay() {
  const overlay = document.createElement('div');
  overlay.className = 'play-overlay';
  overlay.innerHTML = `
    <svg viewBox="0 0 64 64" width="72" height="72" aria-hidden="true">
      <circle cx="32" cy="32" r="30" fill="rgba(0,0,0,0.5)"/>
      <polygon points="26 20 46 32 26 44" fill="#fff"/>
    </svg>`;
  return overlay;
}

function makeYouTubeOverlay() {
  // YouTube-branded play button (red rounded rect + white triangle)
  const overlay = document.createElement('div');
  overlay.className = 'play-overlay';
  overlay.innerHTML = `
    <svg viewBox="0 0 68 48" width="80" height="56" aria-hidden="true">
      <rect width="68" height="48" rx="14" fill="#ff0000"/>
      <polygon points="27,14 27,34 45,24" fill="#fff"/>
    </svg>`;
  return overlay;
}

function makeVideoThumb({ thumb, alt, aspectRatio, onPlay, overlay }) {
  const wrap = document.createElement('div');
  wrap.className = 'video-thumb';
  if (aspectRatio) {
    wrap.style.aspectRatio = `${aspectRatio.width} / ${aspectRatio.height}`;
  }

  const img = document.createElement('img');
  img.src = thumb || '';
  img.loading = 'lazy';
  img.alt = alt || '';
  wrap.appendChild(img);

  wrap.appendChild(overlay || makePlayOverlay());
  wrap.addEventListener('click', onPlay);
  return wrap;
}

// IntersectionObserver-gated HLS: only attach the player when a card is in
// (or near) the viewport. Tear it down when it scrolls offscreen.
const hlsByVideo = new WeakMap();

function attachHls(video) {
  if (video.src || hlsByVideo.has(video)) return; // already attached
  const playlist = video.dataset.playlist;
  if (!playlist) return;
  if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = playlist;
  } else if (Hls.isSupported()) {
    const hls = new Hls();
    hls.loadSource(playlist);
    hls.attachMedia(video);
    hlsByVideo.set(video, hls);
  } else {
    video.src = playlist;
  }
  video.play().catch(() => {});
}

function detachHls(video) {
  video.pause();
  const hls = hlsByVideo.get(video);
  if (hls) {
    hls.destroy();
    hlsByVideo.delete(video);
  }
  if (video.src) {
    video.removeAttribute('src');
    video.load();
  }
}

const videoVisibilityObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (entry.isIntersecting) attachHls(entry.target);
    else detachHls(entry.target);
  }
}, { rootMargin: '200px' });

function videoEl(embed) {
  // Inline auto-playing muted-looped <video>. HLS is attached only when in
  // view, and torn down when offscreen, so 50+ videos in the feed don't all
  // stream at once. Click opens the lightbox (with sound).
  const wrap = document.createElement('div');
  wrap.className = 'video-thumb';
  if (embed.aspectRatio) {
    wrap.style.aspectRatio = `${embed.aspectRatio.width} / ${embed.aspectRatio.height}`;
  }

  const video = document.createElement('video');
  video.muted = true;
  video.loop = true;
  video.playsInline = true;
  video.preload = 'none';
  video.poster = embed.thumbnail || '';
  video.dataset.playlist = embed.playlist;
  wrap.appendChild(video);

  wrap.style.cursor = 'zoom-in';
  wrap.addEventListener('click', () => {
    const fullVideo = createVideoEl(embed, { autoplay: true });
    openLightbox(fullVideo, embed.aspectRatio);
  });

  videoVisibilityObserver.observe(video);
  return wrap;
}

function youtubeEl(videoId, ext) {
  const aspectRatio = { width: 16, height: 9 };
  return makeVideoThumb({
    thumb: ext.thumb || `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
    alt: ext.title,
    aspectRatio,
    overlay: makeYouTubeOverlay(),
    onPlay: () => {
      const iframe = document.createElement('iframe');
      iframe.src = `https://www.youtube.com/embed/${videoId}?autoplay=1`;
      iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
      iframe.allowFullscreen = true;
      openLightbox(iframe, aspectRatio);
    },
  });
}

function externalEl(ext) {
  const uri = ext.uri || '';

  const yt = uri.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|shorts\/|embed\/))([\w-]{11})/);
  if (yt) {
    return { node: youtubeEl(yt[1], ext), kind: 'external' };
  }

  const isTenor = /(?:^|\.)tenor\.com\//.test(uri);
  const isGif = /\.gif(\?|$)/i.test(uri);
  if (isTenor || isGif) {
    const gifUrl = uri.replace(/\.(mp4|webm)(\?|$)/i, '.gif$2');
    const el = document.createElement('img');
    el.src = gifUrl;
    el.loading = 'lazy';
    el.alt = ext.title || '';
    return { node: el, kind: 'external' };
  }

  if (!ext.thumb && !ext.title) return null;
  const wrap = document.createElement('a');
  wrap.href = uri;
  wrap.target = '_blank';
  wrap.rel = 'noopener';
  wrap.style.color = 'inherit';
  wrap.style.textDecoration = 'none';
  if (ext.thumb) {
    const img = document.createElement('img');
    img.src = ext.thumb;
    img.loading = 'lazy';
    img.alt = ext.title || '';
    wrap.appendChild(img);
  }
  if (ext.title) {
    const t = document.createElement('div');
    t.style.padding = '0.5rem 0.75rem';
    t.style.fontSize = '0.85rem';
    t.textContent = ext.title;
    wrap.appendChild(t);
  }
  return { node: wrap, kind: 'linked' };
}
