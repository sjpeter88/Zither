// Sanity-check the song library: every bar must have the right length, every
// melody note must fit the fretboard, every chord must map to open strings.
import { SONGS } from '../web/js/songs.js';
import { parseTune, compileSong, parseChord } from '../web/js/player.js';
import { STRINGS, midiName } from '../web/js/zither-model.js';

let bad = 0;
// a piece with a full version is checked in both lengths
const all = SONGS.flatMap((s) => (s.full ? [s, { ...s, ...s.full, title: s.title + ' (full)' }] : [s]));
for (const song of all) {
  const tune = parseTune(song);
  const [n, d] = song.meter.split('/').map(Number), bar = n * 4 / d;
  const problems = [];
  tune.bars.slice(1).forEach((t, i) => {
    const len = t - tune.bars[i];
    const edge = i === 0 || i === tune.bars.length - 2;
    if (Math.abs(len - bar) > 1e-6 && !(edge && len < bar)) {
      // a short bar is fine if it and a neighbour (pickup + ending) add up to one bar
      const next = tune.bars[i + 2] != null ? tune.bars[i + 2] - t : 0, prev = i > 0 ? tune.bars[i] - tune.bars[i - 1] : 0;
      if (Math.abs(len + next - bar) > 1e-6 && Math.abs(len + prev - bar) > 1e-6) problems.push(`bar ${i + 1} is ${len} beats (expected ${bar})`);
    }
  });
  for (const c of tune.chords) if (!parseChord(c.sym)) problems.push(`unknown chord "${c.sym}"`);
  const comp = compileSong(song);
  const mel = comp.events.filter((e) => e.type === 'mel');
  const placed = mel.length, wanted = tune.groups.reduce((a, g) => a + g.pitches.length, 0);
  if (placed !== wanted) problems.push(`${wanted - placed} melody notes could not be placed on the fretboard`);
  const pitches = mel.map((e) => STRINGS[e.string].midi + e.fret);
  const maxFret = Math.max(...mel.map((e) => e.fret));
  const open = comp.events.filter((e) => e.type === 'open');
  if (open.some((e) => e.string < 5 || e.string > 41)) problems.push('accompaniment used a non-open string');
  console.log(`${problems.length ? 'FAIL' : 'ok  '} ${song.title.padEnd(44)} ${String(comp.bars).padStart(3)} bars, ${String(placed).padStart(3)} melody notes ${midiName(Math.min(...pitches))}–${midiName(Math.max(...pitches))}, highest fret ${maxFret}, ${open.length} open-string plucks, ${(comp.beats * 60 / song.tempo).toFixed(0)} s`);
  for (const p of problems) { console.log('       ' + p); bad++; }
}
console.log(bad ? `\n${bad} problem(s)` : '\nAll songs parse cleanly.');
process.exit(bad ? 1 : 0);
