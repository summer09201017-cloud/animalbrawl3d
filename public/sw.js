/* Service Worker —— 網路優先、離線退快取。
   ★ 改了任何會上線的檔就要 bump 這個版號,否則使用者拿到舊快取。
   ⚠ 這裡刻意**不逐一列出 dist 的 hash 檔名**(vite 每次 build 都會變)——
     改成「安裝時只 precache 殼層,其餘 runtime 快取」,不然每次 build 都要手改清單,
     而漏改一次的症狀是「線上是新版、但某個 chunk 還是舊的」= 最難查的那種壞法。*/
const CACHE = 'animalbrawl3d-v2';   // v2:修 HUD/再來一場不顯示、加轉橫提示與版本號
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon.svg'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(req).then(r => r || caches.match('./index.html')))
  );
});
