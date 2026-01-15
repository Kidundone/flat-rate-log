const SW_VERSION = "2026-01-15-16-33-41";
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
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});
