// Records what is played as the stream of commands sent to the string engine,
// replays it on the instrument, and renders it to a WAV file offline.
import { engineConfig, MELODY_COUNT } from './zither-model.js';

const KEEP = new Set(['pluck', 'fret', 'bend', 'damp', 'dampAll', 'vib']);
const MAX_SECONDS = 600;
const TAKE_KEY = 'concertzither.take.v1';

export class Recorder {
  constructor(audio, scene) {
    this.audio = audio; this.scene = scene;
    this.events = []; this.recording = false; this.playing = false;
    this.t0 = 0; this.duration = 0; this.timers = [];
    this.onChange = null; this.fromLibrary = false;
    try { const saved = JSON.parse(localStorage.getItem(TAKE_KEY)); if (saved && saved.length) this.loadTake(saved, false); } catch (e) { /* none */ }
    // every command on its way to the engine passes through here
    audio.tap = (m) => {
      if (!this.recording || this.playing || !KEEP.has(m.type)) return;
      const t = (m.time != null ? m.time : audio.now) - this.t0;
      if (t < 0 || t > MAX_SECONDS) return;
      const copy = { ...m }; delete copy.time;
      this.events.push({ t, m: copy });
    };
  }

  start() {
    this.stopPlayback();
    this.events = []; this.duration = 0; this.t0 = this.audio.now; this.recording = true;
    if (this.onChange) this.onChange();
  }

  stop() {
    if (!this.recording) return;
    this.recording = false;
    this.events.sort((a, b) => a.t - b.t);
    // trim the silence before the first note
    const first = this.events.find((e) => e.m.type === 'pluck');
    if (first) { const lead = Math.max(0, first.t - 0.15); for (const e of this.events) e.t = Math.max(0, e.t - lead); }
    this.duration = this.events.length ? this.events[this.events.length - 1].t : 0;
    this.fromLibrary = false;
    this.persist();
    if (this.onChange) this.onChange();
  }

  persist() {
    try {
      if (this.hasTake && !this.fromLibrary) localStorage.setItem(TAKE_KEY, JSON.stringify(this.events));
      else if (!this.hasTake) localStorage.removeItem(TAKE_KEY);
    } catch (e) { /* storage full or private: the take still works this session */ }
  }

  /** Load a stored take (from the library or the previous session). */
  loadTake(events, fromLibrary = true) {
    this.stopPlayback();
    this.events = events.map((e) => ({ t: e.t, m: { ...e.m } }));
    this.duration = this.events.length ? this.events[this.events.length - 1].t : 0;
    this.fromLibrary = fromLibrary;
    if (this.onChange) this.onChange();
  }

  discard() {
    this.stopPlayback(); this.recording = false; this.events = []; this.duration = 0;
    if (!this.fromLibrary) this.persist();
    this.fromLibrary = false;
    if (this.onChange) this.onChange();
  }

  get hasTake() { return !this.recording && this.events.some((e) => e.m.type === 'pluck'); }

  play() {
    if (!this.hasTake || this.playing) return;
    const a = this.audio, sc = this.scene, start = a.now + 0.12;
    this.playing = true;
    for (const e of this.events) {
      a._post({ ...e.m, time: start + e.t });
      if (e.m.type !== 'pluck') continue;
      this.timers.push(setTimeout(() => {
        sc.flash(e.m.s, 0.9); sc.handPluck(e.m.s);
        if (e.m.s < MELODY_COUNT && e.m.fret != null) {
          sc.setFinger(e.m.s, e.m.fret, 'song');
          this.timers.push(setTimeout(() => { if (sc.markers[e.m.s].song.fret === e.m.fret) sc.setFinger(e.m.s, 0, 'song'); }, 420));
        }
      }, (0.12 + e.t) * 1000));
    }
    this.timers.push(setTimeout(() => { this.playing = false; this.timers = []; if (this.onChange) this.onChange(); }, (this.duration + 2.5) * 1000));
    if (this.onChange) this.onChange();
  }

  stopPlayback() {
    if (!this.playing) return;
    this.timers.forEach(clearTimeout); this.timers = [];
    this.playing = false;
    this.audio.flush(); this.audio.dampAll();
    for (let s = 0; s < MELODY_COUNT; s++) this.scene.setFinger(s, 0, 'song');
    if (this.onChange) this.onChange();
  }

  /** Render the take through a fresh copy of the engine, faster than real time. */
  async renderWav() {
    const sr = 44100, seconds = this.duration + 5;
    const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!Offline) throw new Error('This browser cannot render audio offline.');
    const ctx = new Offline(2, Math.ceil(seconds * sr), sr);
    if (!ctx.audioWorklet) throw new Error('This browser cannot run the string engine offline.');
    await ctx.audioWorklet.addModule(new URL('../worklet/zither-processor.js', import.meta.url).href);
    const cfg = engineConfig();
    cfg.resonance = this.audio.settings.resonance; cfg.voice = this.audio.settings.voice;
    // the commands travel with the engine's start-up options, so their timing cannot slip
    cfg.events = this.events.map((e) => ({ ...e.m, time: e.t + 0.05 }));
    const node = new AudioWorkletNode(ctx, 'zither', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: cfg });
    this.audio.buildGraph(ctx, node);
    const buf = await ctx.startRendering();
    return encodeWav(buf);
  }
}

function encodeWav(buf) {
  const ch = Math.min(2, buf.numberOfChannels), n = buf.length, sr = buf.sampleRate;
  const data = new DataView(new ArrayBuffer(44 + n * ch * 2));
  const str = (o, s) => { for (let i = 0; i < s.length; i++) data.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); data.setUint32(4, 36 + n * ch * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  data.setUint32(16, 16, true); data.setUint16(20, 1, true); data.setUint16(22, ch, true);
  data.setUint32(24, sr, true); data.setUint32(28, sr * ch * 2, true); data.setUint16(32, ch * 2, true); data.setUint16(34, 16, true);
  str(36, 'data'); data.setUint32(40, n * ch * 2, true);
  const chans = []; for (let c = 0; c < ch; c++) chans.push(buf.getChannelData(c));
  let peak = 0;
  for (let c = 0; c < ch; c++) for (let i = 0; i < n; i++) { const v = Math.abs(chans[c][i]); if (v > peak) peak = v; }
  const gain = peak > 0.98 ? 0.98 / peak : 1;
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) { data.setInt16(o, Math.round(Math.max(-1, Math.min(1, chans[c][i] * gain)) * 32767), true); o += 2; }
  return { blob: new Blob([data], { type: 'audio/wav' }), peak, seconds: n / sr };
}
