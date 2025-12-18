/* sw.js — safe cache-first for static assets */

const CACHE_VERSION = 3; // bump this any time you change files
const CACHE_NAME = `frlog-cache-v${CACHE_VERSION}`;

const ASSETS = [
  "./",
  "./index.html",
  "./more.html",
  "./app.js",
  "./manifest.webmanifest",
  "./sw.js"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.map((k) => (k.startsWith("frlog-cache-") && k !== CACHE_NAME ? caches.delete(k) : null)))
    ).then(() => self.clients.claim())
  );
});

// cache-first for same-origin GET
self.addEventListener("fetch", (event) => {
  try {
    const req = event.request;
    if (req.method !== "GET") return;

    const url = new URL(req.url);

    // only handle same origin
    if (url.origin !== self.location.origin) return;

    event.respondWith(
      caches.match(req).then((hit) => {
        if (hit) return hit;
        return fetch(req).then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
          return res;
        });
      }).catch(() => fetch(req))
    );
  } catch (e) {
    // never brick navigation
    event.respondWith(fetch(event.request));
  }
});