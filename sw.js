const CACHE = "frlog-cache-v8"; // bump to invalidate old runtime cache

const SHELL = [
  "./",
  "./index.html",
  "./more.html",
  "./manifest.webmanifest",
  "./sw.js",
];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Network-first for navigations/HTML so new builds show quickly
  if (event.request.mode === "navigate" || url.pathname.endsWith(".html")) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        const fresh = await fetch(event.request, { cache: "no-store" });
        cache.put(event.request, fresh.clone());
        return fresh;
      } catch {
        const cached = await cache.match(event.request);
        return cached || cache.match("./index.html") || caches.match("./");
      }
    })());
    return;
  }

  // Stale-while-revalidate for static assets (JS/CSS/etc)
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
