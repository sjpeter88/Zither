// MIDI keyboard input (Chrome, Edge and the Windows app; Safari has no Web MIDI).
// Keys below the split point choose and play chords on the open strings;
// keys from the split point up play the melody on the fretboard.
import { STRINGS, MELODY_COUNT, FRETS, placeMelodyNote } from './zither-model.js';

export const MIDI_SPLIT = 48;          // C3: below it, chords

export class MidiInput {
  /** hooks: { onChordOn(pc, id), onChordOff(id), onMelodyPluck(midi, string) } */
  constructor(audio, scene, hooks) {
    this.audio = audio; this.scene = scene; this.hooks = hooks;
    this.access = null; this.notes = new Map(); this.sustain = false; this.sustained = new Set();
    this.lastString = -1; this.onStatus = null;
  }

  get supported() { return typeof navigator !== 'undefined' && typeof navigator.requestMIDIAccess === 'function'; }

  async connect() {
    if (!this.supported) throw new Error('This browser has no MIDI support. Safari on iPad and iPhone does not offer it; use Chrome or Edge on a computer, or the Windows app.');
    if (!this.access) {
      this.access = await navigator.requestMIDIAccess({ sysex: false });
      this.access.onstatechange = () => this._attach();
    }
    this._attach();
    return this.inputs();
  }

  inputs() { return this.access ? [...this.access.inputs.values()].filter((i) => i.state !== 'disconnected').map((i) => i.name || 'MIDI input') : []; }

  _attach() {
    for (const input of this.access.inputs.values()) input.onmidimessage = (e) => this.handle(e.data);
    if (this.onStatus) this.onStatus(this.inputs());
  }

  /** One MIDI message (array of bytes). */
  handle(data) {
    const [st, d1 = 0, d2 = 0] = data, kind = st & 0xf0;
    if ((kind === 0x90 || kind === 0x80) && (st & 0x0f) === 9) return;      // channel 10 is drums: not notes for a zither
    if (kind === 0x90 && d2 > 0) this.noteOn(d1, d2 / 127);
    else if (kind === 0x80 || (kind === 0x90 && d2 === 0)) this.noteOff(d1);
    else if (kind === 0xb0 && d1 === 64) this.pedal(d2 >= 64);
    else if (kind === 0xb0 && d1 === 1) this.modWheel(d2 / 127);
    else if (kind === 0xe0) this.pitchBend(((d2 << 7) | d1) - 8192);
  }

  noteOn(n, vel) {
    this.noteOff(n, true);
    if (n < MIDI_SPLIT) {
      const id = 'midi' + n;
      this.notes.set(n, { chord: id });
      this.hooks.onChordOn(n % 12, id);
      return;
    }
    // fold notes the fretboard cannot reach into its range
    const lo = Math.min(...STRINGS.slice(0, MELODY_COUNT).map((s) => s.midi));
    const hi = Math.max(...STRINGS.slice(0, MELODY_COUNT).map((s) => s.midi)) + FRETS;
    let m = n; while (m < lo) m += 12; while (m > hi) m -= 12;
    const busy = new Set([...this.notes.values()].filter((v) => v.string != null).map((v) => v.string));
    const place = placeMelodyNote(m, busy, 7) || placeMelodyNote(m, null, 7);
    if (!place) return;
    this.sustained.delete(place.string);
    this.audio.pluck(place.string, 0.25 + 0.75 * vel, place.fret);
    this.scene.setFinger(place.string, place.fret, 'user');
    this.scene.flash(place.string);
    this.notes.set(n, { string: place.string, fret: place.fret });
    this.lastString = place.string;
    this.hooks.onMelodyPluck(STRINGS[place.string].midi + place.fret, place.string);
  }

  noteOff(n, silent = false) {
    const v = this.notes.get(n);
    if (!v) return;
    this.notes.delete(n);
    if (v.chord) { this.hooks.onChordOff(v.chord); return; }
    if ([...this.notes.values()].some((o) => o.string === v.string)) return;
    if (this.sustain && !silent) { this.sustained.add(v.string); return; }
    this.scene.setFinger(v.string, 0, 'user');
    if (!silent) this.audio.damp(v.string);
  }

  pedal(down) {
    this.sustain = down;
    if (down) return;
    for (const s of this.sustained) { this.scene.setFinger(s, 0, 'user'); this.audio.damp(s); }
    this.sustained.clear();
  }

  pitchBend(v) { if (this.lastString >= 0) this.audio.bend(this.lastString, Math.max(0, v / 8192 * 2)); }

  modWheel(x) {
    for (const v of this.notes.values()) if (v.string != null) this.audio.vibrato(v.string, x * 0.45, 5.5, 0);
  }
}
