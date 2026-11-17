// Song playback. Songs are written as a melody in a subset of ABC notation
// with chord symbols; the bass and accompaniment on the open strings are
// generated here from those chords, the way a zither player would fill them in.
import { STRINGS, MELODY_COUNT, chordStrings, placeMelodyNote } from './zither-model.js';

const LETTER = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const SHARP_ORDER = 'FCGDAEB', FLAT_ORDER = 'BEADGCF';
const KEY_SHARPS = { C: 0, G: 1, D: 2, A: 3, E: 4, B: 5, 'F#': 6, 'C#': 7, F: -1, Bb: -2, Eb: -3, Ab: -4, Db: -5, Gb: -6, Cb: -7 };
const MODE_SHIFT = { '': 0, maj: 0, m: -3, min: -3, dor: -2, mix: -1, lyd: 1, phr: -4 };

function keySignature(key) {
  const m = /^([A-G][#b]?)\s*(maj|min|m|dor|mix|lyd|phr)?/i.exec(key.trim());
  const sig = {};
  if (!m) return sig;
  const n = (KEY_SHARPS[m[1]] || 0) + (MODE_SHIFT[(m[2] || '').toLowerCase()] || 0);
  for (let i = 0; i < Math.abs(n); i++) sig[n > 0 ? SHARP_ORDER[i] : FLAT_ORDER[i]] = n > 0 ? 1 : -1;
  return sig;
}

function tokenize(src) {
  const s = src.replace(/%.*$/gm, ''), out = [];
  let i = 0;
  const len = (str) => {
    const m = /^(\d*)(\/*)(\d*)/.exec(str);
    let v = m[1] ? parseInt(m[1], 10) : 1;
    if (m[2]) v /= m[3] ? parseInt(m[3], 10) : Math.pow(2, m[2].length);
    return [v, m[0].length];
  };
  const note = () => {
    const m = /^(\^\^|\^|__|_|=)?([A-Ga-g])([,']*)/.exec(s.slice(i));
    if (!m) return null;
    i += m[0].length;
    const [l, used] = len(s.slice(i)); i += used;
    return { acc: m[1] || null, letter: m[2], oct: m[3], len: l };
  };
  while (i < s.length) {
    const c = s[i], rest = s.slice(i);
    let m;
    if (/\s/.test(c) || c === '\\') { i++; continue; }
    if (c === '"') { const j = s.indexOf('"', i + 1); out.push({ t: 'sym', v: s.slice(i + 1, j) }); i = j + 1; continue; }
    if ((m = /^\[([KMLQ]):([^\]]*)\]/.exec(rest))) { out.push({ t: 'field', k: m[1], v: m[2].trim() }); i += m[0].length; continue; }
    if ((m = /^(\|\]|\|\||\[\||\|:|:\|\]|:\||::|\|)\s*(\d)?/.exec(rest))) {
      out.push({ t: 'bar', v: m[1] });
      if (m[2]) out.push({ t: 'ending', n: +m[2] });
      i += m[0].length; continue;
    }
    if ((m = /^\[(\d)/.exec(rest))) { out.push({ t: 'ending', n: +m[1] }); i += m[0].length; continue; }
    if ((m = /^\((\d)/.exec(rest))) { out.push({ t: 'tuplet', n: +m[1] }); i += m[0].length; continue; }
    if (c === '{') { i = s.indexOf('}', i) + 1; continue; }
    if (c === '!') { i = s.indexOf('!', i + 1) + 1; continue; }
    if (c === '[') {
      i++;
      const notes = [];
      while (i < s.length && s[i] !== ']') { const n = note(); if (n) notes.push(n); else i++; }
      i++;
      const [l, used] = len(s.slice(i)); i += used;
      out.push({ t: 'notes', notes, len: l }); continue;
    }
    if (c === 'z' || c === 'x') { i++; const [l, used] = len(s.slice(i)); i += used; out.push({ t: 'rest', len: l }); continue; }
    if (c === '-') { out.push({ t: 'tie' }); i++; continue; }
    if (c === '>' || c === '<') { out.push({ t: 'broken', v: c }); i++; continue; }
    const n = note();
    if (n) { out.push({ t: 'notes', notes: [n], len: 1 }); continue; }
    i++;
  }
  return out;
}

/** Unfold |: :| repeats with first and second endings. */
function unfold(tokens) {
  const out = [];
  let start = 0, pass = 1, i = 0, guard = 0;
  while (i < tokens.length && guard++ < 100000) {
    const tk = tokens[i];
    if (tk.t === 'ending') {
      if (tk.n !== pass) {                       // skip this ending (the first ending on the second pass)
        i++;
        while (i < tokens.length) {
          const x = tokens[i];
          if (x.t === 'ending') break;
          if (x.t === 'bar' && x.v !== '|' && x.v !== '|:') { out.push({ t: 'bar', v: '|' }); i++; break; }
          i++;
        }
        continue;
      }
      i++; continue;
    }
    if (tk.t === 'bar') {
      out.push({ t: 'bar', v: '|' });
      if (tk.v === '|:') { start = i + 1; pass = 1; }
      else if (tk.v === '||' || tk.v === '|]') pass = 1;
      else if (tk.v === ':|' || tk.v === ':|]' || tk.v === '::') {
        if (pass === 1) { pass = 2; i = start; continue; }
        pass = 1; start = i + 1;
      }
      i++; continue;
    }
    out.push(tk); i++;
  }
  return out;
}

/** Parse the tune body. Times are in quarter-note beats. */
export function parseTune(song) {
  const unit = (() => { const m = /(\d+)\/(\d+)/.exec(song.unit || '1/8'); return 4 * m[1] / m[2]; })();
  const tokens = unfold(tokenize(song.abc));
  let sig = keySignature(song.key || 'C'), barAcc = {}, t = 0, tuplet = 0, tupletMul = 1, broken = 0;
  const groups = [], chords = [], bars = [0], meters = [{ t: 0, meter: song.meter || '3/4' }];
  let last = null;
  for (const tk of tokens) {
    if (tk.t === 'sym') { chords.push({ t, sym: tk.v }); continue; }
    if (tk.t === 'field') {
      if (tk.k === 'K') sig = keySignature(tk.v);
      else if (tk.k === 'M' && /^\d+\/\d+$/.test(tk.v)) meters.push({ t, meter: tk.v });       // the metre may change mid-tune
      continue;
    }
    if (tk.t === 'bar') { barAcc = {}; if (t > bars[bars.length - 1] + 1e-6) bars.push(t); continue; }
    if (tk.t === 'tuplet') { tuplet = tk.n; tupletMul = tk.n === 3 ? 2 / 3 : tk.n === 2 ? 3 / 2 : (tk.n - 1) / tk.n; continue; }
    if (tk.t === 'tie') { if (last) last.tie = true; continue; }
    if (tk.t === 'broken') { if (last) { const d = last.dur / 2; if (tk.v === '>') { last.dur += d; t += d; broken = -d; } else { last.dur -= d; t -= d; broken = d; } } continue; }
    if (tk.t === 'rest' || tk.t === 'notes') {
      let longest = 1;
      if (tk.t === 'notes') { longest = 0; for (const n of tk.notes) longest = Math.max(longest, n.len); }
      let dur = tk.len * unit * longest;
      if (tuplet > 0) { dur *= tupletMul; tuplet--; }
      if (broken) { dur += broken; broken = 0; }
      if (tk.t === 'rest') { t += dur; last = null; continue; }
      const pitches = [];
      for (const n of tk.notes) {
        const up = n.letter.toUpperCase();
        let midi = 60 + LETTER[up] + (n.letter !== up ? 12 : 0);
        for (const ch of n.oct) midi += ch === ',' ? -12 : 12;
        const id = n.letter + n.oct;
        if (n.acc) barAcc[id] = n.acc === '^' ? 1 : n.acc === '^^' ? 2 : n.acc === '_' ? -1 : n.acc === '__' ? -2 : 0;
        midi += id in barAcc ? barAcc[id] : (sig[up] || 0);
        pitches.push(midi);
      }
      last = { t, dur, pitches };
      groups.push(last);
      t += dur;
    }
  }
  // merge ties
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    if (!g.tie) continue;
    const nx = groups[i + 1];
    if (!nx) continue;
    const shared = nx.pitches.filter((p) => g.pitches.includes(p));
    if (shared.length === nx.pitches.length && shared.length === g.pitches.length) {
      g.dur += nx.dur; g.tie = nx.tie; groups.splice(i + 1, 1); i--;
    }
  }
  if (t > bars[bars.length - 1] + 1e-6) bars.push(t);
  return { groups, chords, bars, meters, beats: t };
}

export function parseChord(sym) {
  const m = /^\s*([A-G])([#b]?)(maj7|m7|min|dim|sus4|m|7|6|°)?(?:\/([A-G])([#b]?))?/.exec(sym || '');
  if (!m) return null;
  const pc = (l, a) => (LETTER[l] + (a === '#' ? 1 : a === 'b' ? -1 : 0) + 12) % 12;
  const quality = { m: 'min', min: 'min', 7: 'dom7', m7: 'min7', dim: 'dim', '°': 'dim' }[m[3]] || 'maj';
  return { rootPc: pc(m[1], m[2]), quality, bassPc: m[4] ? pc(m[4], m[5]) : null, sym: sym.trim() };
}

// accompaniment patterns: [beat offset, role]; roles: B bass, A alternate bass,
// C chord (all accompaniment strings), 0/1/2 single chord strings (arpeggio)
const PATTERNS = {
  waltz: { '3/4': [[0, 'B'], [1, 'C'], [2, 'C']], '6/8': [[0, 'B'], [1, 'C'], [1.5, 'A'], [2.5, 'C']] },
  polka: { '2/4': [[0, 'B'], [0.5, 'C'], [1, 'A'], [1.5, 'C']], '4/4': [[0, 'B'], [1, 'C'], [2, 'A'], [3, 'C']] },
  arp: {
    '3/4': [[0, 'B'], [1, '0'], [1.5, '1'], [2, '2'], [2.5, '1']],
    '6/8': [[0, 'B'], [0.5, '0'], [1, '1'], [1.5, 'A'], [2, '2'], [2.5, '1']],
    '4/4': [[0, 'B'], [1, '0'], [1.5, '1'], [2, 'A'], [3, '2'], [3.5, '1']],
  },
  hymn: { '3/4': [[0, 'B'], [1, 'C']], '4/4': [[0, 'B'], [2, 'C']], '6/8': [[0, 'B'], [1.5, 'C']], '2/4': [[0, 'B'], [1, 'C']] },
};

/** A plain pattern for any metre that has no pattern of its own: bass on the first beat, chords after it. */
function genericPattern(meter) {
  const [n, d] = meter.split('/').map(Number), out = [[0, 'B']];
  if (d === 8 && n % 3 === 0) {                        // compound time: groups of three quavers
    for (let g = 0; g < n / 3; g++) { if (g) out.push([g * 1.5, 'A']); out.push([g * 1.5 + 1, 'C']); }
    return out;
  }
  const beats = n * 4 / d;
  for (let k = 1; k < beats - 1e-9; k++) out.push([k, beats >= 4 && k === 2 ? 'A' : 'C']);
  return out;
}

/** Turn a song into timed performance events (times in beats). */
export function compileSong(song) {
  const tune = parseTune(song);
  const ev = [];
  // --- melody on the fretboard
  let hand = 5, seed = 1;
  const jitter = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5);
  const [mn, md] = (song.meter || '3/4').split('/').map(Number), barBeats = mn * 4 / md;
  const barOf = (t) => { let b = 0; while (b + 1 < tune.bars.length && tune.bars[b + 1] <= t + 1e-6) b++; return b; };
  for (const g of tune.groups) {
    const busy = new Set();
    const sorted = [...g.pitches].sort((a, b) => b - a);
    const downbeat = Math.abs(g.t - tune.bars[barOf(g.t)]) < 1e-6;
    sorted.forEach((midi, k) => {
      let m = midi + (song.transpose || 0);
      while (m < 48) m += 12;
      const place = placeMelodyNote(m, busy, hand);
      if (!place) return;
      busy.add(place.string);
      if (k === 0 && place.fret > 0) hand += (place.fret - hand) * 0.6;
      ev.push({ t: g.t, type: 'mel', string: place.string, fret: place.fret, dur: g.dur, top: k === 0, vel: (k === 0 ? 0.8 : 0.62) + (downbeat ? 0.07 : 0) + jitter() * 0.06 });
    });
  }
  // stop each melody note when it ends, unless the same string is plucked again straight away
  const lastOn = {};
  for (let i = ev.length - 1; i >= 0; i--) {
    const e = ev[i], nx = lastOn[e.string];
    e.damp = !(nx && nx.t < e.t + e.dur + 0.2);
    lastOn[e.string] = e;
  }
  // --- bass and accompaniment on the open strings
  const style = PATTERNS[song.style || 'waltz'] || PATTERNS.waltz;
  const meterAt = (t) => { let m = tune.meters[0].meter; for (const x of tune.meters) { if (x.t <= t + 1e-6) m = x.meter; else break; } return m; };
  const chordAt = (t) => { let c = null; for (const ch of tune.chords) { if (ch.t <= t + 1e-6) c = ch; else break; } return c; };
  let prevSym = null, prevStrings = null, lastBass = -1;
  for (let b = 0; b + 1 < tune.bars.length; b++) {
    const t0 = tune.bars[b], len = tune.bars[b + 1] - t0;
    if (b === 0 && len < barBeats - 1e-6) continue;             // pickup bar: melody alone
    const meter = meterAt(t0), pattern = style[meter] || genericPattern(meter);
    for (const [off, role0] of pattern) {
      if (off >= len - 1e-6) continue;
      const t = t0 + off, ch = chordAt(t);
      const parsed = ch && parseChord(ch.sym);
      if (!parsed) { prevSym = null; continue; }
      const cs = chordStrings(parsed.rootPc, parsed.quality, parsed.bassPc);
      let role = role0;
      if (ch.sym !== prevSym) {
        if (prevStrings) for (const s of prevStrings) ev.push({ t: t - 0.02, type: 'damp', string: s });
        ev.push({ t, type: 'chord', chord: parsed, strings: cs });
        if (role !== 'B' && role !== 'A') role = 'B';             // a new chord always starts on its bass note
        prevSym = ch.sym; prevStrings = [...cs.acc, cs.bass, cs.altBass, cs.contra];
      }
      const accent = off === 0 ? 0.06 : 0;
      if (role === 'B' || role === 'A') {
        const s = role === 'A' && parsed.bassPc == null ? cs.altBass : cs.bass;
        if (lastBass >= 0 && lastBass !== s) ev.push({ t: t - 0.01, type: 'damp', string: lastBass });
        ev.push({ t, type: 'open', string: s, bass: role === 'B', vel: 0.6 + accent + jitter() * 0.05 });
        if (role === 'B' && off === 0 && cs.contra >= 0) ev.push({ t, type: 'open', string: cs.contra, vel: 0.42 });
        lastBass = s;
      } else if (role === 'C') {
        cs.acc.forEach((s, k) => ev.push({ t, roll: k, type: 'open', string: s, vel: 0.4 + jitter() * 0.05 }));
      } else {
        const s = cs.acc[Math.min(cs.acc.length - 1, +role)];
        ev.push({ t, type: 'open', string: s, vel: 0.44 + jitter() * 0.05 });
      }
    }
  }
  ev.sort((a, b) => a.t - b.t || (a.type === 'damp' ? -1 : 0) - (b.type === 'damp' ? -1 : 0));
  return { events: ev, beats: tune.beats, bars: tune.bars.length - 1, barTimes: tune.bars, notes: tune.groups.length };
}

export class SongPlayer {
  constructor(audio, scene) {
    this.audio = audio; this.scene = scene;
    this.song = null; this.compiled = null;
    this.playing = false; this.pos = 0;         // seconds of song time at the song's own tempo
    this.scale = 1; this.loop = false; this.vibrato = true; this.vibDepth = 1;
    this.stats = { hit: 0, wrong: 0, waitSum: 0 }; this.waitStart = 0; this.onGate = null;
    // practice: who plays what, and whether the song waits for the player's melody notes
    this.mode = 'listen';             // 'listen' | 'melody' (you play the melody) | 'chords' (you play the chords)
    this.wait = false; this.gate = null; this.gateDone = -1; this.waiting = false;
    this.next = 0; this.timer = null; this.visuals = new Set(); this.runId = 0;
    this.onProgress = null; this.onEnd = null; this.onChord = null; this.onState = null;
  }

  load(song) {
    this.stop();
    this.song = song;
    this.compiled = compileSong(song);
    this.resetStats();
    this.spb = 60 / song.tempo;                 // seconds per beat
    this.duration = this.compiled.beats * this.spb + 2.5;
    this.pos = 0; this.next = 0;
    if (this.onProgress) this.onProgress(0, this.duration);
  }

  async play() {
    if (!this.song || this.playing) return;
    await this.audio.start();
    if (this.pos >= this.duration - 0.05) this.seek(0);
    this.playing = true;
    this.anchor = this.audio.now + 0.12 - this.pos / this.scale;
    this.timer = setInterval(() => this._tick(), 25);
    this._tick();
    if (this.onState) this.onState();
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    clearInterval(this.timer);
    this.pos = Math.max(0, (this.audio.now - this.anchor) * this.scale);
    this._clear();
    this._rewind();
    if (this.onState) this.onState();
  }

  stop() {
    const was = this.playing;
    this.playing = false; clearInterval(this.timer);
    this._clear();
    if (this.audio.ready) this.audio.dampAll();
    this.pos = 0; this.next = 0;
    this.scene.setHints([]);
    if (this.onChord) this.onChord(null);
    if (this.onProgress && this.song) this.onProgress(0, this.duration);
    if (was && this.onState) this.onState();
  }

  seek(seconds) {
    const playing = this.playing;
    if (playing) { clearInterval(this.timer); this.playing = false; }
    this._clear();
    if (this.audio.ready) this.audio.dampAll();
    this.pos = Math.max(0, Math.min(this.duration, seconds));
    this._rewind();
    if (this.onProgress) this.onProgress(this.pos, this.duration);
    if (playing) { this.playing = false; this.play(); }
  }

  setTempoScale(scale) {
    if (this.playing) { const p = (this.audio.now - this.anchor) * this.scale; this.scale = scale; this.anchor = this.audio.now - p / scale; this._clear(true); this.pos = p; this._rewind(this.audio.now + 0.03); }
    else this.scale = scale;
  }

  _rewind(from) {
    const ev = this.compiled.events, beat = this.pos / this.spb;
    let i = 0; while (i < ev.length && ev[i].t < beat - 1e-6) i++;
    this.next = i; this.minTime = from || 0;
    this.gate = null; this.gateDone = i - 1; this.waiting = false; this.runId++;
  }

  _clear(keepFingers) {
    this.audio.flush();
    for (const id of this.visuals) clearTimeout(id);
    this.visuals.clear();
    if (!keepFingers) for (let s = 0; s < MELODY_COUNT; s++) this.scene.setFinger(s, 0, 'song');
  }

  _later(time, fn) {
    const ms = Math.max(0, (time - this.audio.now) * 1000);
    const id = setTimeout(() => { this.visuals.delete(id); fn(); }, ms);
    this.visuals.add(id);
  }

  /** How many notes the player has to supply in this piece in the current practice mode. */
  gateCount() {
    if (!this.compiled || this.mode === 'listen') return 0;
    const isGate = this.mode === 'melody' ? (e) => e.type === 'mel' && e.top : (e) => e.type === 'open' && e.bass;
    return this.compiled.events.filter(isGate).length;
  }
  resetStats() { this.stats = { hit: 0, wrong: 0, waitSum: 0 }; }

  /** Position in beats right now. */
  beat() {
    if (this.waiting && this.gate) return this.gate.t;          // held at the note being waited for
    return (this.playing ? Math.max(0, (this.audio.now - this.anchor) * this.scale) : this.pos) / this.spb;
  }

  /** The player plucked a note. In wait mode the right note moves the song on:
   *  the melody note that is due, or (when you play the chords) the bass note of the bar. */
  userPluck(midi, string = -1) {
    const g = this.gate;
    if (!g || !this.playing) return false;
    const now = this.audio.now, tg = this.anchor + g.t * this.spb / this.scale;
    const right = g.bass ? string >= 17 && ((midi - g.midi) % 12 + 12) % 12 === 0 : midi === g.midi;
    if (!right || now < tg - 0.45) { if (this.waiting) this.stats.wrong++; return false; }
    this.stats.hit++;
    if (this.waiting) this.stats.waitSum += now - this.waitStart;
    if (now > tg) this.anchor = now - g.t * this.spb / this.scale;
    this.gateDone = g.i; this.gate = null; this.waiting = false;
    this._tick();
    return true;
  }

  _tick() {
    if (!this.playing) return;
    const a = this.audio, sc = this.scene, ev = this.compiled.events, now = a.now, horizon = now + 0.15;
    const sec = (beats) => this.anchor + beats * this.spb / this.scale;
    const userMelody = this.mode === 'melody', userChords = this.mode === 'chords';
    let limit = Infinity;
    if ((userMelody || userChords) && this.wait) {
      // the gate is the next note the player has to pluck; nothing at or after it is played until then
      if (!this.gate) {
        const isGate = userMelody ? (e) => e.type === 'mel' && e.top : (e) => e.type === 'open' && e.bass;
        let i = Math.max(this.next, this.gateDone + 1);
        while (i < ev.length && !isGate(ev[i])) i++;
        if (i < ev.length) {
          const e = ev[i];
          this.gate = { i, t: e.t, e, bass: userChords, midi: STRINGS[e.string].midi + (e.fret || 0) };
          if (this.onGate) this.onGate(this.gate);
          if (userMelody) this._later(Math.max(now, sec(e.t) - 1.2), () => sc.setFinger(e.string, e.fret, 'song'));     // show it a little ahead
        }
      }
      const g = this.gate;
      if (g) {
        limit = g.t;
        const tg = sec(g.t);
        if (now >= tg) {                         // the note is due: hold the song here
          if (!this.waiting) this.waitStart = now;
          this.anchor += now - tg; this.waiting = true;
          if (userMelody) sc.setFinger(g.e.string, g.e.fret, 'song');
          sc.flash(g.e.string, 0.5);
          // light the chord that belongs to this moment, so the strings to pluck are shown while the song waits
          for (let j = this.next; j < ev.length && ev[j].t <= g.t + 1e-9; j++) {
            const c = ev[j];
            if (c.type !== 'chord' || c.shown === this.runId) continue;
            c.shown = this.runId;
            sc.setHints([...c.strings.acc.map((x) => [x, 0]), [c.strings.bass, 1]]);
            if (this.onChord) this.onChord(c.chord);
          }
        }
      }
    } else { this.gate = null; this.waiting = false; }

    while (this.next < ev.length && sec(ev[this.next].t) < horizon) {
      if (ev[this.next].t >= limit - 1e-9) break;          // nothing at or after the gate until it is passed
      const e = ev[this.next++];
      let time = Math.max(sec(e.t), now + 0.005);
      if (e.type === 'mel') {
        const end = sec(e.t + e.dur), mine = userMelody && e.top;      // the player's own note: shown but not sounded
        if (!mine) {
          a.pluck(e.string, e.vel, e.fret, time);
          if (this.vibrato && end - time > 0.6) a.vibrato(e.string, 0.16 * this.vibDepth, 5.5, 0.25, time);
          if (e.damp) a.damp(e.string, Math.max(time + 0.05, end + 0.03));
        }
        this._later(time, () => { sc.setFinger(e.string, e.fret, 'song'); sc.flash(e.string, 0.9); if (!mine) sc.handPluck(e.string); });
        this._later(end - 0.02, () => { if (sc.markers[e.string].song.fret === e.fret && !(this.gate && !this.gate.bass && this.gate.e.string === e.string)) sc.setFinger(e.string, 0, 'song'); });
      } else if (e.type === 'open') {
        time += (e.roll || 0) * 0.013;                    // roll chords slightly, low string first
        if (!userChords) a.pluck(e.string, e.vel, undefined, time);
        this._later(time, () => { sc.flash(e.string, 0.8); if (!userChords) sc.handPluck(e.string); });
      } else if (e.type === 'damp') {
        if (!userChords) a.damp(e.string, time);
      } else if (e.type === 'chord') {
        if (e.shown === this.runId) continue;             // already lit while waiting at the gate
        e.shown = this.runId;
        this._later(time, () => {
          sc.setHints([...e.strings.acc.map((s) => [s, 0]), [e.strings.bass, 1]]);
          if (this.onChord) this.onChord(e.chord);
        });
      }
    }
    const p = Math.max(0, (now - this.anchor) * this.scale);
    if (this.onProgress) this.onProgress(Math.min(p, this.duration), this.duration);
    if (p >= this.duration) {
      this.playing = false; clearInterval(this.timer);
      this.pos = this.duration;
      sc.setHints([]); if (this.onChord) this.onChord(null);
      if (this.loop) { this.pos = 0; this._rewind(); this.play(); }
      else { if (this.onState) this.onState(); if (this.onEnd) this.onEnd(); }
    }
  }
}

/** Build a song from pasted ABC notation (one tune, one voice). Throws if nothing playable is found. */
export function songFromAbc(text, opts = {}) {
  const hdr = {}, body = [];
  let inBody = false, voices = 0, skip = false;
  for (const raw of String(text).replace(/\r/g, '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('%')) continue;
    const m = /^([A-Za-z]):\s*(.*)$/.exec(line);
    if (m && !/^[A-Za-z]:[|:\]]/.test(line)) {
      const k = m[1], v = m[2].replace(/%.*$/, '').trim();
      if (k === 'V') { voices++; skip = voices > 1; continue; }
      if (k === 'X' && inBody) break;                              // a second tune: stop
      if (!inBody) { if (!(k in hdr)) hdr[k] = v; if (k === 'K') inBody = true; }
      else if (k === 'K' || k === 'M') body.push('[' + k + ':' + v + ']');
      continue;
    }
    if (!skip) body.push(raw);
  }
  if (!('K' in hdr)) throw new Error('This does not look like ABC notation: there is no K: (key) line. A tune starts with lines such as T:, M:, L: and K:, followed by the notes.');
  let meter = (hdr.M || '4/4').trim();
  if (meter === 'C') meter = '4/4'; else if (meter === 'C|') meter = '2/2';
  if (!/^\d+\/\d+$/.test(meter)) meter = '4/4';
  const [mn, md] = meter.split('/').map(Number);
  const unit = /^\d+\/\d+$/.test(hdr.L || '') ? hdr.L : (mn / md < 0.75 ? '1/16' : '1/8');
  let tempo = { '3/4': 132, '6/8': 80 }[meter] || 108;
  const q = /(\d+)\/(\d+)\s*=\s*(\d+)/.exec(hdr.Q || '') || null, qn = /^\s*(\d+)\s*$/.exec(hdr.Q || '');
  if (q) tempo = Math.round(q[3] * (q[1] / q[2]) * 4); else if (qn) tempo = +qn[1];
  tempo = Math.max(30, Math.min(300, tempo));
  const auto = meter === '3/4' ? 'waltz' : md === 8 && mn % 3 === 0 ? 'arp' : mn === 3 ? 'waltz' : 'polka';
  const song = {
    id: 'user-' + Date.now().toString(36), category: 'My Songs', user: true,
    title: (hdr.T || 'Untitled').slice(0, 80), composer: (hdr.C || 'Imported').slice(0, 80), year: null,
    key: (hdr.K || 'C').split(/\s+/).slice(0, 2).join('').replace(/(major|minor)$/i, (x) => x.slice(0, 3)), meter, unit, tempo,
    style: opts.style && opts.style !== 'auto' ? opts.style : auto, transpose: opts.octaveUp ? 12 : 0,
    accuracy: 'user', source: 'Imported from ABC notation' + (voices > 1 ? ' (first voice only).' : '.'), abc: body.join('\n'),
  };
  const tune = parseTune(song), comp = compileSong(song);
  const wanted = tune.groups.reduce((n, g) => n + g.pitches.length, 0), placed = comp.events.filter((e) => e.type === 'mel').length;
  if (!placed) throw new Error('No playable notes were found. Paste the tune in ABC notation, including its K: (key) line.');
  const barBeats = mn * 4 / md;
  let odd = 0;
  for (let i = 1; i + 2 < tune.bars.length; i++) if (tune.meters.length === 1 && Math.abs(tune.bars[i + 1] - tune.bars[i] - barBeats) > 1e-6) odd++;
  return { song, info: { notes: placed, unplaced: wanted - placed, bars: comp.bars, oddBars: odd, chords: tune.chords.length, seconds: Math.round(comp.beats * 60 / tempo) } };
}
