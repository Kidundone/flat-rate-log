const SW_VERSION = "2026-01-29-15-07-11";
const CACHE_NAME = `fr-cache-${SW_VERSION}`;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll([
    "./",
    "./index.html",
    "./more.html",
    "./app.f5603b3119.js",
    "./manifest.webmanifest",
    "./icon-192.png",
    "./icon-512.png"
  ])));
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)));
  })());
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);

  // Only handle our own origin. Never touch Supabase/CDNs.
  if (url.origin !== self.location.origin) return;

  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});
