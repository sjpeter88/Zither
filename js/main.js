// Concert Zither — application glue: interface, chords, keyboard, transport.
import { STRINGS, MELODY_COUNT, N_STRINGS, GROUP_START, CHORD_ROOTS, PC_NAMES, chordStrings, chordName, placeMelodyNote } from './zither-model.js';
import { ZitherScene } from './scene.js';
import { ZitherAudio } from './audio.js';
import { ZitherInput } from './input.js';
import { SongPlayer } from './player.js';
import { SONGS, ACCURACY } from './songs.js';

const $ = (id) => document.getElementById(id);
const host = window.chrome && window.chrome.webview ? window.chrome.webview : null;   // Windows shell
const params = new URLSearchParams(location.search);
const KEY = 'concertzither.settings.v1';

// ---- settings (remembered between sessions) -------------------------------------
const settings = Object.assign({
  mirror: false, labels: true, tapSounds: true, autoPluck: true, volume: 0.8, reverb: 0.22, resonance: 0.5,
  quality: 'maj', pattern: 'oompah', view: 'play', tempo: 100, song: null,
}, (() => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; } })());
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch (e) { /* private mode */ } };

// ---- core objects --------------------------------------------------------------------
const canvas = $('stage');
let scene;
try { scene = new ZitherScene(canvas); } catch (e) {
  $('startNote').textContent = 'This device could not start WebGL, which the 3D view needs.';
  $('startBtn').disabled = true;
  throw e;
}
const audio = new ZitherAudio();
Object.assign(audio.settings, { volume: settings.volume, reverb: settings.reverb, resonance: settings.resonance });
const input = new ZitherInput(canvas, scene, audio, settings);
const player = new SongPlayer(audio, scene);
audio.onLevels = (lv) => scene.setLevels(lv);

scene.setMirror(settings.mirror);
scene.setLabels(settings.labels);
scene.setView(settings.view, true);

function layout() {
  const top = $('topbar').getBoundingClientRect(), bottom = $('chordbar').getBoundingClientRect();
  scene.setInsets(top.bottom + 6, window.innerHeight - bottom.top + 6);
}
window.addEventListener('resize', layout);
window.addEventListener('orientationchange', () => setTimeout(layout, 250));
if (window.visualViewport) window.visualViewport.addEventListener('resize', layout);
layout();

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  scene.update(dt);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---- toast ------------------------------------------------------------------------------
let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

// ---- audio start (first tap) ----------------------------------------------------------------
function report(extra) {
  const info = {
    type: 'audio', state: audio.ctx ? audio.ctx.state : 'none', sampleRate: audio.ctx ? audio.ctx.sampleRate : 0,
    baseLatencyMs: audio.ctx && audio.ctx.baseLatency ? Math.round(audio.ctx.baseLatency * 1000) : null,
    engineReports: audio.reports, engineBlocks: audio.blocks, stringPeak: +audio.peak.toFixed(4), ...extra,
  };
  if (host) host.postMessage(info);
  return info;
}
window.zitherStatus = () => report({});

async function startAudio() {
  try {
    await audio.start();
    $('start').classList.add('gone');
    setTimeout(() => { $('start').hidden = true; }, 600);
    $('audioInfo').textContent = `Audio running at ${audio.ctx.sampleRate} Hz · 42 modelled strings · three.js r170`;
    report({});
    return true;
  } catch (e) {
    console.error(e);
    $('startNote').textContent = 'Audio could not start: ' + e.message;
    report({ error: String(e.message || e) });
    return false;
  }
}
$('startBtn').addEventListener('click', startAudio);
$('start').addEventListener('click', (e) => { if (e.target === $('start')) startAudio(); });
// iOS suspends audio when the app goes to the background; wake it on the next touch
for (const ev of ['pointerup', 'touchend', 'keydown'])
  document.addEventListener(ev, () => { if (audio.ready && audio.ctx.state !== 'running') audio.ctx.resume(); }, { passive: true });
document.addEventListener('visibilitychange', () => { if (document.hidden && player.playing) { player.pause(); syncTransport(); } });
audio.onState = (state) => { if (state === 'interrupted' || state === 'suspended') { if (player.playing) { player.pause(); syncTransport(); } } };

// ---- chords ---------------------------------------------------------------------------------
const RED = new Set([5, 9, 1]);
const KEYS = ['Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P', '[', ']'];
const rootsEl = $('roots');
let currentRoot = null, chordTimers = [];
CHORD_ROOTS.forEach((pc, i) => {
  const b = document.createElement('button');
  b.className = 'root' + (RED.has(pc) ? ' red' : '');
  b.dataset.pc = pc;
  b.innerHTML = `${PC_NAMES[pc]}<small>${KEYS[i]}</small>`;
  b.title = `${PC_NAMES[pc]} chord — key ${KEYS[i]}`;
  b.addEventListener('pointerdown', (e) => { e.preventDefault(); pressChord(pc); });
  rootsEl.appendChild(b);
});

function markRoot(pc) {
  for (const b of rootsEl.children) b.classList.toggle('active', pc != null && +b.dataset.pc === pc);
}
function showChord(pc, quality) {
  const cs = chordStrings(pc, quality);
  scene.setHints([...cs.acc.map((s) => [s, 0]), [cs.bass, 1]]);
  markRoot(pc);
  return cs;
}
function pluckAt(string, vel, delay, fret) {
  const t = audio.now + 0.01 + delay;
  audio.pluck(string, vel, fret, t);
  chordTimers.push(setTimeout(() => scene.flash(string), delay * 1000));
}
function strum(strings, vel, delay, spread = 0.014) { strings.forEach((s, k) => pluckAt(s, vel, delay + k * spread)); }

/** Select a chord; with auto-pluck on, play it in the chosen pattern. */
async function pressChord(pc, opts = {}) {
  currentRoot = pc;
  const cs = showChord(pc, settings.quality);
  if (!(await startAudio())) return;
  if (!settings.autoPluck && !opts.force) return;
  chordTimers.forEach(clearTimeout); chordTimers = [];
  const p = opts.pattern || settings.pattern;
  if (p === 'together') { pluckAt(cs.bass, 0.7, 0); pluckAt(cs.contra, 0.45, 0); strum(cs.acc, 0.55, 0.012); }
  else if (p === 'oompah') { pluckAt(cs.bass, 0.72, 0); pluckAt(cs.contra, 0.45, 0); strum(cs.acc, 0.52, 0.3); }
  else if (p === 'waltz') { pluckAt(cs.bass, 0.72, 0); pluckAt(cs.contra, 0.45, 0); strum(cs.acc, 0.5, 0.36); strum(cs.acc, 0.46, 0.72); }
  else if (p === 'arp') { pluckAt(cs.bass, 0.7, 0); [...cs.acc, cs.acc[1], cs.acc[cs.acc.length - 1]].forEach((s, k) => pluckAt(s, 0.52, 0.18 * (k + 1))); }
  else if (p === 'bass') pluckAt(cs.bass, 0.75, 0);
  else if (p === 'alt') pluckAt(cs.altBass, 0.7, 0);
  else if (p === 'chord') strum(cs.acc, 0.58, 0);
}

function segmented(el, attr, key, onChange) {
  const sync = () => { for (const b of el.children) b.classList.toggle('active', b.dataset[attr] === settings[key]); };
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    settings[key] = b.dataset[attr]; save(); sync(); if (onChange) onChange();
  });
  sync(); return sync;
}
const syncQuality = segmented($('qualitySeg'), 'q', 'quality', () => { if (currentRoot != null) showChord(currentRoot, settings.quality); });
segmented($('patternSeg'), 'p', 'pattern');
const autoBtn = $('autoBtn');
const syncAuto = () => autoBtn.setAttribute('aria-pressed', String(settings.autoPluck));
autoBtn.addEventListener('click', () => { settings.autoPluck = !settings.autoPluck; save(); syncAuto(); toast(settings.autoPluck ? 'Auto-pluck on: choosing a chord plays it.' : 'Auto-pluck off: chords are only highlighted — pluck the lit strings yourself.'); });
syncAuto();
function dampAll() { audio.dampAll(); scene.setHints([]); markRoot(null); currentRoot = null; }
$('dampBtn').addEventListener('click', dampAll);

// glissando over a whole group of open strings
function gliss(up) {
  if (!audio.ready) return;
  const list = [];
  for (let i = GROUP_START.acc; i < GROUP_START.bass; i++) list.push(i);
  list.sort((a, b) => STRINGS[a].midi - STRINGS[b].midi);
  if (!up) list.reverse();
  list.forEach((s, k) => pluckAt(s, 0.5 + 0.2 * (k / list.length), k * 0.035));
}

// ---- keyboard ---------------------------------------------------------------------------------
const MELODY_KEYS = { a: 60, s: 62, d: 64, f: 65, g: 67, h: 69, j: 71, k: 72, l: 74, ';': 76, "'": 77 };
const heldKeys = new Map();
window.addEventListener('keydown', async (e) => {
  if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target instanceof HTMLInputElement && e.target.type !== 'range' && e.target.type !== 'checkbox') return;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const ci = KEYS.indexOf(k.toUpperCase());
  if (ci >= 0) { e.preventDefault(); pressChord(CHORD_ROOTS[ci]); return; }
  if (k === '1' || k === '2' || k === '3') { settings.quality = ['maj', 'min', 'dom7'][+k - 1]; save(); syncQuality(); if (currentRoot != null) showChord(currentRoot, settings.quality); return; }
  if (k === 'Enter') { e.preventDefault(); togglePlay(); return; }
  if (k === 'Escape') { closePanels(); if (audio.ready) dampAll(); return; }
  if (k === 'm') { setMirror(!settings.mirror); return; }
  if (!(await startAudio())) return;
  if (k in MELODY_KEYS) {
    const busy = new Set([...heldKeys.values()].map((v) => v.string));
    const place = placeMelodyNote(MELODY_KEYS[k] + 12, busy, 7);
    if (place) { heldKeys.set(k, place); audio.pluck(place.string, 0.82, place.fret); scene.setFinger(place.string, place.fret, 'user'); scene.flash(place.string); }
    return;
  }
  const root = currentRoot == null ? 0 : currentRoot;
  if (k === ' ') { e.preventDefault(); pressChord(root, { force: true }); }
  else if (k === 'z') pressChord(root, { force: true, pattern: 'bass' });
  else if (k === 'x') pressChord(root, { force: true, pattern: 'chord' });
  else if (k === 'c') pressChord(root, { force: true, pattern: 'alt' });
  else if (k === 'v') pressChord(root, { force: true, pattern: 'arp' });
  else if (k === 'ArrowUp') { e.preventDefault(); gliss(true); }
  else if (k === 'ArrowDown') { e.preventDefault(); gliss(false); }
});
window.addEventListener('keyup', (e) => {
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const held = heldKeys.get(k);
  if (held) { heldKeys.delete(k); scene.setFinger(held.string, 0, 'user'); audio.damp(held.string); }
});

// ---- song library and transport ---------------------------------------------------------------
const listEl = $('songList');
let songIndex = -1;
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
(() => {
  let cat = null;
  SONGS.forEach((song, i) => {
    if (song.category !== cat) { cat = song.category; const h = document.createElement('h3'); h.textContent = cat; listEl.appendChild(h); }
    const b = document.createElement('button');
    b.className = 'song'; b.dataset.i = i;
    const acc = ACCURACY[song.accuracy];
    b.innerHTML = `<b></b><span class="badge ${song.accuracy}" title="${acc.note}">${acc.label}</span><i></i><span class="src"></span>`;
    b.querySelector('b').textContent = song.title;
    b.querySelector('i').textContent = `${song.composer}${song.year ? ' · ' + song.year : ''} · ${song.key} · ${song.meter}`;
    b.querySelector('.src').textContent = song.source;
    b.addEventListener('click', () => { loadSong(i); player.play().then(syncTransport); });
    listEl.appendChild(b);
  });
})();

function loadSong(i) {
  songIndex = (i + SONGS.length) % SONGS.length;
  const song = SONGS[songIndex];
  try { player.load(song); } catch (e) { console.error(e); toast('Could not load this piece.'); return; }
  player.setTempoScale(settings.tempo / 100);
  $('songTitle').textContent = song.title;
  $('songSub').textContent = `${song.composer} · ${ACCURACY[song.accuracy].label.toLowerCase()}`;
  for (const b of listEl.querySelectorAll('.song')) b.classList.toggle('current', +b.dataset.i === songIndex);
  settings.song = song.id; save();
  syncTransport();
}
function syncTransport() {
  $('playIcon').setAttribute('d', player.playing ? 'M7 5h3.5v14H7zM13.5 5H17v14h-3.5z' : 'M7 4l13 8-13 8z');
  $('playBtn').setAttribute('aria-label', player.playing ? 'Pause' : 'Play');
}
async function togglePlay() {
  if (songIndex < 0) loadSong(0);
  if (player.playing) player.pause(); else { if (!(await startAudio())) return; await player.play(); }
  syncTransport();
}
player.onState = syncTransport;
player.onProgress = (p, d) => {
  $('progressFill').style.width = (d ? (p / d) * 100 : 0) + '%';
  $('timeNow').textContent = fmt(p / (settings.tempo / 100)); $('timeEnd').textContent = fmt(d / (settings.tempo / 100));
};
player.onChord = (ch) => { markRoot(ch ? ch.rootPc : null); currentRoot = ch ? ch.rootPc : currentRoot; };
player.onEnd = () => { syncTransport(); };
$('playBtn').addEventListener('click', togglePlay);
$('stopBtn').addEventListener('click', () => { player.stop(); markRoot(null); syncTransport(); });
$('prevBtn').addEventListener('click', () => { const was = player.playing; loadSong(songIndex - 1); if (was) player.play().then(syncTransport); });
$('nextBtn').addEventListener('click', () => { const was = player.playing; loadSong(songIndex + 1); if (was) player.play().then(syncTransport); });
$('loopBtn').addEventListener('click', () => { player.loop = !player.loop; $('loopBtn').setAttribute('aria-pressed', String(player.loop)); });
$('progress').addEventListener('pointerdown', (e) => {
  if (songIndex < 0) return;
  const r = $('progress').getBoundingClientRect();
  player.seek(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * player.duration);
});
const tempo = $('tempo');
tempo.value = settings.tempo; $('tempoOut').textContent = settings.tempo + '%';
tempo.addEventListener('input', () => { settings.tempo = +tempo.value; $('tempoOut').textContent = settings.tempo + '%'; player.setTempoScale(settings.tempo / 100); save(); });

// ---- panels and settings ---------------------------------------------------------------------------
function closePanels() { $('library').hidden = true; $('settings').hidden = true; }
function togglePanel(id) { const el = $(id), open = el.hidden; closePanels(); el.hidden = !open; }
$('songBtn').addEventListener('click', () => togglePanel('library'));
$('settingsBtn').addEventListener('click', () => togglePanel('settings'));
for (const b of document.querySelectorAll('[data-close]')) b.addEventListener('click', closePanels);
canvas.addEventListener('pointerdown', closePanels);

for (const b of document.querySelectorAll('.views .chip')) {
  b.classList.toggle('active', b.dataset.view === settings.view);
  b.addEventListener('click', () => {
    settings.view = b.dataset.view; save(); scene.setView(settings.view);
    for (const o of document.querySelectorAll('.views .chip')) o.classList.toggle('active', o === b);
  });
}
function slider(id, key, apply) {
  const el = $(id); el.value = Math.round(settings[key] * 100);
  el.addEventListener('input', () => { settings[key] = el.value / 100; apply(settings[key]); save(); });
}
slider('volume', 'volume', (v) => audio.setVolume(v));
slider('reverb', 'reverb', (v) => audio.setReverb(v));
slider('resonance', 'resonance', (v) => audio.setResonance(v));
function setMirror(on) { settings.mirror = on; $('mirror').checked = on; scene.setMirror(on); save(); }
function checkbox(id, key, apply) {
  const el = $(id); el.checked = !!settings[key];
  el.addEventListener('change', () => { settings[key] = el.checked; if (apply) apply(el.checked); save(); });
}
checkbox('mirror', 'mirror', (v) => scene.setMirror(v));
checkbox('labels', 'labels', (v) => scene.setLabels(v));
checkbox('tapSounds', 'tapSounds');

// restore the last piece (without playing it)
{
  const i = SONGS.findIndex((s) => s.id === settings.song);
  loadSong(i >= 0 ? i : 0);
}

// ---- offline support -----------------------------------------------------------------------------------
if ('serviceWorker' in navigator && !host && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// ---- self-test for the Windows shell: start audio without a gesture and report back ---------------------
if (params.has('selftest')) {
  (async () => {
    const ok = await startAudio();
    if (ok) { pressChord(0, { force: true, pattern: 'together' }); audio.pluck(0, 0.9, 5); }
    setTimeout(() => {
      const r = report({ type: 'selftest', started: ok, userAgent: navigator.userAgent });
      window.__selftest = r;
    }, 2500);
  })();
}
window.__zither = { scene, audio, player, input, settings, SONGS, pressChord, loadSong };
