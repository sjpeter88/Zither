// Kept with the project: used to bring the Mutopia pieces added in 1.6 into ABC for songs.js.
// Minimal LilyPond -> ABC converter for one melodic voice.
// usage: node tools/ly2abc.mjs file.ly varName key meter unitDen [startText] [endText]
// Handles \relative or absolute pitch, english (fs, bf) and dutch (fis, bes) names,
// chords, durations, dots, ties, rests, \times tuplets, \repeat volta + \alternative,
// \partial, << {first voice} \\ {...} >>, grace notes (dropped).
import { readFileSync } from 'node:fs';
const [file, varName, key, meter, unitDen = '16', startText = '', endText = ''] = process.argv.slice(2);
let src = readFileSync(file, 'utf8').replace(/%\{[\s\S]*?%\}/g, '').replace(/%[^\n]*/g, '');
const at = src.indexOf(varName + ' =');
if (at < 0) throw new Error('no variable ' + varName);
const open = src.indexOf('{', at);
let depth = 0, end = open;
for (; end < src.length; end++) { if (src[end] === '{') depth++; else if (src[end] === '}' && !--depth) break; }
const head = src.slice(at, open + 1);
let body = src.slice(open + 1, end);
const rel = /\\relative\s+([a-g][a-z]*[',]*)/.exec(head);

// strip markup and settings
body = body
  .replace(/[\^_-]?\\markup\s*(\\[a-zA-Z-]+\s*)*\{(?:[^{}]|\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*\})*\}/g, ' ')
  .replace(/#\((?:[^()]|\([^()]*\))*\)/g, ' ')
  .replace(/\\(set|override|unset|revert)\s+[^\n]*/g, ' ')
  .replace(/\\(key)\s+\S+\s+\\\w+/g, ' ')
  .replace(/\\(time|clef|tempo|mark|transposition)\s+("[^"]*"|\S+)/g, ' ')
  .replace(/\\(voiceOne|voiceTwo|voiceOneNotes|break|myBreak|bar\s+"[^"]*"|slurDown|slurUp|slurNeutral|stemUp|stemDown|stemNeutral|dynamicUp|arpeggio|accent|staccato|trill|fermata|f|p|ff|pp|mf|mp|sf|fz|cresc|dim|startTextSpan|stopTextSpan|my\w+|dol|cres|cress|espr|rit|atem|smz|seg|cod|toseg|fin|pos\w+|\w+Spanner\w*)\b/g, ' ')
  .replace(/[\^_-][>^.!+_|-]/g, ' ')
  .replace(/-\d/g, ' ').replace(/\\\d/g, ' ')
  .replace(/[()\[\]]/g, ' ').replace(/\\\(|\\\)/g, ' ');
if (startText) { const k = body.indexOf(startText); if (k < 0) throw new Error('start text not found'); body = body.slice(k + startText.length); }
if (endText) { const k = body.indexOf(endText); if (k >= 0) body = body.slice(0, k); }

const toks = body.match(/\\[a-zA-Z]+|<<|>>|\\\\|\d+\/\d+|\d+\*\d+|[{}<>~]|[a-g](?:isis|eses|is|es|ss|ff|s|f)?[',]*!?\??\d*\.*|[rsR]\d*\.*|\d+\.*/g) || [];

const STEP = { c: 0, d: 1, e: 2, f: 3, g: 4, a: 5, b: 6 }, SEMI = [0, 2, 4, 5, 7, 9, 11];
function pitch(tok) {
  const m = /^([a-g])(isis|eses|is|es|ss|ff|s|f)?([',]*)/.exec(tok);
  const alt = { is: 1, s: 1, isis: 2, ss: 2, es: -1, f: -1, eses: -2, ff: -2 }[m[2]] || 0;
  let o = 0; for (const ch of m[3]) o += ch === "'" ? 1 : -1;
  return { step: STEP[m[1]], alt, o };
}
let prevDia = null;
if (rel) { const p = pitch(rel[1]); prevDia = (3 + p.o) * 7 + p.step; }
function resolve(p) {
  let dia;
  if (prevDia == null) dia = (3 + p.o) * 7 + p.step;
  else {
    let best = null;
    for (let oc = 0; oc < 10; oc++) { const d = oc * 7 + p.step; if (best == null || Math.abs(d - prevDia) < Math.abs(best - prevDia)) best = d; }
    dia = best + p.o * 7;
  }
  const octave = Math.floor(dia / 7), step = dia - octave * 7;
  return { dia, step, alt: p.alt, octave, midi: (octave + 1) * 12 + SEMI[step] + p.alt };
}
const relative = !!rel;

// parse into events
const ev = [];
let lastDur = 1, tmul = 1, grace = 0;
const stack = [];   // entries: 'brace', 'tuplet', 'rep', 'alts', 'alt', 'voices', 'skipvoice'
let voiceSkip = 0;
const dur = (s) => { const m = /(\d+)(\.*)$/.exec(s); if (!m) return null; return (4 / +m[1]) * (2 - Math.pow(0.5, m[2].length)) / 4; };   // in whole notes
for (let k = 0; k < toks.length; k++) {
  const t = toks[k];
  if (t === '\\acciaccatura' || t === '\\appoggiatura' || t === '\\grace') { grace = 1; continue; }
  if (t === '\\times' || t === '\\tuplet') { const [a, b] = toks[++k].split('/').map(Number); stack.push({ kind: 'tuplet', prev: tmul }); tmul *= t === '\\times' ? a / b : b / a; ev.push({ type: 'tuplet', n: t === '\\times' ? b : a }); continue; }
  if (t === '\\repeat') { k += 2; stack.push({ kind: 'rep' }); ev.push({ type: 'repStart' }); continue; }
  if (t === '\\alternative') { stack.push({ kind: 'alts', n: 0 }); continue; }
  if (t === '\\partial') { const v = toks[++k]; const [d, mul] = v.split('*'); ev.push({ type: 'partial', len: (1 / +d) * (mul ? +mul : 1) }); continue; }
  if (t === '\\relative') { k++; continue; }
  if (t === '<<') { stack.push({ kind: 'voices', sep: false }); continue; }
  if (t === '\\\\') { const v = [...stack].reverse().find((x) => x.kind === 'voices'); if (v) { v.sep = true; voiceSkip++; } continue; }
  if (t === '>>') { const v = stack.pop(); if (v && v.sep) voiceSkip--; continue; }
  if (t === '{') {
    const top = stack[stack.length - 1];
    if (top && top.kind === 'alts') {
      if (top.opened) { top.n++; stack.push({ kind: 'alt', n: top.n }); if (!voiceSkip) ev.push({ type: 'alt', n: top.n }); }
      else { top.opened = true; stack.push({ kind: 'altsBrace' }); }
      continue;
    }
    stack.push({ kind: 'brace', parent: top && top.kind });
    continue;
  }
  if (t === '}') {
    const b = stack.pop();
    if (b && b.kind === 'altsBrace') { stack.pop(); if (!voiceSkip) ev.push({ type: 'altsEnd' }); continue; }
    if (b && b.kind === 'alt') { const top = stack[stack.length - 1]; stack.pop(); stack.push(top); continue; }
    const top = stack[stack.length - 1];
    if (top && top.kind === 'tuplet') { stack.pop(); tmul = top.prev; if (!voiceSkip) ev.push({ type: 'tupletEnd' }); }
    else if (top && top.kind === 'rep') {
      stack.pop();
      // a repeat without alternatives ends here; with alternatives, \alternative follows
      if (toks[k + 1] !== '\\alternative' && !voiceSkip) ev.push({ type: 'repEnd' });
    }
    continue;
  }
  if (t === '~') { const last = ev[ev.length - 1]; if (last && last.type === 'note') last.tie = true; continue; }
  if (t === '<') {
    const ps = []; let first = null;
    for (k++; k < toks.length && toks[k] !== '>'; k++) {
      if (!/^[a-g]/.test(toks[k])) continue;
      const r = resolve(pitch(toks[k]));
      if (relative) prevDia = r.dia;
      if (!first) first = r;
      ps.push(r);
    }
    if (relative && first) prevDia = first.dia;
    let d = lastDur;
    if (/^\d+\.*$/.test(toks[k + 1] || '')) { d = dur(toks[++k]); lastDur = d; }
    if (grace) { grace = 0; continue; }
    if (!voiceSkip) ev.push({ type: 'note', ps, d: d * tmul, written: d });
    continue;
  }
  if (/^[rsR]/.test(t)) {
    let d = lastDur; const dd = dur(t); if (dd) { d = dd; lastDur = d; }
    if (grace) { grace = 0; continue; }
    if (!voiceSkip) ev.push({ type: 'rest', d: d * tmul, written: d });
    continue;
  }
  if (/^[a-g]/.test(t)) {
    const r = resolve(pitch(t));
    if (relative) prevDia = r.dia;
    let d = lastDur; const dd = dur(t.replace(/^[a-g][a-z]*[',]*!?\??/, '')); if (dd) { d = dd; lastDur = d; }
    if (grace) { grace = 0; continue; }
    if (!voiceSkip) ev.push({ type: 'note', ps: [r], d: d * tmul, written: d });
  }
}

// emit ABC
const [mn, md] = meter.split('/').map(Number), barLen = mn / md, unit = 1 / +unitDen;
const KS = { C: 0, G: 1, D: 2, A: 3, E: 4, B: 5, F: -1, Bb: -2, Eb: -3, Ab: -4 }[key] ?? 0;
const sig = {}; for (let q = 0; q < Math.abs(KS); q++) sig[(KS > 0 ? 'FCGDAEB' : 'BEADGCF')[q]] = KS > 0 ? 1 : -1;
const LET = 'CDEFGAB';
let acc = {};
const name = (r) => {
  const L = LET[r.step], id = L + r.octave, cur = id in acc ? acc[id] : (sig[L] || 0);
  let a = ''; if (r.alt !== cur) { a = { 1: '^', 2: '^^', '-1': '_', '-2': '__', 0: '=' }[r.alt]; acc[id] = r.alt; }
  return a + (r.octave >= 5 ? L.toLowerCase() + "'".repeat(r.octave - 5) : L + ','.repeat(Math.max(0, 4 - r.octave)));
};
const len = (w) => { const u = w / unit; if (Math.abs(u - 1) < 1e-9) return ''; for (const den of [1, 2, 4, 8]) { const n = u * den; if (Math.abs(n - Math.round(n)) < 1e-6) return den === 1 ? String(Math.round(n)) : `${Math.round(n)}/${den}`; } return String(u); };
let pos = 0, out = '', bars = 0;
const bar = (s = '|') => { out += ` ${s} `; acc = {}; bars++; if (bars % 4 === 0) out += '\n'; };
const advance = (d) => { pos += d; while (pos > barLen - 1e-9) { pos -= barLen; if (pos < 1e-9) { pos = 0; bar(); } else { bar(); } } };
for (const e of ev) {
  if (e.type === 'partial') { pos = barLen - e.len; continue; }
  if (e.type === 'repStart') { out += ' |: '; continue; }
  if (e.type === 'repEnd') { out = out.replace(/\s\|\s*(\n?)\s*$/, ' :|$1 '); continue; }
  if (e.type === 'alt') { out = out.replace(/\s\|\s*(\n?)\s*$/, e.n === 1 ? ' |1$1 ' : ' :|2$1 '); if (!/[|][12]\s*$/.test(out.trim().slice(-4))) out += e.n === 1 ? ' |1 ' : ' :|2 '; continue; }
  if (e.type === 'altsEnd') { out = out.replace(/\s\|\s*(\n?)\s*$/, ' ||$1 '); continue; }
  if (e.type === 'tuplet') { out += ` (${e.n}`; continue; }
  if (e.type === 'tupletEnd') continue;
  if (e.type === 'rest') { out += ' z' + len(e.written); advance(e.d); continue; }
  const ps = e.ps.slice().sort((a, b) => b.midi - a.midi);
  const sel = [ps[0]];
  if (ps[1] && [3, 4, 8, 9].includes(ps[0].midi - ps[1].midi)) sel.push(ps[1]);
  const txt = sel.length > 1 ? '[' + sel.map(name).join('') + ']' : name(sel[0]);
  out += ' ' + txt + len(e.written) + (e.tie ? '-' : '');
  advance(e.d);
}
console.log(out.replace(/[ \t]+/g, ' ').replace(/ \n/g, '\n').trim());
