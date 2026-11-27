// Service worker de Sonora
// 1) Hace que la app abra al instante y funcione como app instalada.
// 2) Transmite el audio desde Google Drive en su calidad original: añade tu token a cada
//    petición y deja pasar las peticiones "Range" para que puedas adelantar la canción sin descargarla completa.

const VERSION = 'sonora-v10';
const AUDIO_CACHE = 'sonora-audio'; // descargas: nunca se borra al actualizar
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'icons.js', 'tags.js', 'demo.js', 'config.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('sonora-v') && k !== VERSION) await caches.delete(k);
    await self.clients.claim();
  })());
});

let TOKEN = null;
self.addEventListener('message', e => {
  if (e.data?.type === 'token') TOKEN = e.data.token;
  else if (e.data?.type === 'prefetch' && e.data.id) e.waitUntil(fullFetch(e.data.id));
});

/* Copia temporal de las canciones que suenan (y de la siguiente): la música sigue aunque se corte
   la conexión o venza el acceso a Google, y el navegador no corta streams largos. */
const TMP = 'sonora-tmp', TMP_MAX = 3, CHUNK = 4 * 1024 * 1024;
const tmpKey = id => new URL('tmp/' + id, self.registration.scope).href;
const inflight = new Map();
function fullFetch(id) {
  if (inflight.has(id)) return inflight.get(id);
  const p = (async () => {
    const c = await caches.open(TMP);
    if (await c.match(tmpKey(id))) return;
    const token = TOKEN || (TOKEN = await tokenFromDB()); if (!token) return;
    const r = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media&supportsAllDrives=true`, { headers: { Authorization: 'Bearer ' + token } });
    if (!r.ok) return;
    await c.put(tmpKey(id), new Response(r.body, { headers: { 'Content-Type': r.headers.get('content-type') || 'audio/mpeg' } }));
    const keys = await c.keys();
    for (let i = 0; i < keys.length - TMP_MAX; i++) await c.delete(keys[i]);
  })().catch(() => { }).finally(() => inflight.delete(id));
  inflight.set(id, p); return p;
}

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
  const type = new URL(req.url).searchParams.get('t') || res.headers.get('content-type') || 'audio/mpeg';
  const blob = await res.blob(); const size = blob.size;
  if (!range) return new Response(blob, { status: 200, headers: { 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes' } });
  const m = /bytes=(\d*)-(\d*)/.exec(range) || [];
  let start, end;
  if (m[1] === '' && m[2]) { start = Math.max(0, size - +m[2]); end = size - 1; }
  else { start = +m[1] || 0; end = m[2] ? Math.min(+m[2], size - 1) : size - 1; }
  if (start >= size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  return new Response(blob.slice(start, end + 1, type), { status: 206, headers: { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1), 'Accept-Ranges': 'bytes' } });
}

async function stream(id, req, e) {
  const u = new URL(req.url);
  const hit = await caches.match(u.origin + u.pathname); // busca en las descargas de cualquier perfil
  if (hit) return fromDownload(hit, req);
  const tmp = await (await caches.open(TMP)).match(tmpKey(id));
  if (tmp) return fromDownload(tmp, req);
  if (e && u.searchParams.get('p') !== '0') e.waitUntil(fullFetch(id)); // guarda la canción completa en segundo plano
  const go = token => {
    const h = new Headers({ Authorization: 'Bearer ' + token });
    let range = req.headers.get('range');
    // Pedir a Drive en trozos: cada respuesta termina rápido (los streams eternos los corta el navegador)
    const m = range && /^bytes=(\d+)-$/.exec(range.trim());
    if (m) range = `bytes=${m[1]}-${+m[1] + CHUNK - 1}`;
    if (range) h.set('Range', range);
    return fetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media&supportsAllDrives=true`, { headers: h });
  };
  let token = TOKEN || (TOKEN = await tokenFromDB());
  let r = await go(token);
  if (r.status === 401) { const t2 = await tokenFromDB(); if (t2 && t2 !== token) { TOKEN = t2; r = await go(t2); } }
  // iPhone (WebKit) no reproduce si el tipo llega como "application/octet-stream": se corrige con la extensión
  const want = u.searchParams.get('t') || '';
  if (r.ok && want && !/^(audio|video)\//.test(r.headers.get('content-type') || '')) {
    const h = new Headers(r.headers); h.set('Content-Type', want);
    return new Response(r.body, { status: r.status, statusText: r.statusText, headers: h });
  }
  return r;
}

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || e.request.method !== 'GET') return;
  const m = url.pathname.match(/\/stream\/([\w-]+)$/);
  if (m) { e.respondWith(stream(m[1], e.request, e)); return; }
  if (e.request.mode === 'navigate') {
    // La app abre al instante desde la copia guardada (aunque no haya internet o la red sea lenta)
    // y se actualiza en segundo plano para la próxima vez.
    e.respondWith((async () => {
      const cached = await caches.match('index.html') || await caches.match('./');
      const net = fetch(e.request, { cache: 'no-cache' }).then(r => { if (r.ok) { const c = r.clone(); caches.open(VERSION).then(ca => ca.put('index.html', c)); } return r; });
      if (cached) { e.waitUntil(net.catch(() => { })); return cached; }
      try { return await Promise.race([net, new Promise((_, rej) => setTimeout(() => rej(new Error('lento')), 6000))]); }
      catch { return (await caches.match('index.html')) || new Response('<h1>Sonora</h1><p>Sin conexión. Abre la app con internet una vez para poder usarla sin conexión.</p>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } }); }
    })());
    return;
  }
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(hit => {
    const net = fetch(e.request, { cache: 'no-cache' }).then(r => { if (r.ok) { const c = r.clone(); caches.open(VERSION).then(ca => ca.put(e.request, c)); } return r; }).catch(() => hit);
    return hit || net;
  }));
});
