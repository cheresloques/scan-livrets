/* Cache hors ligne : l'appli fonctionne sans réseau, les envois Drive attendent le retour du réseau. */
const VERSION = 'scan-livrets-v1.7.1';
const SHELL = ['./', 'index.html', 'styles.css', 'config.js', 'app.js', 'vision-core.js', 'vision-worker.js',
  'lib/opencv.js', 'lib/jszip.min.js', 'lib/tesseract/tesseract.min.js', 'lib/tesseract/worker.min.js',
  'lib/tesseract/core/tesseract-core-simd-lstm.wasm.js', 'lib/tesseract/core/tesseract-core-lstm.wasm.js', 'lib/tesseract/lang/eng.traineddata.gz',
  'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== VERSION + '-ext').map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // jamais de cache pour Google (connexion, Drive)
  if (/googleapis\.com$|accounts\.google\.com$/.test(url.hostname) && !url.hostname.startsWith('fonts.')) return;
  if (url.origin === location.origin) {
    // code de l'appli : réseau d'abord (mises à jour), cache si hors ligne
    e.respondWith(fetch(e.request).then(r => {
      const copy = r.clone();
      caches.open(VERSION).then(c => c.put(e.request, copy));
      return r;
    }).catch(() => caches.match(e.request, { ignoreSearch: true })));
    return;
  }
  // bibliothèques externes (lecture du texte, polices, ZIP) : cache d'abord
  e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request).then(r => {
    if (r.ok || r.type === 'opaque') { const copy = r.clone(); caches.open(VERSION + '-ext').then(c => c.put(e.request, copy)); }
    return r;
  })));
});
