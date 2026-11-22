// Service worker de Sonora
// 1) Hace que la app abra al instante y funcione como app instalada.
// 2) Transmite el audio desde Google Drive en su calidad original: añade tu token a cada
//    petición y deja pasar las peticiones "Range" para que puedas adelantar la canción sin descargarla completa.

const VERSION = 'sonora-v1';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'icons.js', 'tags.js', 'demo.js', 'config.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION) await caches.delete(k);
    await self.clients.claim();
  })());
});

let TOKEN = null;
self.addEventListener('message', e => { if (e.data?.type === 'token') TOKEN = e.data.token; });

function tokenFromDB() {
  return new Promise(res => {
    const r = indexedDB.open('sonora', 1);
    r.onupgradeneeded = () => { const d = r.result; for (const s of ['kv', 'tags', 'covers']) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s); };
    r.onsuccess = () => {
      try { const g = r.result.transaction('kv').objectStore('kv').get('token'); g.onsuccess = () => res(g.result?.t || null); g.onerror = () => res(null); }
      catch { res(null); }
    };
    r.onerror = () => res(null);
  });
}

async function stream(id, req) {
  const go = token => {
    const h = new Headers({ Authorization: 'Bearer ' + token });
    const range = req.headers.get('range'); if (range) h.set('Range', range);
    return fetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media&supportsAllDrives=true`, { headers: h });
  };
  let token = TOKEN || (TOKEN = await tokenFromDB());
  let r = await go(token);
  if (r.status === 401) { const t2 = await tokenFromDB(); if (t2 && t2 !== token) { TOKEN = t2; r = await go(t2); } }
  return r;
}

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || e.request.method !== 'GET') return;
  const m = url.pathname.match(/\/stream\/([\w-]+)$/);
  if (m) { e.respondWith(stream(m[1], e.request)); return; }
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).then(r => { const c = r.clone(); caches.open(VERSION).then(ca => ca.put('index.html', c)); return r; })
      .catch(() => caches.match('index.html')));
    return;
  }
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(hit => {
    const net = fetch(e.request).then(r => { if (r.ok) { const c = r.clone(); caches.open(VERSION).then(ca => ca.put(e.request, c)); } return r; }).catch(() => hit);
    return hit || net;
  }));
});
