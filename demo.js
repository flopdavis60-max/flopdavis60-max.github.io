// Música de demostración: portadas y canciones generadas en el propio dispositivo (no usa internet).

const ALBUMS = [
  { artist: 'Luna Costera', album: 'Mareas', year: 2025, hue: 185, tracks: ['Brisa de sal', 'Faro', 'Arena tibia', 'Mareas', 'Luz de agosto'] },
  { artist: 'Luna Costera', album: 'Noches de puerto', year: 2023, hue: 255, tracks: ['Neón', 'Muelle 9', 'Última barca'] },
  { artist: 'Los Satélites', album: 'Órbita baja', year: 2024, hue: 320, tracks: ['Despegue', 'Gravedad cero', 'Polvo de estrellas', 'Reentrada'] },
  { artist: 'Ámbar Ruiz', album: 'Café a las 7', year: 2026, hue: 28, tracks: ['Mañana lenta', 'Taza doble', 'Domingo', 'Ventana'] },
  { artist: 'Selva Norte', album: 'Verde', year: 2022, hue: 120, tracks: ['Raíz', 'Lluvia fina', 'Musgo'] },
];

function hash(s) { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }

function makeCover(a) {
  const c = document.createElement('canvas'); c.width = c.height = 512;
  const g = c.getContext('2d');
  const h = a.hue;
  const grd = g.createLinearGradient(0, 0, 512, 512);
  grd.addColorStop(0, `hsl(${h} 70% 55%)`); grd.addColorStop(1, `hsl(${(h + 60) % 360} 65% 18%)`);
  g.fillStyle = grd; g.fillRect(0, 0, 512, 512);
  const r = hash(a.album);
  g.globalCompositeOperation = 'screen';
  for (let i = 0; i < 6; i++) {
    const x = (r >>> (i * 3)) % 512, y = (r >>> (i * 2 + 5)) % 512, rad = 60 + ((r >>> i) % 160);
    const rg = g.createRadialGradient(x, y, 0, x, y, rad);
    rg.addColorStop(0, `hsla(${(h + i * 25) % 360} 90% 70% / .55)`); rg.addColorStop(1, 'transparent');
    g.fillStyle = rg; g.beginPath(); g.arc(x, y, rad, 0, 7); g.fill();
  }
  g.globalCompositeOperation = 'source-over';
  g.strokeStyle = 'rgba(255,255,255,.25)'; g.lineWidth = 3;
  for (let k = 0; k < 5; k++) {
    g.beginPath();
    for (let x = 0; x <= 512; x += 8) { const y = 330 + k * 26 + Math.sin(x / 40 + k + r % 7) * (14 + k * 3); x ? g.lineTo(x, y) : g.moveTo(x, y); }
    g.stroke();
  }
  g.fillStyle = '#fff'; g.font = '800 46px system-ui, sans-serif'; g.textBaseline = 'top';
  g.fillText(a.album.toUpperCase(), 32, 34);
  g.font = '600 24px system-ui, sans-serif'; g.globalAlpha = .8; g.fillText(a.artist, 34, 90); g.globalAlpha = 1;
  return c.toDataURL('image/jpeg', .88);
}

export function buildDemo() {
  const tracks = [], covers = new Map();
  let n = 0;
  for (const a of ALBUMS) {
    const cover = makeCover(a);
    a.tracks.forEach((title, i) => {
      const seed = hash(a.album + title);
      tracks.push({
        id: 'demo-' + (n++), demo: true, title, artist: a.artist, album: a.album, year: String(a.year),
        trackNo: i + 1, disc: 1, duration: 24, ext: 'wav', codec: 'WAV', bits: 16, sampleRate: 44100,
        size: 24 * 176400, mod: new Date(Date.UTC(a.year, (seed % 12), 1 + seed % 27)).toISOString(), seed, cover,
      });
    });
    covers.set(a, cover);
  }
  return tracks;
}

/* --------- Síntesis de audio (OfflineAudioContext → WAV) --------- */
const cache = new Map();
const midiHz = m => 440 * Math.pow(2, (m - 69) / 12);

export async function renderDemoAudio(t) {
  if (cache.has(t.id)) return cache.get(t.id);
  const sr = 44100, dur = t.duration;
  const ctx = new OfflineAudioContext(2, sr * dur, sr);
  const seed = t.seed;
  const minor = seed % 2 === 1;
  const scale = minor ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11];
  const degs = minor ? [[0, 5, 2, 6], [0, 3, 4, 0], [5, 6, 0, 0]][seed % 3] : [[0, 4, 5, 3], [0, 5, 3, 4], [3, 4, 0, 5]][seed % 3];
  const root = 48 + (seed % 9);
  const bpm = 78 + (seed % 36);
  const beat = 60 / bpm, bar = beat * 4;

  const master = ctx.createGain(); master.gain.value = 0.55;
  const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -14; comp.ratio.value = 3;
  master.connect(comp).connect(ctx.destination);
  // eco ligero (más barato que una reverberación por convolución)
  const conv = ctx.createDelay(1); conv.delayTime.value = 60 / (78 + (t.seed % 36)) * .75;
  const fb = ctx.createGain(); fb.gain.value = .32; const wet = ctx.createGain(); wet.gain.value = .22;
  const damp = ctx.createBiquadFilter(); damp.type = 'lowpass'; damp.frequency.value = 2500;
  conv.connect(damp).connect(fb).connect(conv); damp.connect(wet).connect(master);
  const note = (midi, start, len, type, vol, pan = 0, cutoff = 4000) => {
    const o = ctx.createOscillator(); o.type = type; o.frequency.value = midiHz(midi);
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = cutoff;
    const g = ctx.createGain(); const p = ctx.createStereoPanner(); p.pan.value = pan;
    g.gain.setValueAtTime(0, start); g.gain.linearRampToValueAtTime(vol, start + Math.min(.04, len / 4));
    g.gain.exponentialRampToValueAtTime(0.0008, start + len);
    o.connect(f).connect(g).connect(p); p.connect(master); if (type === 'sine' && vol < .1) p.connect(conv);
    o.start(start); o.stop(start + len + .05);
  };
  const tri = d => [0, 2, 4].map(k => { const idx = d + k; return root + scale[idx % 7] + 12 * Math.floor(idx / 7); });

  const bars = Math.ceil(dur / bar);
  for (let b = 0; b < bars; b++) {
    const t0 = b * bar; const chord = tri(degs[b % 4]);
    chord.forEach((m, i) => note(m + 12, t0, bar * 1.05, 'triangle', .07, (i - 1) * .4, 1800));
    for (let s = 0; s < 8; s++) {
      const m = chord[(s * (seed % 3 + 1)) % 3] + 24 + (s % 4 === 3 ? 12 : 0);
      note(m, t0 + s * beat / 2, beat * .9, 'sine', .06, Math.sin(s) * .5, 6000);
    }
    for (let q = 0; q < 4; q++) note(chord[0] - 12, t0 + q * beat, beat * .85, 'sine', .22, 0, 600);
    if (b > 0) for (let q = 0; q < 4; q++) {
      const kt = t0 + q * beat;
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.frequency.setValueAtTime(140, kt); o.frequency.exponentialRampToValueAtTime(42, kt + .18);
      g.gain.setValueAtTime(.55, kt); g.gain.exponentialRampToValueAtTime(.001, kt + .3);
      o.connect(g).connect(master); o.start(kt); o.stop(kt + .32);
    }
  }
  // fade out
  master.gain.setValueAtTime(.55, dur - 2.5); master.gain.linearRampToValueAtTime(0, dur);

  const buf = await ctx.startRendering();
  const url = URL.createObjectURL(toWav(buf));
  cache.set(t.id, url);
  return url;
}

function toWav(buf) {
  const ch = buf.numberOfChannels, len = buf.length, sr = buf.sampleRate;
  const data = new DataView(new ArrayBuffer(44 + len * ch * 2));
  const w = (o, s) => [...s].forEach((c, i) => data.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); data.setUint32(4, 36 + len * ch * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  data.setUint32(16, 16, true); data.setUint16(20, 1, true); data.setUint16(22, ch, true);
  data.setUint32(24, sr, true); data.setUint32(28, sr * ch * 2, true); data.setUint16(32, ch * 2, true); data.setUint16(34, 16, true);
  w(36, 'data'); data.setUint32(40, len * ch * 2, true);
  const chans = [...Array(ch)].map((_, i) => buf.getChannelData(i));
  let o = 44;
  for (let i = 0; i < len; i++) for (let c = 0; c < ch; c++) { const v = Math.max(-1, Math.min(1, chans[c][i])); data.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true); o += 2; }
  return new Blob([data], { type: 'audio/wav' });
}
