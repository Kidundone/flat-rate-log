const SW_VERSION = "2026-01-21-20-43-11";
const CACHE = "frlog-20260107a";

self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll([
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
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);

  // Only handle our own origin. Never touch Supabase/CDNs.
  if (url.origin !== self.location.origin) return;

  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});
