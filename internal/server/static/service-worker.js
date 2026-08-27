// v0.6.30 M3 minimal push service worker (Iris).
// Payload contract (docs/push/DESIGN.md red line, superior-approved):
//   { unread_count, from_name, digest? } — nothing else. No subject, no
//   body, no addresses: the push intermediary must not learn who mails whom.
// digest > 0 means a quiet-hours summary (single catch-up notification,
// server-side DND already held the individual ones back).
// Lives at /static/service-worker.js for now, so its scope doesn't cover
// the app pages: notificationclick opens a fresh tab instead of focusing.
// A root-scope route is a Devi follow-up; this changes nothing for push
// delivery, which wakes the registration regardless of scope.
const FALLBACK_URL = '/';

self.addEventListener('push', function (event) {
  var data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) {}
  var swLang = ((self.navigator && self.navigator.language) || '').toLowerCase();
  var zh = swLang.indexOf('zh') === 0;
  var title, body;
  if (data.digest > 0) {
    title = zh ? '静默期间的新信' : 'New mail during quiet hours';
    body = zh
      ? '免打扰期间收到 ' + data.digest + ' 封新信'
      : data.digest + ' new letter' + (data.digest > 1 ? 's' : '') + ' arrived while silenced';
  } else {
    var n = data.unread_count || 1;
    title = data.from_name || (zh ? '新信' : 'New mail');
    body = zh
      ? '收到 ' + n + ' 封新信 · 点按查看'
      : n + ' new letter' + (n > 1 ? 's' : '') + ' · tap to view';
  }
  event.waitUntil(self.registration.showNotification(title, {
    body: body,
    tag: 'moa-mail',
    data: { url: FALLBACK_URL },
  }));
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var url = (event.notification.data && event.notification.data.url) || FALLBACK_URL;
  event.waitUntil((async function () {
    var all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (var i = 0; i < all.length; i++) {
      if (all[i].url.indexOf(self.location.origin) === 0) {
        await all[i].focus();
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});
