const CACHE_NAME = 'mimic-cache-v5'; // v5 — исправленная стратегия

// Базовые файлы (кэшируем в первую очередь, стратегия Cache-First)
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/manifest.json',
  '/lib/tf.min.js',
  '/lib/body-pix.min.js',
  '/lib/face-api.js'
];

// Файлы моделей (тяжёлые, но статичные)
const MODEL_FILES = [
  '/models/tiny_face_detector_model-weights_manifest.json',
  '/models/tiny_face_detector_model-shard1',
  '/models/face_landmark_68_model-weights_manifest.json',
  '/models/face_landmark_68_model-shard1',
  '/models/face_expression_model-weights_manifest.json',
  '/models/face_expression_model-shard1',
  '/emotions/happy.jpg', '/emotions/happy2.jpg', '/emotions/happy3.jpg',
  '/emotions/happy4.jpg', '/emotions/happy5.jpg', '/emotions/happy6.jpg',
  '/emotions/sad.jpg', '/emotions/sad2.jpg', '/emotions/sad3.jpg',
  '/emotions/sad4.jpg', '/emotions/sad5.jpg', '/emotions/sad6.jpg',
  '/emotions/angry.jpg', '/emotions/angry2.jpg', '/emotions/angry3.jpg',
  '/emotions/angry4.jpg', '/emotions/angry5.jpg', '/emotions/angry6.jpg',
  '/emotions/surprised.jpg', '/emotions/surprised2.jpg', '/emotions/surprised3.jpg',
  '/emotions/surprised4.jpg', '/emotions/surprised5.jpg', '/emotions/surprised6.jpg',
  '/emotions/fearful.jpg', '/emotions/fearful2.jpg', '/emotions/fearful3.jpg',
  '/emotions/fearful4.jpg', '/emotions/fearful5.jpg', '/emotions/fearful6.jpg',
  '/emotions/disgusted.jpg', '/emotions/disgusted2.jpg', '/emotions/disgusted3.jpg',
  '/emotions/disgusted4.jpg', '/emotions/disgusted5.jpg', '/emotions/disgusted6.jpg'
];

// CDN (опционально, с игнорированием ошибок)
const CDN_LIBS = [
  'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.10.0/dist/tf.min.js',
  'https://cdn.jsdelivr.net/npm/@tensorflow-models/body-pix@2.2.1/dist/body-pix.min.js',
  'https://cdn.jsdelivr.net/npm/face-api.js@0.22.2/dist/face-api.min.js'
];

// Вспомогательная функция: безопасное клонирование ответа
function safeCloneResponse(response) {
  try {
    // Нельзя клонировать, если тело уже использовано или тип непрозрачный
    if (response.bodyUsed || response.type === 'opaque' || response.type === 'error') {
      return null;
    }
    return response.clone();
  } catch (e) {
    console.debug('Clone failed:', e);
    return null;
  }
}

// Вспомогательная функция: безопасное кеширование
async function safeCachePut(cache, request, response) {
  try {
    const clone = safeCloneResponse(response);
    if (clone) {
      await cache.put(request, clone);
      return true;
    }
    // Если клонировать не удалось, пробуем кешировать оригинал (если он ещё не использован)
    if (!response.bodyUsed && response.type === 'basic') {
      await cache.put(request, response);
      return true;
    }
  } catch (e) {
    console.debug('Cache put failed:', e);
  }
  return false;
}

// 1. Установка
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(async (cache) => {
        console.log('📦 Pre-caching...');
        
        // Объединяем все ресурсы
        const allResources = [...STATIC_ASSETS, ...MODEL_FILES];
        
        for (const url of allResources) {
          try {
            const response = await fetch(url, { cache: 'no-store' });
            if (response.ok && response.type === 'basic') {
              // Кешируем через безопасную функцию
              await safeCachePut(cache, url, response);
              console.log(`✅ Cached: ${url}`);
            }
          } catch (err) {
            console.warn(`⚠️ Failed to cache ${url}:`, err.message);
          }
        }
        
        console.log('✅ Pre-caching complete');
        self.skipWaiting();
      })
  );
});

// 2. Активация
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(names => 
      Promise.all(
        names.filter(name => name !== CACHE_NAME)
          .map(name => {
            console.log('🗑️ Deleting old cache:', name);
            return caches.delete(name);
          })
      )
    ).then(() => self.clients.claim())
  );
});

// 3. Обработка запросов
self.addEventListener('fetch', (event) => {
  // Игнорируем запросы с неподдерживаемыми схемами
  if (!event.request.url.startsWith('http')) {
    return;
  }
  // Не кешируем POST/PUT/DELETE и запросы с авторизацией
  if (event.request.method !== 'GET') {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      // Если есть в кеше -> отдаём сразу, параллельно обновляем кеш (Stale-While-Revalidate)
      if (cachedResponse) {
        // Обновляем кеш в фоне
        fetch(event.request)
          .then((networkRes) => {
            if (networkRes && networkRes.ok && networkRes.type === 'basic') {
              // Клонируем ДО того, как отдадим в cache.put()
              const responseToCache = networkRes.clone();
              caches.open(CACHE_NAME).then((cache) => {
                cache.put(event.request, responseToCache);
              });
            }
          })
          .catch(() => {}); // Тихо игнорируем ошибки фонового обновления
        return cachedResponse;
      }

      // Если нет в кеше -> идём в сеть
      return fetch(event.request).then((networkRes) => {
        // Проверяем, что ответ валиден и его можно кешировать
        if (networkRes && networkRes.ok && networkRes.type === 'basic') {
          try {
            // Клонируем перед использованием
            const responseToCache = networkRes.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, responseToCache);
            });
          } catch (e) {
            console.warn('⚠️ Could not cache response:', e);
          }
        }
        return networkRes;
      }).catch(() => {
        // Оффлайн-фоллбэк: только для навигации
        if (event.request.mode === 'navigate') {
          return caches.match('/index.html');
        }
        return new Response('', { status: 404, statusText: 'Not Found' });
      });
    })
  );
});

// 4. Мгновенное обновление
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});