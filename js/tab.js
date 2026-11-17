// Scrolling tablature for the melody: five lines for the five melody strings
// (in the same order as on screen), fret numbers at each note, chord symbols
// above, and a fixed playhead the music scrolls past.
import { STRINGS, MELODY_COUNT, stringLabel } from './zither-model.js';
import { keySignature } from './player.js';

const LETTERS = 'CDEFGAB', NAT = [0, 2, 4, 5, 7, 9, 11];
const BLACK_IN_C = { 1: ['C', 1], 3: ['E', -1], 6: ['F', 1], 8: ['G', 1], 10: ['B', -1] };

/** Spell a MIDI pitch in a key: [letter index 0-6, alteration, diatonic step from C0]. */
function spell(midi, sig, sharpKey, flatKey) {
  const pc = ((midi % 12) + 12) % 12;
  let best = null;
  for (let L = 0; L < 7; L++) {
    let alt = pc - NAT[L]; if (alt > 6) alt -= 12; if (alt < -6) alt += 12;
    if (Math.abs(alt) > 1) continue;
    const inKey = (sig[LETTERS[L]] || 0) === alt;
    const score = inKey ? 3 : alt === 0 ? 2 : (sharpKey && alt === 1) || (flatKey && alt === -1) ? 1 : 0;
    if (!best || score > best.score) best = { L, alt, score };
  }
  if (!sharpKey && !flatKey && best.score < 2 && BLACK_IN_C[pc]) { const [l, a] = BLACK_IN_C[pc]; best = { L: LETTERS.indexOf(l), alt: a }; }
  const octave = Math.floor((midi - best.alt) / 12) - 1;
  return { L: best.L, alt: best.alt, step: octave * 7 + best.L };
}


export class TabStrip {
  constructor(canvas, player) {
    this.canvas = canvas; this.player = player;
    this.ctx = canvas.getContext('2d');
    this.w = 0; this.h = 0;
    this.view = 'tab'; this.cache = null;
    // a treble clef glyph, if this device's fonts have one
    const c = this.ctx; c.font = '40px serif';
    const wClef = c.measureText('\u{1D11E}').width, wNone = c.measureText('\u{E0FFF}').width;
    this.hasClef = wClef > 4 && Math.abs(wClef - wNone) > 0.5;
  }

  /** Spelled notes for the notation view, worked out once per arrangement. */
  _notes() {
    const p = this.player;
    if (this.cache && this.cache.compiled === p.compiled) return this.cache;
    const key = p.keyName(), sig = keySignature(key);
    const nSharp = Object.values(sig).filter((v) => v > 0).length, nFlat = Object.values(sig).filter((v) => v < 0).length;
    const bars = p.compiled.barTimes, notes = [];
    let bar = -1, acc = {};
    for (const e of p.compiled.events) {
      if (e.type !== 'mel') continue;
      let b = bar; while (b + 1 < bars.length && bars[b + 1] <= e.t + 1e-6) b++;
      if (b !== bar) { bar = b; acc = {}; }
      const one = (midi) => {
        const sp = spell(midi, sig, nSharp > 0, nFlat > 0), id = sp.step, cur = id in acc ? acc[id] : (sig[LETTERS[sp.L]] || 0);
        const show = sp.alt !== cur ? (sp.alt === 1 ? '♯' : sp.alt === -1 ? '♭' : '♮') : '';
        acc[id] = sp.alt;
        return { step: sp.step, show };
      };
      const grace = e.grace ? e.grace.map(one) : [];
      notes.push({ e, ...one(STRINGS[e.string].midi + e.fret), grace });
    }
    this.cache = { compiled: p.compiled, notes, sig, nSharp, nFlat };
    return this.cache;
  }

  resize() {
    const r = this.canvas.getBoundingClientRect(), dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (!r.width || !r.height) return;
    this.w = r.width; this.h = r.height;
    this.canvas.width = Math.round(r.width * dpr); this.canvas.height = Math.round(r.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  draw() {
    const p = this.player, c = this.ctx, w = this.w, h = this.h;
    if (!w || !p.compiled) return;
    c.clearRect(0, 0, w, h);
    if (this.view === 'notes') return this._drawNotes();
    const gutter = 26, head = gutter + Math.min(170, (w - gutter) * 0.24);
    const top = 22, gap = (h - top - 9) / (MELODY_COUNT - 1);
    // string 0 (nearest the player) is the bottom line, as on the instrument
    const lineY = (s) => top + (MELODY_COUNT - 1 - s) * gap;
    const beat = p.beat(), ppb = Math.max(46, Math.min(92, 5200 / p.song.tempo));
    const X = (t) => head + (t - beat) * ppb;
    const t0 = beat - (head - gutter) / ppb - 1, t1 = beat + (w - head) / ppb + 1;

    c.font = '600 11px Georgia, serif'; c.textBaseline = 'middle'; c.textAlign = 'center';
    for (let s = 0; s < MELODY_COUNT; s++) {
      c.strokeStyle = 'rgba(232,201,140,0.22)'; c.lineWidth = 1;
      c.beginPath(); c.moveTo(gutter, lineY(s) + 0.5); c.lineTo(w, lineY(s) + 0.5); c.stroke();
    }
    c.save(); c.beginPath(); c.rect(gutter, 0, w - gutter, h); c.clip();
    // bar lines
    c.strokeStyle = 'rgba(232,201,140,0.3)';
    for (const b of p.compiled.barTimes) {
      if (b < t0 || b > t1) continue;
      const x = Math.round(X(b)) + 0.5;
      c.beginPath(); c.moveTo(x, top - 3); c.lineTo(x, h - 6); c.stroke();
    }
    const gate = p.gate;
    for (const e of p.compiled.events) {
      if (e.t > t1) break;
      if (e.type === 'chord') {
        if (e.t < t0) continue;
        c.fillStyle = e.t <= beat ? 'rgba(244,213,148,0.55)' : '#f4d594';
        c.font = '600 13px Georgia, serif'; c.textAlign = 'left';
        c.fillText(e.chord.sym, X(e.t) + 3, 9);
        continue;
      }
      if (e.type !== 'mel' || e.t + e.dur < t0) continue;
      const x = X(e.t), y = lineY(e.string), len = Math.max(0, e.dur * ppb - 4);
      const past = e.t + e.dur <= beat, now = e.t <= beat && !past, due = gate && gate.e === e;
      // length of the note
      c.fillStyle = past ? 'rgba(217,178,106,0.14)' : now || due ? 'rgba(244,213,148,0.6)' : 'rgba(217,178,106,0.32)';
      c.beginPath(); c.roundRect(x, y - 3, len, 6, 3); c.fill();
      // fret number
      const r = Math.min(8.5, gap * 0.46);
      c.beginPath(); c.arc(x, y, r, 0, 7);
      c.fillStyle = due ? '#f4d594' : now ? '#d9b26a' : '#19130e'; c.fill();
      c.lineWidth = e.top ? 1.6 : 1; c.strokeStyle = past ? 'rgba(217,178,106,0.3)' : '#d9b26a'; c.stroke();
      c.fillStyle = due || now ? '#24160a' : past ? 'rgba(243,234,217,0.4)' : '#f3ead9';
      c.font = '700 10.5px system-ui, sans-serif'; c.textAlign = 'center';
      c.fillText(String(e.fret), x, y + 0.5);
    }
    c.restore();
    // string names and playhead
    c.fillStyle = 'rgba(22,16,12,0.9)'; c.fillRect(0, 0, gutter, h);
    c.font = '600 11px Georgia, serif'; c.textAlign = 'center';
    for (let s = 0; s < MELODY_COUNT; s++) { c.fillStyle = '#b9aa92'; c.fillText(stringLabel(s), gutter / 2, lineY(s)); }
    c.strokeStyle = p.waiting ? '#ffe2ad' : 'rgba(244,213,148,0.85)'; c.lineWidth = p.waiting ? 2.5 : 1.5;
    c.beginPath(); c.moveTo(head, 14); c.lineTo(head, h - 3); c.stroke();
    if (p.wait && p.mode !== 'listen') {
      const st = p.stats, n = p.gateCount();
      const avg = st.hit ? (st.waitSum / st.hit).toFixed(1) : '0.0';
      c.fillStyle = '#b9aa92'; c.font = '600 11px system-ui, sans-serif'; c.textAlign = 'right';
      c.fillText(`${st.hit} / ${n} notes · ${st.wrong} wrong · waited ${avg} s a note`, w - 8, 9);
    }
    if (p.waiting) {
      c.fillStyle = '#ffe2ad'; c.font = '600 11px system-ui, sans-serif'; c.textAlign = 'right';
      c.fillText('your turn', head - 6, 9);
    }
  }

  // ---- standard notation: treble staff, key signature, note heads with stems, accidentals, ledger lines
  _drawNotes() {
    const p = this.player, c = this.ctx, w = this.w, h = this.h, N = this._notes();
    const top = 20, hs = Math.max(2.6, Math.min(4.3, (h - top - 6) / 20));       // half a staff space
    const E4 = 4 * 7 + 2, baseY = top + 13 * hs;                                    // bottom staff line (E4)
    const Y = (step) => baseY - (step - E4) * hs;
    const ks = N.nSharp || N.nFlat, gutter = (this.hasClef ? 30 : 12) + ks * 7 + 6;
    const head = gutter + Math.min(170, (w - gutter) * 0.24);
    const beat = p.beat(), ppb = Math.max(46, Math.min(92, 5200 / p.song.tempo));
    const X = (t) => head + (t - beat) * ppb;
    const t0 = beat - (head - gutter) / ppb - 1, t1 = beat + (w - head) / ppb + 1;
    c.strokeStyle = 'rgba(232,201,140,0.35)'; c.lineWidth = 1;
    for (let k = 0; k < 5; k++) { const y = Math.round(Y(E4 + 2 * k)) + 0.5; c.beginPath(); c.moveTo(4, y); c.lineTo(w, y); c.stroke(); }
    c.save(); c.beginPath(); c.rect(gutter, 0, w - gutter, h); c.clip();
    c.strokeStyle = 'rgba(232,201,140,0.4)';
    for (const b of p.compiled.barTimes) {
      if (b < t0 || b > t1) continue;
      const x = Math.round(X(b)) + 0.5; c.beginPath(); c.moveTo(x, Y(E4 + 8)); c.lineTo(x, Y(E4)); c.stroke();
    }
    for (const e of p.compiled.events) {
      if (e.t > t1) break;
      if (e.type !== 'chord' || e.t < t0) continue;
      c.fillStyle = e.t <= beat ? 'rgba(244,213,148,0.55)' : '#f4d594';
      c.font = '600 13px Georgia, serif'; c.textAlign = 'left'; c.textBaseline = 'middle';
      c.fillText(e.chord.sym, X(e.t) + 3, 9);
    }
    const gate = p.gate, rx = hs * 1.35, ry = hs * 0.95;
    const ledger = (x, step) => {
      c.strokeStyle = 'rgba(232,201,140,0.55)';
      for (let s = E4 - 2; s >= step; s -= 2) { const y = Math.round(Y(s)) + 0.5; c.beginPath(); c.moveTo(x - rx - 3, y); c.lineTo(x + rx + 3, y); c.stroke(); }
      for (let s = E4 + 10; s <= step; s += 2) { const y = Math.round(Y(s)) + 0.5; c.beginPath(); c.moveTo(x - rx - 3, y); c.lineTo(x + rx + 3, y); c.stroke(); }
    };
    for (const n of N.notes) {
      const e = n.e;
      if (e.t > t1) break;
      if (e.t + e.dur < t0) continue;
      const x = X(e.t), y = Y(n.step);
      const past = e.t + e.dur <= beat, now = e.t <= beat && !past, due = gate && gate.e === e;
      const col = due ? '#ffe2ad' : now ? '#f4d594' : past ? 'rgba(243,234,217,0.35)' : e.top ? '#f3ead9' : 'rgba(243,234,217,0.7)';
      ledger(x, n.step);
      // grace notes: small heads just before the note
      n.grace.forEach((g, j) => {
        const gx = x - (n.grace.length - j) * rx * 1.9 - 2, gy = Y(g.step);
        ledger(gx, g.step);
        c.fillStyle = col; c.beginPath(); c.ellipse(gx, gy, rx * 0.62, ry * 0.62, -0.35, 0, 7); c.fill();
        c.strokeStyle = col; c.lineWidth = 1; c.beginPath(); c.moveTo(gx + rx * 0.58, gy); c.lineTo(gx + rx * 0.58, gy - hs * 4.5); c.stroke();
      });
      const d = e.dur, hollow = d >= 1.99, whole = d >= 3.99, dotted = [0.75, 1.5, 3, 0.375].some((v) => Math.abs(d - v) < 0.02);
      c.fillStyle = col; c.strokeStyle = col; c.lineWidth = 1.3;
      c.beginPath(); c.ellipse(x, y, rx, ry, -0.35, 0, 7);
      if (hollow) c.stroke(); else c.fill();
      if (!whole && e.top) {
        const up = n.step < E4 + 4, sx = up ? x + rx - 0.6 : x - rx + 0.6;
        c.beginPath(); c.moveTo(sx, y); c.lineTo(sx, y + (up ? -1 : 1) * hs * 7); c.stroke();
      }
      if (dotted) { c.beginPath(); c.arc(x + rx + 4, y - (n.step % 2 === 0 ? hs * 0.5 : 0), 1.4, 0, 7); c.fill(); }
      if (n.show) { c.font = `${Math.round(hs * 3.6)}px system-ui, sans-serif`; c.textAlign = 'right'; c.textBaseline = 'middle'; c.fillText(n.show, x - rx - (n.grace.length ? n.grace.length * rx * 1.9 + 2 : 2), y); }
    }
    c.restore();
    // clef and key signature
    c.fillStyle = 'rgba(22,16,12,0.92)'; c.fillRect(0, 0, gutter, h);
    c.strokeStyle = 'rgba(232,201,140,0.35)'; c.lineWidth = 1;
    for (let k = 0; k < 5; k++) { const y = Math.round(Y(E4 + 2 * k)) + 0.5; c.beginPath(); c.moveTo(4, y); c.lineTo(gutter, y); c.stroke(); }
    c.fillStyle = '#e6d6b8';
    if (this.hasClef) { c.font = `${Math.round(hs * 9.5)}px serif`; c.textAlign = 'left'; c.textBaseline = 'alphabetic'; c.fillText('\u{1D11E}', 5, Y(E4) + hs * 2.4); }
    const SH = [E4 + 8, E4 + 5, E4 + 9, E4 + 6, E4 + 3, E4 + 7, E4 + 4], FL = [E4 + 4, E4 + 7, E4 + 3, E4 + 6, E4 + 2, E4 + 5, E4 + 1];
    c.font = `${Math.round(hs * 3.6)}px system-ui, sans-serif`; c.textAlign = 'center'; c.textBaseline = 'middle';
    for (let k = 0; k < ks; k++) c.fillText(N.nSharp ? '♯' : '♭', (this.hasClef ? 30 : 12) + k * 7 + 3, Y((N.nSharp ? SH : FL)[k]) - (N.nFlat ? hs * 0.6 : 0));
    // playhead and status
    c.strokeStyle = p.waiting ? '#ffe2ad' : 'rgba(244,213,148,0.85)'; c.lineWidth = p.waiting ? 2.5 : 1.5;
    c.beginPath(); c.moveTo(head, 14); c.lineTo(head, h - 3); c.stroke();
    if (p.wait && p.mode !== 'listen') {
      const st = p.stats, n = p.gateCount(), avg = st.hit ? (st.waitSum / st.hit).toFixed(1) : '0.0';
      c.fillStyle = '#b9aa92'; c.font = '600 11px system-ui, sans-serif'; c.textAlign = 'right'; c.textBaseline = 'middle';
      c.fillText(`${st.hit} / ${n} notes · ${st.wrong} wrong · waited ${avg} s a note`, w - 8, 9);
    }
    if (p.waiting) { c.fillStyle = '#ffe2ad'; c.font = '600 11px system-ui, sans-serif'; c.textAlign = 'right'; c.fillText('your turn', head - 6, 9); }
  }
}
