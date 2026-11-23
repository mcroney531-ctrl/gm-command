const CACHE_NAME = 'gm-command-v3';
const STATIC_ASSETS = [
  '/index.html',
  '/manifest.json',
  '/dynasty_config.json',
  'https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Mono:wght@400;500&family=Figtree:wght@300;400;500;600;700&display=swap'
];

// Install — cache static assets
self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll(STATIC_ASSETS);
    })
  );
  self.skipWaiting();
});

// Activate — clean old caches
self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(key) { return key !== CACHE_NAME; })
            .map(function(key) { return caches.delete(key); })
      );
    })
  );
  self.clients.claim();
});

// Fetch — network first, fall back to cache
self.addEventListener('fetch', function(event) {
  // Always go network-first for API calls
  // The Report Cards API carries the user's intel and chat: never cache it,
  // or an offline load would replay a stale /intel as if it were live.
  if (event.request.url.includes('ddreportcards.onrender.com') ||
      event.request.url.includes('api.sleeper.app') ||
      event.request.url.includes('api.anthropic.com') ||
      event.request.url.includes('rotowire.com')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Network first, cache fallback for everything else
  event.respondWith(
    fetch(event.request)
      .then(function(response) {
        // Cache successful responses
        if (response && response.status === 200) {
          var clone = response.clone();
          caches.open(CACHE_NAME).then(function(cache) {
            cache.put(event.request, clone);
          });
        }
        return response;
      })
      .catch(function() {
        return caches.match(event.request);
      })
  );
});
