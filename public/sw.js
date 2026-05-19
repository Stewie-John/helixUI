// Service Worker — 透传模式（不缓存任何内容）
// 原因：本工具频繁重新构建，JS bundle hash 每次变化，
// 若缓存 index.html 会导致浏览器加载不存在的旧 bundle，超时 1-2 分钟。

// 安装时立即激活，清除所有旧缓存
self.addEventListener('install', () => {
  self.skipWaiting();
});

// 激活时清理所有历史缓存版本
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 不拦截任何 fetch 请求，全部走网络
// （不注册 fetch 事件监听器即可）
