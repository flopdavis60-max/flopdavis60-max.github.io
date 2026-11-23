// Service worker de Sonora
// 1) Hace que la app abra al instante y funcione como app instalada.
// 2) Transmite el audio desde Google Drive en su calidad original: añade tu token a cada
//    petición y deja pasar las peticiones "Range" para que puedas adelantar la canción sin descargarla completa.

const VERSION = 'sonora-v7';
const AUDIO_CACHE = 'sonora-audio'; // descargas: nunca se borra al actualizar
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'icons.js', 'tags.js', 'demo.js', 'config.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('sonora-v') && k !== VERSION) await caches.delete(k);
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

// Respuesta parcial (206) desde una canción descargada, para poder adelantar sin internet
async function fromDownload(res, req) {
  const range = req.headers.get('range');
  const type = res.headers.get('content-type') || 'audio/mpeg';
  const blob = await res.blob(); const size = blob.size;
  if (!range) return new Response(blob, { status: 200, headers: { 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes' } });
  const m = /bytes=(\d*)-(\d*)/.exec(range) || [];
  let start, end;
  if (m[1] === '' && m[2]) { start = Math.max(0, size - +m[2]); end = size - 1; }
  else { start = +m[1] || 0; end = m[2] ? Math.min(+m[2], size - 1) : size - 1; }
  if (start >= size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  return new Response(blob.slice(start, end + 1, type), { status: 206, headers: { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1), 'Accept-Ranges': 'bytes' } });
}

async function stream(id, req) {
  const u = new URL(req.url);
  const hit = await caches.match(u.origin + u.pathname); // busca en las descargas de cualquier perfil
  if (hit) return fromDownload(hit, req);
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
    // La app abre al instante desde la copia guardada (aunque no haya internet o la red sea lenta)
    // y se actualiza en segundo plano para la próxima vez.
    e.respondWith((async () => {
      const cached = await caches.match('index.html') || await caches.match('./');
      const net = fetch(e.request).then(r => { if (r.ok) { const c = r.clone(); caches.open(VERSION).then(ca => ca.put('index.html', c)); } return r; });
      if (cached) { e.waitUntil(net.catch(() => { })); return cached; }
      try { return await Promise.race([net, new Promise((_, rej) => setTimeout(() => rej(new Error('lento')), 6000))]); }
      catch { return (await caches.match('index.html')) || new Response('<h1>Sonora</h1><p>Sin conexión. Abre la app con internet una vez para poder usarla sin conexión.</p>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } }); }
    })());
    return;
  }
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(hit => {
    const net = fetch(e.request).then(r => { if (r.ok) { const c = r.clone(); caches.open(VERSION).then(ca => ca.put(e.request, c)); } return r; }).catch(() => hit);
    return hit || net;
  }));
});
