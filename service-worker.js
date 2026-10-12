self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
// Network-only: map/routing data must not be presented as fresh when cached offline.
self.addEventListener('fetch', event => { if (event.request.method !== 'GET') return; });
