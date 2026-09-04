/* ──────────────────────────────────────────────────────────────
   sw.js — 離線快取
   · App Shell（自家檔案）：安裝時預先快取，之後 cache-first
   · 導覽請求：network-first，離線時回退到快取的 index.html
   · 外部資源（字型、jsQR、Tesseract 語言模型）：用到才快取
   改版時記得把 VERSION 加一，舊快取會在啟用階段被清掉。
   ────────────────────────────────────────────────────────────── */
const VERSION = 'v5';
const SHELL_CACHE = 'financeapp-shell-' + VERSION;
const RUNTIME_CACHE = 'financeapp-runtime-' + VERSION;

const SHELL = [
  './',
  './index.html',
  './runtime.js',
  './app.js',
  './config.js',
  './sync.js',
  './boot.js',
  './vendor/chart.umd.min.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== SHELL_CACHE && k !== RUNTIME_CACHE)
            .map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  // Google 的登入與 API 一律直通網路：快取授權過的回應既無意義也不安全
  if (/(^|\.)(googleapis\.com|google\.com|gstatic\.com)$/.test(url.hostname)) return;

  // 導覽：優先拿新版，離線時退回快取
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((c) => c.put('./index.html', copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match('./index.html').then((r) => r || caches.match('./')))
    );
    return;
  }

  const sameOrigin = url.origin === self.location.origin;

  // 自家檔案：cache-first（安裝後即可完全離線）
  if (sameOrigin) {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      }))
    );
    return;
  }

  // 外部資源：先給快取，同時在背景更新
  event.respondWith(
    caches.open(RUNTIME_CACHE).then((cache) =>
      cache.match(req).then((hit) => {
        const network = fetch(req).then((res) => {
          // opaque 回應（no-cors）也存，字型與 wasm 才能離線使用
          if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone()).catch(() => {});
          return res;
        }).catch(() => hit);
        return hit || network;
      })
    )
  );
});
