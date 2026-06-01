// 每次部署只要這個檔案內容有任何變動，瀏覽器就會偵測到新版 SW 並觸發更新流程
// 不需要特別維護 VERSION 常數，直接讓部署工具或 git 自然改動此檔即可

self.addEventListener('install', () => {
    self.skipWaiting();
});

self.addEventListener('activate', e => {
    // 清空所有舊快取，確保下次請求都從網路取得最新版
    e.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys.map(k => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

// network-first：HTML / JS / CSS 永遠先從網路取，失敗才用快取（離線備援）
self.addEventListener('fetch', e => {
    const { request } = e;
    if (request.method !== 'GET') return;

    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return;

    const path = url.pathname;
    if (
        path === '/' || path.endsWith('/') ||
        path.endsWith('.html') ||
        path.endsWith('.js') ||
        path.endsWith('.css')
    ) {
        e.respondWith(
            fetch(request, { cache: 'no-cache' })
                .catch(() => caches.match(request))
        );
    }
});
