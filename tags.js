// Lectura de etiquetas y calidad real de archivos de audio (MP3/ID3, FLAC, WAV, M4A/ALAC, OGG/OPUS)
// Solo descarga los primeros KB de cada archivo (peticiones Range), nunca el archivo completo.

const CAP = 6 * 1024 * 1024; // máximo que leemos por archivo (portadas grandes)

const latin1 = b => { let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return s; };
const be32 = (b, o) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
const be16 = (b, o) => (b[o] << 8) | b[o + 1];
const le32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + ((b[o + 3] << 24) >>> 0);
const le16 = (b, o) => b[o] | (b[o + 1] << 8);
const syncsafe = (b, o) => ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);
const utf8 = new TextDecoder('utf-8');

function indexOfStr(b, str, from = 0, to = b.length) {
  const c = [...str].map(ch => ch.charCodeAt(0));
  outer: for (let i = from; i <= to - c.length; i++) {
    for (let j = 0; j < c.length; j++) if (b[i + j] !== c[j]) continue outer;
    return i;
  }
  return -1;
}

function sniffMime(d, fallback) {
  if (d[0] === 0xFF && d[1] === 0xD8) return 'image/jpeg';
  if (d[0] === 0x89 && d[1] === 0x50) return 'image/png';
  if (d[0] === 0x52 && d[1] === 0x49 && d[8] === 0x57) return 'image/webp';
  return fallback || 'image/jpeg';
}

/* ---------------- ID3v2 ---------------- */
function decodeText(enc, b) {
  if (!b.length) return '';
  let s;
  if (enc === 0) s = latin1(b);
  else if (enc === 3) s = utf8.decode(b);
  else if (enc === 1) {
    if (b[0] === 0xFE && b[1] === 0xFF) s = new TextDecoder('utf-16be').decode(b.subarray(2));
    else if (b[0] === 0xFF && b[1] === 0xFE) s = new TextDecoder('utf-16le').decode(b.subarray(2));
    else s = new TextDecoder('utf-16le').decode(b);
  } else if (enc === 2) s = new TextDecoder('utf-16be').decode(b);
  else s = latin1(b);
  return s.split('\0').map(x => x.trim()).filter(Boolean).join(', ');
}

function unsync(d) {
  const out = []; for (let i = 0; i < d.length; i++) { out.push(d[i]); if (d[i] === 0xFF && d[i + 1] === 0) i++; }
  return Uint8Array.from(out);
}

function parsePic(d, v22) {
  const enc = d[0]; let p = 1, mime;
  if (v22) { const f = latin1(d.subarray(1, 4)).toLowerCase(); mime = f === 'png' ? 'image/png' : 'image/jpeg'; p = 4; }
  else { let e = p; while (e < d.length && d[e] !== 0) e++; mime = latin1(d.subarray(p, e)); p = e + 1; }
  const type = d[p]; p++;
  if (enc === 1 || enc === 2) { while (p + 1 < d.length && !(d[p] === 0 && d[p + 1] === 0)) p += 2; p += 2; }
  else { while (p < d.length && d[p] !== 0) p++; p++; }
  const data = d.slice(p);
  return { type, mime: sniffMime(data, mime), data };
}

const ID3MAP = {
  TIT2: 'title', TT2: 'title', TPE1: 'artist', TP1: 'artist', TPE2: 'albumArtist', TP2: 'albumArtist',
  TALB: 'album', TAL: 'album', TRCK: 'track', TRK: 'track', TPOS: 'disc', TPA: 'disc',
  TYER: 'year', TYE: 'year', TDRC: 'year', TDOR: 'year', TCON: 'genre', TCO: 'genre',
};

function parseID3(b) {
  const ver = b[3], flags = b[5];
  const size = syncsafe(b, 6) + 10 + ((flags & 0x10) ? 10 : 0);
  const out = {};
  let p = 10;
  if (flags & 0x40) p += ver === 4 ? syncsafe(b, 10) : be32(b, 10) + 4;
  const end = Math.min(size, b.length);
  while (p < end - 10) {
    let id, len, hdr;
    if (ver === 2) { id = latin1(b.subarray(p, p + 3)); len = (b[p + 3] << 16) | (b[p + 4] << 8) | b[p + 5]; hdr = 6; }
    else { id = latin1(b.subarray(p, p + 4)); len = ver === 4 ? syncsafe(b, p + 4) : be32(b, p + 4); hdr = 10; }
    if (!/^[A-Z0-9]{3,4}$/.test(id) || len <= 0) break;
    const complete = p + hdr + len <= b.length;
    let d = b.subarray(p + hdr, Math.min(p + hdr + len, b.length));
    if (ver === 4) { const ff = b[p + 9]; if (ff & 0x01) d = d.subarray(4); if (ff & 0x02) d = unsync(d); }
    const key = ID3MAP[id];
    if (key && !out[key]) out[key] = decodeText(d[0], d.subarray(1));
    else if ((id === 'APIC' || id === 'PIC') && complete) {
      try { const pic = parsePic(d, id === 'PIC'); if (pic.data.length > 100 && (!out.picture || pic.type === 3)) out.picture = pic; } catch { }
    }
    p += hdr + len;
  }
  return { tags: out, size };
}

/* ---------------- MP3 frames ---------------- */
const BR1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BR2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];

function mp3Info(b, start, bytesFromStart) {
  const lim = Math.min(b.length - 4, start + 65536);
  for (let i = start; i < lim; i++) {
    if (b[i] !== 0xFF || (b[i + 1] & 0xE0) !== 0xE0) continue;
    const vb = (b[i + 1] >> 3) & 3, layer = (b[i + 1] >> 1) & 3, bri = b[i + 2] >> 4, sri = (b[i + 2] >> 2) & 3, pad = (b[i + 2] >> 1) & 1, mode = b[i + 3] >> 6;
    if (vb === 1 || layer !== 1 || bri === 0 || bri === 15 || sri === 3) continue;
    const m1 = vb === 3;
    const br = (m1 ? BR1 : BR2)[bri];
    const sr = (vb === 3 ? [44100, 48000, 32000] : vb === 2 ? [22050, 24000, 16000] : [11025, 12000, 8000])[sri];
    const flen = Math.floor((m1 ? 144000 : 72000) * br / sr) + pad;
    if (i + flen + 1 < b.length && !(b[i + flen] === 0xFF && (b[i + flen + 1] & 0xE0) === 0xE0)) continue; // falso positivo
    const spf = m1 ? 1152 : 576;
    const audioBytes = bytesFromStart - (i - start);
    const xo = i + 4 + (m1 ? (mode === 3 ? 17 : 32) : (mode === 3 ? 9 : 17));
    const xt = latin1(b.subarray(xo, xo + 4));
    if ((xt === 'Xing' || xt === 'Info') && xo + 12 <= b.length && (be32(b, xo + 4) & 1)) {
      const frames = be32(b, xo + 8); const dur = frames * spf / sr;
      if (dur > 0) return { duration: dur, bitrate: Math.round(audioBytes * 8 / dur / 1000), vbr: xt === 'Xing', sampleRate: sr };
    }
    const vo = i + 36;
    if (latin1(b.subarray(vo, vo + 4)) === 'VBRI' && vo + 18 <= b.length) {
      const frames = be32(b, vo + 14); const dur = frames * spf / sr;
      if (dur > 0) return { duration: dur, bitrate: Math.round(audioBytes * 8 / dur / 1000), vbr: true, sampleRate: sr };
    }
    return { duration: audioBytes * 8 / (br * 1000), bitrate: br, vbr: false, sampleRate: sr };
  }
  return null;
}

/* ---------------- Vorbis comments (FLAC / OGG) ---------------- */
const VMAP = { TITLE: 'title', ARTIST: 'artist', ALBUM: 'album', ALBUMARTIST: 'albumArtist', 'ALBUM ARTIST': 'albumArtist', TRACKNUMBER: 'track', DISCNUMBER: 'disc', DATE: 'year', YEAR: 'year', GENRE: 'genre' };
function vorbis(b, out) {
  let p = 0; if (p + 4 > b.length) return;
  const vlen = le32(b, p); p += 4 + vlen; if (p + 4 > b.length) return;
  const n = le32(b, p); p += 4;
  for (let k = 0; k < n && p + 4 <= b.length; k++) {
    const len = le32(b, p); p += 4; if (p + len > b.length) break;
    const s = utf8.decode(b.subarray(p, p + len)); p += len;
    const eq = s.indexOf('='); if (eq < 0) continue;
    const key = VMAP[s.slice(0, eq).toUpperCase()];
    if (key && !out[key]) out[key] = s.slice(eq + 1).trim();
  }
}

/* ---------------- FLAC ---------------- */
function parseFLAC(b, base = 0) {
  let p = base + 4; const out = { codec: 'FLAC' };
  while (p + 4 <= b.length) {
    const last = b[p] & 0x80, type = b[p] & 0x7f, len = (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3];
    const s = p + 4, e = s + len;
    if (e > b.length) return { tags: out, needMore: e };
    if (type === 0) {
      const o = s + 10;
      out.sampleRate = (b[o] << 12) | (b[o + 1] << 4) | (b[o + 2] >> 4);
      out.channels = ((b[o + 2] >> 1) & 7) + 1;
      out.bits = (((b[o + 2] & 1) << 4) | (b[o + 3] >> 4)) + 1;
      const total = (b[o + 3] & 0x0f) * 4294967296 + ((b[o + 4] << 24) >>> 0) + (b[o + 5] << 16) + (b[o + 6] << 8) + b[o + 7];
      if (out.sampleRate) out.duration = total / out.sampleRate;
    } else if (type === 4) vorbis(b.subarray(s, e), out);
    else if (type === 6) {
      try {
        const d = b.subarray(s, e); let q = 0;
        const ptype = be32(d, q); q += 4; const ml = be32(d, q); q += 4; const mime = latin1(d.subarray(q, q + ml)); q += ml;
        const dl = be32(d, q); q += 4 + dl + 16; const datalen = be32(d, q); q += 4;
        const data = d.slice(q, q + datalen);
        if (!out.picture || ptype === 3) out.picture = { type: ptype, mime: sniffMime(data, mime), data };
      } catch { }
    }
    p = e; if (last) break;
  }
  return { tags: out };
}

/* ---------------- WAV ---------------- */
function parseWAV(b, size) {
  const out = { codec: 'WAV' };
  const f = indexOfStr(b, 'fmt ', 12, Math.min(b.length, 4096));
  if (f > 0) {
    out.channels = le16(b, f + 10); out.sampleRate = le32(b, f + 12);
    const byteRate = le32(b, f + 16); out.bits = le16(b, f + 22);
    if (byteRate) out.duration = (size - 44) / byteRate;
  }
  for (const [tag, key] of [['INAM', 'title'], ['IART', 'artist'], ['IPRD', 'album']]) {
    const i = indexOfStr(b, tag); if (i > 0) { const l = le32(b, i + 4); out[key] = latin1(b.subarray(i + 8, i + 8 + l)).replace(/\0+$/, '').trim(); }
  }
  return out;
}

/* ---------------- M4A / ALAC / AAC ---------------- */
function parseM4A(b, out = {}) {
  if (!out.codec) {
    const alac = indexOfStr(b, 'alac'), mp4a = indexOfStr(b, 'mp4a'), flac = indexOfStr(b, 'fLaC');
    if (alac >= 0) {
      out.codec = 'ALAC';
      const inner = indexOfStr(b, 'alac', alac + 4);
      if (inner > 0 && inner + 32 <= b.length) { out.bits = b[inner + 13]; out.channels = b[inner + 17]; out.sampleRate = be32(b, inner + 28); }
    } else if (flac >= 0) out.codec = 'FLAC';
    else if (mp4a >= 0) { out.codec = 'AAC'; if (mp4a + 32 <= b.length) out.sampleRate = be32(b, mp4a + 28) >>> 16; }
  }
  const mv = indexOfStr(b, 'mvhd');
  if (mv > 0 && !out.duration) {
    const v = b[mv + 4];
    const ts = v === 1 ? be32(b, mv + 24) : be32(b, mv + 16);
    const du = v === 1 ? be32(b, mv + 28) * 4294967296 + be32(b, mv + 32) : be32(b, mv + 20);
    if (ts) out.duration = du / ts;
  }
  const atoms = [['©nam', 'title'], ['©ART', 'artist'], ['aART', 'albumArtist'], ['©alb', 'album'], ['©day', 'year'], ['©gen', 'genre']];
  for (const [name, key] of atoms) {
    if (out[key]) continue;
    const i = indexOfStr(b, name);
    if (i > 0 && latin1(b.subarray(i + 8, i + 12)) === 'data') {
      const sz = be32(b, i + 4); out[key] = utf8.decode(b.subarray(i + 20, Math.min(b.length, i + 4 + sz))).trim();
    }
  }
  const tk = indexOfStr(b, 'trkn');
  if (tk > 0 && latin1(b.subarray(tk + 8, tk + 12)) === 'data' && !out.track) out.track = String(be16(b, tk + 22));
  const cv = indexOfStr(b, 'covr');
  if (cv > 0 && !out.picture && latin1(b.subarray(cv + 8, cv + 12)) === 'data') {
    const sz = be32(b, cv + 4); const end = cv + 4 + sz;
    if (end <= b.length) { const data = b.slice(cv + 20, end); out.picture = { type: 3, mime: sniffMime(data), data }; }
  }
  return out;
}

/* ---------------- OGG / OPUS ---------------- */
function parseOgg(b) {
  const out = {};
  const oh = indexOfStr(b, 'OpusHead');
  if (oh >= 0) { out.codec = 'OPUS'; out.channels = b[oh + 9]; out.sampleRate = 48000; }
  else { const vh = indexOfStr(b, '\x01vorbis'); out.codec = 'OGG'; if (vh >= 0) { out.channels = b[vh + 11]; out.sampleRate = le32(b, vh + 12); out.bitrate = Math.round(le32(b, vh + 20) / 1000) || undefined; } }
  const ot = indexOfStr(b, 'OpusTags'); if (ot >= 0) vorbis(b.subarray(ot + 8), out);
  const vc = indexOfStr(b, '\x03vorbis'); if (vc >= 0) vorbis(b.subarray(vc + 7), out);
  return out;
}

/* ---------------- Etiquetas de calidad ---------------- */
const khz = sr => (sr / 1000).toFixed(sr % 1000 ? 1 : 0).replace('.0', '');
export function qualityOf(t) {
  const c = t.codec || (t.ext || '').toUpperCase();
  const lossless = ['FLAC', 'ALAC', 'WAV', 'AIFF'].includes(c);
  let long = c, short = c;
  if (lossless && t.bits && t.sampleRate) { long = `${c} · ${t.bits}-bit / ${khz(t.sampleRate)} kHz`; short = `${c} ${t.bits}/${khz(t.sampleRate)}`; }
  else if (lossless && t.sampleRate) { long = `${c} · ${khz(t.sampleRate)} kHz`; }
  else if (t.bitrate) { long = `${c} · ${t.vbr ? '~' : ''}${t.bitrate} kbps`; short = `${c} ${t.bitrate}`; }
  return { long, short, lossless, hires: lossless && ((t.bits || 0) > 16 || (t.sampleRate || 0) > 48000) };
}

/* ---------------- Entrada principal ---------------- */
export async function readTags({ size, ext, fetchRange }) {
  const first = Math.min(size, 131072);
  let b = new Uint8Array(await fetchRange(0, first - 1));
  const head = latin1(b.subarray(0, 4));
  let res = {};

  if (head.startsWith('ID3')) {
    const tsize = syncsafe(b, 6) + 10;
    if (tsize + 4096 > b.length && tsize < CAP && b.length < size) b = new Uint8Array(await fetchRange(0, Math.min(size, tsize + 8192) - 1));
    const { tags, size: ts } = parseID3(b);
    res = tags;
    if (latin1(b.subarray(ts, ts + 4)) === 'fLaC') {
      const r = parseFLAC(b, ts); Object.assign(res, r.tags, { title: res.title || r.tags.title });
    } else {
      let info = b.length > ts + 1024 ? mp3Info(b, ts, size - ts) : null;
      if (!info && ts < size) { const c = new Uint8Array(await fetchRange(ts, Math.min(size, ts + 16384) - 1)); info = mp3Info(c, 0, size - ts); }
      if (info) Object.assign(res, info);
      res.codec = ext === 'mp3' || info ? 'MP3' : (ext || '').toUpperCase();
    }
  } else if (head === 'fLaC') {
    let r = parseFLAC(b);
    if (r.needMore && r.needMore < CAP && b.length < size) { b = new Uint8Array(await fetchRange(0, Math.min(size, r.needMore + 1024) - 1)); r = parseFLAC(b); }
    res = r.tags;
  } else if (head === 'RIFF') {
    res = parseWAV(b, size);
  } else if (latin1(b.subarray(4, 8)) === 'ftyp') {
    res = parseM4A(b);
    if (indexOfStr(b, 'moov') < 0 && size > first) {
      const start = Math.max(first, size - 1572864);
      const tail = new Uint8Array(await fetchRange(start, size - 1));
      res = parseM4A(tail, res);
    }
  } else if (head === 'OggS') {
    res = parseOgg(b);
  } else {
    const info = mp3Info(b, 0, size);
    if (info) { res = info; res.codec = 'MP3'; }
  }

  if (!res.codec) res.codec = (ext || '').toUpperCase();
  if (!res.bitrate && res.duration && !['FLAC', 'ALAC', 'WAV'].includes(res.codec)) res.bitrate = Math.round(size * 8 / res.duration / 1000);
  return res;
}
