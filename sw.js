const CACHE = "frlog-cache-v9"; // bump when you deploy changes
const SHELL = [
  "./",
  "./index.html",
  "./more.html",
  "./app.js",
  "./manifest.webmanifest",
  "./sw.js",
];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL))
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    // delete old caches so you don't get stuck on old builds
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));

    // take control immediately
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // only handle same-origin requests (avoid caching unpkg, etc)
  if (url.origin !== self.location.origin) return;

  // Network-first for navigations/HTML so updates show quickly
  if (event.request.mode === "navigate" || url.pathname.endsWith(".html")) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        const fresh = await fetch(event.request, { cache: "no-store" });
        cache.put(event.request, fresh.clone());
        return fresh;
      } catch {
        return (await cache.match(event.request)) || (await cache.match("./index.html")) || (await cache.match("./"));
      }
    })());
    return;
  }

  // Stale-while-revalidate for static assets
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(event.request);

    const fetchPromise = fetch(event.request).then((fresh) => {
      cache.put(event.request, fresh.clone());
      return fresh;
    }).catch(() => null);

    return cached || (await fetchPromise) || Response.error();
  })());
});