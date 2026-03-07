self.addEventListener('install', (e) => {
    self.skipWaiting();
});

self.addEventListener('activate', (e) => {
    e.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (e) => {
    // Minimal fetch listener for PWA installability.
    // Falls back to network, and if offline, may fail gracefully.
    e.respondWith(
        fetch(e.request).catch(() => {
            return new Response("オフラインのため接続できませんでした。", {
                status: 503,
                statusText: "Service Unavailable",
                headers: new Headers({ "Content-Type": "text/plain; charset=utf-8" })
            });
        })
    );
});
