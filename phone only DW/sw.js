/* DripWriter Phone Only — offline app shell + OCR assets. */
"use strict";
const CACHE = "dripwriter-phone-only-v1";
const SHELL = [
  "./", "./index.html", "./styles.css", "./theme.css", "./app.js", "./theme.js", "./manifest.webmanifest",
  "./icons/icon-192.png", "./icons/icon-512.png",
  "./ocr/tesseract.min.js", "./ocr/worker.min.js",
  "./ocr/core/tesseract-core-lstm.wasm.js",
  "./ocr/core/tesseract-core-simd-lstm.wasm.js",
  "./ocr/lang/eng.traineddata.gz"
];
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => Promise.allSettled(SHELL.map((u) => c.add(u)))));
  self.skipWaiting();
});
self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
    return res;
  })));
});
