/* MicroViber service worker — notifications only (no API/token caching: NetworkOnly by omission). */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  if (!event.data) return;
  let p; try { p = event.data.json(); } catch { return; }
  if (p.type === 'dismiss' && p.tag) {
    event.waitUntil(self.registration.getNotifications({ tag: p.tag }).then((ns) => ns.forEach((n) => n.close())));
    return;
  }
  if (p.type === 'notify') {
    // icon/badge are REQUIRED, not decoration: with neither set, Android Chrome
    // renders the notification under its OWN logo, so a MicroViber push is
    // indistinguishable from any other Chrome notification on the lock screen
    // (found in real-device testing, 2026-09-07). icon is the large app image;
    // badge is the small monochrome status-bar glyph. Both are same-origin
    // manifest assets, so they are already cached by the install.
    event.waitUntil(self.registration.showNotification(p.title || 'Session idle', {
      body: p.body || '', tag: p.tag, renotify: false, data: { sessionId: p.sessionId },
      icon: '/icon-192.png', badge: '/icon-192.png',
    }));
  }
});

// Overtaken-by-events fallback: a dismiss can also arrive as a client message.
self.addEventListener('message', (event) => {
  const m = event.data;
  if (m && m.type === 'dismiss' && m.tag) {
    self.registration.getNotifications({ tag: m.tag }).then((ns) => ns.forEach((n) => n.close()));
  }
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const id = event.notification.data && event.notification.data.sessionId;
  event.waitUntil(self.clients.matchAll({ type: 'window' }).then((cs) => {
    for (const c of cs) { if ('focus' in c) { c.postMessage({ type: 'open-session', sessionId: id }); return c.focus(); } }
    return self.clients.openWindow('/?session=' + encodeURIComponent(id || ''));
  }));
});
