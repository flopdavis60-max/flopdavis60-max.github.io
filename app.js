import { ICONS } from './icons.js';
import { readTags, qualityOf } from './tags.js';
import { buildDemo, renderDemoAudio } from './demo.js';

/* =========================================================
   Utilidades
   ========================================================= */
const CFG = window.SONORA_CONFIG || {};
const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const API = 'https://www.googleapis.com/drive/v3/files';
const AUDIO_EXT = new Set(['mp3', 'flac', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wav', 'webm', 'mp4a']);
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const enc = encodeURIComponent;
const icon = n => `<i data-icon="${n}">${ICONS[n] || ''}</i>`;
const hydrate = (root = document) => $$('i[data-icon]', root).forEach(el => { if (!el.firstChild) el.innerHTML = ICONS[el.dataset.icon] || ''; });
const setIcon = (btn, n) => { const i = btn.querySelector('i'); if (i.dataset.icon !== n) { i.dataset.icon = n; i.innerHTML = ICONS[n]; } };
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
const hue = s => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const fmtTime = s => { if (!isFinite(s) || s < 0) s = 0; s = Math.floor(s); const m = Math.floor(s / 60), h = Math.floor(m / 60); return h ? `${h}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`; };
const fmtLong = s => { const m = Math.round(s / 60); return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`; };
const isMobile = () => matchMedia('(max-width:820px)').matches;
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
/* ---------- Perfiles: cada perfil guarda sus datos por separado ---------- */
const PROFILES = (() => {
  const read = k => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
  let list = read('sonora.profiles');
  if (!Array.isArray(list) || !list.length) {
    list = [{ id: 'p1', name: 'Principal', hue: 160 }];
    // migra datos de la versión anterior (sin perfiles) al perfil principal
    for (const k of Object.keys(localStorage)) if (k.startsWith('sonora.') && !k.startsWith('sonora.p.') && k !== 'sonora.profiles' && k !== 'sonora.profile') {
      localStorage.setItem('sonora.p.p1.' + k.slice(7), localStorage.getItem(k)); localStorage.removeItem(k);
    }
    localStorage.setItem('sonora.profiles', JSON.stringify(list));
  }
  let active = read('sonora.profile');
  if (!list.some(p => p.id === active)) { active = list[0].id; localStorage.setItem('sonora.profile', JSON.stringify(active)); }
  return { list, active };
})();
const PID = PROFILES.active;
const store = {
  key: k => `sonora.p.${PID}.${k}`,
  get(k, d) { try { const v = localStorage.getItem(this.key(k)); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(this.key(k), JSON.stringify(v)); } catch { } },
  del(k) { localStorage.removeItem(this.key(k)); },
};
const LIB_KEY = 'library:' + PID;
class AuthError extends Error { constructor() { super('auth'); } }

/* ---------- IndexedDB ---------- */
const idb = (() => {
  let dbp;
  const open = () => dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open('sonora', 1);
    r.onupgradeneeded = () => { const d = r.result; for (const s of ['kv', 'tags', 'covers']) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  const run = async (st, mode, fn) => { const d = await open(); return new Promise((res, rej) => { const t = d.transaction(st, mode); const q = fn(t.objectStore(st)); t.oncomplete = () => res(q?.result); t.onerror = () => rej(t.error); }); };
  return {
    get: (st, k) => run(st, 'readonly', s => s.get(k)),
    set: (st, k, v) => run(st, 'readwrite', s => s.put(v, k)),
    del: (st, k) => run(st, 'readwrite', s => s.delete(k)),
    clear: st => run(st, 'readwrite', s => s.clear()),
    async all(st) { const d = await open(); return new Promise((res, rej) => { const out = new Map(); const t = d.transaction(st); const c = t.objectStore(st).openCursor(); c.onsuccess = () => { const k = c.result; if (k) { out.set(k.key, k.value); k.continue(); } }; t.oncomplete = () => res(out); t.onerror = () => rej(t.error); }); },
  };
})();

/* ---------- Service worker (streaming) ---------- */
let swReady = Promise.resolve();
if ('serviceWorker' in navigator) {
  swReady = (async () => {
    await navigator.serviceWorker.register('sw.js');
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise(r => { navigator.serviceWorker.addEventListener('controllerchange', r, { once: true }); setTimeout(r, 3000); });
    if (auth.token) swPost({ type: 'token', token: auth.token });
  })().catch(e => console.warn('SW', e));
}
const swPost = m => navigator.serviceWorker?.controller?.postMessage(m);

/* =========================================================
   Autenticación con Google (Google Identity Services)
   ========================================================= */
const auth = {
  token: null, exp: 0,
  load() { const a = store.get('auth', null); if (a) { this.token = a.t; this.exp = a.e; } },
  valid() { return !!this.token && Date.now() < this.exp - 60000; },
  save() { const v = { t: this.token, e: this.exp }; store.set('auth', v); idb.set('kv', 'token', v).catch(() => { }); swPost({ type: 'token', token: this.token }); },
  waitGis() {
    return new Promise((res, rej) => {
      if (window.google?.accounts?.oauth2) return res();
      let n = 0; const t = setInterval(() => { if (window.google?.accounts?.oauth2) { clearInterval(t); res(); } else if (++n > 80) { clearInterval(t); rej(new Error('No se pudo cargar el inicio de sesión de Google. Revisa tu conexión.')); } }, 100);
    });
  },
  async request(prompt = '') {
    if (!CFG.GOOGLE_CLIENT_ID) throw new Error('Falta tu Client ID de Google en config.js (ver la guía).');
    await this.waitGis();
    return new Promise((res, rej) => {
      const client = google.accounts.oauth2.initTokenClient({
        client_id: CFG.GOOGLE_CLIENT_ID, scope: SCOPE, prompt,
        callback: r => {
          if (r.error) return rej(new Error(r.error_description || r.error));
          this.token = r.access_token; this.exp = Date.now() + (r.expires_in || 3600) * 1000; this.save(); res(this.token);
        },
        error_callback: e => rej(new Error(e?.type === 'popup_closed' ? 'Se cerró la ventana de Google.' : (e?.message || 'No se pudo iniciar sesión.'))),
      });
      client.requestAccessToken({ prompt });
    });
  },
  logout() {
    try { if (this.token && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(this.token, () => { }); } catch { }
    this.token = null; this.exp = 0; store.del('auth'); idb.del('kv', 'token').catch(() => { });
  },
};

/* =========================================================
   Google Drive
   ========================================================= */
async function gfetch(url, headers = {}) {
  if (!auth.valid()) throw new AuthError();
  const r = await fetch(url, { headers: { ...headers, Authorization: 'Bearer ' + auth.token } });
  if (r.status === 401) { auth.exp = 0; throw new AuthError(); }
  if (!r.ok) throw new Error('Drive respondió ' + r.status);
  return r;
}
async function listAll(q, fields) {
  const out = []; let pageToken = '';
  do {
    const p = new URLSearchParams({ q, fields: `nextPageToken,files(${fields})`, pageSize: '1000', includeItemsFromAllDrives: 'true', supportsAllDrives: 'true' });
    if (pageToken) p.set('pageToken', pageToken);
    const j = await (await gfetch(`${API}?${p}`)).json();
    out.push(...(j.files || [])); pageToken = j.nextPageToken;
  } while (pageToken);
  return out;
}
const fetchRange = async (id, a, b) => (await gfetch(`${API}/${id}?alt=media&supportsAllDrives=true`, { Range: `bytes=${a}-${b}` })).arrayBuffer();

/* =========================================================
   Estado de la biblioteca
   ========================================================= */
const L = { tracks: [], all: [], byId: new Map(), albums: new Map(), artists: new Map(), raw: null, ready: false };
const coverURLs = new Map();   // albumKey -> url
const coverColors = new Map(); // albumKey -> [r,g,b]
let liked = new Set(store.get('liked', []));
let mode = store.get('mode', null); // 'drive' | 'demo' | null
let playlists = store.get('playlists', []);
const savePlaylists = () => { store.set('playlists', playlists); renderSidebar(); };
let downloaded = new Set(store.get('dl', []));
const saveDl = () => store.set('dl', [...downloaded]);
const settings = { quality: store.get('quality', 'max'), dlQuality: store.get('dlQuality', 'max') };
const AUDIO_CACHE = 'sonora-audio-' + PID;
const streamUrl = id => new URL('stream/' + id, location.href).href.split('#')[0].split('?')[0];
const MIME = { flac: 'audio/flac', mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', webm: 'audio/webm' };

/* ---------- Carpeta de música: nombre o enlace de Drive ---------- */
function folderRule() {
  const raw = String(store.get('folder', '') || CFG.MUSIC_FOLDER || '').trim();
  const id = (raw.match(/folders\/([\w-]+)/) || raw.match(/[?&]id=([\w-]+)/) || raw.match(/^([\w-]{20,})$/) || [])[1];
  return id ? { id } : raw ? { name: norm(raw) } : {};
}

/* ---------- Calidad: elegir entre versiones duplicadas de una misma canción ---------- */
const qscore = t => {
  const lossless = ['FLAC', 'ALAC', 'WAV', 'AIFF'].includes(t.codec);
  return lossless ? 100000 + (t.bits || 16) * (t.sampleRate || 44100) / 1000 : (t.bitrate || (t.size && t.duration ? t.size * 8 / t.duration / 1000 : 128));
};
function variantFor(t, pref) {
  if (!t.variants || t.variants.length < 2) return t;
  return t.variants.reduce((a, b) => (pref === 'saver' ? qscore(b) < qscore(a) : qscore(b) > qscore(a)) ? b : a);
}
const dlVariant = t => (t.variants || [t]).find(v => downloaded.has(v.id));
const isDl = t => !!t && (t.demo ? false : !!dlVariant(t));

function trackFromFile(f, folders, rule = {}) {
  const ext = (f.fileExtension || f.name.split('.').pop() || '').toLowerCase();
  const base = f.name.replace(/\.[^.]+$/, '');
  const parent = folders.get(f.parents?.[0]);
  const gp = parent && folders.get(parent.parents?.[0]);
  const isRoot = x => !x || (rule.id && x.id === rule.id) || (rule.name && norm(x.name) === rule.name);
  let title = base.replace(/^\s*\d{1,3}\s*[-._)]\s*/, '').trim() || base;
  const trackNo = parseInt((base.match(/^\s*(\d{1,3})\s*[-._) ]/) || [])[1]) || 0;
  let artist = null;
  const m = title.match(/^(.+?)\s+-\s+(.+)$/); if (m) { artist = m[1].trim(); title = m[2].trim(); }
  return {
    id: f.id, file: f.name, ext, size: +f.size || 0, mod: f.modifiedTime, folderId: f.parents?.[0],
    title, artist: artist || (!isRoot(gp) ? gp.name : null) || 'Artista desconocido',
    album: !isRoot(parent) ? parent.name : 'Sin álbum', trackNo, disc: 1, codec: ext.toUpperCase(),
  };
}

function applyTags(t, g) {
  if (!g || g.failed) return;
  if (g.title) t.title = g.title;
  if (g.artist) t.artist = g.artist;
  if (g.album) t.album = g.album;
  if (g.albumArtist) t.albumArtist = g.albumArtist;
  if (g.track) t.trackNo = parseInt(g.track) || t.trackNo;
  if (g.disc) t.disc = parseInt(g.disc) || 1;
  if (g.year) t.year = String(g.year).slice(0, 4);
  for (const k of ['duration', 'codec', 'bits', 'sampleRate', 'bitrate', 'vbr', 'channels']) if (g[k] != null) t[k] = g[k];
}

function buildLibrary(allTracks) {
  const albums = new Map(), artists = new Map(), byId = new Map();
  // Agrupa versiones de la misma canción (p. ej. FLAC y MP3) y muestra solo la preferida
  const groups = new Map();
  for (const t of allTracks) {
    const q = qualityOf(t); t.qLong = q.long; t.qShort = q.short; t.lossless = q.lossless; t.hires = q.hires;
    delete t.variants; byId.set(t.id, t);
    const k = norm(t.albumArtist || t.artist) + '|' + norm(t.title);
    (groups.get(k) || groups.set(k, []).get(k)).push(t);
  }
  const tracks = [];
  for (const g of groups.values()) {
    if (g.length === 1 || g[0].demo) { tracks.push(...g); continue; }
    const primary = variantFor({ variants: g }, settings.quality);
    for (const v of g) v.variants = g;
    tracks.push(primary);
  }
  for (const t of tracks) {
    const aa = t.albumArtist || t.artist;
    t.albumKey = norm(aa) + '|' + norm(t.album);
    t.artistKey = norm(t.artist);
    byId.set(t.id, t);
    let al = albums.get(t.albumKey);
    if (!al) albums.set(t.albumKey, al = { key: t.albumKey, title: t.album, artist: aa, artistKey: norm(aa), year: t.year, tracks: [], mod: t.mod || '', folderId: t.folderId });
    al.tracks.push(t); if ((t.mod || '') > al.mod) al.mod = t.mod; if (!al.year && t.year) al.year = t.year;
    for (const [k, name] of [[t.artistKey, t.artist], [al.artistKey, aa]]) {
      let ar = artists.get(k); if (!ar) artists.set(k, ar = { key: k, name, tracks: new Set(), albums: new Set() });
      ar.albums.add(t.albumKey); if (k === t.artistKey) ar.tracks.add(t);
    }
  }
  for (const al of albums.values()) al.tracks.sort((a, b) => (a.disc - b.disc) || (a.trackNo - b.trackNo) || a.title.localeCompare(b.title));
  for (const ar of artists.values()) { ar.tracks = [...ar.tracks]; ar.albums = [...ar.albums].map(k => albums.get(k)).sort((a, b) => (b.year || '').localeCompare(a.year || '')); }
  for (const [k, ar] of artists) if (!ar.tracks.length && !ar.albums.length) artists.delete(k);
  L.tracks = tracks; L.all = allTracks; L.albums = albums; L.artists = artists; L.byId = byId; L.ready = true;
  if (P.queue.length) P.queue = P.queue.map(t => byId.get(t.id) || t);
}

const sortedAlbums = () => [...L.albums.values()].sort((a, b) => (b.mod || '').localeCompare(a.mod || ''));
const sortedArtists = () => [...L.artists.values()].sort((a, b) => b.tracks.length - a.tracks.length);
const artistCover = ar => (ar.albums.find(a => coverURLs.has(a.key)) || ar.albums[0])?.key || ar.key;

/* ---------- Portadas ---------- */
function setCover(key, blobOrUrl) {
  if (!key || coverURLs.has(key)) return;
  const url = typeof blobOrUrl === 'string' ? blobOrUrl : URL.createObjectURL(blobOrUrl);
  coverURLs.set(key, url);
  $$(`[data-cover="${CSS.escape(key)}"]`).forEach(el => { el.classList.remove('ph'); el.innerHTML = ''; el.style.backgroundImage = `url("${url}")`; });
  if (P.cur?.albumKey === key) updateNowPlaying();
}
function cv(key, cls = '', ph = 'album') {
  const u = coverURLs.get(key);
  if (u) return `<span class="cv ${cls}" data-cover="${esc(key)}" style="background-image:url(&quot;${u}&quot;)"></span>`;
  const h = hue(key);
  return `<span class="cv ph ${cls}" data-cover="${esc(key)}" style="background-image:linear-gradient(135deg,hsl(${h} 50% 40%),hsl(${(h + 50) % 360} 55% 20%))">${icon(ph)}</span>`;
}
const likedCover = (cls = '') => `<span class="cv ph ${cls}" style="background-image:linear-gradient(135deg,#4b2fd6,#2ee6a6)">${icon('heartFill')}</span>`;

async function colorOf(key) {
  if (coverColors.has(key)) return coverColors.get(key);
  const h = hue(key);
  const fallback = hslToRgb(h, .45, .32);
  const url = coverURLs.get(key);
  if (!url) return fallback;
  try {
    const img = new Image(); img.src = url; await img.decode();
    const c = document.createElement('canvas'); c.width = c.height = 24;
    const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0, 24, 24);
    const d = g.getImageData(0, 0, 24, 24).data;
    let best = null, bestScore = -1, r = 0, gg = 0, b = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) {
      r += d[i]; gg += d[i + 1]; b += d[i + 2]; n++;
      const mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]);
      const score = (mx - mn) * (mx > 40 && mx < 235 ? 1 : .3);
      if (score > bestScore) { bestScore = score; best = [d[i], d[i + 1], d[i + 2]]; }
    }
    const avg = [r / n, gg / n, b / n];
    let col = best && bestScore > 40 ? best.map((v, i) => v * .6 + avg[i] * .4) : avg;
    const mx = Math.max(...col); if (mx > 170) col = col.map(v => v * 170 / mx);
    if (mx < 60) col = col.map(v => v + 40);
    col = col.map(Math.round);
    coverColors.set(key, col); return col;
  } catch { return fallback; }
}
function hslToRgb(h, s, l) { const a = s * Math.min(l, 1 - l); const f = n => { const k = (n + h / 30) % 12; return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))); }; return [f(0), f(8), f(4)]; }

/* =========================================================
   Escaneo de Drive
   ========================================================= */
let scanning = false;
const scanEl = () => $('#scanStatus');
function setScan(txt) { const e = scanEl(); e.textContent = txt || ''; e.classList.toggle('on', !!txt); }

async function loadCachedLibrary() {
  const raw = await idb.get('kv', LIB_KEY).catch(() => null);
  if (!raw) return false;
  await materialize(raw, false);
  return true;
}

async function materialize(raw, readNew) {
  L.raw = raw;
  const folders = new Map(raw.folders.map(f => [f.id, f]));
  const rule = folderRule();
  const inRoot = id => {
    if (!rule.id && !rule.name) return true;
    let cur = id, guard = 0;
    while (cur && guard++ < 40) {
      if (rule.id && cur === rule.id) return true;
      const f = folders.get(cur); if (!f) return false;
      if (rule.name && norm(f.name) === rule.name) return true;
      cur = f.parents?.[0];
    }
    return false;
  };
  const tracks = raw.audio.filter(f => inRoot(f.parents?.[0])).map(f => trackFromFile(f, folders, rule));
  const cache = await idb.all('tags').catch(() => new Map());
  const todo = [];
  for (const t of tracks) { const c = cache.get(t.id); if (c && c.mod === t.mod) applyTags(t, c); else todo.push(t); }
  const covers = await idb.all('covers').catch(() => new Map());
  for (const [k, blob] of covers) setCover(k, blob);
  buildLibrary(tracks);
  rerender();
  if (readNew && todo.length) await enrich(todo, raw);
  if (readNew) await folderCovers(raw);
}

async function scanDrive() {
  if (scanning) return; scanning = true;
  try {
    setScan('Buscando tu música en Drive…'); updateScanBtn();
    const rule = folderRule();
    const [folders, audio, images] = rule.id ? await scanFolderTree(rule.id) : await Promise.all([
      listAll("mimeType='application/vnd.google-apps.folder' and trashed=false", 'id,name,parents'),
      listAll("trashed=false and (mimeType contains 'audio/' or name contains '.flac' or name contains '.m4a' or name contains '.opus')", 'id,name,mimeType,size,parents,modifiedTime,fileExtension'),
      listAll("trashed=false and mimeType contains 'image/' and (name contains 'cover' or name contains 'folder' or name contains 'front' or name contains 'portada' or name contains 'album')", 'id,name,parents'),
    ]);
    const raw = {
      folders,
      audio: audio.filter(f => AUDIO_EXT.has((f.fileExtension || f.name.split('.').pop() || '').toLowerCase())),
      images, at: Date.now(),
    };
    await idb.set('kv', LIB_KEY, raw).catch(() => { });
    await materialize(raw, true);
    setScan('');
    if (!L.tracks.length) toast('No encontramos música en tu Drive. Sube MP3 o FLAC y vuelve a escanear.');
  } catch (e) {
    setScan('');
    if (e instanceof AuthError) askReconnect('Tu sesión de Google expiró.');
    else { console.error(e); toast('Error al leer Drive: ' + e.message); }
  } finally { scanning = false; updateScanBtn(); }
}

// Recorre solo la carpeta elegida y sus subcarpetas (funciona también con carpetas que otra persona compartió contigo)
async function scanFolderTree(rootId) {
  const root = await (await gfetch(`${API}/${rootId}?fields=id,name&supportsAllDrives=true`)).json();
  const folders = [{ id: root.id, name: root.name }], audio = [], images = [];
  let pending = [root.id];
  while (pending.length) {
    const batch = pending.splice(0, 25);
    const q = `(${batch.map(id => `'${id}' in parents`).join(' or ')}) and trashed=false`;
    const files = await listAll(q, 'id,name,mimeType,size,parents,modifiedTime,fileExtension');
    for (const f of files) {
      if (f.mimeType === 'application/vnd.google-apps.folder') { folders.push(f); pending.push(f.id); }
      else if (f.mimeType?.startsWith('image/')) images.push(f);
      else audio.push(f);
    }
    setScan(`Buscando tu música… ${audio.length} archivos`);
  }
  return [folders, audio, images];
}
function updateScanBtn() { $('#btnScan')?.classList.toggle('spin', scanning); }
async function manualScan() {
  if (mode === 'demo') return toast('En la demo no hay nada que escanear. Conecta tu Drive.');
  if (scanning) return toast('Ya estoy escaneando…');
  if (!navigator.onLine) return toast('Necesitas internet para escanear.');
  if (!auth.valid()) { try { await auth.request(''); } catch (e) { return toast(e.message); } }
  toast('Buscando canciones nuevas…'); scanDrive();
}

async function enrich(todo, raw) {
  const total = todo.length; let done = 0; let stop = false;
  const reRender = debounce(() => { buildLibrary(L.all); rerender(true); }, 900);
  const worker = async () => {
    while (todo.length && !stop) {
      const t = todo.shift();
      try {
        const g = await readTags({ size: t.size, ext: t.ext, fetchRange: (a, b) => fetchRange(t.id, a, b) });
        const pic = g.picture; delete g.picture;
        const rec = { ...g, mod: t.mod };
        applyTags(t, rec);
        if (pic) {
          const aa = t.albumArtist || t.artist; const key = norm(aa) + '|' + norm(t.album);
          if (!coverURLs.has(key)) { const blob = new Blob([pic.data], { type: pic.mime }); idb.set('covers', key, blob).catch(() => { }); setCover(key, blob); }
        }
        idb.set('tags', t.id, rec).catch(() => { });
      } catch (e) {
        if (e instanceof AuthError) { stop = true; askReconnect('Tu sesión de Google expiró.'); break; }
        idb.set('tags', t.id, { mod: t.mod, failed: true }).catch(() => { });
      }
      done++; setScan(`Leyendo tu música ${done}/${total}`); reRender();
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  buildLibrary(L.all); rerender(true); setScan('');
}

async function folderCovers(raw) {
  const pref = n => /^(cover|folder|front|portada)\./i.test(n) ? 0 : 1;
  const byFolder = new Map();
  for (const im of raw.images) { const p = im.parents?.[0]; if (!p) continue; const cur = byFolder.get(p); if (!cur || pref(im.name) < pref(cur.name)) byFolder.set(p, im); }
  const need = [...L.albums.values()].filter(a => !coverURLs.has(a.key) && byFolder.has(a.folderId));
  for (const al of need) {
    try {
      const blob = await (await gfetch(`${API}/${byFolder.get(al.folderId).id}?alt=media&supportsAllDrives=true`)).blob();
      idb.set('covers', al.key, blob).catch(() => { }); setCover(al.key, blob);
    } catch (e) { if (e instanceof AuthError) break; }
  }
}

/* =========================================================
   Reproductor
   ========================================================= */
const audio = $('#audio');
const P = { queue: [], order: [], pos: -1, shuffle: store.get('shuffle', false), repeat: store.get('repeat', 'off'), ctx: '', cur: null, needsLoad: false, resumeAt: 0 };

function buildOrder(start) {
  const idx = P.queue.map((_, i) => i);
  if (P.shuffle) {
    const rest = idx.filter(i => i !== start);
    for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; }
    P.order = start >= 0 ? [start, ...rest] : rest; P.pos = 0;
  } else { P.order = idx; P.pos = Math.max(0, start); }
}

function playList(list, start = 0, ctx = '') {
  if (!list.length) return;
  P.queue = list.slice(); P.ctx = ctx;
  buildOrder(start);
  loadCurrent(true);
}

async function loadCurrent(autoplay, at = 0, hops = 0) {
  const t = P.queue[P.order[P.pos]]; if (!t) return;
  // Sin internet: salta a la siguiente canción descargada
  if (!t.demo && !navigator.onLine && !isDl(t)) {
    for (let k = P.pos + 1; k < P.order.length; k++) if (isDl(P.queue[P.order[k]])) { P.pos = k; return loadCurrent(autoplay, 0, hops + 1); }
    toast('Sin conexión: esta canción no está descargada.');
    if (!hops) return;
  }
  const v = t.demo ? t : (dlVariant(t) || variantFor(t, settings.quality));
  P.cur = t; P.playing = v; P.needsLoad = false;
  updateNowPlaying(); markPlaying(); renderQueue(); saveSession();
  if (P.ctx.startsWith('album:')) pushRecent(P.ctx.slice(6));
  try {
    let src;
    if (t.demo) src = await renderDemoAudio(t);
    else if (downloaded.has(v.id)) {
      await swReady;
      if (navigator.serviceWorker?.controller) src = `stream/${v.id}`;
      else { const r = await (await caches.open(AUDIO_CACHE)).match(streamUrl(v.id)); src = URL.createObjectURL(await r.blob()); }
    } else {
      if (!auth.valid()) { try { await auth.request(''); } catch { P.needsLoad = true; askReconnect('Conéctate a Google para reproducir.'); return; } }
      await swReady;
      if (navigator.serviceWorker?.controller) { swPost({ type: 'token', token: auth.token }); src = `stream/${v.id}`; }
      else src = URL.createObjectURL(await (await gfetch(`${API}/${v.id}?alt=media&supportsAllDrives=true`)).blob());
    }
    if (P.cur !== t) return; // el usuario cambió de canción mientras cargaba
    if (audio.dataset.blob) { URL.revokeObjectURL(audio.dataset.blob); delete audio.dataset.blob; }
    if (src.startsWith('blob:') && !t.demo) audio.dataset.blob = src;
    audio.src = src;
    if (at) audio.currentTime = at;
    if (autoplay) await audio.play().catch(e => { if (e.name !== 'AbortError') console.warn(e); });
    const nx = P.queue[P.order[P.pos + 1]];
    if (nx?.demo) setTimeout(() => renderDemoAudio(nx), 400); // prepara la siguiente
  } catch (e) {
    if (e instanceof AuthError) askReconnect('Tu sesión de Google expiró.');
    else toast('No se pudo cargar la canción.');
  }
}

function togglePlay() {
  if (!P.cur) { const list = L.tracks.length ? L.tracks : []; if (list.length) playList(shuffled(list), 0, 'mix'); return; }
  if (P.needsLoad) return loadCurrent(true, P.resumeAt);
  audio.paused ? audio.play().catch(() => { }) : audio.pause();
}
function next(auto = false) {
  if (!P.queue.length) return;
  if (auto && P.repeat === 'one') { audio.currentTime = 0; audio.play(); return; }
  if (P.pos + 1 >= P.order.length) {
    if (P.repeat === 'all' || !auto) { if (P.shuffle) buildOrder(-1); P.pos = 0; }
    else { audio.pause(); audio.currentTime = 0; return; }
  } else P.pos++;
  loadCurrent(true);
}
function prev() {
  if (!P.queue.length) return;
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  P.pos = Math.max(0, P.pos - 1); loadCurrent(true);
}
function toggleShuffle() {
  P.shuffle = !P.shuffle; store.set('shuffle', P.shuffle);
  if (P.queue.length) { const cur = P.order[P.pos]; buildOrder(cur); }
  updateModes(); renderQueue();
}
function cycleRepeat() { P.repeat = { off: 'all', all: 'one', one: 'off' }[P.repeat]; store.set('repeat', P.repeat); updateModes(); }
const shuffled = a => { const b = a.slice(); for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };

function saveSession() {
  if (!P.cur) return;
  store.set('session', { ids: P.queue.map(t => t.id), order: P.order, pos: P.pos, ctx: P.ctx, t: audio.currentTime || 0, mode });
}
function restoreSession() {
  const s = store.get('session', null);
  if (!s || s.mode !== mode || P.cur) return;
  const q = s.ids.map(id => L.byId.get(id)).filter(Boolean);
  if (q.length !== s.ids.length || !q.length) return;
  P.queue = q; P.order = s.order; P.pos = s.pos; P.ctx = s.ctx; P.cur = q[P.order[P.pos]];
  P.needsLoad = true; P.resumeAt = s.t || 0;
  updateNowPlaying(); markPlaying(); renderQueue();
  setProgress(P.resumeAt, P.cur?.duration || 0);
}
function pushRecent(key) { const r = store.get('recent', []).filter(k => k !== key); r.unshift(key); store.set('recent', r.slice(0, 20)); }

/* ---------- Eventos del audio ---------- */
let lastPosState = 0;
audio.addEventListener('timeupdate', () => {
  setProgress(audio.currentTime, audio.duration || P.cur?.duration || 0);
  const now = Date.now();
  if (now - lastPosState > 4000) { lastPosState = now; saveSession(); updatePositionState(); }
});
audio.addEventListener('loadedmetadata', () => {
  const t = P.cur; if (t && isFinite(audio.duration) && (!t.duration || Math.abs(t.duration - audio.duration) > 2)) { t.duration = audio.duration; }
  updatePositionState();
});
audio.addEventListener('play', updatePlayState);
audio.addEventListener('pause', updatePlayState);
audio.addEventListener('ended', () => next(true));
audio.addEventListener('error', () => {
  if (!audio.src || P.cur?.demo) return;
  if (!auth.valid()) { P.needsLoad = true; P.resumeAt = audio.currentTime; askReconnect('Tu sesión de Google expiró.'); return; }
  const code = audio.error?.code;
  toast(code === 4 ? 'Este formato no se puede reproducir en este dispositivo. Saltando…' : 'Error al reproducir. Saltando…');
  setTimeout(() => next(true), 1500);
});

/* ---------- Media Session (controles en la pantalla bloqueada / notificación) ---------- */
function updateMediaSession() {
  if (!('mediaSession' in navigator) || !P.cur) return;
  const t = P.cur; const art = coverURLs.get(t.albumKey);
  navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artist, album: t.album, artwork: art ? [{ src: art, sizes: '512x512' }] : [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }] });
}
function updatePositionState() {
  try { if ('mediaSession' in navigator && isFinite(audio.duration)) navigator.mediaSession.setPositionState({ duration: audio.duration, position: Math.min(audio.currentTime, audio.duration), playbackRate: audio.playbackRate }); } catch { }
}
if ('mediaSession' in navigator) {
  const ms = navigator.mediaSession;
  const h = (a, f) => { try { ms.setActionHandler(a, f); } catch { } };
  h('play', () => togglePlay()); h('pause', () => audio.pause());
  h('previoustrack', prev); h('nexttrack', () => next());
  h('seekto', d => { audio.currentTime = d.seekTime; updatePositionState(); });
  h('seekbackward', d => { audio.currentTime = Math.max(0, audio.currentTime - (d.seekOffset || 10)); });
  h('seekforward', d => { audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + (d.seekOffset || 10)); });
}

/* =========================================================
   UI del reproductor
   ========================================================= */
function makeSlider(el, { onInput, onCommit }) {
  const fill = el.querySelector('.slider-fill'), knob = el.querySelector('.slider-knob');
  const api = {
    dragging: false,
    set(f) { f = Math.max(0, Math.min(1, f || 0)); fill.style.width = f * 100 + '%'; knob.style.left = f * 100 + '%'; },
  };
  const frac = e => { const r = el.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); };
  el.addEventListener('pointerdown', e => {
    api.dragging = true; el.classList.add('drag'); el.setPointerCapture(e.pointerId);
    const f = frac(e); api.set(f); onInput?.(f);
    const move = ev => { const f2 = frac(ev); api.set(f2); onInput?.(f2); };
    const up = ev => { api.dragging = false; el.classList.remove('drag'); el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); onCommit?.(frac(ev)); };
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
  });
  return api;
}
const dur = () => (isFinite(audio.duration) && audio.duration) || P.cur?.duration || 0;
const seekS = makeSlider($('#seek'), { onInput: f => { $('#tCur').textContent = fmtTime(f * dur()); }, onCommit: f => seekTo(f) });
const fpSeekS = makeSlider($('#fpSeek'), { onInput: f => { $('#fpCur').textContent = fmtTime(f * dur()); }, onCommit: f => seekTo(f) });
const volS = makeSlider($('#vol'), { onInput: f => setVolume(f), onCommit: f => setVolume(f) });
function seekTo(f) {
  const d = dur(); if (!d) return;
  if (P.needsLoad) { P.resumeAt = f * d; return loadCurrent(true, f * d); }
  audio.currentTime = f * d; updatePositionState();
}
function setVolume(v) { audio.volume = v; audio.muted = false; store.set('vol', v); updateVolume(); }
function updateVolume() { const v = audio.muted ? 0 : audio.volume; volS.set(v); setIcon($('#btnMute'), v === 0 ? 'volumeOff' : 'volume'); }

function setProgress(cur, d) {
  const f = d ? cur / d : 0;
  if (!seekS.dragging) { seekS.set(f); $('#tCur').textContent = fmtTime(cur); }
  if (!fpSeekS.dragging) { fpSeekS.set(f); $('#fpCur').textContent = fmtTime(cur); }
  $('#tDur').textContent = fmtTime(d); $('#fpDur').textContent = fmtTime(d);
  $('#miniProgress').style.width = f * 100 + '%';
}
function updatePlayState() {
  const playing = !audio.paused;
  for (const b of ['#btnPlay', '#btnPlayMini', '#fpPlay']) setIcon($(b), playing ? 'pause' : 'play');
  document.body.classList.toggle('paused', !playing);
  $$('[data-play-btn]').forEach(b => setIcon(b, playing && P.ctx === b.dataset.playBtn ? 'pause' : 'play'));
}
function updateModes() {
  for (const b of ['#btnShuffle', '#fpShuffle']) $(b).classList.toggle('on', P.shuffle);
  for (const b of ['#btnRepeat', '#fpRepeat']) { $(b).classList.toggle('on', P.repeat !== 'off'); setIcon($(b), P.repeat === 'one' ? 'repeatOne' : 'repeat'); }
}
async function updateNowPlaying() {
  const t = P.cur; const pl = $('#player');
  if (!t) { pl.classList.add('hidden'); return; }
  pl.classList.remove('hidden');
  const u = coverURLs.get(t.albumKey);
  const bg = u ? `url("${u}")` : `linear-gradient(135deg,hsl(${hue(t.albumKey)} 50% 40%),hsl(${(hue(t.albumKey) + 50) % 360} 55% 20%))`;
  $('#plCover').style.backgroundImage = bg; $('#fpCover').style.backgroundImage = bg;
  $('#plTitle').innerHTML = `<a data-href="#/album/${enc(t.albumKey)}">${esc(t.title)}</a>`;
  $('#plArtist').innerHTML = `<a data-href="#/artist/${enc(t.artistKey)}">${esc(t.artist)}</a>`;
  $('#fpTitle').textContent = t.title; $('#fpArtist').textContent = t.artist;
  const qv = P.playing || t;
  $('#plQuality').textContent = qv.lossless ? (qv.hires ? 'HI-RES' : 'LOSSLESS') : (qv.qShort || '');
  $('#plQuality').title = qv.qLong || '';
  $('#fpQuality').textContent = (qv.hires ? 'HI-RES · ' : qv.lossless ? 'LOSSLESS · ' : '') + (qv.qLong || '') + (isDl(t) ? ' · DESCARGADA' : '');
  $('#fpFrom').textContent = P.ctx.startsWith('album:') ? t.album : P.ctx.startsWith('artist:') ? t.artist : P.ctx === 'liked' ? 'Tus me gusta' : P.ctx.startsWith('playlist:') ? (playlists.find(p => 'playlist:' + p.id === P.ctx)?.name || 'Lista') : P.ctx === 'downloads' ? 'Descargas' : 'Tu biblioteca';
  updateLikeButtons(); updateMediaSession();
  document.title = `${t.title} · ${t.artist}`;
  const c = await colorOf(t.albumKey);
  if (P.cur !== t) return;
  $('#fpBg').style.background = `linear-gradient(rgb(${c}) 0%, rgb(${c.map(v => v * .45 | 0)}) 55%, #0c0c0f 100%)`;
  pl.style.setProperty('--mini-bg', `rgb(${c.map(v => v * .62 | 0)})`);
}
function markPlaying() { $$('.tr').forEach(r => r.classList.toggle('playing', r.dataset.id === P.cur?.id)); updatePlayState(); }

/* ---------- Me gusta ---------- */
function toggleLike(id) {
  liked.has(id) ? liked.delete(id) : liked.add(id);
  store.set('liked', [...liked]);
  const on = liked.has(id);
  $$(`[data-like="${CSS.escape(id)}"]`).forEach(b => { b.classList.toggle('on', on); setIcon(b, on ? 'heartFill' : 'heart'); });
  updateLikeButtons(); renderSidebar();
  toast(on ? 'Agregada a Tus me gusta' : 'Eliminada de Tus me gusta');
  if (route.name === 'liked') rerender(true);
}
function updateLikeButtons() {
  const on = P.cur && liked.has(P.cur.id);
  for (const b of ['#plLike', '#fpLike']) { $(b).classList.toggle('on', !!on); setIcon($(b), on ? 'heartFill' : 'heart'); }
}

/* =========================================================
   Descargas (escuchar sin internet)
   ========================================================= */
const DL = { queue: [], running: false, cur: null, pct: 0, done: 0, total: 0 };
function ctxList(ctx) {
  if (ctx.startsWith('album:')) return L.albums.get(ctx.slice(6))?.tracks || [];
  if (ctx.startsWith('artist:')) return L.artists.get(ctx.slice(7))?.tracks || [];
  if (ctx.startsWith('playlist:')) return plTracks(playlists.find(p => p.id === ctx.slice(9)));
  if (ctx.startsWith('track:')) return [L.byId.get(ctx.slice(6))].filter(Boolean);
  if (ctx === 'liked') return [...liked].map(id => L.byId.get(id)).filter(Boolean).reverse();
  if (ctx === 'downloads') return L.tracks.filter(isDl);
  if (ctx === 'all') return L.tracks;
  return [];
}
async function downloadTracks(list) {
  if (mode === 'demo') return toast('En la demo no hay descargas. Conecta tu Drive para descargar tu música.');
  const todo = list.filter(t => !isDl(t)).map(t => variantFor(t, settings.dlQuality)).filter(v => !DL.queue.includes(v));
  if (!todo.length) return toast('Ya está todo descargado.');
  if (!navigator.onLine) return toast('Necesitas internet para descargar.');
  if (!auth.valid()) { try { await auth.request(''); } catch { return askReconnect('Conéctate a Google para descargar.'); } }
  try { await navigator.storage?.persist?.(); } catch { }
  DL.queue.push(...todo); DL.total += todo.length;
  toast(`Descargando ${todo.length} ${todo.length === 1 ? 'canción' : 'canciones'}…`);
  runDownloads();
}
async function runDownloads() {
  if (DL.running) return; DL.running = true;
  const cache = await caches.open(AUDIO_CACHE);
  while (DL.queue.length) {
    const t = DL.queue[0]; DL.cur = t; DL.pct = 0; updateDlStatus();
    try {
      const r = await gfetch(`${API}/${t.id}?alt=media&supportsAllDrives=true`);
      const total = +r.headers.get('content-length') || t.size || 0; let got = 0, last = 0;
      const counted = r.body.pipeThrough(new TransformStream({ transform(chunk, c) { got += chunk.length; const now = Date.now(); if (now - last > 300) { last = now; DL.pct = total ? got / total : 0; updateDlStatus(); } c.enqueue(chunk); } }));
      const type = MIME[t.ext] || r.headers.get('content-type') || 'audio/mpeg';
      await cache.put(new Request(streamUrl(t.id)), new Response(counted, { headers: { 'Content-Type': type, 'Content-Length': String(total) } }));
      downloaded.add(t.id); saveDl(); refreshDlMarks();
    } catch (e) {
      if (e instanceof AuthError) { askReconnect('Tu sesión expiró. Reconecta para seguir descargando.'); DL.queue.length = 0; break; }
      toast('No se pudo descargar: ' + t.title);
    }
    DL.queue.shift(); DL.done++;
  }
  DL.running = false; DL.cur = null; DL.done = DL.total = 0; updateDlStatus();
  if (route.name === 'library') rerender(true);
}
function updateDlStatus() {
  if (DL.running && DL.cur) setScan(`Descargando ${DL.done + 1}/${DL.total} · ${Math.round(DL.pct * 100)}%`);
  else if (!scanning) setScan('');
}
async function removeDownloads(list) {
  const cache = await caches.open(AUDIO_CACHE);
  for (const t of list) for (const v of (t.variants || [t])) if (downloaded.has(v.id)) { await cache.delete(streamUrl(v.id)); downloaded.delete(v.id); }
  saveDl(); refreshDlMarks();
}
async function toggleDownload(ctx) {
  const list = ctxList(ctx); if (!list.length) return;
  if (list.every(isDl)) {
    if (await askConfirm('¿Quitar descargas?', `Se borrarán ${list.length} ${list.length === 1 ? 'canción' : 'canciones'} de este dispositivo. Seguirán en tu Drive.`, 'Quitar')) { await removeDownloads(list); toast('Descargas eliminadas'); if (route.name === 'library') rerender(true); }
  } else downloadTracks(list);
}
function refreshDlMarks() {
  $$('.tr[data-id]').forEach(r => r.classList.toggle('dl', isDl(L.byId.get(r.dataset.id))));
  $$('[data-dl]').forEach(b => { const all = ctxList(b.dataset.dl); const on = all.length && all.every(isDl); b.classList.toggle('on', !!on); setIcon(b, on ? 'downloaded' : 'download'); b.title = on ? 'Descargado' : 'Descargar'; });
  if (P.cur) updateNowPlaying();
}
const dlButton = ctx => { const all = ctxList(ctx); const on = all.length && all.every(isDl); return `<button class="icon-btn dl-btn${on ? ' on' : ''}" data-dl="${esc(ctx)}" title="${on ? 'Descargado' : 'Descargar'}" aria-label="Descargar">${icon(on ? 'downloaded' : 'download')}</button>`; };
async function storageInfo() {
  try { const e = await navigator.storage.estimate(); return `${(e.usage / 1048576).toFixed(0)} MB usados de ${(e.quota / 1073741824).toFixed(1)} GB disponibles`; } catch { return ''; }
}
window.addEventListener('online', () => { document.body.classList.remove('offline'); toast('Conexión restablecida'); });
window.addEventListener('offline', () => { document.body.classList.add('offline'); toast('Sin conexión: solo se reproducirán tus descargas'); });

/* =========================================================
   Listas de reproducción
   ========================================================= */
const plTracks = pl => (pl?.ids || []).map(id => L.byId.get(id)).filter(Boolean);
function plCover(pl, cls = '') {
  const keys = [...new Set(plTracks(pl).map(t => t.albumKey))].filter(k => coverURLs.has(k));
  if (keys.length >= 4) return `<span class="cv mosaic ${cls}">${keys.slice(0, 4).map(k => `<i style="background-image:url(&quot;${coverURLs.get(k)}&quot;)"></i>`).join('')}</span>`;
  if (keys.length) return cv(keys[0], cls);
  const h = hue(pl.id);
  return `<span class="cv ph ${cls}" style="background-image:linear-gradient(135deg,hsl(${h} 45% 35%),hsl(${(h + 60) % 360} 55% 18%))">${icon('playlist')}</span>`;
}
async function createPlaylist(withIds = []) {
  const name = await askText('Nueva lista', 'Ponle un nombre a tu lista', `Mi lista n.º ${playlists.length + 1}`);
  if (!name) return null;
  const pl = { id: Date.now().toString(36), name, ids: [...new Set(withIds)], created: Date.now() };
  playlists.unshift(pl); savePlaylists();
  toast(withIds.length ? `Agregada a "${name}"` : `Lista "${name}" creada`);
  return pl;
}
function addToPlaylist(pl, ids) {
  const before = pl.ids.length; pl.ids.push(...ids.filter(id => !pl.ids.includes(id))); savePlaylists();
  toast(pl.ids.length > before ? `Agregada a "${pl.name}"` : `Ya estaba en "${pl.name}"`);
}
function removeFromPlaylist(pl, id) { pl.ids = pl.ids.filter(x => x !== id); savePlaylists(); toast(`Quitada de "${pl.name}"`); rerender(true); }
async function renamePlaylist(pl) { const n = await askText('Cambiar nombre', '', pl.name); if (n) { pl.name = n; savePlaylists(); rerender(true); } }
async function deletePlaylist(pl) {
  if (!await askConfirm('¿Eliminar lista?', `"${pl.name}" se eliminará. Las canciones siguen en tu Drive.`, 'Eliminar')) return;
  playlists = playlists.filter(p => p !== pl); savePlaylists(); location.hash = '#/library/playlists';
}
function movePlaylistTrack(pl, id, dir) {
  const i = pl.ids.indexOf(id), j = i + dir; if (i < 0 || j < 0 || j >= pl.ids.length) return;
  [pl.ids[i], pl.ids[j]] = [pl.ids[j], pl.ids[i]]; savePlaylists(); rerender(true);
}

/* =========================================================
   Menú de canción (⋯) y diálogos
   ========================================================= */
const menuEl = $('#menu');
function openTrackMenu(t, x, y, ctx = '') {
  if (!t) return; menuEl._ctx = ctx;
  const pl = ctx.startsWith('playlist:') ? playlists.find(p => p.id === ctx.slice(9)) : null;
  const versions = (t.variants || []).length > 1 ? t.variants.map(v => v.qShort).join(' · ') : '';
  const items = [
    ['add', 'plus', 'Agregar a una lista'],
    [isDl(t) ? 'undl' : 'dl', isDl(t) ? 'downloaded' : 'download', isDl(t) ? 'Quitar descarga' : 'Descargar'],
    ['like', liked.has(t.id) ? 'heartFill' : 'heart', liked.has(t.id) ? 'Quitar de Tus me gusta' : 'Agregar a Tus me gusta'],
    ['queue', 'queue', 'Reproducir a continuación'],
    pl && ['up', 'chevronLeft', 'Mover arriba'], pl && ['down', 'chevronRight', 'Mover abajo'],
    pl && ['rm', 'trash', 'Quitar de esta lista'],
    ['album', 'album', 'Ir al álbum'], ['artist', 'person', 'Ir al artista'],
  ].filter(Boolean);
  menuEl.innerHTML = `<div class="menu-head">${cv(t.albumKey, '', 'note')}<div><b>${esc(t.title)}</b><small>${esc(t.artist)}${versions ? ' · ' + esc(versions) : ''}</small></div></div>` +
    items.map(([k, ic, label]) => `<button data-m="${k}">${icon(ic)}<span>${label}</span></button>`).join('');
  hydrate(menuEl);
  menuEl.onclick = async e => {
    const b = e.target.closest('[data-m]'); if (!b) return; e.stopPropagation();
    const k = b.dataset.m;
    if (k === 'add') return showPlaylistPicker(t);
    closeMenu();
    if (k === 'dl') downloadTracks([t]);
    else if (k === 'undl') { await removeDownloads([t]); toast('Descarga eliminada'); }
    else if (k === 'like') toggleLike(t.id);
    else if (k === 'queue') playNext(t);
    else if (k === 'up') movePlaylistTrack(pl, t.id, -1);
    else if (k === 'down') movePlaylistTrack(pl, t.id, 1);
    else if (k === 'rm') removeFromPlaylist(pl, t.id);
    else if (k === 'album') location.hash = '#/album/' + enc(t.albumKey);
    else if (k === 'artist') location.hash = '#/artist/' + enc(t.artistKey);
  };
  showMenu(x, y);
}
function showPlaylistPicker(t) {
  menuEl.innerHTML = `<button data-p="back">${icon('back')}<span>Agregar a una lista</span></button>
    <button data-p="new">${icon('plus')}<span><b>Nueva lista</b></span></button>` +
    playlists.map(p => `<button data-p="${esc(p.id)}">${icon('playlist')}<span>${esc(p.name)} <small class="muted">${p.ids.length}</small></span></button>`).join('');
  hydrate(menuEl);
  menuEl.onclick = async e => {
    const b = e.target.closest('[data-p]'); if (!b) return; e.stopPropagation();
    if (b.dataset.p === 'back') return openTrackMenu(t, menuEl._x, menuEl._y, menuEl._ctx);
    closeMenu();
    if (b.dataset.p === 'new') await createPlaylist([t.id]);
    else addToPlaylist(playlists.find(p => p.id === b.dataset.p), [t.id]);
  };
}
function showMenu(x, y) {
  menuEl._x = x; menuEl._y = y;
  menuEl.classList.add('open'); $('#menuShade').classList.add('open');
  if (isMobile()) { menuEl.style.left = menuEl.style.top = ''; return; }
  const r = menuEl.getBoundingClientRect();
  menuEl.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
  menuEl.style.top = Math.max(8, Math.min(y, innerHeight - r.height - 8)) + 'px';
}
function closeMenu() { menuEl.classList.remove('open'); $('#menuShade').classList.remove('open'); }
$('#menuShade').addEventListener('click', closeMenu);
function playNext(t) {
  if (!P.cur) return playList([t], 0, 'track:' + t.id);
  P.queue.push(t); P.order.splice(P.pos + 1, 0, P.queue.length - 1); renderQueue(); toast('Sonará a continuación');
}

function dialog({ title, text = '', input = null, ok = 'Aceptar', danger = false }) {
  return new Promise(res => {
    const d = $('#dialog');
    $('#dlgTitle').textContent = title; $('#dlgText').textContent = text; $('#dlgText').style.display = text ? '' : 'none';
    const inp = $('#dlgInput'); inp.style.display = input == null ? 'none' : ''; inp.value = input ?? '';
    $('#dlgOk').textContent = ok; $('#dlgOk').classList.toggle('danger', danger);
    d.classList.add('open'); if (input != null) setTimeout(() => { inp.focus(); inp.select(); }, 50);
    const done = v => { d.classList.remove('open'); $('#dlgOk').onclick = $('#dlgCancel').onclick = inp.onkeydown = null; res(v); };
    $('#dlgOk').onclick = () => done(input == null ? true : inp.value.trim() || null);
    $('#dlgCancel').onclick = () => done(input == null ? false : null);
    inp.onkeydown = e => { if (e.key === 'Enter') $('#dlgOk').click(); if (e.key === 'Escape') $('#dlgCancel').click(); };
  });
}
const askText = (title, text, initial) => dialog({ title, text, input: initial || '', ok: 'Guardar' });
const askConfirm = (title, text, ok) => dialog({ title, text, ok, danger: true });

/* =========================================================
   Orden automático
   ========================================================= */
const TRACK_SORTS = { custom: 'Orden de la lista', recent: 'Agregadas recientemente', title: 'Título (A-Z)', artist: 'Artista', album: 'Álbum', duration: 'Duración', quality: 'Calidad' };
const ALBUM_SORTS = { recent: 'Agregados recientemente', name: 'Nombre (A-Z)', artist: 'Artista', year: 'Año' };
const ARTIST_SORTS = { count: 'Más canciones', name: 'Nombre (A-Z)' };
const byAlbum = (x, y) => x.album.localeCompare(y.album) || (x.disc - y.disc) || (x.trackNo - y.trackNo);
function sortTracks(list, key) {
  const cmp = {
    title: (x, y) => x.title.localeCompare(y.title), artist: (x, y) => x.artist.localeCompare(y.artist) || byAlbum(x, y), album: byAlbum,
    recent: (x, y) => (y.mod || '').localeCompare(x.mod || ''), duration: (x, y) => (y.duration || 0) - (x.duration || 0), quality: (x, y) => qscore(variantFor(y, settings.quality)) - qscore(variantFor(x, settings.quality)),
  }[key];
  return cmp ? list.slice().sort(cmp) : list.slice();
}
function sortAlbums(list, key) {
  const cmp = { name: (a, b) => a.title.localeCompare(b.title), artist: (a, b) => a.artist.localeCompare(b.artist) || (a.year || '').localeCompare(b.year || ''), year: (a, b) => (b.year || '').localeCompare(a.year || ''), recent: (a, b) => (b.mod || '').localeCompare(a.mod || '') }[key];
  return cmp ? list.slice().sort(cmp) : list;
}
function sortArtists(list, key) { return key === 'name' ? list.slice().sort((a, b) => a.name.localeCompare(b.name)) : list.slice().sort((a, b) => b.tracks.length - a.tracks.length); }
const getSort = (id, def) => store.get('sort.' + id, def);
function sortSelect(id, current, map, omit = []) {
  return `<label class="sort">${icon('queue')}<select data-sort="${esc(id)}" aria-label="Ordenar">${Object.entries(map).filter(([k]) => !omit.includes(k)).map(([k, l]) => `<option value="${k}"${k === current ? ' selected' : ''}>${l}</option>`).join('')}</select></label>`;
}
document.addEventListener('change', e => {
  const s = e.target.closest('[data-sort]'); if (!s) return;
  store.set('sort.' + s.dataset.sort, s.value); rerender(true);
});

/* ---------- Cola ---------- */
function renderQueue() {
  const body = $('#queueBody'); if (!body) return;
  if (!P.cur) { body.innerHTML = '<p class="muted small" style="padding:8px">La cola está vacía.</p>'; return; }
  const up = P.order.slice(P.pos + 1, P.pos + 60).map((qi, k) => ({ t: P.queue[qi], pos: P.pos + 1 + k }));
  const item = (t, pos, now) => `<div class="q-item ${now ? 'now' : ''}" data-qpos="${pos}">${cv(t.albumKey, '', 'note')}<div><div class="t-title">${esc(t.title)}</div><div class="t-sub">${esc(t.artist)}</div></div></div>`;
  body.innerHTML = `<h4>Sonando ahora</h4>${item(P.cur, P.pos, true)}<h4>A continuación</h4>${up.map(x => item(x.t, x.pos)).join('') || '<p class="muted small" style="padding:0 8px">No hay más canciones.</p>'}`;
  hydrate(body);
}

/* =========================================================
   Vistas
   ========================================================= */
const view = $('#view');
const route = { name: 'home', arg: '' };
const LISTS = new Map(); let listN = 0;
const regList = tracks => { const id = 'L' + (++listN); LISTS.set(id, tracks); return id; };

function trackRows(tracks, { album = false, covers = true, ctx = '' } = {}) {
  const lid = regList(tracks);
  const rows = tracks.map((t, i) => {
    const on = liked.has(t.id);
    const q = variantFor(t, settings.quality);
    return `<div class="tr${P.cur?.id === t.id ? ' playing' : ''}${isDl(t) ? ' dl' : ''}" data-i="${i}" data-id="${esc(t.id)}">
      <div class="n"><span class="num">${album ? (t.trackNo || i + 1) : i + 1}</span><span class="pi">${icon('play')}</span><span class="eq"><span></span><span></span><span></span></span></div>
      <div class="t-main">${covers ? cv(t.albumKey, '', 'note') : ''}<div class="t-text"><div class="t-title">${esc(t.title)}</div><div class="t-sub"><span class="t-dl" title="Descargada">${icon('downloaded')}</span><a data-href="#/artist/${enc(t.artistKey)}">${esc(t.artist)}</a></div></div></div>
      <div class="t-alb"><a data-href="#/album/${enc(t.albumKey)}">${esc(t.album)}</a></div>
      <div class="t-q ${q.lossless ? 'hi' : ''}" title="${esc(q.qLong)}${(t.variants || []).length > 1 ? ' · ' + t.variants.length + ' versiones' : ''}">${esc(q.qShort || '')}</div>
      <div class="t-dur"><button class="t-like${on ? ' on' : ''}" data-like="${esc(t.id)}" aria-label="Me gusta">${icon(on ? 'heartFill' : 'heart')}</button><span class="dur">${t.duration ? fmtTime(t.duration) : '–'}</span><button class="t-more" data-more="${esc(t.id)}" aria-label="Más opciones">${icon('more')}</button></div>
    </div>`;
  }).join('');
  return `<div class="tracks${album ? ' compact' : ''}" data-list="${lid}" data-ctx="${esc(ctx)}">
    <div class="tr-head"><div class="n">#</div><div>Título</div><div class="h-alb">Álbum</div><div>Calidad</div><div class="t-dur">${icon('clock')}</div></div>${rows}</div>`;
}
const albumCard = al => `<div class="card" data-href="#/album/${enc(al.key)}"><div class="cv-wrap">${cv(al.key)}<button class="hover-play" data-play="album:${esc(al.key)}" aria-label="Reproducir">${icon('play')}</button></div><b>${esc(al.title)}</b><small>${esc(al.year ? al.year + ' • ' : '')}${esc(al.artist)}</small></div>`;
const artistCard = ar => `<div class="card" data-href="#/artist/${enc(ar.key)}"><div class="cv-wrap">${cv(artistCover(ar), 'circle', 'person')}<button class="hover-play" data-play="artist:${esc(ar.key)}" aria-label="Reproducir">${icon('play')}</button></div><b>${esc(ar.name)}</b><small>Artista</small></div>`;

function emptyState(title, text, ic = 'note') { return `<div class="empty">${icon(ic)}<h2>${esc(title)}</h2><p>${esc(text)}</p></div>`; }
function loadingOrEmpty() {
  if (scanning || !L.ready) return emptyState('Escaneando tu Google Drive…', 'Esto toma unos segundos la primera vez.', 'drive');
  return emptyState('Aún no hay música', 'Sube canciones (MP3, FLAC, M4A, WAV…) a tu Google Drive y pulsa Ajustes → Volver a escanear.', 'drive');
}

function renderHome() {
  setTitle('Inicio');
  const h = new Date().getHours();
  const greet = h < 12 ? 'Buenos días' : h < 19 ? 'Buenas tardes' : 'Buenas noches';
  if (!L.tracks.length) return `<div class="page"><h1 class="greet">${greet}</h1>${loadingOrEmpty()}</div>`;
  const recentKeys = store.get('recent', []).map(k => L.albums.get(k)).filter(Boolean);
  const albums = sortedAlbums();
  const quickPl = playlists.slice(0, 3);
  const quick = [...new Set([...recentKeys, ...albums])].slice(0, 7 - quickPl.length);
  const dlAlbums = albums.filter(a => a.tracks.some(isDl)).slice(0, 12);
  const artists = sortedArtists().slice(0, 12);
  const lossless = albums.filter(a => a.tracks.some(t => t.lossless)).slice(0, 12);
  return `<div class="page">
    <div class="hero-grad" style="background:linear-gradient(rgba(46,230,166,.22),transparent)"></div>
    <h1 class="greet">${greet}</h1>
    <div class="quick">
      <div class="quick-item" data-href="#/liked">${likedCover()}<b>Tus me gusta</b><button class="hover-play" data-play="liked">${icon('play')}</button></div>
      ${quickPl.map(pl => `<div class="quick-item" data-href="#/playlist/${enc(pl.id)}">${plCover(pl)}<b>${esc(pl.name)}</b><button class="hover-play" data-play="playlist:${esc(pl.id)}">${icon('play')}</button></div>`).join('')}
      ${quick.map(al => `<div class="quick-item" data-href="#/album/${enc(al.key)}">${cv(al.key)}<b>${esc(al.title)}</b><button class="hover-play" data-play="album:${esc(al.key)}">${icon('play')}</button></div>`).join('')}
    </div>
    <div class="section"><div class="section-head"><h2>Hecho para ti</h2></div>
      <div class="row">
        <div class="card" data-play="mix"><div class="cv-wrap"><span class="cv ph" style="background-image:linear-gradient(135deg,#2ee6a6,#1b4dff)">${icon('shuffle')}</span><button class="hover-play" data-play="mix">${icon('play')}</button></div><b>Mezcla aleatoria</b><small>${L.tracks.length} canciones de tu Drive</small></div>
        ${lossless.length ? `<div class="card" data-play="lossless"><div class="cv-wrap"><span class="cv ph" style="background-image:linear-gradient(135deg,#f5c542,#a1287a)">${icon('note')}</span><button class="hover-play" data-play="lossless">${icon('play')}</button></div><b>Calidad sin pérdida</b><small>Solo FLAC, ALAC y WAV</small></div>` : ''}
        ${artists.slice(0, 6).map(ar => `<div class="card" data-play="artist:${esc(ar.key)}"><div class="cv-wrap">${cv(artistCover(ar), '', 'person')}<button class="hover-play" data-play="artist:${esc(ar.key)}">${icon('play')}</button></div><b>Radio de ${esc(ar.name)}</b><small>Todas sus canciones</small></div>`).join('')}
      </div></div>
    ${playlists.length ? `<div class="section"><div class="section-head"><h2>Tus listas</h2><a href="#/library/playlists">Mostrar todo</a></div><div class="row">${playlists.slice(0, 14).map(playlistCard).join('')}</div></div>` : ''}
    ${dlAlbums.length ? `<div class="section"><div class="section-head"><h2>Disponible sin conexión</h2><a href="#/library/downloads">Mostrar todo</a></div><div class="row">${dlAlbums.map(albumCard).join('')}</div></div>` : ''}
    <div class="section"><div class="section-head"><h2>Agregados recientemente</h2><a href="#/library/albums">Mostrar todo</a></div>
      <div class="row">${albums.slice(0, 14).map(albumCard).join('')}</div></div>
    <div class="section"><div class="section-head"><h2>Tus artistas</h2><a href="#/library/artists">Mostrar todo</a></div>
      <div class="row">${artists.map(artistCard).join('')}</div></div>
  </div>`;
}

function renderSearch() {
  setTitle('Buscar');
  setTimeout(() => {
    const inp = $('#searchInput'); if (!inp) return;
    inp.value = route.q || ''; if (!isMobile()) inp.focus();
    inp.addEventListener('input', debounce(() => { route.q = inp.value; $('#searchResults').innerHTML = searchResults(inp.value); hydrate($('#searchResults')); markPlaying(); }, 120));
  });
  return `<div class="page">
    <div class="search-box">${icon('search')}<input id="searchInput" type="search" placeholder="¿Qué quieres escuchar?" autocomplete="off"></div>
    <div id="searchResults">${searchResults(route.q || '')}</div></div>`;
}
function searchResults(q) {
  const n = norm(q);
  if (!L.tracks.length) return loadingOrEmpty();
  if (!n) {
    const ars = sortedArtists().slice(0, 16);
    return `<div class="section-head"><h2>Explorar tus artistas</h2></div><div class="genre-grid">${ars.map(ar => {
      const h = hue(ar.key); return `<div class="genre" data-href="#/artist/${enc(ar.key)}" style="background:hsl(${h} 55% 38%)">${esc(ar.name)}${cv(artistCover(ar), '', 'person')}</div>`;
    }).join('')}</div>`;
  }
  const words = n.split(' ');
  const match = s => { const x = norm(s); return words.every(w => x.includes(w)); };
  const songs = L.tracks.filter(t => match(`${t.title} ${t.artist} ${t.album}`)).slice(0, 50);
  const albums = [...L.albums.values()].filter(a => match(`${a.title} ${a.artist}`)).slice(0, 12);
  const artists = [...L.artists.values()].filter(a => match(a.name)).slice(0, 12);
  if (!songs.length && !albums.length && !artists.length) return emptyState(`No encontramos "${q}"`, 'Revisa la ortografía o prueba con otras palabras.', 'search');
  const top = artists[0] ? { html: cv(artistCover(artists[0]), 'circle', 'person'), name: artists[0].name, sub: 'Artista', href: `#/artist/${enc(artists[0].key)}`, play: `artist:${artists[0].key}` }
    : albums[0] ? { html: cv(albums[0].key), name: albums[0].title, sub: 'Álbum • ' + albums[0].artist, href: `#/album/${enc(albums[0].key)}`, play: `album:${albums[0].key}` }
      : { html: cv(songs[0].albumKey, '', 'note'), name: songs[0].title, sub: 'Canción • ' + songs[0].artist, href: `#/album/${enc(songs[0].albumKey)}`, play: `track:${songs[0].id}` };
  return `<div class="search-top">
      <div><div class="section-head"><h2>Resultado principal</h2></div>
        <div class="top-result" data-href="${top.href}">${top.html}<b>${esc(top.name)}</b><small class="muted">${esc(top.sub)}</small><button class="hover-play" data-play="${esc(top.play)}">${icon('play')}</button></div></div>
      <div><div class="section-head"><h2>Canciones</h2></div>${songs.length ? trackRows(songs.slice(0, 5), { ctx: 'search' }).replace('class="tracks', 'class="tracks compact') : '<p class="muted">Sin canciones.</p>'}</div>
    </div>
    ${artists.length ? `<div class="section"><div class="section-head"><h2>Artistas</h2></div><div class="row">${artists.map(artistCard).join('')}</div></div>` : ''}
    ${albums.length ? `<div class="section"><div class="section-head"><h2>Álbumes</h2></div><div class="row">${albums.map(albumCard).join('')}</div></div>` : ''}
    ${songs.length > 5 ? `<div class="section"><div class="section-head"><h2>Más canciones</h2></div>${trackRows(songs, { ctx: 'search' })}</div>` : ''}`;
}

function renderLibrary(tab) {
  tab = tab || store.get('libTab', 'playlists'); store.set('libTab', tab);
  setTitle('Tu biblioteca');
  const nDl = L.tracks.filter(isDl).length;
  const chips = [['playlists', 'Listas'], ['albums', 'Álbumes'], ['artists', 'Artistas'], ['songs', 'Canciones'], ['downloads', `Descargas${nDl ? ' · ' + nDl : ''}`]]
    .map(([k, l]) => `<a class="chip ${tab === k ? 'on' : ''}" href="#/library/${k}">${l}</a>`).join('');
  let body, tools = '';
  if (!L.tracks.length) body = loadingOrEmpty();
  else if (tab === 'artists') {
    const k = getSort('artists', 'count'); tools = sortSelect('artists', k, ARTIST_SORTS);
    body = `<div class="grid">${sortArtists([...L.artists.values()], k).map(artistCard).join('')}</div>`;
  } else if (tab === 'albums') {
    const k = getSort('albums', 'recent'); tools = sortSelect('albums', k, ALBUM_SORTS);
    body = `<div class="grid">${sortAlbums([...L.albums.values()], k).map(albumCard).join('')}</div>`;
  } else if (tab === 'songs') {
    const k = getSort('songs', 'artist'); tools = sortSelect('songs', k, TRACK_SORTS, ['custom']);
    const all = sortTracks(L.tracks, k);
    body = `<div class="actions" style="padding:0 0 16px"><button class="play-btn" data-play="all" data-play-btn="all">${icon('play')}</button>${dlButton('all')}<span class="muted">${all.length} canciones</span></div>${trackRows(all, { ctx: 'all' })}`;
  } else if (tab === 'downloads') {
    const k = getSort('downloads', 'artist'); tools = sortSelect('downloads', k, TRACK_SORTS, ['custom']);
    const list = sortTracks(L.tracks.filter(isDl), k);
    body = `<div class="actions" style="padding:0 0 16px"><button class="play-btn" data-play="downloads" data-play-btn="downloads">${icon('play')}</button>
      <span class="muted" id="storageInfo">${list.length} canciones disponibles sin internet</span>
      ${list.length ? `<button class="btn ghost small-btn" data-dl="downloads">${icon('trash')} Borrar todas</button>` : ''}</div>
      ${list.length ? trackRows(list, { ctx: 'downloads' }) : emptyState('Aún no descargas nada', 'Toca el botón de descarga ⤓ en un álbum, una lista o una canción (menú ⋯) para escucharla sin internet.', 'download')}`;
    storageInfo().then(t => { const el = $('#storageInfo'); if (el && t) el.textContent += ' · ' + t; });
  } else {
    body = `<div class="grid">
      <div class="card new-card" data-new-playlist><div class="cv-wrap"><span class="cv ph" style="background:var(--panel-2)">${icon('plus')}</span></div><b>Crear lista</b><small>Junta tus canciones favoritas</small></div>
      <div class="card" data-href="#/liked"><div class="cv-wrap">${likedCover()}<button class="hover-play" data-play="liked">${icon('play')}</button></div><b>Tus me gusta</b><small>${liked.size} canciones</small></div>
      ${playlists.map(playlistCard).join('')}</div>`;
  }
  return `<div class="page"><h1 class="greet">Tu biblioteca</h1><div class="lib-tools"><div class="chips">${chips}</div>${tools}</div>${body}</div>`;
}
const playlistCard = pl => `<div class="card" data-href="#/playlist/${enc(pl.id)}"><div class="cv-wrap">${plCover(pl)}<button class="hover-play" data-play="playlist:${esc(pl.id)}">${icon('play')}</button></div><b>${esc(pl.name)}</b><small>Lista • ${pl.ids.length} canciones</small></div>`;

function renderPlaylist(id) {
  const pl = playlists.find(p => p.id === id);
  if (!pl) return `<div class="page">${emptyState('Lista no encontrada', 'Puede que la hayas eliminado.', 'playlist')}</div>`;
  setTitle(pl.name);
  const k = getSort('pl.' + id, 'custom');
  const songs = sortTracks(plTracks(pl), k);
  const total = songs.reduce((s, t) => s + (t.duration || 0), 0);
  const firstKey = songs.find(t => coverURLs.has(t.albumKey))?.albumKey;
  const color = (firstKey && coverColors.get(firstKey)) || hslToRgb(hue(pl.id), .45, .3);
  if (firstKey) tintHeader(firstKey);
  return `<div>${headerBlock({ coverHTML: plCover(pl), kind: 'Lista', title: pl.name, color, sub: `${songs.length} canciones${total ? ', ' + fmtLong(total) : ''}` })}
  <div class="body-grad" id="bodyGrad" style="background:linear-gradient(rgba(${color},.32),var(--panel) 260px)">
    <div class="actions"><button class="play-btn" data-play="playlist:${esc(id)}" data-play-btn="playlist:${esc(id)}">${icon('play')}</button>
      <button class="icon-btn" data-shuffle="playlist:${esc(id)}" aria-label="Aleatorio">${icon('shuffle')}</button>
      ${dlButton('playlist:' + id)}
      <button class="icon-btn" data-pl-edit="${esc(id)}" title="Cambiar nombre">${icon('edit')}</button>
      <button class="icon-btn" data-pl-del="${esc(id)}" title="Eliminar lista">${icon('trash')}</button>
      <span class="grow"></span>${sortSelect('pl.' + id, k, TRACK_SORTS)}</div>
    ${songs.length ? trackRows(songs, { ctx: 'playlist:' + id }) : emptyState('Tu lista está vacía', 'Agrega canciones con el menú ⋯ de cualquier canción → "Agregar a una lista".', 'playlist')}
  </div></div>`;
}

function headerBlock({ coverHTML, kind, title, sub, color }) {
  return `<div class="hdr" id="hdr" style="background:linear-gradient(rgb(${color}),rgba(${color},.55))">${coverHTML}
    <div class="hdr-info"><small>${esc(kind)}</small><h1>${esc(title)}</h1><div class="sub">${sub}</div></div></div>`;
}
function renderAlbum(key) {
  const al = L.albums.get(key);
  if (!al) return `<div class="page">${L.ready ? emptyState('Álbum no encontrado', 'Puede que se haya movido en tu Drive.', 'album') : loadingOrEmpty()}</div>`;
  setTitle(al.title);
  const total = al.tracks.reduce((s, t) => s + (t.duration || 0), 0);
  const q = al.tracks.find(t => t.lossless) ? (al.tracks.some(t => t.hires) ? 'HI-RES' : 'LOSSLESS') : '';
  const color = coverColors.get(key) || hslToRgb(hue(key), .45, .32);
  tintHeader(key);
  return `<div>${headerBlock({
    coverHTML: cv(key), kind: 'Álbum', title: al.title, color,
    sub: `<a data-href="#/artist/${enc(al.artistKey)}">${esc(al.artist)}</a>${al.year ? ' • ' + esc(al.year) : ''} • ${al.tracks.length} canciones${total ? ', ' + fmtLong(total) : ''}${q ? ` <span class="quality" style="margin-left:6px">${q}</span>` : ''}`,
  })}
  <div class="body-grad" id="bodyGrad" style="background:linear-gradient(rgba(${color},.32),var(--panel) 260px)">
    <div class="actions"><button class="play-btn" data-play="album:${esc(key)}" data-play-btn="album:${esc(key)}" aria-label="Reproducir">${icon('play')}</button>
      <button class="icon-btn" data-shuffle="album:${esc(key)}" aria-label="Aleatorio">${icon('shuffle')}</button>${dlButton('album:' + key)}</div>
    ${trackRows(al.tracks, { album: true, covers: false, ctx: 'album:' + key })}
  </div></div>`;
}
function renderArtist(key) {
  const ar = L.artists.get(key);
  if (!ar) return `<div class="page">${L.ready ? emptyState('Artista no encontrado', '', 'person') : loadingOrEmpty()}</div>`;
  setTitle(ar.name);
  const ck = artistCover(ar);
  const color = coverColors.get(ck) || hslToRgb(hue(key), .45, .32);
  tintHeader(ck);
  const songs = ar.tracks.slice().sort((a, b) => (b.year || '').localeCompare(a.year || '') || a.album.localeCompare(b.album) || a.trackNo - b.trackNo);
  return `<div>${headerBlock({ coverHTML: cv(ck, 'circle', 'person'), kind: 'Artista', title: ar.name, color, sub: `${ar.tracks.length} canciones • ${ar.albums.length} ${ar.albums.length === 1 ? 'álbum' : 'álbumes'}` })}
  <div class="body-grad" id="bodyGrad" style="background:linear-gradient(rgba(${color},.32),var(--panel) 260px)">
    <div class="actions"><button class="play-btn" data-play="artist:${esc(key)}" data-play-btn="artist:${esc(key)}">${icon('play')}</button>
      <button class="icon-btn" data-shuffle="artist:${esc(key)}" aria-label="Aleatorio">${icon('shuffle')}</button>${dlButton('artist:' + key)}</div>
    <div style="padding:0 24px"><div class="section-head"><h2>Canciones</h2></div></div>
    ${trackRows(songs.slice(0, 10), { ctx: 'artist:' + key })}
    <div class="page" style="padding-top:8px"><div class="section-head"><h2>Discografía</h2></div><div class="grid">${ar.albums.map(albumCard).join('')}</div></div>
  </div></div>`;
}
function renderLiked() {
  setTitle('Tus me gusta');
  const k = getSort('liked', 'custom');
  const songs = sortTracks([...liked].map(id => L.byId.get(id)).filter(Boolean).reverse(), k);
  const color = [75, 47, 214];
  return `<div>${headerBlock({ coverHTML: likedCover(), kind: 'Lista', title: 'Tus me gusta', color, sub: `${songs.length} canciones` })}
  <div class="body-grad" style="background:linear-gradient(rgba(${color},.32),var(--panel) 260px)">
    <div class="actions"><button class="play-btn" data-play="liked" data-play-btn="liked">${icon('play')}</button>${dlButton('liked')}<span class="grow"></span>${sortSelect('liked', k, { ...TRACK_SORTS, custom: 'Agregadas por ti' })}</div>
    ${songs.length ? trackRows(songs, { ctx: 'liked' }) : emptyState('Las canciones que te gustan aparecen aquí', 'Toca el corazón ♡ en cualquier canción para guardarla.', 'heart')}
  </div></div>`;
}
async function tintHeader(key) {
  if (coverColors.has(key) || !coverURLs.has(key)) return;
  const c = await colorOf(key);
  const h = $('#hdr'), b = $('#bodyGrad');
  if (h) h.style.background = `linear-gradient(rgb(${c}),rgba(${c},.55))`;
  if (b) b.style.background = `linear-gradient(rgba(${c},.32),var(--panel) 260px)`;
}

function setTitle(t) { $('#topTitle').textContent = t; }

const VIEWS = { home: renderHome, search: renderSearch, library: renderLibrary, album: renderAlbum, artist: renderArtist, liked: renderLiked, playlist: renderPlaylist };
function parseRoute() {
  const [, name = 'home', ...rest] = (location.hash || '#/home').split('/');
  route.name = VIEWS[name] ? name : 'home';
  route.arg = decodeURIComponent(rest.join('/'));
}
function render(keepScroll = false) {
  const st = view.scrollTop;
  LISTS.clear();
  view.innerHTML = VIEWS[route.name](route.arg);
  hydrate(view);
  view.scrollTop = keepScroll ? st : 0;
  $$('[data-nav]').forEach(a => a.classList.toggle('active', a.dataset.nav === route.name));
  updatePlayState(); onScroll();
}
function rerender(soft = false) {
  renderSidebar();
  if (soft && route.name === 'search') { const r = $('#searchResults'); if (r) { r.innerHTML = searchResults(route.q || ''); hydrate(r); return; } }
  render(soft);
}
window.addEventListener('hashchange', () => { parseRoute(); render(); });

function renderSidebar() {
  const el = $('#sideLibrary'); if (!el) return;
  const items = sortedAlbums().slice(0, 150);
  el.innerHTML = `<div class="lib-item new-item" data-new-playlist><span class="cv ph" style="background:var(--panel-2)">${icon('plus')}</span><div><b>Crear lista</b><small>Nueva lista de reproducción</small></div></div>` +
    `<div class="lib-item" data-href="#/liked">${likedCover()}<div><b>Tus me gusta</b><small>Lista • ${liked.size} canciones</small></div></div>` +
    playlists.map(pl => `<div class="lib-item" data-href="#/playlist/${enc(pl.id)}">${plCover(pl)}<div><b>${esc(pl.name)}</b><small>Lista • ${pl.ids.length} canciones</small></div></div>`).join('') +
    items.map(al => `<div class="lib-item" data-href="#/album/${enc(al.key)}">${cv(al.key)}<div><b>${esc(al.title)}</b><small>Álbum • ${esc(al.artist)}</small></div></div>`).join('');
  hydrate(el);
}

/* ---------- Topbar al hacer scroll ---------- */
function onScroll() { $('#topbar').classList.toggle('solid', view.scrollTop > 200 || (route.name !== 'album' && route.name !== 'artist' && route.name !== 'liked' && route.name !== 'playlist' && view.scrollTop > 40)); }
view.addEventListener('scroll', onScroll, { passive: true });

/* =========================================================
   Interacción global (delegación de eventos)
   ========================================================= */
function playContext(ctx, shuffleIt = false) {
  let list = [];
  if (ctx.startsWith('album:')) list = L.albums.get(ctx.slice(6))?.tracks || [];
  else if (ctx.startsWith('artist:')) list = L.artists.get(ctx.slice(7))?.tracks || [];
  else if (ctx === 'liked') list = sortTracks(ctxList('liked'), getSort('liked', 'custom'));
  else if (ctx.startsWith('playlist:')) list = sortTracks(ctxList(ctx), getSort('pl.' + ctx.slice(9), 'custom'));
  else if (ctx === 'downloads') list = sortTracks(ctxList(ctx), getSort('downloads', 'artist'));
  else if (ctx === 'mix') { list = shuffled(L.tracks); }
  else if (ctx === 'lossless') list = shuffled(L.tracks.filter(t => t.lossless));
  else if (ctx === 'all') list = sortTracks(L.tracks, getSort('songs', 'artist'));
  else if (ctx.startsWith('track:')) { const t = L.byId.get(ctx.slice(6)); if (t) { const al = L.albums.get(t.albumKey); return playList(al.tracks, al.tracks.indexOf(t), 'album:' + t.albumKey); } }
  if (!list.length) return toast(ctx === 'liked' ? 'Aún no tienes canciones que te gusten.' : 'No hay canciones aquí.');
  if (P.ctx === ctx && P.cur && !shuffleIt) return togglePlay();
  if (shuffleIt && !P.shuffle) toggleShuffle();
  playList(list, P.shuffle ? Math.floor(Math.random() * list.length) : 0, ctx);
}

document.addEventListener('click', e => {
  const more = e.target.closest('[data-more]');
  if (more) { e.stopPropagation(); const r = more.getBoundingClientRect(); return openTrackMenu(L.byId.get(more.dataset.more), r.left - 200, r.bottom + 4, more.closest('[data-ctx]')?.dataset.ctx || ''); }
  const dlb = e.target.closest('[data-dl]');
  if (dlb) { e.stopPropagation(); return toggleDownload(dlb.dataset.dl); }
  if (e.target.closest('[data-new-playlist]')) { e.stopPropagation(); return createPlaylist().then(pl => { if (pl) location.hash = '#/playlist/' + enc(pl.id); }); }
  const ped = e.target.closest('[data-pl-edit]'); if (ped) return renamePlaylist(playlists.find(p => p.id === ped.dataset.plEdit));
  const pdel = e.target.closest('[data-pl-del]'); if (pdel) return deletePlaylist(playlists.find(p => p.id === pdel.dataset.plDel));
  const like = e.target.closest('[data-like]');
  if (like) { e.stopPropagation(); return toggleLike(like.dataset.like); }
  const play = e.target.closest('[data-play]');
  if (play) { e.stopPropagation(); e.preventDefault(); return playContext(play.dataset.play); }
  const sh = e.target.closest('[data-shuffle]');
  if (sh) { return playContext(sh.dataset.shuffle, true); }
  const link = e.target.closest('[data-href]');
  if (link) {
    e.preventDefault(); closeFull(); closeQueue();
    if (location.hash !== link.dataset.href) location.hash = link.dataset.href; return;
  }
  const row = e.target.closest('.tr[data-i]');
  if (row) {
    const box = row.closest('[data-list]'); const list = LISTS.get(box.dataset.list); const i = +row.dataset.i;
    if (P.cur?.id === list[i].id && P.queue.length) return togglePlay();
    return playList(list, i, box.dataset.ctx || '');
  }
  const q = e.target.closest('[data-qpos]');
  if (q) { P.pos = +q.dataset.qpos; loadCurrent(true); }
});

document.addEventListener('contextmenu', e => {
  const row = e.target.closest('.tr[data-id]'); if (!row) return;
  e.preventDefault(); menuEl._ctx = row.closest('[data-ctx]')?.dataset.ctx || '';
  openTrackMenu(L.byId.get(row.dataset.id), e.clientX, e.clientY, menuEl._ctx);
});

/* ---------- Botones del reproductor ---------- */
const on = (sel, fn) => $(sel).addEventListener('click', e => { e.stopPropagation(); fn(e); });
on('#btnPlay', togglePlay); on('#btnPlayMini', togglePlay); on('#fpPlay', togglePlay);
on('#btnNext', () => next()); on('#fpNext', () => next());
on('#btnPrev', prev); on('#fpPrev', prev);
on('#btnShuffle', toggleShuffle); on('#fpShuffle', toggleShuffle);
on('#btnRepeat', cycleRepeat); on('#fpRepeat', cycleRepeat);
on('#plLike', () => P.cur && toggleLike(P.cur.id)); on('#fpLike', () => P.cur && toggleLike(P.cur.id));
on('#btnMute', () => { audio.muted = !audio.muted; updateVolume(); });
on('#btnQueue', () => toggleQueue()); on('#fpQueue', () => toggleQueue()); on('#queueClose', closeQueue);
on('#btnBack', () => history.back()); on('#btnFwd', () => history.forward());
on('#plCover', () => { if (P.cur) location.hash = '#/album/' + enc(P.cur.albumKey); });
on('#fpClose', closeFull);
$('#player').addEventListener('click', e => { if (isMobile() && P.cur && !e.target.closest('button')) openFull(); });

function openFull() { $('#fullplayer').classList.add('open'); $('#fullplayer').setAttribute('aria-hidden', 'false'); }
function closeFull() { $('#fullplayer').classList.remove('open'); $('#fullplayer').setAttribute('aria-hidden', 'true'); }
function toggleQueue() { const q = $('#queuePanel'); renderQueue(); q.classList.toggle('open'); }
function closeQueue() { $('#queuePanel').classList.remove('open'); }

// Deslizar hacia abajo para cerrar el reproductor completo
(() => {
  const fp = $('#fullplayer'); let y0 = null, dy = 0;
  fp.addEventListener('touchstart', e => { if (e.target.closest('.slider')) return; y0 = e.touches[0].clientY; dy = 0; fp.style.transition = 'none'; }, { passive: true });
  fp.addEventListener('touchmove', e => { if (y0 == null) return; dy = Math.max(0, e.touches[0].clientY - y0); fp.style.transform = `translateY(${dy}px)`; }, { passive: true });
  fp.addEventListener('touchend', () => { if (y0 == null) return; fp.style.transition = ''; fp.style.transform = ''; if (dy > 120) closeFull(); y0 = null; });
})();

// Teclado (PC)
document.addEventListener('keydown', e => {
  if (e.target.matches('input,textarea')) return;
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  else if (e.code === 'ArrowRight' && (e.ctrlKey || e.metaKey)) next();
  else if (e.code === 'ArrowLeft' && (e.ctrlKey || e.metaKey)) prev();
  else if (e.code === 'ArrowRight') audio.currentTime = Math.min(dur(), audio.currentTime + 5);
  else if (e.code === 'ArrowLeft') audio.currentTime = Math.max(0, audio.currentTime - 5);
  else if (e.key === 'Escape') { closeFull(); closeQueue(); closeSettings(); closeMenu(); }
});

/* ---------- Toast ---------- */
let toastT;
function toast(msg, action, fn, ms = 3500) {
  const t = $('#toast');
  t.innerHTML = `<span>${esc(msg)}</span>${action ? `<button>${esc(action)}</button>` : ''}`;
  if (action) t.querySelector('button').onclick = () => { t.classList.remove('show'); fn(); };
  t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), action ? 9000 : ms);
}
function askReconnect(msg) {
  toast(msg, 'Reconectar', async () => {
    try { await auth.request(''); if (P.needsLoad) loadCurrent(true, P.resumeAt); else scanDrive(); }
    catch (e) { toast(e.message); }
  });
}

/* ---------- Ajustes ---------- */
function openSettings() {
  $('#setFolder').value = store.get('folder', '') || CFG.MUSIC_FOLDER || '';
  $('#setQuality').value = settings.quality; $('#setDlQuality').value = settings.dlQuality;
  const at = L.raw?.at ? new Date(L.raw.at).toLocaleString() : '—';
  $('#setInfo').innerHTML = mode === 'demo' ? 'Modo demostración. Cierra sesión para conectar tu Google Drive.' : `${L.tracks.length} canciones · ${L.albums.size} álbumes · ${L.artists.size} artistas<br>Último escaneo: ${esc(at)}`;
  $('#setRescan').style.display = mode === 'demo' ? 'none' : '';
  $('#setDlInfo').textContent = `${downloaded.size} canciones descargadas`;
  storageInfo().then(t => { if (t) $('#setDlInfo').textContent = `${downloaded.size} canciones descargadas · ${t}`; });
  $('#settings').classList.add('open');
}
function closeSettings() { $('#settings').classList.remove('open'); }
on('#btnSettings', openSettings); on('#settingsClose', closeSettings);
$('#settings').addEventListener('click', e => { if (e.target.id === 'settings') closeSettings(); });
$('#setFolder').addEventListener('change', async e => {
  store.set('folder', e.target.value.trim());
  if (L.raw) { await materialize(L.raw, false); toast('Filtro de carpeta aplicado'); }
});
$('#setQuality').addEventListener('change', e => {
  settings.quality = e.target.value; store.set('quality', settings.quality);
  buildLibrary(L.all); rerender(true); toast(settings.quality === 'max' ? 'Calidad máxima activada' : 'Ahorro de datos activado');
});
$('#setDlQuality').addEventListener('change', e => { settings.dlQuality = e.target.value; store.set('dlQuality', settings.dlQuality); });
on('#setClearDl', async () => {
  if (!downloaded.size) return toast('No hay descargas.');
  if (!await askConfirm('¿Borrar todas las descargas?', `Se liberará el espacio de ${downloaded.size} canciones. Seguirán en tu Drive.`, 'Borrar')) return;
  await caches.delete(AUDIO_CACHE); downloaded.clear(); saveDl(); refreshDlMarks(); closeSettings(); toast('Descargas borradas'); rerender(true);
});
on('#setRescan', async () => {
  store.set('folder', $('#setFolder').value.trim()); closeSettings();
  if (!auth.valid()) { try { await auth.request(''); } catch (e) { return toast(e.message); } }
  scanDrive();
});
on('#setLogout', async () => {
  closeSettings(); audio.pause(); audio.removeAttribute('src');
  auth.logout(); mode = null; store.del('mode'); store.del('session');
  await idb.del('kv', LIB_KEY).catch(() => { });
  P.queue = []; P.cur = null; L.tracks = []; L.albums = new Map(); L.artists = new Map(); L.ready = false;
  updateNowPlaying(); showLogin(true);
});

/* =========================================================
   Perfiles
   ========================================================= */
const saveProfiles = () => localStorage.setItem('sonora.profiles', JSON.stringify(PROFILES.list));
const curProfile = () => PROFILES.list.find(p => p.id === PID);
const avatar = (p, cls = '') => `<span class="avatar ${cls}" style="background:linear-gradient(135deg,hsl(${p.hue} 70% 55%),hsl(${(p.hue + 50) % 360} 65% 35%))">${esc((p.name || '?').trim().charAt(0).toUpperCase())}</span>`;
function switchProfile(id) {
  if (id === PID) return closeProfiles();
  localStorage.setItem('sonora.profile', JSON.stringify(id));
  try { audio.pause(); } catch { }
  location.hash = '#/home'; location.reload();
}
function renderProfiles(manage = false) {
  const box = $('#profilesGrid');
  box.innerHTML = PROFILES.list.map(p => `<button class="pf" data-pf="${esc(p.id)}">${avatar(p)}${manage ? `<span class="pf-edit">${icon('edit')}</span>` : ''}<b>${esc(p.name)}</b>${p.id === PID ? '<small>Activo</small>' : ''}</button>`).join('') +
    (PROFILES.list.length < 8 ? `<button class="pf" data-pf="new"><span class="avatar add">${icon('plus')}</span><b>Agregar perfil</b></button>` : '');
  hydrate(box);
  $('#profilesTitle').textContent = manage ? 'Administrar perfiles' : '¿Quién está escuchando?';
  $('#profilesManage').textContent = manage ? 'Listo' : 'Administrar perfiles';
  box.onclick = async e => {
    const b = e.target.closest('[data-pf]'); if (!b) return;
    const id = b.dataset.pf;
    if (id === 'new') {
      const name = await askText('Nuevo perfil', 'Cada perfil tiene sus propias listas, me gusta, descargas y cuenta de Google.', '');
      if (!name) return;
      const p = { id: 'p' + Date.now().toString(36), name, hue: Math.floor(Math.random() * 360) };
      PROFILES.list.push(p); saveProfiles(); return switchProfile(p.id);
    }
    const p = PROFILES.list.find(x => x.id === id);
    if (!manage) return switchProfile(id);
    editProfile(p);
  };
  $('#profilesManage').onclick = () => renderProfiles(!manage);
}
async function editProfile(p) {
  menuEl.innerHTML = `<div class="menu-head">${avatar(p)}<div><b>${esc(p.name)}</b><small>Perfil</small></div></div>
    <button data-e="rename">${icon('edit')}<span>Cambiar nombre</span></button>
    <button data-e="color">${icon('refresh')}<span>Cambiar color</span></button>
    ${PROFILES.list.length > 1 ? `<button data-e="del">${icon('trash')}<span>Eliminar perfil</span></button>` : ''}`;
  hydrate(menuEl); showMenu(innerWidth / 2 - 130, innerHeight / 2 - 90);
  menuEl.onclick = async e => {
    const b = e.target.closest('[data-e]'); if (!b) return; closeMenu();
    if (b.dataset.e === 'rename') { const n = await askText('Cambiar nombre', '', p.name); if (n) { p.name = n; saveProfiles(); renderProfiles(true); updateProfileBtn(); } }
    else if (b.dataset.e === 'color') { p.hue = (p.hue + 47) % 360; saveProfiles(); renderProfiles(true); updateProfileBtn(); }
    else if (b.dataset.e === 'del') {
      if (!await askConfirm(`¿Eliminar a "${p.name}"?`, 'Se borrarán sus listas, me gusta, descargas y sesión en este dispositivo. La música de Drive no se toca.', 'Eliminar')) return;
      for (const k of Object.keys(localStorage)) if (k.startsWith(`sonora.p.${p.id}.`)) localStorage.removeItem(k);
      await idb.del('kv', 'library:' + p.id).catch(() => { }); await caches.delete('sonora-audio-' + p.id).catch(() => { });
      PROFILES.list = PROFILES.list.filter(x => x !== p); saveProfiles();
      if (p.id === PID) return switchProfile(PROFILES.list[0].id);
      renderProfiles(true);
    }
  };
}
function openProfiles(manage = false) { renderProfiles(manage); $('#profiles').classList.add('open'); }
function closeProfiles() { $('#profiles').classList.remove('open'); }
function updateProfileBtn() { const p = curProfile(); if (p) { $('#btnProfile').innerHTML = avatar(p, 'small'); $('#btnProfile').title = 'Perfil: ' + p.name; } }
on('#btnProfile', () => {
  menuEl.innerHTML = PROFILES.list.map(p => `<button data-sw="${esc(p.id)}">${avatar(p, 'tiny')}<span>${esc(p.name)}${p.id === PID ? ' <small class="muted">· activo</small>' : ''}</span></button>`).join('') +
    `<button data-sw="new">${icon('plus')}<span>Agregar perfil</span></button><button data-sw="manage">${icon('settings')}<span>Administrar perfiles</span></button>`;
  hydrate(menuEl); const r = $('#btnProfile').getBoundingClientRect(); showMenu(r.right - 240, r.bottom + 6);
  menuEl.onclick = e => {
    const b = e.target.closest('[data-sw]'); if (!b) return; closeMenu();
    if (b.dataset.sw === 'manage') openProfiles(true);
    else if (b.dataset.sw === 'new') { openProfiles(false); $('#profilesGrid [data-pf="new"]')?.click(); }
    else switchProfile(b.dataset.sw);
  };
});
on('#btnScan', manualScan);
on('#profilesClose', closeProfiles);
on('#loginProfile', () => openProfiles(false));

/* =========================================================
   Inicio de sesión y arranque
   ========================================================= */
function showLogin(v) { $('#login').classList.toggle('open', v); }
on('#btnLogin', async () => {
  const note = $('#loginNote');
  note.textContent = '';
  try {
    await auth.request('');
    mode = 'drive'; store.set('mode', mode); showLogin(false);
    location.hash = '#/home'; render();
    await scanDrive(); restoreSession();
  } catch (e) { note.textContent = e.message; }
});
on('#btnDemo', () => { mode = 'demo'; store.set('mode', mode); showLogin(false); startDemo(); });

function startDemo() {
  const tracks = buildDemo();
  for (const t of tracks) { const k = norm(t.artist) + '|' + norm(t.album); setCover(k, t.cover); }
  buildLibrary(tracks); rerender(); restoreSession();
}

async function init() {
  hydrate();
  audio.volume = store.get('vol', 0.8); updateVolume(); updateModes(); updateNowPlaying();
  auth.load(); parseRoute(); updateProfileBtn();
  if (auth.valid()) auth.save(); // el reproductor en segundo plano usa la sesión de este perfil
  const p = curProfile(); $('#loginProfile').innerHTML = `${avatar(p, 'tiny')} Perfil: <b>${esc(p.name)}</b> · cambiar`;
  if (PROFILES.list.length > 1 && !sessionStorage.getItem('sonora.picked')) openProfiles(false);
  sessionStorage.setItem('sonora.picked', '1');
  if (!CFG.GOOGLE_CLIENT_ID) $('#loginNote').textContent = 'Para conectar Drive falta configurar tu Client ID (ver la guía). Mientras, puedes probar la demo.';
  if (mode === 'demo') { startDemo(); }
  else if (mode === 'drive') {
    render();
    const had = await loadCachedLibrary();
    restoreSession();
    if (!navigator.onLine) document.body.classList.add('offline');
    else if (auth.valid()) scanDrive();
    else if (!had) askReconnect('Conéctate a Google para cargar tu música.');
  } else { render(); showLogin(true); }
}
init();

// Exponer para depuración
window.sonora = { L, P, auth, PROFILES };
