// Main-thread side of the audio: creates the context on the first user
// gesture, loads the string engine worklet and adds a little room around it.
import { engineConfig, N_STRINGS } from './zither-model.js';

export class ZitherAudio {
  constructor() {
    this.ctx = null; this.node = null; this.ready = false; this.starting = null;
    this.levels = new Float32Array(N_STRINGS);
    this.onLevels = null; this.onState = null;
    this.reports = 0; this.peak = 0; this.blocks = 0;
    this.settings = { volume: 0.8, reverb: 0.22, resonance: 0.5 };
  }

  /** Must be called from a user gesture the first time (required by iOS Safari). */
  start() {
    if (this.ready) { if (this.ctx.state !== 'running') this.ctx.resume(); return Promise.resolve(); }
    if (!this.starting) this.starting = this._start().catch((e) => { this.starting = null; throw e; });
    else if (this.ctx && this.ctx.state !== 'running') this.ctx.resume();
    return this.starting;
  }

  async _start() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) throw new Error('Web Audio is not available in this browser.');
    // play through the iPhone/iPad silent switch like any other instrument app
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) { /* older Safari */ }
    const ctx = this.ctx = new AC({ latencyHint: 'interactive' });
    const resume = ctx.resume();            // synchronously inside the gesture
    if (!ctx.audioWorklet) throw new Error('This browser has no AudioWorklet support (needs Safari 14.5+ / a current browser).');
    await ctx.audioWorklet.addModule(new URL('../worklet/zither-processor.js', import.meta.url).href);
    const cfg = engineConfig(); cfg.resonance = this.settings.resonance;
    const node = this.node = new AudioWorkletNode(ctx, 'zither', {
      numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: cfg,
    });
    node.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'lv') {
        this.levels = m.lv; this.reports++; this.blocks = m.blocks;
        if (m.top > this.peak) this.peak = m.top;
        if (this.onLevels) this.onLevels(m.lv);
      }
    };
    node.onprocessorerror = (e) => console.error('zither engine error', e);

    const g = this.buildGraph(ctx, node);
    this.master = g.master; this.wet = g.wet;
    this.setVolume(this.settings.volume); this.setReverb(this.settings.reverb);

    ctx.onstatechange = () => { if (this.onState) this.onState(ctx.state); };
    await resume;
    this.ready = true;
    if (this.onState) this.onState(ctx.state);
  }

  /** Engine -> gentle limiter -> dry + a small procedural room -> output. Also used for offline rendering. */
  buildGraph(ctx, node) {
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -7; limiter.knee.value = 6; limiter.ratio.value = 6;
    limiter.attack.value = 0.002; limiter.release.value = 0.16;
    const master = ctx.createGain(), wet = ctx.createGain(), conv = ctx.createConvolver();
    conv.normalize = false;
    conv.buffer = this._room(ctx);
    node.connect(limiter);
    limiter.connect(master);
    limiter.connect(conv); conv.connect(wet); wet.connect(master);
    master.connect(ctx.destination);
    master.gain.value = this.settings.volume * this.settings.volume * 1.6;
    wet.gain.value = this.settings.reverb * 1.4;
    return { master, wet };
  }

  /** A small, warm wooden room: decaying noise with early reflections. */
  _room(ctx) {
    const sr = ctx.sampleRate, len = Math.floor(sr * 1.7), buf = ctx.createBuffer(2, len, sr);
    let seed = 20241;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const t = i / sr;
        const env = Math.exp(-t / 0.33) * Math.min(1, t / 0.012);
        const cut = 0.55 * Math.exp(-t / 0.5) + 0.06;       // highs die first
        lp += cut * (rnd() - lp);
        d[i] = lp * env;
      }
      for (const [ms, g] of [[11, 0.5], [19, -0.38], [27, 0.3], [38, -0.22]]) {
        const k = Math.floor((ms + ch * 2.3) * sr / 1000); if (k < len) d[k] += g * 0.6;
      }
      let e = 0; for (let i = 0; i < len; i++) e += d[i] * d[i];
      const norm = 1 / Math.sqrt(e);
      for (let i = 0; i < len; i++) d[i] *= norm;
    }
    return buf;
  }

  _post(m) { if (this.tap) this.tap(m); if (this.node) this.node.port.postMessage(m); }
  get now() { return this.ctx ? this.ctx.currentTime : 0; }

  pluck(s, vel = 0.8, fret, time) { this._post({ type: 'pluck', s, vel, fret, time }); }
  setFret(s, fret, hammer = 0, time) { this._post({ type: 'fret', s, fret, hammer, time }); }
  bend(s, semis) { this._post({ type: 'bend', s, semis }); }
  vibrato(s, depth, rate = 5.5, delay = 0.2, time) { this._post({ type: 'vib', s, depth, rate, delay, time }); }
  damp(s, time) { this._post({ type: 'damp', s, time }); }
  dampAll() { this._post({ type: 'dampAll' }); }
  flush() { this._post({ type: 'flush' }); }

  setVolume(v) { this.settings.volume = v; if (this.master) this.master.gain.value = v * v * 1.6; }
  setReverb(v) { this.settings.reverb = v; if (this.wet) this.wet.gain.value = v * 1.4; }
  setResonance(v) { this.settings.resonance = v; this._post({ type: 'resonance', value: v }); }
}
