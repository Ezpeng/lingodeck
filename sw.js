// ========== LingoDeck Service Worker ==========
// 缓存策略：HTML Network-first，数据文件 stale-while-revalidate，静态资源 Cache-first

// 每次发布新版本时递增，确保旧缓存被清理
const CACHE_VERSION = 'lingodeck-v4';

// 从 SW 自身 URL 推导部署根路径（支持子路径部署，如 GitHub Pages）
const BASE = self.location.pathname.replace(/sw\.js$/, '');

// 预缓存资源列表（App Shell + 数据）
const PRECACHE_URLS = [
  BASE,
  BASE + 'courses/',
  BASE + 'review/',
  BASE + 'profile/',
  BASE + 'learn/',
  BASE + 'data/catalog.json',
];

// ========== Install：预缓存 App Shell（逐个容错） ==========
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(async (cache) => {
      const results = await Promise.allSettled(
        PRECACHE_URLS.map((url) =>
          cache.add(url).catch((err) => {
            console.warn('[SW] precache skip:', url, err.message);
          })
        )
      );
      const failed = results.filter((r) => r.status === 'rejected');
      if (failed.length > 0) {
        console.warn('[SW] ' + failed.length + '/' + PRECACHE_URLS.length + ' precache URLs failed, continuing');
      }
    }).then(() => {
      // 跳过等待，立即激活
      return self.skipWaiting();
    })
  );
});

// ========== Activate：清理旧版缓存 ==========
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_VERSION)
          .map((name) => caches.delete(name))
      );
    }).then(() => {
      // 立即接管所有页面
      return self.clients.claim();
    })
  );
});

// ========== Fetch：分策略拦截请求 ==========
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // 仅处理同源请求
  if (url.origin !== location.origin) return;

  // API 请求：Network-only（不缓存）
  if (url.pathname.startsWith(BASE + 'api/')) return;

  // 数据文件（课程 JSON 等）：stale-while-revalidate（先返回缓存，后台刷新，新内容可推达老用户）
  if (url.pathname.includes('/data/')) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }

  // HTML 页面请求：Network-first
  if (request.mode === 'navigate' || request.headers.get('accept')?.includes('text/html')) {
    event.respondWith(networkFirst(request));
    return;
  }

  // 静态资源（JS/CSS/图片/字体）：Cache-first
  event.respondWith(cacheFirst(request));
});

// ========== 策略函数 ==========

/**
 * Network-first：在线取最新，失败用缓存
 */
async function networkFirst(request) {
  try {
    const response = await fetch(request);
    // 请求成功，更新缓存
    if (response.ok) {
      const cache = await caches.open(CACHE_VERSION);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    // 网络不可用，从缓存返回
    const cached = await caches.match(request);
    if (cached) return cached;
    // 未缓存过的页面离线时兜底到已缓存的首页（App Shell）
    const shell = await caches.match(BASE);
    if (shell) return shell;
    return new Response('离线状态，请检查网络连接', {
      status: 503,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
}

/**
 * Stale-while-revalidate：先返回缓存，同时后台请求最新并更新缓存
 */
async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_VERSION);
  const cached = await cache.match(request);
  const fetchPromise = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => cached);
  return cached || fetchPromise;
}

/**
 * Cache-first：优先缓存，未命中走网络
 */
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_VERSION);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    // 静态资源无缓存且离线
    return new Response('', { status: 408 });
  }
}
