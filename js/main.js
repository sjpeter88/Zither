// Concert Zither — application glue: interface, chords, keyboard, transport.
import { STRINGS, MELODY_COUNT, N_STRINGS, GROUP_START, CHORD_ROOTS, PC_NAMES, chordStrings, chordName, placeMelodyNote, setTuning, TUNINGS, VOICES } from './zither-model.js';
import { MidiInput } from './midi.js';
import { ZitherScene } from './scene.js';
import { ZitherAudio } from './audio.js';
import { ZitherInput, startTremolo } from './input.js';
import { SongPlayer, songFromAbc } from './player.js';
import { Recorder } from './recorder.js';
import { SONGS, ACCURACY } from './songs.js';
import { TabStrip } from './tab.js';

const $ = (id) => document.getElementById(id);
const host = window.chrome && window.chrome.webview ? window.chrome.webview : null;   // Windows shell
const params = new URLSearchParams(location.search);
const KEY = 'concertzither.settings.v1';
export const APP_VERSION = '1.5.0';

// ---- settings (remembered between sessions) -------------------------------------
const settings = Object.assign({
  mirror: false, labels: true, tapSounds: true, autoPluck: true, volume: 0.8, reverb: 0.22, resonance: 0.5,
  quality: 'maj', pattern: 'oompah', view: 'play', tempo: 100, song: null,
  focus: 'all', latch: false, chordBpm: 108, vibrato: true,
  practice: false, mode: 'listen', wait: false, repeat: 'off',
  tremolo: true, tremoloDelay: 320, vibDepth: 1,
  tuning: 'munich', pitch: 440, voice: 'concert', finish: 'sunburst', hands: true, midi: false,
}, (() => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; } })());
setTuning(settings.tuning, settings.pitch);             // before anything places notes or starts the engine
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
Object.assign(audio.settings, { volume: settings.volume, reverb: settings.reverb, resonance: settings.resonance, voice: VOICES[settings.voice] || VOICES.concert });
const input = new ZitherInput(canvas, scene, audio, settings);
const player = new SongPlayer(audio, scene);
audio.onLevels = (lv) => scene.setLevels(lv);
const tab = new TabStrip($('tab'), player);
input.onPluck = (string, fret) => player.userPluck(STRINGS[string].midi + fret, string);
const recorder = new Recorder(audio, scene);

// songs added by the player are kept on this device
const USER_KEY = 'concertzither.songs.v1';
try { for (const s of JSON.parse(localStorage.getItem(USER_KEY)) || []) if (s && (s.abc || (s.take && Array.isArray(s.events)))) SONGS.push(s); } catch (e) { /* none */ }
const saveUserSongs = () => { try { localStorage.setItem(USER_KEY, JSON.stringify(SONGS.filter((s) => s.user))); } catch (e) { /* full or private */ } };
player.mode = settings.mode; player.wait = settings.wait; player.vibDepth = settings.vibDepth;
// in a zoomed framing, follow the part of the instrument the next note is on
player.onGate = (g) => { if (settings.focus === 'all') return; const want = g.bass ? 'chords' : 'frets'; if (settings.focus !== want) setZoom(want); };

scene.setMirror(settings.mirror);
scene.setLabels(settings.labels);
scene.setFinish(settings.finish);
scene.setHands(settings.hands);
scene.setView(settings.focus === 'all' ? settings.view : 'top', true);
scene.setFocus(settings.focus, true);
player.vibrato = settings.vibrato;

function layout() {
  const root = document.documentElement.style;
  root.setProperty('--bar-bottom', Math.round($('topbar').getBoundingClientRect().bottom) + 'px');
  root.setProperty('--chord-h', Math.round(window.innerHeight - $('chordbar').getBoundingClientRect().top) + 'px');
  const top = ($('practice').hidden ? $('topbar') : $('practice')).getBoundingClientRect(), bottom = $('chordbar').getBoundingClientRect();
  scene.setInsets(top.bottom + 6, window.innerHeight - bottom.top + 6);
  tab.resize();
}
window.addEventListener('resize', layout);
window.addEventListener('orientationchange', () => setTimeout(layout, 250));
if (window.visualViewport) window.visualViewport.addEventListener('resize', layout);
layout();

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  scene.update(dt);
  if (!$('practice').hidden) tab.draw();
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
    if (settings.midi && midi.supported && !midi.access) midi.connect().catch(() => {});
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
let currentRoot = null, chordTimers = [], chordLoop = null;
const holds = new Set();          // chord buttons and keys currently held down
CHORD_ROOTS.forEach((pc, i) => {
  const b = document.createElement('button');
  b.className = 'root' + (RED.has(pc) ? ' red' : '');
  b.dataset.pc = pc;
  b.innerHTML = `${PC_NAMES[pc]}<small>${KEYS[i]}</small>`;
  b.title = `${PC_NAMES[pc]} chord — key ${KEYS[i]}`;
  // hold the button to keep the pattern going; it stops at the end of the bar after you let go
  b.addEventListener('pointerdown', (e) => { e.preventDefault(); try { b.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ } holds.add('p' + e.pointerId); pressChord(pc); });
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) b.addEventListener(ev, (e) => holds.delete('p' + e.pointerId));
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
function pluckTime(string, vel, time, fret) {
  if (string < 0) return;
  audio.pluck(string, vel, fret, time);
  if (chordTimers.length > 200) chordTimers = [];
  chordTimers.push(setTimeout(() => scene.flash(string), Math.max(0, (time - audio.now) * 1000)));
}
function pluckAt(string, vel, delay, fret) { pluckTime(string, vel, audio.now + 0.01 + delay, fret); }
function strumAt(strings, vel, time, spread = 0.014) { strings.forEach((s, k) => pluckTime(s, vel, time + k * spread)); }

function stopChordLoop() { if (chordLoop) { clearTimeout(chordLoop.timer); chordLoop = null; } }

/** Play one bar of a pattern at audio time t; returns the bar length in seconds. */
function playBar(p, t, bar) {
  const cs = chordStrings(currentRoot, settings.quality), beat = 60 / settings.chordBpm;
  const bass = bar % 2 ? cs.altBass : cs.bass;            // alternate root and fifth, bar by bar
  if (p === 'together') { pluckTime(cs.bass, 0.7, t); if (!bar) pluckTime(cs.contra, 0.45, t); strumAt(cs.acc, 0.55, t + 0.012); return 2 * beat; }
  if (p === 'oompah') { pluckTime(bass, 0.72, t); if (bar % 2 === 0) pluckTime(cs.contra, 0.42, t); strumAt(cs.acc, 0.52, t + beat); return 2 * beat; }
  if (p === 'waltz') { pluckTime(bass, 0.72, t); if (bar % 2 === 0) pluckTime(cs.contra, 0.42, t); strumAt(cs.acc, 0.5, t + beat); strumAt(cs.acc, 0.46, t + 2 * beat); return 3 * beat; }
  pluckTime(bass, 0.7, t);
  [...cs.acc, cs.acc[1], cs.acc[cs.acc.length - 1]].slice(0, 5).forEach((s, k) => pluckTime(s, 0.52, t + (k + 1) * beat / 2));
  return 3 * beat;
}
function chordTick() {
  const lp = chordLoop; if (!lp) return;
  lp.t += playBar(lp.pattern, lp.t, lp.bar++);
  lp.timer = setTimeout(() => {
    if (chordLoop !== lp) return;
    if (holds.size || settings.latch) chordTick(); else chordLoop = null;
  }, Math.max(0, (lp.t - audio.now - 0.09) * 1000));
}

/** Select a chord; with auto-pluck on, play it in the chosen pattern. Held (or latched) it keeps going. */
async function pressChord(pc, opts = {}) {
  const again = chordLoop && currentRoot === pc && settings.latch && !opts.force;
  currentRoot = pc;
  showChord(pc, settings.quality);
  if (!(await startAudio())) return;
  if (again) { stopChordLoop(); return; }                 // latched: pressing the sounding chord again stops it
  if (!settings.autoPluck && !opts.force) return;
  const p = opts.pattern || settings.pattern, cs = chordStrings(pc, settings.quality), now = audio.now + 0.02;
  if (p !== 'chord' && p !== 'alt') player.userPluck(STRINGS[cs.bass].midi, cs.bass);      // counts as your bass note in Wait for me
  if (p === 'bass') { pluckTime(cs.bass, 0.75, now); return; }
  if (p === 'alt') { pluckTime(cs.altBass, 0.7, now); return; }
  if (p === 'chord') { strumAt(cs.acc, 0.58, now); return; }
  stopChordLoop();
  chordLoop = { pattern: p, t: now, bar: 0, timer: 0 };
  chordTick();
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
function dampAll() { stopChordLoop(); audio.dampAll(); scene.setHints([]); markRoot(null); currentRoot = null; }
$('dampBtn').addEventListener('click', dampAll);
const latchBtn = $('latchBtn');
const syncLatch = () => latchBtn.setAttribute('aria-pressed', String(settings.latch));
latchBtn.addEventListener('click', () => { settings.latch = !settings.latch; save(); syncLatch(); if (!settings.latch && !holds.size) stopChordLoop(); toast(settings.latch ? 'Latch on: a chord keeps playing until you press it again, choose another, or press Damp.' : 'Latch off: a chord keeps playing only while you hold its button.'); });
syncLatch();

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
  if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
  if (e.target instanceof HTMLInputElement && e.target.type !== 'range' && e.target.type !== 'checkbox') return;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const ci = KEYS.indexOf(k.toUpperCase());
  if (ci >= 0) { e.preventDefault(); holds.add('k' + k); pressChord(CHORD_ROOTS[ci]); return; }
  if (k === 'F2') { e.preventDefault(); cycleZoom(); return; }
  if (k === '1' || k === '2' || k === '3') { settings.quality = ['maj', 'min', 'dom7'][+k - 1]; save(); syncQuality(); if (currentRoot != null) showChord(currentRoot, settings.quality); return; }
  if (k === 'F1') { e.preventDefault(); togglePanel('manual'); return; }
  if (k === 'Escape' && (!$('manual').hidden || !$('importer').hidden)) { closePanels(); return; }
  if ((!$('manual').hidden || !$('importer').hidden) && k !== 'Enter') return;      // do not play notes while reading
  if (k === 'Enter') { e.preventDefault(); togglePlay(); return; }
  if (k === 'Escape') { closePanels(); if (audio.ready) dampAll(); return; }
  if (k === 'm') { setMirror(!settings.mirror); return; }
  if (!(await startAudio())) return;
  if (k in MELODY_KEYS) {
    const busy = new Set([...heldKeys.values()].map((v) => v.string));
    const place = placeMelodyNote(MELODY_KEYS[k] + 12, busy, 7);
    if (place) {
      player.userPluck(STRINGS[place.string].midi + place.fret);
      heldKeys.set(k, place); audio.pluck(place.string, 0.82, place.fret); scene.setFinger(place.string, place.fret, 'user'); scene.flash(place.string);
      if (e.shiftKey) place.stop = startTremolo(audio, scene, place.string, () => place.fret);     // Shift: tremolo while held
      else if (settings.vibrato) audio.vibrato(place.string, 0.16 * settings.vibDepth, 5.5, 0.35);
    }
    return;
  }
  const root = currentRoot == null ? 0 : currentRoot;
  if (k === ' ') { e.preventDefault(); holds.add('k '); pressChord(root, { force: true }); }
  else if (k === 'z') pressChord(root, { force: true, pattern: 'bass' });
  else if (k === 'x') pressChord(root, { force: true, pattern: 'chord' });
  else if (k === 'c') pressChord(root, { force: true, pattern: 'alt' });
  else if (k === 'v') pressChord(root, { force: true, pattern: 'arp' });
  else if (k === 'ArrowUp') { e.preventDefault(); gliss(true); }
  else if (k === 'ArrowDown') { e.preventDefault(); gliss(false); }
});
window.addEventListener('keyup', (e) => {
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  holds.delete('k' + k);
  const held = heldKeys.get(k);
  if (held && held.stop) held.stop();
  if (held) { heldKeys.delete(k); scene.setFinger(held.string, 0, 'user'); audio.damp(held.string); }
});

// ---- MIDI keyboard: keys below C3 choose chords, higher keys play the melody
const midi = new MidiInput(audio, scene, {
  onChordOn: (pc, id) => { holds.add(id); pressChord(pc, { force: true }); },
  onChordOff: (id) => holds.delete(id),
  onMelodyPluck: (m, s) => player.userPluck(m, s),
});
midi.onStatus = (names) => { $('midiStatus').textContent = names.length ? 'Connected: ' + names.join(', ') : 'No MIDI device found. Plug one in; it is picked up automatically.'; };
window.__midi = midi;

// ---- song library and transport ---------------------------------------------------------------
const listEl = $('songList');
let songIndex = -1;
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
function renderList() {
  listEl.textContent = '';
  let cat = null;
  SONGS.forEach((song, i) => {
    if (song.category !== cat) { cat = song.category; const h = document.createElement('h3'); h.textContent = cat; listEl.appendChild(h); }
    const b = document.createElement('button');
    b.className = 'song' + (i === songIndex ? ' current' : ''); b.dataset.i = i;
    const acc = ACCURACY[song.accuracy] || ACCURACY.user;
    b.innerHTML = `<b></b><span class="badge ${song.accuracy}" title="${acc.note}">${acc.label}</span><i></i><span class="src"></span>`;
    b.querySelector('b').textContent = song.title;
    b.querySelector('i').textContent = song.take ? `Recorded on this zither · ${fmt(song.duration)}` : `${song.composer}${song.year ? ' · ' + song.year : ''} · ${song.key} · ${song.meter}`;
    b.querySelector('.src').textContent = song.source;
    if (song.user) {
      const del = document.createElement('span');
      del.className = 'del'; del.textContent = 'Remove'; del.setAttribute('role', 'button');
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        const cur = SONGS[songIndex];
        SONGS.splice(SONGS.indexOf(song), 1); saveUserSongs();
        if (cur === song) { player.stop(); songIndex = -1; loadSong(0); } else songIndex = SONGS.indexOf(cur);
        renderList();
      });
      b.querySelector('.src').appendChild(del);
    }
    b.addEventListener('click', () => { loadSong(i); if (song.take) togglePlay(); else player.play().then(syncTransport); });
    listEl.appendChild(b);
  });
}
renderList();

function loadSong(i) {
  songIndex = (i + SONGS.length) % SONGS.length;
  const song = SONGS[songIndex];
  if (song.take) {                                         // a kept recording: played by the recorder, not the song player
    player.stop(); player.song = null; player.compiled = null;
    recorder.loadTake(song.events);
    $('songTitle').textContent = song.title;
    $('songSub').textContent = 'Your recording · ' + fmt(song.duration);
    for (const b of listEl.querySelectorAll('.song')) b.classList.toggle('current', +b.dataset.i === songIndex);
    settings.song = song.id; save(); syncTransport();
    return;
  }
  try { player.load(song); } catch (e) { console.error(e); toast('Could not load this piece.'); return; }
  player.setTempoScale(settings.tempo / 100);
  $('songTitle').textContent = song.title;
  syncSongSub();
  for (const b of listEl.querySelectorAll('.song')) b.classList.toggle('current', +b.dataset.i === songIndex);
  settings.song = song.id; save();
  syncTransport();
}
function syncSongSub() {
  const song = SONGS[songIndex]; if (!song || song.take) return;
  const mode = { listen: '', melody: settings.wait ? ' · waits for your melody' : ' · you play the melody', chords: settings.wait ? ' · waits for your bass notes' : ' · you play the chords' }[settings.mode];
  $('songSub').textContent = `${song.composer} · ${ACCURACY[song.accuracy].label.toLowerCase()}${mode}`;
}
function syncTransport() {
  $('playIcon').setAttribute('d', player.playing ? 'M7 5h3.5v14H7zM13.5 5H17v14h-3.5z' : 'M7 4l13 8-13 8z');
  $('playBtn').setAttribute('aria-label', player.playing ? 'Pause' : 'Play');
}
async function togglePlay() {
  if (songIndex < 0) loadSong(0);
  const cur = SONGS[songIndex];
  if (cur && cur.take) { if (recorder.playing) recorder.stopPlayback(); else { if (!(await startAudio())) return; recorder.play(); } return; }
  if (player.playing) player.pause(); else { if (!(await startAudio())) return; await player.play(); }
  syncTransport();
}
player.onState = syncTransport;
player.onProgress = (p, d) => {
  $('progressFill').style.width = (d ? (p / d) * 100 : 0) + '%';
  $('timeNow').textContent = fmt(p / (settings.tempo / 100)); $('timeEnd').textContent = fmt(d / (settings.tempo / 100));
};
player.onChord = (ch) => { markRoot(ch ? ch.rootPc : null); currentRoot = ch ? ch.rootPc : currentRoot; };
// at the end of a piece: stop, or (repeat "all") go on to the next one, round and round
let nextTimer;
/** Next piece of written music (kept recordings are skipped when playing everything). */
function nextSongIndex(from, step = 1) {
  for (let k = 1; k <= SONGS.length; k++) { const i = ((from + step * k) % SONGS.length + SONGS.length) % SONGS.length; if (!SONGS[i].take) return i; }
  return from;
}
player.onEnd = () => {
  syncTransport();
  const st = player.stats, n = player.gateCount();
  if (player.wait && n && st.hit) toast(`Finished: ${st.hit} of ${n} notes, ${st.wrong} wrong, ${(st.waitSum / st.hit).toFixed(1)} s waited per note on average.`, 6000);
  if (settings.repeat !== 'all') return;
  nextTimer = setTimeout(() => { loadSong(nextSongIndex(songIndex)); player.play().then(syncTransport); }, 700);
};
const REPEATS = ['off', 'one', 'all'];
function syncRepeat() {
  player.loop = settings.repeat === 'one';
  const b = $('loopBtn');
  b.setAttribute('aria-pressed', String(settings.repeat !== 'off'));
  b.title = { off: 'Repeat is off', one: 'Repeating this piece', all: 'Playing all pieces in turn, then starting again' }[settings.repeat];
  $('loopBadge').textContent = { off: '', one: '1', all: 'all' }[settings.repeat];
}
function playAll() {
  settings.repeat = 'all'; save(); syncRepeat(); closePanels();
  loadSong(0); startAudio().then((ok) => ok && player.play().then(syncTransport));
  toast('Playing every piece in turn. It starts again after the last one; press Stop to end.', 3600);
}
$('playAllBtn').addEventListener('click', playAll);
$('playBtn').addEventListener('click', togglePlay);
$('stopBtn').addEventListener('click', () => { clearTimeout(nextTimer); recorder.stopPlayback(); player.stop(); markRoot(null); syncTransport(); });
$('prevBtn').addEventListener('click', () => { const was = player.playing; loadSong(nextSongIndex(songIndex, -1)); if (was) player.play().then(syncTransport); });
$('nextBtn').addEventListener('click', () => { const was = player.playing; loadSong(nextSongIndex(songIndex)); if (was) player.play().then(syncTransport); });
$('loopBtn').addEventListener('click', () => {
  settings.repeat = REPEATS[(REPEATS.indexOf(settings.repeat) + 1) % REPEATS.length]; save(); syncRepeat();
  toast({ off: 'Repeat off.', one: 'Repeat this piece.', all: 'Play all pieces in turn, then start again.' }[settings.repeat]);
});
syncRepeat();
$('progress').addEventListener('pointerdown', (e) => {
  if (songIndex < 0 || !player.song) return;
  const r = $('progress').getBoundingClientRect();
  player.seek(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * player.duration);
});
const tempo = $('tempo');
tempo.value = settings.tempo; $('tempoOut').textContent = settings.tempo + '%';
tempo.addEventListener('input', () => { settings.tempo = +tempo.value; $('tempoOut').textContent = settings.tempo + '%'; player.setTempoScale(settings.tempo / 100); save(); });

// ---- panels and settings ---------------------------------------------------------------------------
// ---- practice strip: tablature, who plays what, wait-for-me
function syncPractice() {
  $('practice').hidden = !settings.practice;
  $('practiceBtn').setAttribute('aria-pressed', String(settings.practice));
  for (const b of $('modeSeg').children) b.classList.toggle('active', b.dataset.m === settings.mode);
  $('waitBtn').setAttribute('aria-pressed', String(settings.wait && settings.mode !== 'listen'));
  $('waitBtn').disabled = settings.mode === 'listen';
  player.mode = settings.mode; player.wait = settings.wait && settings.mode !== 'listen';
  syncSongSub();
  layout();
}
$('practiceBtn').addEventListener('click', () => { settings.practice = !settings.practice; save(); syncPractice(); });
$('modeSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  settings.mode = b.dataset.m; save(); syncPractice();
  toast({ listen: 'The app plays everything.', melody: 'You play the melody (the notes with the bold ring); the app plays the accompaniment.', chords: 'You play the bass and chords on the lit strings; the app plays the melody.' }[settings.mode]);
});
$('waitBtn').addEventListener('click', () => {
  settings.wait = !settings.wait; save(); syncPractice();
  toast(!settings.wait ? 'The song keeps its own tempo.' : settings.mode === 'chords' ? 'Wait for me: the song stops at each bar until you pluck its lit bass string.' : 'Wait for me: the song stops at each melody note until you pluck it.');
});

function closePanels() { $('library').hidden = true; $('settings').hidden = true; $('manual').hidden = true; $('importer').hidden = true; }

// ---- recording a take
const fmtTake = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
let recTick;
recorder.onChange = () => {
  $('recBtn').setAttribute('aria-pressed', String(recorder.recording));
  $('recBtn').title = recorder.recording ? 'Stop recording' : 'Record what you play';
  clearInterval(recTick);
  if (recorder.recording) {
    $('takeBar').hidden = false; $('takePlay').hidden = true; $('takeSave').hidden = true; $('takeKeep').hidden = true;
    const show = () => { $('takeInfo').textContent = 'Recording ' + fmtTake(audio.now - recorder.t0); };
    show(); recTick = setInterval(show, 500);
  } else if (recorder.hasTake) {
    $('takeBar').hidden = false; $('takePlay').hidden = false; $('takeSave').hidden = false; $('takeKeep').hidden = recorder.fromLibrary;
    $('takeInfo').textContent = 'Your take · ' + fmtTake(recorder.duration);
    $('takePlay').textContent = recorder.playing ? 'Stop' : 'Play take';
  } else $('takeBar').hidden = true;
};
$('recBtn').addEventListener('click', async () => {
  if (recorder.recording) { recorder.stop(); if (!recorder.hasTake) toast('Nothing was played, so there is no take.'); return; }
  if (!(await startAudio())) return;
  recorder.start(); toast('Recording. Play, then press the record button again to finish.');
});
$('takePlay').addEventListener('click', () => { if (recorder.playing) recorder.stopPlayback(); else { if (player.playing) { player.pause(); syncTransport(); } recorder.play(); } });
$('takeClose').addEventListener('click', () => { recorder.discard(); });
$('takeKeep').addEventListener('click', () => {
  const when = new Date().toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const name = (window.prompt('Name this recording', 'My take, ' + when) || '').trim();
  if (!name) return;
  const song = { id: 'take-' + Date.now().toString(36), category: 'My Recordings', user: true, take: true, title: name.slice(0, 80), composer: 'Your recording', key: '', meter: '', accuracy: 'take', source: 'Recorded on this zither and kept on this device.', events: recorder.events.map((e) => ({ t: +e.t.toFixed(4), m: e.m })), duration: recorder.duration };
  SONGS.push(song); saveUserSongs(); renderList();
  recorder.discard();
  loadSong(SONGS.indexOf(song));
  toast(`Kept “${song.title}” in the library under My Recordings.`);
});
$('takeSave').addEventListener('click', async () => {
  const btn = $('takeSave'); btn.disabled = true; btn.textContent = 'Rendering…';
  try {
    const { blob } = await recorder.renderWav();
    const name = 'zither-take-' + new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-') + '.wav';
    const file = typeof File === 'function' ? new File([blob], name, { type: 'audio/wav' }) : null;
    if (file && navigator.canShare && navigator.canShare({ files: [file] }) && /iPad|iPhone|Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1) {
      await navigator.share({ files: [file], title: 'Zither take' });          // iPad: the share sheet (Save to Files, AirDrop…)
    } else {
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 30000);
      toast('Saved ' + name);
    }
  } catch (e) { if (e && e.name !== 'AbortError') { console.error(e); toast('Could not save the audio: ' + (e.message || e), 4000); } }
  btn.disabled = false; btn.textContent = 'Save audio';
});
window.__recorder = recorder;

// ---- adding a song from ABC notation
$('importBtn').addEventListener('click', () => { closePanels(); $('importer').hidden = false; $('abcMsg').textContent = ''; setTimeout(() => $('abcText').focus(), 50); });
$('abcAdd').addEventListener('click', () => {
  const msg = $('abcMsg');
  try {
    const { song, info } = songFromAbc($('abcText').value, { style: $('abcStyle').value, octaveUp: $('abcOctave').checked });
    SONGS.push(song); saveUserSongs(); renderList();
    const notes = [`Added “${song.title}”: ${info.notes} notes, ${info.bars} bars, about ${info.seconds} s.`];
    if (!info.chords) notes.push('It has no chord symbols, so it will play without accompaniment.');
    if (info.unplaced) notes.push(`${info.unplaced} notes are outside the range of the fretboard and were left out.`);
    if (info.oddBars) notes.push(`${info.oddBars} bars do not match the ${song.meter} metre; check the note lengths if it sounds uneven.`);
    $('abcText').value = ''; closePanels();
    loadSong(SONGS.indexOf(song)); toast(notes.join(' '), 6000);
  } catch (e) { msg.textContent = e.message || String(e); }
});
$('abcCancel').addEventListener('click', closePanels);
function togglePanel(id) { const el = $(id), open = el.hidden; closePanels(); el.hidden = !open; }
$('songBtn').addEventListener('click', () => togglePanel('library'));
$('settingsBtn').addEventListener('click', () => togglePanel('settings'));
$('manualBtn').addEventListener('click', () => togglePanel('manual'));
// contents links scroll inside the manual instead of changing the page address
for (const a of document.querySelectorAll('#manual .toc a')) a.addEventListener('click', (e) => { e.preventDefault(); const t = document.querySelector(a.getAttribute('href')); if (t) t.scrollIntoView({ block: 'start' }); });
for (const b of document.querySelectorAll('[data-close]')) b.addEventListener('click', closePanels);
canvas.addEventListener('pointerdown', closePanels);

for (const b of document.querySelectorAll('.views .chip')) {
  b.classList.toggle('active', b.dataset.view === settings.view);
  b.addEventListener('click', () => {
    settings.view = b.dataset.view; save(); scene.setView(settings.view);
    if (settings.focus !== 'all') { settings.focus = 'all'; save(); scene.setFocus('all'); $('zoomBtn').textContent = ZOOM_LABEL.all; $('zoomBtn').classList.remove('active'); }
    for (const o of document.querySelectorAll('.views .chip')) o.classList.toggle('active', o === b);
  });
}
const ZOOMS = ['all', 'frets', 'chords', 'strings'], ZOOM_LABEL = { all: 'Zoom: All', frets: 'Zoom: Frets', chords: 'Zoom: Chords', strings: 'Zoom: Strings' };
function setZoom(name) {
  settings.focus = name; save();
  scene.setFocus(name);
  scene.setView(name === 'all' ? settings.view : 'top');       // zoomed zones are shown from above, where spacing is widest
  $('zoomBtn').textContent = ZOOM_LABEL[name];
  $('zoomBtn').classList.toggle('active', name !== 'all');
}
function cycleZoom() { setZoom(ZOOMS[(ZOOMS.indexOf(settings.focus) + 1) % ZOOMS.length]); }
$('zoomBtn').addEventListener('click', cycleZoom);
$('zoomBtn').textContent = ZOOM_LABEL[settings.focus]; $('zoomBtn').classList.toggle('active', settings.focus !== 'all');
{
  const el = $('chordBpm'), out = $('chordBpmOut');
  el.value = settings.chordBpm; out.textContent = settings.chordBpm;
  el.addEventListener('input', () => { settings.chordBpm = +el.value; out.textContent = el.value; save(); });
}
function slider(id, key, apply) {
  const el = $(id); el.value = Math.round(settings[key] * 100);
  el.addEventListener('input', () => { settings[key] = el.value / 100; apply(settings[key]); save(); });
}
slider('volume', 'volume', (v) => audio.setVolume(v));
slider('reverb', 'reverb', (v) => audio.setReverb(v));
slider('resonance', 'resonance', (v) => audio.setResonance(v));
slider('vibDepth', 'vibDepth', (v) => { player.vibDepth = v; });
{
  const el = $('tremoloDelay'), out = $('tremoloDelayOut');
  el.value = settings.tremoloDelay; out.textContent = (settings.tremoloDelay / 1000).toFixed(2);
  el.addEventListener('input', () => { settings.tremoloDelay = +el.value; out.textContent = (el.value / 1000).toFixed(2); save(); });
}
$('appVersion').textContent = 'Concert Zither ' + APP_VERSION;

// ---- sound, tuning and looks
function select(id, key, options, apply) {
  const el = $(id);
  for (const [v, label] of options) { const o = document.createElement('option'); o.value = v; o.textContent = label; el.appendChild(o); }
  if (!options.some(([v]) => v === settings[key])) settings[key] = options[0][0];
  el.value = settings[key];
  el.addEventListener('change', () => { settings[key] = el.value; save(); apply(el.value); });
}
function retune() {
  audio.setTuning(setTuning(settings.tuning, settings.pitch));
  const cur = SONGS[songIndex];
  if (cur && !cur.take) { const was = player.playing; loadSong(songIndex); if (was) player.play().then(syncTransport); }
}
select('voiceSel', 'voice', Object.entries(VOICES).map(([k, v]) => [k, v.label]), (v) => audio.setVoice(VOICES[v]));
select('tuningSel', 'tuning', Object.entries(TUNINGS).map(([k, t]) => [k, t.label]), retune);
select('finishSel', 'finish', [['sunburst', 'Spruce with amber sunburst'], ['natural', 'Natural spruce, maple sides'], ['walnut', 'Walnut'], ['ebony', 'Black lacquer, gold purfling']], (v) => scene.setFinish(v));
{
  const el = $('pitch'), out = $('pitchOut');
  el.value = settings.pitch; out.textContent = settings.pitch;
  el.addEventListener('input', () => { out.textContent = el.value; });
  el.addEventListener('change', () => { settings.pitch = +el.value; save(); retune(); });
}
$('midiBtn').addEventListener('click', async () => {
  try { await startAudio(); await midi.connect(); settings.midi = true; save(); }
  catch (e) { $('midiStatus').textContent = e.message || String(e); }
});
if (!midi.supported) { $('midiBtn').disabled = true; $('midiStatus').textContent = 'Not available in this browser. Safari has no MIDI support; use Chrome or Edge on a computer, or the Windows app.'; }
else $('midiStatus').textContent = settings.midi ? 'Reconnects when you start playing.' : 'Keys below C3 play chords; higher keys play the melody.';
function setMirror(on) { settings.mirror = on; $('mirror').checked = on; scene.setMirror(on); save(); }
function checkbox(id, key, apply) {
  const el = $(id); el.checked = !!settings[key];
  el.addEventListener('change', () => { settings[key] = el.checked; if (apply) apply(el.checked); save(); });
}
checkbox('mirror', 'mirror', (v) => scene.setMirror(v));
checkbox('labels', 'labels', (v) => scene.setLabels(v));
checkbox('tapSounds', 'tapSounds');
checkbox('vibrato', 'vibrato', (v) => { player.vibrato = v; });
checkbox('tremolo', 'tremolo');
checkbox('hands', 'hands', (v) => scene.setHands(v));

syncPractice();
recorder.onChange();            // shows a take kept from the last session

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
