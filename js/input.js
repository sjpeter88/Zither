// Playing with fingers or a mouse. Every pointer is tracked on its own, so one
// hand can hold frets while the other plucks, strums or sweeps a glissando.
import { STRINGS, GEOM, FRETS, fretX, N_STRINGS, MELODY_COUNT } from './zither-model.js';

/** Tremolo: rapid repeated plucks of one string. Returns a function that stops it. */
export function startTremolo(audio, scene, string, getFret, rate = 11) {
  let next = audio.now + 0.02, k = 0;
  const tick = () => {
    if (next < audio.now) next = audio.now + 0.01;
    while (next < audio.now + 0.12) { audio.pluck(string, k % 2 ? 0.5 : 0.63, getFret(), next); next += 1 / rate; k++; }
    scene.flash(string, 0.6);
  };
  tick();
  const id = setInterval(tick, 40);
  return () => clearInterval(id);
}

export class ZitherInput {
  constructor(canvas, scene, audio, options) {
    this.canvas = canvas; this.scene = scene; this.audio = audio;
    this.opt = options;                 // live settings object: { tapSounds }
    this.pointers = new Map();
    this.onPlay = null;                 // called on any user-made sound
    this.onPluck = null;                // called with (string, fret) for each note the player plucks
    const o = { passive: false };
    canvas.addEventListener('pointerdown', (e) => this.down(e), o);
    canvas.addEventListener('pointermove', (e) => this.move(e), o);
    canvas.addEventListener('pointerup', (e) => this.up(e), o);
    canvas.addEventListener('pointercancel', (e) => this.up(e), o);
    canvas.addEventListener('lostpointercapture', (e) => this.up(e), o);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('wheel', (e) => { e.preventDefault(); scene.zoom(e.deltaY > 0 ? 0.93 : 1.075); }, o);
    // stop Safari from scrolling, zooming or selecting while playing
    for (const ev of ['touchstart', 'touchmove', 'gesturestart', 'gesturechange'])
      canvas.addEventListener(ev, (e) => e.preventDefault(), o);
  }

  /** Highest fret currently held on a melody string by the player. */
  heldFret(string) {
    let f = 0;
    for (const p of this.pointers.values()) if (p.mode === 'fret' && p.string === string && p.fret > f) f = p.fret;
    return f;
  }

  _fretAt(x) {
    if (x <= GEOM.nutX) return 0;
    let n = 1; while (n < FRETS && fretX(n) < x) n++;
    return n;
  }

  down(e) {
    e.preventDefault();
    this.audio.start().catch(() => {});
    try { this.canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    const pk = this.scene.pick(e.clientX, e.clientY);
    const p = { mode: 'none', string: -1, fret: 0, x: e.clientX, y: e.clientY, t: performance.now(), mouse: e.pointerType === 'mouse', lastString: -1, lastT: 0 };
    this.pointers.set(e.pointerId, p);
    if ((p.mouse && e.button !== 0) || !pk.zone) {
      if (!pk.onBody || (p.mouse && e.button !== 0)) p.mode = 'orbit';
      return;
    }
    if (pk.zone === 'fret') {
      p.mode = 'fret'; p.string = pk.string; p.fret = pk.fret; p.d0 = pk.d; p.bend = 0; p.xRef = pk.x;
      const f = this.heldFret(pk.string);
      this.scene.setFinger(pk.string, f, 'user');
      if (p.mouse || this.opt.tapSounds) { this.audio.pluck(pk.string, p.mouse ? 0.85 : 0.72, f); this.scene.flash(pk.string); if (this.onPluck) this.onPluck(pk.string, f); }
      else this.audio.setFret(pk.string, f, 0.4);          // silent stop, or a true hammer-on if the string rings
      if (this.onPlay) this.onPlay();
    } else {
      p.mode = 'strum'; p.d = pk.d;
      this._pluck(p, pk.string, 0.82);
    }
  }

  _pluck(p, string, vel) {
    const fret = string < MELODY_COUNT ? this.heldFret(string) : undefined;
    this.audio.pluck(string, vel, fret);
    this.scene.flash(string);
    if (this.onPluck) this.onPluck(string, fret || 0);
    p.lastString = string; p.lastT = performance.now();
    // resting on the string after plucking it turns into a tremolo
    this._stopTremolo(p);
    p.tremTimer = setTimeout(() => {
      p.tremStop = startTremolo(this.audio, this.scene, string, () => (string < MELODY_COUNT ? this.heldFret(string) : undefined));
    }, 320);
    if (this.onPlay) this.onPlay();
  }

  _stopTremolo(p) {
    clearTimeout(p.tremTimer);
    if (p.tremStop) { p.tremStop(); p.tremStop = null; }
  }

  move(e) {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    e.preventDefault();
    const now = performance.now();
    if (p.mode === 'orbit') {
      this.scene.orbit(e.clientX - p.x, e.clientY - p.y);
    } else if (p.mode === 'fret') {
      const loc = this.scene.locate(e.clientX, e.clientY, GEOM.melodyY);
      if (loc) {
        // along the string: slide from fret to fret without re-plucking
        const f = loc.x >= GEOM.pluckX0 ? FRETS : this._fretAt(loc.x);
        if (f !== p.fret) {
          p.fret = f; p.xRef = loc.x;
          const held = this.heldFret(p.string);
          this.audio.setFret(p.string, held, 0);
          this.scene.setFinger(p.string, held, 'user');
        }
        // across the string: push it sideways to bend the note up
        const side = Math.abs(loc.d - STRINGS[p.string].d);
        // rocking the fingertip along the string inside the fret: vibrato
        const dx = loc.x - p.xRef, rock = Math.sign(dx) * Math.min(1, Math.max(0, Math.abs(dx) - 1.2) / 7) * 0.3;
        const bend = Math.min(2, Math.max(0, side - 4) / 11) + rock;
        if (Math.abs(bend - p.bend) > 0.01) { p.bend = bend; this.audio.bend(p.string, bend); }
      }
    } else if (p.mode === 'strum') {
      const loc = this.scene.locate(e.clientX, e.clientY, GEOM.openY);
      if (loc) {
        const d0 = p.d, d1 = loc.d;
        if (d0 !== d1) {
          const lo = Math.min(d0, d1), hi = Math.max(d0, d1);
          const dt = Math.max(1, now - p.t), speed = Math.abs(d1 - d0) / dt * 1000;   // mm per second across the strings
          const vel = Math.min(1, 0.4 + speed / 1100);
          const hits = [];
          for (let i = 0; i < N_STRINGS; i++) {
            const s = STRINGS[i];
            if (s.d <= lo || s.d > hi) continue;
            const inX = i < MELODY_COUNT ? (loc.x >= GEOM.pluckX0 - 4 && loc.x <= GEOM.melodyBridgeX + 8) : (loc.x >= s.x0 - 4 && loc.x <= s.x1 + 4);
            if (inX) hits.push(i);
          }
          if (d1 < d0) hits.reverse();
          for (const i of hits) {
            if (i === p.lastString && now - p.lastT < 110) continue;     // do not double-trigger the string we started on
            this._pluck(p, i, vel);
          }
          p.d = d1;
        }
      }
    }
    p.x = e.clientX; p.y = e.clientY; p.t = now;
  }

  up(e) {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    this.pointers.delete(e.pointerId);
    this._stopTremolo(p);
    if (p.mode === 'fret') {
      const held = this.heldFret(p.string);
      this.scene.setFinger(p.string, held, 'user');
      if (p.bend) this.audio.bend(p.string, 0);
      if (held > 0) this.audio.setFret(p.string, held, 0);          // pull-off to a finger still down
      else if (!p.mouse) this.audio.damp(p.string);                 // lifting the finger stops the note
    }
  }
}
