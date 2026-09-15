'use strict';

self.addEventListener('push', (event) => {
  let payload = {};
  try { payload = event.data?.json?.() || {}; } catch { payload = { body: event.data?.text?.() || '' }; }
  const route = payload.route === 'shifts' ? 'shifts' : 'team';
  event.waitUntil(self.registration.showNotification(payload.title || 'Atlas update', {
    body: payload.body || 'Open Atlas to review the update.',
    tag: payload.tag || `atlas-${route}`,
    renotify: Boolean(payload.renotify),
    data: { route, object_id: payload.object_id || null }
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const route = event.notification.data?.route === 'shifts' ? 'shifts' : 'team';
  const target = new URL(`./#${route}`, self.registration.scope).href;
  event.waitUntil((async () => {
    const windows = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find((client) => client.url.startsWith(self.registration.scope));
    if (existing) {
      await existing.navigate(target);
      return existing.focus();
    }
    return clients.openWindow(target);
  })());
});
