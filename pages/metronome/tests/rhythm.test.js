import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_STATE, createBeat, createPattern, getPattern, compileBar, normalizeState,
  serializeState, parseState } from '../js/rhythm.js';
const state = (overrides = {}) => ({ ...structuredClone(DEFAULT_STATE), ...overrides });
const offsets = (bar) => bar.events.map((event) => event.offset);

test('a new beat has independent ordinary cells with usable note defaults', () => {
  assert.equal(typeof createBeat, 'function', 'createBeat must be implemented');
  const beat = createBeat(3);
  assert.deepEqual(beat, { divisions: 3, swing: false, cells: [
    { kind: 'normal', velocity: 80, sound: 'inherit' },
    { kind: 'normal', velocity: 80, sound: 'inherit' },
    { kind: 'normal', velocity: 80, sound: 'inherit' },
  ] });
  beat.cells[0].velocity = 20;
  assert.equal(beat.cells[1].velocity, 80);
  assert.equal(createBeat().cells[0].velocity, 80);
  assert.throws(() => createBeat(9), /网格|分拍/);
});

const presetFixtures = [
  ['quarter', [0, 1]],
  ['eighth', [0, 0.5, 1, 1.5]],
  ['sixteenth', [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75]],
  ['eighth-sixteenth', [0, 0.5, 0.75, 1, 1.5, 1.75]],
  ['sixteenth-eighth', [0, 0.25, 0.5, 1, 1.25, 1.5]],
  ['dotted', [0, 0.75, 1, 1.75]],
  ['triplet', [0, 1 / 3, 2 / 3, 1, 1 + 1 / 3, 1 + 2 / 3]],
  ['triplet-skip', [0, 2 / 3, 1, 1 + 2 / 3]],
  ['syncopated', [0.25, 0.75, 1.25, 1.75]],
  ['sextuplet', [0, 1 / 6, 2 / 6, 3 / 6, 4 / 6, 5 / 6,
    1, 1 + 1 / 6, 1 + 2 / 6, 1 + 3 / 6, 1 + 4 / 6, 1 + 5 / 6]],
];
for (const [preset, expected] of presetFixtures) {
  test(`${preset} emits the expected sounding subdivisions`, () => {
    const result = compileBar(state({ advanced: true, beats: 2, preset,
      pattern: createPattern(2, preset, 67) }));
    assert.deepEqual(offsets(result), expected);
  });
}

test('swing moves the second click while other divisions remain straight', () => {
  const pattern = createPattern(2, 'swing', 67);
  assert.equal(pattern[0].swing, true);
  assert.deepEqual(offsets(compileBar(state({ advanced: true, beats: 2, preset: 'swing',
    swing: 67, pattern }))), [0, 0.67, 1, 1.67]);
  assert.deepEqual(offsets(compileBar(state({ advanced: true, beats: 1, swing: 75,
    preset: 'custom', pattern: [createBeat(3)] }))), [0, 1 / 3, 2 / 3]);
  assert.deepEqual(offsets(compileBar(state({ advanced: true, beats: 1, preset: 'swing', swing: 50,
    pattern: createPattern(1, 'swing', 50) }))), [0, 0.5]);
});

test('selected presets compile their own rhythm even if a saved custom pattern is present', () => {
  const input = state({ advanced: true, beats: 1, preset: 'eighth', pattern: [createBeat(1)] });
  assert.deepEqual(offsets(compileBar(input)), [0, 0.5]);
  input.preset = 'custom';
  assert.deepEqual(offsets(compileBar(input)), [0]);
});

test('custom even grids swing each pair and retain their timing after JSON import', () => {
  const beat = createBeat(4);
  beat.swing = true;
  const input = state({ advanced: true, beats: 1, preset: 'custom', swing: 67, pattern: [beat] });
  assert.deepEqual(offsets(compileBar(input)), [0, 0.335, 0.5, 0.835]);
  assert.equal(normalizeState(input).pattern[0].swing, true);
  const imported = parseState(JSON.stringify(input));
  assert.deepEqual(offsets(compileBar(imported)), [0, 0.335, 0.5, 0.835]);
});

test('mixed grids preserve exact offsets, rests, note volume and individual sounds', () => {
  const pattern = [createBeat(3), createBeat(4), createBeat(5)];
  pattern[0].cells[1].kind = 'rest';
  pattern[1].cells[1] = { kind: 'accent', velocity: 35, sound: 'kick' };
  pattern[2].cells[4].velocity = 0;
  const result = compileBar(state({ advanced: true, preset: 'custom', beats: 3, denominator: 8, accent: false,
    sound: 'cowbell', pattern }));
  assert.deepEqual(offsets(result), [0, 2 / 3, 1, 1.25, 1.5, 1.75, 2, 2.2, 2.4, 2.6, 2.8]);
  assert.deepEqual(result.events[3], { offset: 1.25, accent: true, velocity: 0.35,
    sound: 'kick', beat: 1, cell: 1 });
  assert.equal(result.events[0].sound, 'cowbell');
  assert.equal(result.events.at(-1).velocity, 0);
  assert.equal(result.denominator, 4);
});

test('a normal custom first cell disables the global accent while preserving later accents', () => {
  const pattern = [createBeat(2), createBeat(1)];
  pattern[1].cells[0].kind = 'accent';
  const input = state({ advanced: true, preset: 'custom', beats: 2, accent: true, pattern });
  assert.equal(normalizeState(input).accent, false);
  assert.deepEqual(compileBar(input).events.map((event) => event.accent), [false, false, true]);
  assert.equal(compileBar({ ...input, advanced: false }).events[0].accent, false);
  assert.equal(compileBar(input, -1).events[0].accent, false);
});

test('an accented custom first cell enables the bound flag in advanced, basic and count-in bars', () => {
  const pattern = [createBeat(2), createBeat(1)];
  pattern[0].cells[0].kind = 'accent';
  const input = state({ advanced: true, preset: 'custom', beats: 2, accent: false, pattern });
  assert.equal(normalizeState(input).accent, true);
  assert.deepEqual(compileBar(input).events.map((event) => event.accent), [true, false, false]);
  assert.equal(compileBar({ ...input, advanced: false }).events[0].accent, true);
  assert.equal(compileBar(input, -1).events[0].accent, true);
});

test('a custom first-cell rest clears the accent flag and remains silent in advanced mode', () => {
  const pattern = [createBeat(2)];
  pattern[0].cells[0].kind = 'rest';
  const input = state({ advanced: true, preset: 'custom', beats: 1, accent: true, pattern });
  assert.equal(normalizeState(input).accent, false);
  assert.deepEqual(compileBar(input).events.map(({ offset, accent }) => ({ offset, accent })),
    [{ offset: 0.5, accent: false }]);
  assert.equal(compileBar({ ...input, advanced: false }).events[0].accent, false);
  assert.equal(compileBar(input, -1).events[0].accent, false);
});

test('built-in first-cell kinds and playback follow the global accent without replacing rests', () => {
  for (const preset of ['quarter', 'eighth', 'sixteenth', 'eighth-sixteenth', 'sixteenth-eighth',
    'dotted', 'swing', 'triplet', 'triplet-skip', 'sextuplet']) {
    for (const accent of [true, false]) {
      const input = state({ advanced: true, beats: 1, preset, accent,
        pattern: createPattern(1, preset) });
      const expectedKind = accent ? 'accent' : 'normal';
      assert.equal(normalizeState(input).pattern[0].cells[0].kind, expectedKind, preset);
      assert.equal(getPattern(input)[0].cells[0].kind, expectedKind, preset);
      assert.equal(compileBar(input).events[0].accent, accent, preset);
    }
  }
  const syncopated = state({ advanced: true, beats: 1, preset: 'syncopated', accent: true,
    pattern: createPattern(1, 'syncopated') });
  assert.equal(normalizeState(syncopated).accent, false);
  assert.deepEqual(getPattern(syncopated)[0].cells.map((cell) => cell.kind),
    ['rest', 'normal', 'rest', 'normal']);
  assert.deepEqual(compileBar(syncopated).events.map((event) => event.accent), [false, false]);
  assert.equal(compileBar({ ...syncopated, advanced: false }).events[0].accent, false);
});

test('effective patterns copy custom cells and derive built-ins without changing saved edits', () => {
  const pattern = [createBeat(3), createBeat(2)];
  pattern[0].cells[0].kind = 'accent';
  pattern[0].cells[1].kind = 'rest';
  pattern[1].cells[1] = { kind: 'accent', velocity: 35, sound: 'kick' };
  const custom = state({ advanced: true, beats: 2, preset: 'custom', accent: false, pattern });
  const copied = getPattern(custom);
  assert.deepEqual(copied, pattern);
  copied[0].cells[0].kind = 'normal';
  copied[1].cells[1].velocity = 60;
  assert.equal(custom.pattern[0].cells[0].kind, 'accent');
  assert.equal(custom.pattern[1].cells[1].velocity, 35);
  const builtin = { ...custom, preset: 'eighth', accent: false };
  const derived = getPattern(builtin);
  assert.deepEqual(derived.map((beat) => beat.cells.map((cell) => cell.kind)),
    [['normal', 'normal'], ['normal', 'normal']]);
  assert.equal(builtin.pattern[0].cells[1].kind, 'rest');
  assert.equal(builtin.pattern[1].cells[1].kind, 'accent');
  const normalized = normalizeState(builtin);
  assert.equal(normalized.pattern[0].cells[0].kind, 'normal');
  assert.equal(normalized.pattern[0].cells[1].kind, 'rest');
  assert.equal(normalized.pattern[1].cells[1].kind, 'accent');
});

test('JSON import and export resolve contradictory custom accent flags from the first cell', () => {
  for (const [kind, flag, expected] of [['normal', true, false], ['accent', false, true],
    ['rest', true, false]]) {
    const pattern = [createBeat(2)];
    pattern[0].cells[0].kind = kind;
    pattern[0].cells[1].kind = 'accent';
    const input = state({ advanced: false, beats: 1, preset: 'custom', accent: flag, pattern });
    const imported = parseState(JSON.stringify(input));
    const exported = JSON.parse(serializeState(input));
    assert.equal(imported.accent, expected);
    assert.equal(exported.accent, expected);
    assert.equal(imported.pattern[0].cells[0].kind, kind);
    assert.equal(exported.pattern[0].cells[0].kind, kind);
    assert.equal(imported.pattern[0].cells[1].kind, 'accent');
    assert.equal(compileBar(imported).events[0].accent, expected);
  }
});

test('basic mode ignores advanced pattern and all exercise switches', () => {
  const result = compileBar(state({ advanced: false, beats: 3,
    preset: 'sixteenth', pattern: createPattern(3, 'sixteenth', 67), practice: {
      countIn: true, muteEnabled: true, playBars: 1, muteBars: 1,
      rampEnabled: true, rampEvery: 1, rampStep: 10, rampMax: 200,
      stopEnabled: true, stopBars: 1,
    } }), 10);
  assert.deepEqual(offsets(result), [0, 1, 2]);
  assert.equal(result.bpm, 120);
  assert.equal(result.finished, false);
  assert.equal(result.muted, false);
  assert.equal(result.countIn, false);
});

test('a negative bar index is a basic count-in without exercise muting or ramp', () => {
  const result = compileBar(state({ advanced: true, preset: 'sixteenth',
    pattern: createPattern(4, 'sixteenth', 67), practice: { ...DEFAULT_STATE.practice,
      muteEnabled: true, rampEnabled: true, rampEvery: 1, rampStep: 5,
      stopEnabled: true, stopBars: 1 } }), -1);
  assert.deepEqual(offsets(result), [0, 1, 2, 3]);
  assert.equal(result.bpm, 120);
  assert.equal(result.countIn, true);
  assert.equal(result.muted, false);
  assert.equal(result.finished, false);
});

test('mute practice repeats its play-bar and mute-bar cycle from normal bar zero', () => {
  const input = state({ advanced: true, practice: { ...DEFAULT_STATE.practice,
    muteEnabled: true, playBars: 2, muteBars: 1 } });
  assert.deepEqual([0, 1, 2, 3, 4, 5].map((index) => compileBar(input, index).muted),
    [false, false, true, false, false, true]);
});

test('ramp advances at exact bar boundaries and caps without reducing an initial tempo', () => {
  const input = state({ advanced: true, practice: { ...DEFAULT_STATE.practice,
    rampEnabled: true, rampEvery: 2, rampStep: 7, rampMax: 130 } });
  assert.deepEqual([0, 1, 2, 3, 4, 20].map((index) => compileBar(input, index).bpm),
    [120, 120, 127, 127, 130, 130]);
  input.practice.rampMax = 80;
  assert.equal(compileBar(input, 20).bpm, 120);
});

test('automatic stop finishes after the requested number of normal bars', () => {
  const input = state({ advanced: true, practice: { ...DEFAULT_STATE.practice,
    stopEnabled: true, stopBars: 2 } });
  assert.equal(compileBar(input, 1).finished, false);
  assert.equal(compileBar(input, 2).finished, true);
  assert.deepEqual(compileBar(input, 2).events, []);
});

test('local settings normalization repairs corrupt values without losing advanced edits', () => {
  const input = { bpm: 999, beats: 0, denominator: 3, advanced: false, preset: 'custom',
    swing: 0, sound: 'unknown', volume: -1, pattern: [{ divisions: 2, swing: false,
      cells: [{ kind: 'accent', velocity: 40, sound: 'kick' }, { kind: 'bad', velocity: 800 }] }],
    practice: { muteEnabled: true, playBars: 0, rampEvery: 'broken', stopBars: 999999 } };
  const result = normalizeState(input);
  assert.equal(result.bpm, 300);
  assert.equal(result.beats, 1);
  assert.equal(result.denominator, 4);
  assert.equal(result.swing, 50);
  assert.equal(result.sound, 'wood');
  assert.equal(result.volume, 0);
  assert.equal(result.pattern[0].cells[0].kind, 'accent');
  assert.equal(result.pattern[0].cells[0].sound, 'kick');
  assert.equal(result.pattern[0].cells[1].velocity, 100);
  assert.equal(result.practice.muteEnabled, true);
  assert.equal(result.practice.playBars, 1);
  assert.equal(result.practice.rampEvery, 4);
  assert.equal(result.practice.stopBars, 999);
  assert.deepEqual(normalizeState(null), DEFAULT_STATE);
});

test('normalization expands or truncates the pattern to the meter without sharing cells', () => {
  const input = state({ beats: 2, preset: 'eighth', pattern: createPattern(1, 'eighth', 67) });
  input.pattern[0].cells[1].kind = 'accent';
  const expanded = normalizeState(input);
  assert.equal(expanded.pattern.length, 2);
  assert.equal(expanded.pattern[0].cells[1].kind, 'accent');
  assert.equal(expanded.pattern[1].divisions, 2);
  expanded.pattern[0].cells[1].kind = 'rest';
  assert.equal(input.pattern[0].cells[1].kind, 'accent');
  assert.equal(normalizeState({ ...expanded, beats: 1 }).pattern.length, 1);
});

test('JSON export is readable and round-trips all advanced configuration', () => {
  const input = state({ advanced: false, preset: 'custom', beats: 1,
    pattern: [createBeat(16)], practice: { ...DEFAULT_STATE.practice, rampEnabled: true } });
  input.pattern[0].cells[7] = { kind: 'rest', velocity: 55, sound: 'hihat' };
  const text = serializeState(input);
  assert.match(text, /\n  "version": 1/);
  assert.deepEqual(parseState(text), { ...input, accent: false });
  assert.deepEqual(compileBar(parseState(text)).events.map((event) => event.offset), [0]);
});

test('the sextuplet preset keeps its six equal sounding subdivisions after JSON import', () => {
  const input = state({ advanced: true, beats: 1, preset: 'sextuplet',
    pattern: createPattern(1, 'sextuplet') });
  const imported = parseState(serializeState(input));
  const expected = structuredClone(input);
  expected.pattern[0].cells[0].kind = 'accent';
  assert.deepEqual(imported, expected);
  assert.deepEqual(offsets(compileBar(imported)), [0, 1 / 6, 2 / 6, 3 / 6, 4 / 6, 5 / 6]);
  assert.equal(imported.pattern[0].divisions, 6);
  assert.equal(imported.pattern[0].swing, false);
});

for (const denominator of [2, 8, 16]) {
  test(`stored and imported /${denominator} settings migrate to quarter-note beats without losing configuration`, () => {
    const pattern = [createBeat(3), createBeat(4)];
    pattern[0].cells[1] = { kind: 'rest', velocity: 35, sound: 'hihat' };
    pattern[1].swing = true;
    pattern[1].cells[2] = { kind: 'accent', velocity: 60, sound: 'kick' };
    const input = state({ bpm: 145, beats: 2, denominator, advanced: true,
      preset: 'custom', accent: false, sound: 'cowbell', volume: 0.45, swing: 61,
      pattern, practice: { ...DEFAULT_STATE.practice, countIn: true,
        muteEnabled: true, playBars: 5, rampEnabled: true, rampStep: 3 } });
    const expected = { ...structuredClone(input), denominator: 4 };
    assert.deepEqual(normalizeState(input), expected);
    assert.deepEqual(parseState(JSON.stringify(input)), expected);
    const exported = JSON.parse(serializeState(input));
    assert.equal(exported.version, 1);
    assert.equal(exported.denominator, 4);
    assert.deepEqual(exported.pattern, pattern);
    assert.equal(input.denominator, denominator);
  });
}

test('imports reject malformed JSON, nonobjects and unsupported schema versions', () => {
  assert.throws(() => parseState('{'), /JSON/);
  for (const value of [null, [], 8, 'settings']) {
    assert.throws(() => parseState(JSON.stringify(value)), /对象/);
  }
  assert.throws(() => parseState(JSON.stringify({ ...DEFAULT_STATE, version: 2 })), /版本/);
  const missing = state();
  delete missing.bpm;
  assert.throws(() => parseState(JSON.stringify(missing)), /bpm|速度/);
  assert.throws(() => parseState(JSON.stringify({ ...DEFAULT_STATE, surprise: true })), /未知|不支持/);
});

test('imports reject invalid numeric, boolean and selectable settings', () => {
  for (const [field, value] of [['bpm', 19], ['bpm', 301], ['bpm', '120'],
    ['beats', 1.5], ['beats', 13], ['denominator', 3], ['swing', 76], ['volume', 1.1],
    ['advanced', 1], ['accent', 'yes'], ['preset', 'unknown'], ['sound', 'unknown']]) {
    assert.throws(() => parseState(JSON.stringify(state({ [field]: value }))),
      new RegExp(field + '|速度|拍|音|模式|比例|音量|重音|预设'));
  }
  assert.throws(() => parseState(JSON.stringify(state({ practice: {
    ...DEFAULT_STATE.practice, rampEvery: 0 } }))), /rampEvery|小节/);
  for (const [field, value] of [['playBars', 33], ['muteBars', 33], ['stopBars', 1000]]) {
    assert.throws(() => parseState(JSON.stringify(state({ practice: {
      ...DEFAULT_STATE.practice, [field]: value } }))), /小节/);
  }
});

test('imports reject malformed beat grids and notes rather than repairing them', () => {
  const mutations = [
    (input) => { input.pattern.pop(); },
    (input) => { input.pattern[0].divisions = 9; },
    (input) => { input.pattern[0].cells.push({ kind: 'normal', velocity: 80, sound: 'inherit' }); },
    (input) => { input.pattern[0].cells[0].kind = 'quiet'; },
    (input) => { input.pattern[0].cells[0].velocity = 101; },
    (input) => { input.pattern[0].cells[0].sound = 'piano'; },
    (input) => { input.pattern[0].swing = true; },
    (input) => { input.pattern[0].extra = true; },
    (input) => { input.pattern[0].cells[0] = null; },
  ];
  for (const mutate of mutations) {
    const input = state();
    mutate(input);
    assert.throws(() => parseState(JSON.stringify(input)), /编排|网格|分拍|音符|力度|音色|Swing|未知/);
  }
});

test('compiling a bar does not change saved rhythm or practice state', () => {
  const input = state({ advanced: true, pattern: createPattern(4, 'swing', 67) });
  const before = JSON.stringify(input);
  compileBar(input, 5);
  assert.equal(JSON.stringify(input), before);
});
