// Concert (Alpine) zither, Munich tuning — the single source of truth for
// tuning, geometry and per-string sound parameters. Shared by the 3D view,
// the audio engine (via processorOptions) and the Node verification script.
//
// 42 strings: 5 melody (fretted, 29 frets) + 12 accompaniment + 12 bass
// + 13 contrabass. Open strings are in circle-of-fifths order.

export const FRETS = 29;
export let A4 = 440;

export const PC_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'B♭', 'B'];
/** Pitch class of each natural note letter. */
export const LETTER_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

export function midiToFreq(m) { return A4 * Math.pow(2, (m - 69) / 12); }
export function midiName(m) { return PC_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1); }

// --- tuning (MIDI note numbers), nearest the player first -------------------
const MELODY = [69, 69, 62, 55, 48];                                   // a' a' d' g c

// Fretboard tunings. The open strings stay in Munich tuning in both, as many players do
// (full Viennese open-string tuning breaks the circle-of-fifths layout the chords rely on).
export const TUNINGS = {
  munich: { label: 'Munich — a′ a′ d′ g c', melody: [69, 69, 62, 55, 48] },
  vienna: { label: 'Viennese fretboard — a′ d′ g′ g c', melody: [69, 62, 67, 55, 48] },
};

// Sound presets for the strings and soundbox.
export const VOICES = {
  concert: { name: 'concert', label: 'Concert — spruce top, steel strings', bright: 1, sustain: 1, fscale: 1, tilt: 0 },
  mellow: { name: 'mellow', label: 'Mellow — rosewood body, softer strings', bright: 0.68, sustain: 0.92, fscale: 0.86, tilt: -0.28 },
  brilliant: { name: 'brilliant', label: 'Brilliant — new strings, bright attack', bright: 1.45, sustain: 1.05, fscale: 1.07, tilt: 0.14 },
  resonant: { name: 'resonant', label: 'Resonant — long ringing sustain', bright: 0.92, sustain: 1.5, fscale: 0.94, tilt: -0.08 },
};
const ACCOMP = [63, 58, 65, 60, 55, 62, 57, 64, 59, 54, 61, 56];       // Eb4 Bb3 F4 C4 G3 D4 A3 E4 B3 F#3 C#4 G#3
const BASS = ACCOMP.map((m) => m - 12);                                // Eb3 ... G#2
const CONTRA = [41, 40, 39, 38, 37, 36, 35, 34, 33, 32, 31, 30, 29];   // F2 chromatically down to F1

// --- geometry (millimetres; x along the strings, d = distance from the near edge)
export const GEOM = {
  bodyLen: 600, bodyDepth: 372, bodyHeight: 42,
  nutX: 62, scale: 430,            // melody bridge at nutX + scale
  fretboardD0: 7, fretboardD1: 71, fretboardH: 7,
  melodyY: 10.6, openY: 9.4,
  melodyD0: 16, melodyPitch: 11.5,
  openD0: 86, openPitch: 6.75,
  openX0: 50, openX1: 506,
  pinX: 540,
  holeX: 318, holeD: 205, holeR: 43,
};
GEOM.melodyBridgeX = GEOM.nutX + GEOM.scale;

export function fretX(n) { return GEOM.nutX + GEOM.scale * (1 - Math.pow(2, -n / 12)); }
GEOM.lastFretX = fretX(FRETS);
GEOM.pluckX0 = GEOM.lastFretX + 5;   // melody strings are plucked between here and the bridge

// --- strings ----------------------------------------------------------------
const RED_PCS = new Set([5, 9, 1]);   // F, A and C# open strings are red on a real zither

function build() {
  const out = [];
  const lerp = (a, b, t) => a + (b - a) * t;
  MELODY.forEach((midi, i) => {
    out.push({
      group: 'melody', midi, d: GEOM.melodyD0 + i * GEOM.melodyPitch,
      x0: GEOM.nutX, x1: GEOM.melodyBridgeX,
      radius: [0.42, 0.42, 0.52, 0.72, 0.95][i],
      look: ['steel', 'steel', 'steel', 'brass', 'silverwound'][i],
      dsp: {
        kind: 'pick', t60: [5.2, 5.2, 5.8, 6.2, 6.6][i], hf: [1.5, 1.5, 1.4, 1.2, 1.1][i],
        z: [0.8, 0.8, 1.0, 1.4, 1.9][i], disp: [0.004, 0.004, 0.005, 0.012, 0.016][i],
        gain: [1.0, 1.0, 1.0, 0.95, 0.9][i],
      },
    });
  });
  const open = [
    ['acc', ACCOMP], ['bass', BASS], ['contra', CONTRA],
  ];
  let k = 0;
  for (const [group, list] of open) {
    list.forEach((midi, i) => {
      const low = Math.min(1, Math.max(0, (65 - midi) / 36));   // 0 = F4 … 1 = F1
      const red = group !== 'contra' && RED_PCS.has(midi % 12);
      out.push({
        group, midi, d: GEOM.openD0 + k * GEOM.openPitch,
        x0: GEOM.openX0, x1: GEOM.openX1,
        radius: lerp(0.5, 1.45, Math.pow(low, 0.9)),
        look: red ? 'red' : group === 'acc' ? 'silverwound' : group === 'bass' ? 'brass' : 'copper',
        dsp: {
          kind: 'finger',
          t60: group === 'acc' ? lerp(3.8, 4.8, low * 2) : group === 'bass' ? lerp(5.5, 7, low) : lerp(7.5, 9, low),
          hf: group === 'acc' ? 0.75 : group === 'bass' ? 0.9 : 1.0,
          z: lerp(0.9, 3.4, low),
          disp: lerp(0.008, 0.032, low),
          gain: group === 'acc' ? 0.95 : group === 'bass' ? 1.1 : 1.2,
        },
      });
      k++;
    });
  }
  const dMax = out[out.length - 1].d;
  out.forEach((s, idx) => {
    s.idx = idx;
    s.name = PC_NAMES[s.midi % 12];
    s.freq = midiToFreq(s.midi);
    s.dsp.pan = lerp(-0.32, 0.32, s.d / dMax);
  });
  return out;
}

export const STRINGS = build();
export const N_STRINGS = STRINGS.length;
export const MELODY_COUNT = MELODY.length;
export const GROUP_START = { melody: 0, acc: 5, bass: 17, contra: 29 };

/** Change the fretboard tuning and the concert pitch (A4 in Hz). Returns every string's new frequency. */
export function setTuning(name, pitch = A4) {
  const t = TUNINGS[name] || TUNINGS.munich;
  A4 = Math.max(415, Math.min(466, +pitch || 440));
  t.melody.forEach((m, i) => { STRINGS[i].midi = m; STRINGS[i].name = PC_NAMES[m % 12]; });
  for (const s of STRINGS) s.freq = midiToFreq(s.midi);
  return STRINGS.map((s) => s.freq);
}

/** Helmholtz-style name of a melody string: c, d′, a″ … */
export function stringLabel(i) {
  const m = STRINGS[i].midi, oct = Math.floor(m / 12) - 1;
  const n = PC_NAMES[m % 12];
  if (oct <= 2) return n;
  return n.toLowerCase() + ['', '′', '″', '‴'][Math.min(3, oct - 3)];
}

/** Configuration handed to the audio engine. */
export function engineConfig() {
  return {
    strings: STRINGS.map((s) => ({ midi: s.midi, freq: s.freq, ...s.dsp })),
    resonance: 0.5,
  };
}

// --- chords on the open strings ---------------------------------------------
// Because the accompaniment strings are laid out in fifths, a major triad is
// always "root, next string, four strings on" (C: C-G-E), wherever you start.
export const CHORD_ROOTS = ACCOMP.map((m) => m % 12);    // pitch classes in string order
export const QUALITIES = {
  maj: { suffix: '', tones: [0, 7, 4] },
  min: { suffix: 'm', tones: [0, 7, 3] },
  dom7: { suffix: '7', tones: [0, 4, 7, 10] },
  dim: { suffix: 'dim', tones: [0, 3, 6] },
  min7: { suffix: 'm7', tones: [0, 3, 7, 10] },
};

function findPc(group, pc, count) {
  const start = GROUP_START[group];
  for (let i = 0; i < count; i++) if (STRINGS[start + i].midi % 12 === pc) return start + i;
  return -1;
}

/** Which open strings make up a chord: bass root, alternate bass (fifth),
 *  contrabass root and the accompaniment strings. `bassPc` overrides the bass
 *  note for slash chords. */
export function chordStrings(rootPc, quality = 'maj', bassPc = null) {
  const q = QUALITIES[quality] || QUALITIES.maj;
  const pc = (x) => (((rootPc + x) % 12) + 12) % 12;
  const fifth = q.tones.includes(6) ? 6 : 7;
  const b = bassPc == null ? pc(0) : bassPc;
  return {
    rootPc, quality,
    bass: findPc('bass', b, 12),
    altBass: findPc('bass', pc(fifth), 12),
    contra: findPc('contra', b, 13),
    acc: q.tones.map((t) => findPc('acc', pc(t), 12)).sort((a, c) => STRINGS[a].midi - STRINGS[c].midi),
  };
}

/** Display name of a chord: "G7", "Am", "C/G". */
export function chordName(rootPc, quality, bassPc = null) {
  return PC_NAMES[rootPc] + (QUALITIES[quality] ? QUALITIES[quality].suffix : '') + (bassPc == null ? '' : '/' + PC_NAMES[bassPc]);
}

/** Choose a melody string and fret for a pitch. `busy` is a set of string
 *  indices already used at this instant; `hand` is the current fret position. */
export function placeMelodyNote(midi, busy = null, hand = 5) {
  let best = null;
  for (let s = 0; s < MELODY_COUNT; s++) {
    if (busy && busy.has(s)) continue;
    const fret = midi - STRINGS[s].midi;
    if (fret < 0 || fret > FRETS) continue;
    const cost = Math.abs(fret - hand) + 0.35 * fret + (fret === 0 ? 1.5 : 0) + s * 0.01;
    if (!best || cost < best.cost) best = { string: s, fret, cost };
  }
  return best;
}
