const CACHE = 'familycall-v1';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
// Network first (so updates arrive immediately), cache as an offline fallback.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }))
  );
});

// "Ringing": the server pushes when the other person starts a call in our room.
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { /* plain text */ }
  e.waitUntil(self.registration.showNotification(d.title || '家庭通话', {
    body: d.body || '来电 · Incoming call',
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    tag: 'incoming-call',
    renotify: true,
    requireInteraction: true,
    vibrate: [600, 300, 600, 300, 600],
    data: { url: d.url || '/' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || '/', self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) {
      if ('focus' in c) {
        if ('navigate' in c) c.navigate(url).catch(() => {});
        return c.focus();
      }
    }
    return self.clients.openWindow(url);
  }));
});
