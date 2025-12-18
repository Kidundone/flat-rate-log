const CACHE_VERSION = "v12"; // bump this every push
console.log("FRLOG BUILD", "2025-12-18-1");
const CACHE_NAME = `frlog-${CACHE_VERSION}`;
const ASSETS = [
  "./",
  "./index.html",
  "./more.html",
  "./app.js",
  "./manifest.webmanifest",
  "./sw.js"
];

// fast track new SW
self.addEventListener("install", (e) => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => (k === CACHE_NAME ? null : caches.delete(k))));
    await self.clients.claim();
  })());
});

// Multi-page safe fetch:
// - For navigations, try the actual page (more.html/index.html) from cache/network.
// - Only fall back to index.html if offline and the requested page isn't cached.
self.addEventListener("fetch", (event) => {
  const req = event.request;

  // Handle page navigations
  if (req.mode === "navigate") {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);

      // Try cached exact page first
      const cachedPage = await cache.match(req, { ignoreSearch: true });
      if (cachedPage) return cachedPage;

      // Try network, then cache it
      try {
        const fresh = await fetch(req);
        cache.put(req, fresh.clone()).catch(() => {});
        return fresh;
      } catch {
        // Offline fallback
        return (await cache.match("./index.html")) || Response.error();
      }
    })());
    return;
  }

  // For static assets: cache-first
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req);
    if (cached) return cached;
    try {
      const fresh = await fetch(req);
      cache.put(req, fresh.clone()).catch(() => {});
      return fresh;
    } catch {
      return cached || Response.error();
    }
  })());
});
