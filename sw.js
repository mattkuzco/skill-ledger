// Service worker: app shell cache-first, fonts stale-while-revalidate,
// everything else (Supabase, Anthropic API) goes straight to the network.
// Bump VERSION whenever you change a file so installed apps pick up the update.

const VERSION = 'v7';
const SHELL = `skill-ledger-shell-${VERSION}`;
const FONTS = 'skill-ledger-fonts';

const FILES = [
  './', './index.html', './styles.css', './manifest.webmanifest',
  './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png', './icons/maskable-512.png', './icons/apple-touch-icon.png',
  './js/app.js', './js/router.js', './js/store.js', './js/sync.js', './js/srs.js', './js/ai.js', './js/md.js',
  './js/ui.js', './js/util.js', './js/seed.js', './js/attachments.js', './js/ink.js', './js/board.js',
  './js/views/home.js', './js/views/areas.js', './js/views/topic.js', './js/views/study.js', './js/views/log.js', './js/views/settings.js',
];

self.addEventListener('install', (e) => {
  // cache: 'reload' skips the browser's HTTP cache, so an update never re-caches old files
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('skill-ledger-shell-') && k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(caches.open(FONTS).then(async (c) => {
      const hit = await c.match(req);
      const net = fetch(req).then((res) => { if (res.ok || res.type === 'opaque') c.put(req, res.clone()); return res; }).catch(() => hit);
      return hit || net;
    }));
    return;
  }

  if (url.origin !== self.location.origin) return; // APIs: network only

  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) caches.open(SHELL).then((c) => c.put(req, res.clone()));
      return res;
    }).catch(() => (req.mode === 'navigate' ? caches.match('./index.html') : undefined))),
  );
});
