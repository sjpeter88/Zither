// Offline numerical checks of the string engine. Runs the exact file the
// browser loads as an AudioWorklet.   node tools/verify.mjs [--quick]
import '../web/worklet/zither-processor.js';
import { STRINGS, FRETS, MELODY_COUNT, engineConfig, midiName, setTuning, VOICES } from '../web/js/zither-model.js';
import { writeFileSync } from 'node:fs';

const Engine = globalThis.ZitherEngine;
const quick = process.argv.includes('--quick');
const BLOCK = 128;
const report = {};
const db = (x) => 20 * Math.log10(Math.max(x, 1e-300));

function render(eng, seconds, onBlock) {
  const L = new Float32Array(BLOCK), R = new Float32Array(BLOCK);
  const blocks = Math.ceil(seconds * eng.sr / BLOCK);
  for (let b = 0; b < blocks; b++) {
    eng.process(L, R, BLOCK, eng.clock || 0);
    eng.clock = (eng.clock || 0) + BLOCK / eng.sr;
    if (onBlock) onBlock(L, R, b);
  }
}

// ---- 1. tuning --------------------------------------------------------------
// Complex demodulation at the target frequency: the phase drift of the
// fundamental between two Hann windows gives the frequency error directly.
function demod(x, sr, f, start, len) {
  let re = 0, im = 0;
  const w = 2 * Math.PI * f / sr;
  for (let k = 0; k < len; k++) {
    const h = 0.5 - 0.5 * Math.cos(2 * Math.PI * k / len);
    const v = x[start + k] * h, ph = w * (start + k);
    re += v * Math.cos(ph); im -= v * Math.sin(ph);
  }
  return [re, im];
}
function wrap(p) { while (p > Math.PI) p -= 2 * Math.PI; while (p < -Math.PI) p += 2 * Math.PI; return p; }

function measureCents(x, sr, f) {
  const len = Math.round(1.0 * sr), t0 = Math.round(0.3 * sr);
  const a = demod(x, sr, f, t0, len);
  const b = demod(x, sr, f, t0 + Math.round(0.25 * sr), len);
  const c = demod(x, sr, f, t0 + Math.round(1.0 * sr), len);
  const ph = (p, q) => Math.atan2(q[1] * p[0] - q[0] * p[1], q[0] * p[0] + q[1] * p[1]);
  const coarse = ph(a, b) / (2 * Math.PI * 0.25);                 // Hz, unambiguous to ±2 Hz
  const fine = (coarse * 1.0 * 2 * Math.PI + wrap(ph(a, c) - coarse * 1.0 * 2 * Math.PI)) / (2 * Math.PI * 1.0);
  let rms = 0;
  for (let k = t0; k < t0 + len; k++) rms += x[k] * x[k];
  rms = Math.sqrt(rms / len);
  const amp = 2 * Math.hypot(a[0], a[1]) / (len / 2);
  return { cents: 1200 * Math.log2((f + fine) / f), share: amp / (rms * Math.SQRT2 + 1e-30) };
}

function tuningTest(sr) {
  const rows = [];
  const notes = [];
  for (let s = 0; s < STRINGS.length; s++) {
    const maxFret = s < MELODY_COUNT ? FRETS : 0;
    for (let fret = 0; fret <= maxFret; fret += (quick && fret > 0 ? 6 : 1)) notes.push([s, fret]);
  }
  for (const [s, fret] of notes) {
    const eng = new Engine(sr, engineConfig());
    eng.pluck(s, 0.8, fret);
    const total = Math.ceil(2.5 * sr / BLOCK) * BLOCK;
    const tap = new Float64Array(total), out = new Float64Array(total);
    render(eng, 2.5, (L, R, b) => {
      const base = s * eng.BUF;
      for (let k = 0; k < BLOCK; k++) {
        tap[b * BLOCK + k] = eng.buf[base + ((eng.w - BLOCK + k) & eng.MASK)];
        out[b * BLOCK + k] = L[k] + R[k];
      }
    });
    const f = STRINGS[s].freq * Math.pow(2, fret / 12);
    const m1 = measureCents(tap, sr, f), m2 = measureCents(out, sr, f);
    // the way a zither is actually tuned: every other string muted
    const iso = new Engine(sr, engineConfig());
    for (let j = 0; j < iso.n; j++) if (j !== s) { iso.damp(j); iso.dampUntil[j] = 1e9; }
    iso.pluck(s, 0.8, fret);
    const tapI = new Float64Array(total);
    render(iso, 2.5, (L, R, b) => { const base = s * iso.BUF; for (let k = 0; k < BLOCK; k++) tapI[b * BLOCK + k] = iso.buf[base + ((iso.w - BLOCK + k) & iso.MASK)]; });
    rows.push({ s, fret, f, alone: measureCents(tapI, sr, f).cents, string: m1.cents, output: m2.cents, share: m1.share });
  }
  const worst = (key, list) => list.reduce((a, r) => (Math.abs(r[key]) > Math.abs(a[key]) ? r : a));
  const open = rows.filter((r) => r.fret === 0), fretted = rows.filter((r) => r.fret > 0);
  const fmt = (r, key) => `${r[key].toFixed(4)} cents (string ${r.s + 1} ${midiName(STRINGS[r.s].midi)} fret ${r.fret}, ${r.f.toFixed(2)} Hz)`;
  console.log(`\n[tuning @ ${sr} Hz]  ${rows.length} notes measured (${open.length} open strings, ${fretted.length} fretted)`);
  console.log('  A. string alone (others muted, as when tuning)');
  console.log('     worst open string :', fmt(worst('alone', open), 'alone'));
  if (fretted.length) console.log('     worst fretted note:', fmt(worst('alone', fretted), 'alone'));
  console.log('  B. all 42 strings free to ring in sympathy, measured on the plucked string');
  console.log('     worst open string :', fmt(worst('string', open), 'string'));
  if (fretted.length) console.log('     worst fretted note:', fmt(worst('string', fretted), 'string'));
  console.log('  C. same, measured at the stereo output (plucked string + everything ringing with it)');
  console.log('     worst open string :', fmt(worst('output', open), 'output'));
  if (fretted.length) console.log('     worst fretted note:', fmt(worst('output', fretted), 'output'));
  const minShare = rows.reduce((a, r) => Math.min(a, r.share), 1e9);
  console.log('  weakest fundamental (share of string signal):', minShare.toFixed(3));
  const worstAll = Math.max(...rows.map((r) => Math.max(Math.abs(r.alone), Math.abs(r.string))));
  const worstOut = Math.max(...rows.map((r) => Math.abs(r.output)));
  const pass = worstAll < 1 && minShare > 0.02;
  console.log(`  => ${pass ? 'PASS' : 'FAIL'}: worst string error ${worstAll.toFixed(4)} cents (limit 1.0); worst apparent drift at the output ${worstOut.toFixed(4)} cents`);
  report['tuning_' + sr] = { notes: rows.length, worstCents: worstAll, worstCentsAtOutput: worstOut, minFundamentalShare: minShare, pass, open: open.map((r) => ({ string: r.s + 1, note: midiName(STRINGS[r.s].midi), hz: +r.f.toFixed(3), centsAlone: +r.alone.toFixed(5), cents: +r.string.toFixed(5), centsAtOutput: +r.output.toFixed(5) })) };
  return pass;
}

// ---- 2. glide / bend lands in tune -------------------------------------------
function glideTest(sr) {
  const eng = new Engine(sr, engineConfig());
  eng.pluck(0, 0.9, 3);
  render(eng, 0.2);
  eng.setFret(0, 7, 0);            // slide up four frets
  eng.setBend(0, 1);               // and bend a semitone
  render(eng, 0.3);
  eng.setBend(0, 0);
  const total = Math.ceil(2.5 * sr / BLOCK) * BLOCK, tap = new Float64Array(total);
  render(eng, 2.5, (L, R, b) => { for (let k = 0; k < BLOCK; k++) tap[b * BLOCK + k] = eng.buf[(eng.w - BLOCK + k) & eng.MASK]; });
  const f = STRINGS[0].freq * Math.pow(2, 7 / 12);
  const c = measureCents(tap, sr, f).cents;
  const pass = Math.abs(c) < 1;
  console.log(`\n[slide + bend @ ${sr} Hz] after sliding 3→7 and releasing a 1-semitone bend: ${c.toFixed(4)} cents  => ${pass ? 'PASS' : 'FAIL'}`);
  report['glide_' + sr] = { cents: c, pass };
  return pass;
}

// ---- 2b. vibrato wobbles the pitch and then settles back in tune ---------------------
function vibratoTest(sr) {
  const eng = new Engine(sr, engineConfig());
  eng.pluck(1, 0.9, 5);
  eng.setVibrato(1, 0.25, 5.5, 0.1);
  let lo = 1e9, hi = 0;
  render(eng, 1.2, () => { const f = eng.curF[1]; if (f < lo) lo = f; if (f > hi) hi = f; });
  eng.setVibrato(1, 0);
  const total = Math.ceil(2.5 * sr / BLOCK) * BLOCK, tap = new Float64Array(total);
  render(eng, 2.5, (L, R, b) => { for (let k = 0; k < BLOCK; k++) tap[b * BLOCK + k] = eng.buf[eng.BUF + ((eng.w - BLOCK + k) & eng.MASK)]; });
  const f = STRINGS[1].freq * Math.pow(2, 5 / 12);
  const swing = 1200 * Math.log2(hi / lo) / 2, c = measureCents(tap, sr, f).cents;
  const pass = Math.abs(c) < 1 && swing > 20 && swing < 30;
  console.log(`
[vibrato @ ${sr} Hz] swing +-${swing.toFixed(1)} cents while on (asked for +-25); after stopping: ${c.toFixed(4)} cents  => ${pass ? 'PASS' : 'FAIL'}`);
  report['vibrato_' + sr] = { swingCents: swing, centsAfter: c, pass };
  return pass;
}

// ---- 2c. retuning at run time: Viennese fretboard at A = 443, sent to a running engine --------
function retuneTest(sr) {
  const freqs = setTuning('vienna', 443);
  const rows = [];
  for (let s = 0; s < STRINGS.length; s++) {
    for (const fret of s < MELODY_COUNT ? [0, 7, 19] : [0]) {
      setTuning('munich', 440);
      const eng = new Engine(sr, engineConfig());          // starts in Munich tuning at 440 …
      eng.pluck(s, 0.8, 0);
      render(eng, 0.1);
      eng.setTuning(freqs);                                // … and is retuned while the string rings
      render(eng, 0.3);
      eng.pluck(s, 0.8, fret);
      const total = Math.ceil(2.5 * sr / BLOCK) * BLOCK, tap = new Float64Array(total);
      render(eng, 2.5, (L, R, b) => { const base = s * eng.BUF; for (let k = 0; k < BLOCK; k++) tap[b * BLOCK + k] = eng.buf[base + ((eng.w - BLOCK + k) & eng.MASK)]; });
      rows.push({ s, fret, f: freqs[s] * Math.pow(2, fret / 12), c: measureCents(tap, sr, freqs[s] * Math.pow(2, fret / 12)).cents });
    }
  }
  setTuning('munich', 440);
  const worst = rows.reduce((a, r) => (Math.abs(r.c) > Math.abs(a.c) ? r : a));
  const pass = Math.abs(worst.c) < 1;
  console.log(`\n[retune @ ${sr} Hz] Viennese fretboard, A = 443, sent to a running engine: ${rows.length} notes, worst ${worst.c.toFixed(4)} cents (string ${worst.s + 1} fret ${worst.fret}, ${worst.f.toFixed(2)} Hz)  => ${pass ? 'PASS' : 'FAIL'}`);
  report['retune_' + sr] = { notes: rows.length, worstCents: worst.c, pass };
  return pass;
}

// ---- 2d. sound presets keep every string in tune ---------------------------------------
function voiceTuningTest(sr) {
  let worst = 0, where = '';
  for (const v of Object.values(VOICES)) {
    for (const s of [0, 4, 10, 20, 35, 41]) {
      const cfg = engineConfig(); cfg.voice = v;
      const eng = new Engine(sr, cfg);
      eng.pluck(s, 0.8, 0);
      const total = Math.ceil(2.5 * sr / BLOCK) * BLOCK, tap = new Float64Array(total);
      render(eng, 2.5, (L, R, b) => { const base = s * eng.BUF; for (let k = 0; k < BLOCK; k++) tap[b * BLOCK + k] = eng.buf[base + ((eng.w - BLOCK + k) & eng.MASK)]; });
      const c = measureCents(tap, sr, STRINGS[s].freq).cents;
      if (Math.abs(c) > Math.abs(worst)) { worst = c; where = `${v.name}, string ${s + 1}`; }
    }
  }
  const pass = Math.abs(worst) < 1;
  console.log(`\n[sound presets @ ${sr} Hz] ${Object.keys(VOICES).length} presets × 6 strings: worst ${worst.toFixed(4)} cents (${where})  => ${pass ? 'PASS' : 'FAIL'}`);
  report['voices_' + sr] = { worstCents: worst, pass };
  return pass;
}

// ---- 3. stability -------------------------------------------------------------
function stabilityTest(sr, resonance, voice) {
  const cfg = engineConfig(); cfg.resonance = resonance;
  if (voice) cfg.voice = voice;
  const eng = new Engine(sr, cfg);
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const N = STRINGS.length, playSec = quick ? 8 : 30;
  let outPeak = 0, nan = false;
  const check = (L, R) => { for (let k = 0; k < BLOCK; k++) { const a = Math.max(Math.abs(L[k]), Math.abs(R[k])); if (!(a <= 1e9)) nan = true; if (a > outPeak) outPeak = a; } };
  // phase A: random full-force playing over every string, with slides and bends
  let next = 0, plucks = 0;
  render(eng, playSec, (L, R, b) => {
    const t = b * BLOCK / sr;
    while (t >= next) {
      const s = Math.floor(rnd() * N);
      eng.pluck(s, 1, s < MELODY_COUNT ? Math.floor(rnd() * (FRETS + 1)) : undefined); plucks++;
      if (rnd() < 0.3) eng.setBend(Math.floor(rnd() * MELODY_COUNT), rnd() * 2);
      if (rnd() < 0.3) eng.setFret(Math.floor(rnd() * MELODY_COUNT), Math.floor(rnd() * (FRETS + 1)), rnd());
      if (rnd() < 0.2) eng.setVibrato(Math.floor(rnd() * N), rnd(), 2 + rnd() * 10, 0);
      next += 0.004 + rnd() * 0.012;
    }
    check(L, R);
  });
  // phase B: every string plucked at full force at the same instant, 20 times a second
  render(eng, quick ? 3 : 10, (L, R, b) => {
    if (b % Math.round(0.05 * sr / BLOCK) === 0) { for (let s = 0; s < N; s++) eng.pluck(s, 1); plucks += N; }
    check(L, R);
  });
  const peakInternal = eng.peakPre, peakString = eng.peakString;
  // phase C: hands off. Stored energy may only fall, and must reach silence.
  for (let s = 0; s < MELODY_COUNT; s++) eng.setBend(s, 0);
  for (let s = 0; s < N; s++) eng.setVibrato(s, 0);
  render(eng, 0.5);
  const e0 = eng.energy();
  let prev = Infinity, acc = 0, worstRise = 0, t60 = null, t120 = null, tSleep = null, tailPeak = 0;
  const secs = 120, perSec = Math.round(sr / BLOCK);
  render(eng, secs, (L, R, b) => {
    for (let k = 0; k < BLOCK; k++) { const a = Math.abs(L[k]); if (!(a <= 1e9)) nan = true; if (b >= (secs - 1) * perSec && a > tailPeak) tailPeak = a; }
    acc += eng.energy();
    if (b % perSec === perSec - 1) {          // mean stored energy over each second
      const e = acc / perSec, t = (b + 1) * BLOCK / sr; acc = 0;
      if (prev > 1e-12 && prev !== Infinity) worstRise = Math.max(worstRise, e / prev - 1);
      prev = e;
      if (t60 == null && e < e0 * 1e-6) t60 = t;
      if (t120 == null && e < e0 * 1e-12) t120 = t;
      if (tSleep == null && eng.asleep) tSleep = t;
    }
  });
  const pass = !nan && outPeak <= 1.0000001 && worstRise <= 1e-9 && tailPeak === 0 && eng.asleep;
  console.log(`\n[stability @ ${sr} Hz, resonance ${resonance}${voice ? ', ' + voice.name + ' sound' : ''}]  ${plucks} full-force plucks over ${playSec + (quick ? 3 : 10)} s on all ${N} strings`);
  console.log(`  output peak (after soft clip): ${outPeak.toFixed(4)}   before clip: ${peakInternal.toFixed(2)}   largest string sample: ${peakString.toFixed(2)}   NaN/Inf: ${nan ? 'YES' : 'none'}`);
  console.log(`  after release: largest rise in stored energy from one second to the next: ${(worstRise * 100).toExponential(2)} %  (must be <= 0)`);
  console.log(`  energy -60 dB after ${t60?.toFixed(1)} s, -120 dB after ${t120?.toFixed(1)} s, engine fully silent (asleep) after ${tSleep?.toFixed(1)} s; last-second output peak ${tailPeak}`);
  console.log(`  => ${pass ? 'PASS' : 'FAIL'}`);
  report[`stability_${sr}_r${resonance}${voice ? '_' + voice.name : ''}`] = { plucks, outPeak, preClipPeak: peakInternal, peakString, nan, worstEnergyRise: worstRise, t60, t120, tSleep, tailPeak, pass };
  return pass;
}

// ---- 4. sympathetic resonance is present --------------------------------------
function sympatheticTest(sr) {
  const eng = new Engine(sr, engineConfig());
  eng.pluck(0, 0.9, 0);              // a' melody string only
  render(eng, 1.0);
  const lv = new Float32Array(eng.n); eng.levels(lv);
  const others = [...lv].map((v, i) => [i, v]).filter(([i]) => i !== 0).sort((a, b) => b[1] - a[1]).slice(0, 5);
  console.log(`\n[sympathetic resonance @ ${sr} Hz] 1 s after plucking only the first a' string (level ${lv[0].toFixed(4)}):`);
  console.log('  loudest strings ringing in sympathy: ' + others.map(([i, v]) => `${i + 1}:${midiName(STRINGS[i].midi)} ${(db(v / lv[0])).toFixed(1)} dB`).join(', '));
  report['sympathetic_' + sr] = others.map(([i, v]) => ({ string: i + 1, note: midiName(STRINGS[i].midi), dB: +db(v / lv[0]).toFixed(1) }));
}

// ---- 5. loudness balance -------------------------------------------------------
function balanceTest(sr) {
  const rows = [];
  for (const [s, fret] of [[0, 0], [0, 12], [0, 24], [2, 0], [4, 0], [5, 0], [10, 0], [16, 0], [17, 0], [28, 0], [29, 0], [35, 0], [41, 0]]) {
    const eng = new Engine(sr, engineConfig());
    eng.pluck(s, 0.8, fret);
    let pk = 0, sum = 0, n = 0;
    render(eng, 0.5, (L, R) => { for (let k = 0; k < BLOCK; k++) { const a = Math.abs(L[k]); if (a > pk) pk = a; sum += L[k] * L[k] + R[k] * R[k]; n += 2; } });
    rows.push(`${midiName(STRINGS[s].midi + fret)}: peak ${pk.toFixed(2)} rms ${db(Math.sqrt(sum / n)).toFixed(1)} dB`);
  }
  console.log(`\n[balance @ ${sr} Hz] single pluck at velocity 0.8, first 0.5 s:\n  ` + rows.join('\n  '));
}

// ---- 6. real-time headroom -----------------------------------------------------
function perfTest(sr) {
  const eng = new Engine(sr, engineConfig());
  const N = STRINGS.length, L = new Float32Array(BLOCK), R = new Float32Array(BLOCK);
  const seconds = quick ? 10 : 30, blocks = Math.ceil(seconds * sr / BLOCK), budget = BLOCK / sr * 1000;
  const times = new Float64Array(blocks);
  for (let warm = 0; warm < 400; warm++) { if (warm % 40 === 0) for (let s = 0; s < N; s++) eng.pluck(s, 1); eng.process(L, R, BLOCK, 0); }
  let seed = 7; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const t0 = performance.now();
  for (let b = 0; b < blocks; b++) {
    const a = performance.now();
    if (b % 8 === 0) { eng.pluck(Math.floor(rnd() * N), 1); eng.setBend(Math.floor(rnd() * MELODY_COUNT), rnd() * 2); eng.setFret(Math.floor(rnd() * MELODY_COUNT), Math.floor(rnd() * 29), 0.5); }
    eng.process(L, R, BLOCK, 0);
    times[b] = performance.now() - a;
  }
  const wall = performance.now() - t0;
  const sorted = Float64Array.from(times).sort();
  const mean = wall / blocks, p999 = sorted[Math.floor(blocks * 0.999)], max = sorted[blocks - 1];
  const over = sorted.filter((t) => t > budget).length;
  console.log(`\n[performance @ ${sr} Hz]  all ${N} strings sounding, plucks + slides + bends, ${seconds} s of audio in ${(wall / 1000).toFixed(2)} s`);
  console.log(`  ${(seconds * 1000 / wall).toFixed(1)}x faster than real time; mean ${(mean / budget * 100).toFixed(1)} % of the ${budget.toFixed(2)} ms block budget`);
  console.log(`  99.9th percentile block ${p999.toFixed(3)} ms (${(p999 / budget * 100).toFixed(0)} %), slowest block ${max.toFixed(3)} ms, blocks over budget: ${over} of ${blocks}`);
  // judged on the mean and the 99.9th percentile: the very slowest few blocks measure the PC's
  // scheduler (another program waking up), not the engine, and made short runs fail at random
  const pass = mean < budget * 0.5 && p999 < budget;
  console.log(`  => ${pass ? 'PASS' : 'FAIL'}`);
  report['performance_' + sr] = { realtimeFactor: seconds * 1000 / wall, meanBlockMs: mean, budgetMs: budget, p999Ms: p999, maxMs: max, blocksOverBudget: over, blocks, pass };
  return pass;
}

console.log(`Concert zither engine verification  (Node ${process.version}${quick ? ', quick mode' : ''})`);
let ok = true;
for (const sr of [48000, 44100]) { ok = tuningTest(sr) && ok; ok = glideTest(sr) && ok; ok = vibratoTest(sr) && ok; }
ok = stabilityTest(48000, 0.5) && ok;
ok = stabilityTest(48000, 1.0) && ok;
ok = stabilityTest(44100, 1.0) && ok;
ok = retuneTest(48000) && ok;
ok = voiceTuningTest(48000) && ok;
ok = stabilityTest(48000, 1.0, VOICES.resonant) && ok;
ok = stabilityTest(48000, 1.0, VOICES.brilliant) && ok;
sympatheticTest(48000);
balanceTest(48000);
ok = perfTest(48000) && ok;
if (!quick) ok = perfTest(96000) && ok;
console.log(`\n${ok ? 'ALL CHECKS PASSED' : 'SOME CHECKS FAILED'}`);
report.allPassed = ok; report.node = process.version; report.date = new Date().toISOString();
if (!quick) writeFileSync(new URL('./verify-report.json', import.meta.url), JSON.stringify(report, null, 2));
process.exit(ok ? 0 : 1);
