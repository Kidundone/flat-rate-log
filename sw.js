const CACHE = "frlog-runtime"; // constant on purpose

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
  const req = event.request;
  const url = new URL(req.url);

  // Only handle same-origin requests
  if (url.origin !== self.location.origin) return;

  // Always network-first for HTML AND app.js so deploys show up without rituals
  const isHTML = req.mode === "navigate" || url.pathname.endsWith(".html");
  const isAppJS = url.pathname.endsWith("/app.js") || url.pathname.endsWith("app.js");

  if (isHTML || isAppJS) {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req, { cache: "no-store" });
        const cache = await caches.open(CACHE);
        cache.put(req, fresh.clone());
        return fresh;
      } catch {
        return (await caches.match(req)) || (await caches.match("./"));
      }
    })());
    return;
  }

  // Cache-first for everything else (fast)
  event.respondWith(
    caches.match(req).then((cached) => cached || fetch(req))
  );
});