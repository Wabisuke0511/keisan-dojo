// ============================================================
//  Service Worker（network-first）
//  キャッシュ名は登録URLの ?v=（= index.html の APP.version）から作る。
//  → APP.version を上げるだけで新SWがインストールされ、古いキャッシュが消える。
//     このファイルは基本的に書き換え不要。CACHE_PREFIX はアプリごとに変える。教材ファイル(problems.js)も PRECACHE に入れてある
// ============================================================
const VERSION = new URL(self.location.href).searchParams.get('v') || 'dev';
const CACHE_PREFIX = 'keisan-';
const CACHE = CACHE_PREFIX + VERSION;

// オフライン起動に必要な最小セット（CDNは入れない。別オリジンは素通りさせる）
const PRECACHE = ['./', './index.html', './manifest.json', './problems.js', './icon-192.png', './icon-512.png', './apple-touch-icon.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // 1つでも欠けていると addAll 全体が失敗するので、1件ずつ追加して失敗を無視する
      .then((cache) => Promise.all(PRECACHE.map((u) => cache.add(u).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(() => self.clients.matchAll({ type: 'window' }))
      .then((clients) => clients.forEach((c) => c.postMessage({ type: 'SW_UPDATED', version: VERSION })))
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // GET以外（Supabaseへのinsert/upsert等）は触らない
  if (req.method !== 'GET') return;
  // 別オリジン（Supabase API・CDN）は素通り。APIの応答をキャッシュすると古い記録が出る
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        // 正常な同一オリジン応答だけ保存（404やエラー応答を保存しない）
        if (res && res.ok && res.type === 'basic') {
          const clone = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, clone)).catch(() => {});
        }
        return res;
      })
      .catch(() =>
        caches.match(req).then((hit) => {
          if (hit) return hit;
          if (req.mode === 'navigate') return caches.match('./index.html');   // オフラインの画面遷移はトップへ
          return Response.error();
        })
      )
  );
});
