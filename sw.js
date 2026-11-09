// Prosty service worker: strona zawsze pobierana z sieci (świeże dane),
// a gdy nie ma internetu — pokazywana ostatnia zapisana wersja.
const CACHE = "armia-v4";
self.addEventListener("install", e => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(
  caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())
));
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  // Obrazki (strategie, herb, ikony) rzadko się zmieniają: najpierw z pamięci telefonu = natychmiast
  if (/\.(png|jpe?g|webp|gif|svg)$/i.test(new URL(req.url).pathname)) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {}); }
      return res;
    })));
    return;
  }
  e.respondWith(
    // cache: "no-cache" = zawsze pytaj serwer o najnowszą wersję (bez starej kopii z przeglądarki)
    fetch(req.url, { cache: "no-cache", credentials: "same-origin" }).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }))
  );
});
