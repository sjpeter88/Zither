// Scrolling tablature for the melody: five lines for the five melody strings
// (in the same order as on screen), fret numbers at each note, chord symbols
// above, and a fixed playhead the music scrolls past.
import { STRINGS, MELODY_COUNT, stringLabel } from './zither-model.js';


export class TabStrip {
  constructor(canvas, player) {
    this.canvas = canvas; this.player = player;
    this.ctx = canvas.getContext('2d');
    this.w = 0; this.h = 0;
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
}
