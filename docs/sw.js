// ============================================================
// Service Worker — بيخلي الموقع يشتغل كتطبيق ويفتح آخر نسخة
// حتى لو النت فاصل. الاستراتيجية: الشبكة الأول (عشان التحديثات
// وكلمات السر توصل فوراً) والكاش احتياطي لو النت وقع.
// ============================================================
const CACHE = 'predictor-v6';
const SHELL = ['./', 'index.html', 'style.css', 'config.js', 'auth.js', 'engine.js', 'app.js', 'manifest.json', 'icon.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // بنكيّش ملفات موقعنا بس — بيانات ESPN دايماً من الشبكة مباشرة
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
