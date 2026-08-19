// cache-first：同源 GET 請求優先吃快取，沒有命中才打網路並存入快取，離線時也能用。
// 換來的代價是「改了資料/圖示/程式碼後，使用者不會自動看到新版」——
// 所以每次部署有異動同源靜態資源時，都必須手動把 CACHE_VERSION 往上加一版，
// 讓下面的 activate 清掉舊快取。細節與判斷準則見 docs/CONTEXT.md「部署與快取版本」。
const CACHE_VERSION = 'v15';
const CACHE_NAME = `ffxiv-mit-${CACHE_VERSION}`;

self.addEventListener('install', () => {
    self.skipWaiting();
});

self.addEventListener('activate', e => {
    // 清空非目前版本的快取（保留 CACHE_NAME 本身），確保舊版資源不會殘留
    e.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', e => {
    const { request } = e;
    if (request.method !== 'GET') return;

    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return;

    e.respondWith(
        caches.match(request).then(cached => {
            if (cached) return cached;
            return fetch(request).then(res => {
                if (res.ok) {
                    const clone = res.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
                }
                return res;
            });
        })
    );
});
