import test from 'node:test';
import assert from 'node:assert/strict';
import { MetronomeEngine } from '../js/audio.js';
import { DEFAULT_STATE } from '../js/rhythm.js';

class AudioParamDouble {
  constructor(value = 0) { this.value = value; this.changes = []; }
  setValueAtTime(value, time) { this.value = value; this.changes.push({ value, time }); }
  exponentialRampToValueAtTime(value, time) { this.value = value; this.changes.push({ value, time }); }
  linearRampToValueAtTime(value, time) { this.value = value; this.changes.push({ value, time }); }
  setTargetAtTime(value, time) { this.value = value; this.changes.push({ value, time }); }
  cancelScheduledValues() {}
}

class AudioNodeDouble {
  constructor(context, source = false) {
    this.context = context;
    this.gain = new AudioParamDouble(1);
    this.frequency = new AudioParamDouble(440);
    this.Q = new AudioParamDouble(1);
    this.detune = new AudioParamDouble();
    this.connections = [];
    this.stops = [];
    if (source) context.sources.push(this);
  }
  connect(node) { this.connections.push(node); return node; }
  disconnect() { this.connections = []; }
  start(time) { this.startTime = time; }
  stop(time) { this.stops.push(time); }
}

class AudioContextDouble {
  constructor() {
    this.currentTime = 0;
    this.state = 'suspended';
    this.sampleRate = 44100;
    this.destination = {};
    this.sources = [];
    this.gains = [];
    this.resumes = 0;
  }
  async resume() { this.resumes += 1; this.state = 'running'; }
  createGain() { const node = new AudioNodeDouble(this); this.gains.push(node); return node; }
  createOscillator() { return new AudioNodeDouble(this, true); }
  createBufferSource() { return new AudioNodeDouble(this, true); }
  createBiquadFilter() { return new AudioNodeDouble(this); }
  createBuffer(channels, length) {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return { getChannelData: channel => data[channel] };
  }
}

function harness(overrides = {}) {
  const context = new AudioContextDouble();
  let state = structuredClone(DEFAULT_STATE);
  state = { ...state, ...overrides, practice: { ...state.practice, ...overrides.practice } };
  const intervals = new Map();
  const bars = [];
  const stops = [];
  const errors = [];
  let sequence = 0;
  const engine = new MetronomeEngine({
    getState: () => state,
    onBar: position => bars.push(position),
    onStop: reason => stops.push(reason),
    onError: error => errors.push(error),
    createAudioContext: () => context,
    setInterval: (callback, delay) => { intervals.set(++sequence, { callback, delay }); return sequence; },
    clearInterval: id => intervals.delete(id)
  });
  return {
    context, engine, intervals, bars, stops, errors,
    get state() { return state; },
    set state(value) { state = value; },
    at(time) {
      context.currentTime = time;
      for (const interval of [...intervals.values()]) interval.callback();
      return engine.getPosition();
    }
  };
}

function close(actual, expected) { assert.ok(Math.abs(actual - expected) < 0.00001, `${actual} differs from ${expected}`); }

test('start resumes audio and reports bars only when their audio boundary arrives', async () => {
  const h = harness();
  assert.equal(await h.engine.start(), true);
  assert.equal(h.context.resumes, 1);
  assert.equal(h.intervals.size, 1);
  assert.equal([...h.intervals.values()][0].delay, 25);
  assert.ok(h.context.sources[0].startTime > h.context.currentTime);
  assert.equal(h.bars.length, 0);
  const first = h.at(0.06);
  assert.equal(first.barIndex, 0);
  assert.equal(first.beat, 0);
  assert.equal(first.bpm, 120);
  assert.equal(h.bars.length, 1);
  h.engine.getPosition();
  assert.equal(h.bars.length, 1);
  const secondBeat = h.at(0.56);
  assert.equal(secondBeat.beat, 1);
  close(secondBeat.progress, 0.255);
  h.engine.stop();
});

test('stop immediately cancels current and already scheduled future sources', async () => {
  const h = harness();
  await h.engine.start();
  h.at(0.46);
  assert.ok(h.context.sources.some(source => source.startTime > h.context.currentTime));
  h.engine.stop();
  assert.equal(h.engine.getPosition(), null);
  assert.equal(h.intervals.size, 0);
  assert.deepEqual(h.stops, ['manual']);
  for (const source of h.context.sources) {
    assert.ok(source.stops.length > 0);
    assert.ok(source.stops.at(-1) <= h.context.currentTime);
  }
  h.engine.stop();
  assert.deepEqual(h.stops, ['manual']);
});

test('tempo edits immediately preserve fractional beat phase and cancel old future audio', async () => {
  const h = harness();
  await h.engine.start();
  h.at(0.46);
  const obsolete = h.context.sources.find(source => Math.abs(source.startTime - 0.55) < 0.00001);
  h.context.currentTime = 0.5;
  const before = h.engine.getPosition();
  h.state.bpm = 240;
  h.engine.refresh();
  const active = h.engine.getPosition();
  assert.equal(active.bpm, 240);
  close(active.progress, before.progress);
  assert.equal(active.barIndex, 0);
  assert.ok(obsolete.stops.at(-1) <= 0.5);
  assert.ok(h.context.sources.some(source => Math.abs(source.startTime - 0.525) < 0.00001));
  assert.equal(h.at(0.53).beat, 1);
  h.at(1.2);
  const next = h.at(1.276);
  assert.equal(next.barIndex, 1);
  assert.equal(next.bpm, 240);
  assert.equal(next.beat, 0);
  h.engine.stop();
});

test('rhythm changes add upcoming subdivisions immediately without replaying the downbeat', async () => {
  const h = harness({ advanced: true });
  await h.engine.start();
  h.at(0.2);
  h.state.preset = 'eighth';
  h.engine.refresh();
  assert.equal(h.engine.getPosition().events.length, 8);
  assert.ok(h.context.sources.some(source => Math.abs(source.startTime - 0.3) < 0.00001));
  assert.equal(h.context.sources.filter(source => Math.abs(source.startTime - 0.05) < 0.00001).length, 1);
  assert.equal(h.at(0.31).cell, 1);
  h.engine.stop();
});

test('custom sound, accent and velocity changes replace already scheduled notes in the active bar', async () => {
  const h = harness({ advanced: true, preset: 'custom' });
  await h.engine.start();
  h.at(0.46);
  const obsolete = h.context.sources.find(source => Math.abs(source.startTime - 0.55) < 0.00001);
  h.state.pattern[1].cells[0] = { kind: 'accent', velocity: 50, sound: 'electronic' };
  h.engine.refresh();
  assert.ok(obsolete.stops.at(-1) <= 0.46);
  const replacement = h.context.sources.at(-1);
  close(replacement.startTime, 0.55);
  assert.equal(replacement.frequency.changes[0].value, 1600);
  close(replacement.connections[0].gain.changes[1].value, 0.4);
  assert.equal(h.engine.getPosition().events[1].accent, true);
  h.engine.stop();
});

test('basic sound and accent settings affect the next unsounded onset immediately', async () => {
  const h = harness({ beats: 1 });
  await h.engine.start();
  h.at(0.46);
  const obsolete = h.context.sources.at(-1);
  h.state.sound = 'electronic';
  h.state.accent = false;
  h.engine.refresh();
  assert.ok(obsolete.stops.at(-1) <= 0.46);
  const replacement = h.context.sources.at(-1);
  close(replacement.startTime, 0.55);
  assert.equal(replacement.frequency.changes[0].value, 1100);
  assert.equal(h.engine.getPosition().state.sound, 'electronic');
  assert.equal(h.engine.getPosition().events[0].accent, false);
  h.engine.stop();
});

test('first-cell edits replace scheduled accent sound without a hidden first-beat override', async () => {
  const h = harness({ advanced: true, beats: 1, preset: 'custom', sound: 'electronic' });
  h.state.pattern[0].cells[0].kind = 'normal';
  h.state.accent = true;
  await h.engine.start();
  assert.equal(h.context.sources[0].frequency.changes[0].value, 1100);
  h.at(0.46);
  const oldNormal = h.context.sources.at(-1);
  h.state.pattern[0].cells[0].kind = 'accent';
  h.engine.refresh();
  assert.ok(oldNormal.stops.at(-1) <= 0.46);
  assert.equal(h.context.sources.at(-1).frequency.changes[0].value, 1600);
  h.state.pattern[0].cells[0].kind = 'normal';
  h.engine.refresh();
  assert.equal(h.context.sources.at(-1).frequency.changes[0].value, 1100);
  assert.equal(h.engine.getPosition().events[0].accent, false);
  h.engine.stop();
});

test('an edit at an already sounded onset does not duplicate it or cut its tail', async () => {
  const h = harness({ advanced: true, preset: 'eighth' });
  await h.engine.start();
  h.at(0.2);
  h.context.currentTime = 0.3;
  const sounding = h.context.sources.at(-1);
  h.state.sound = 'electronic';
  h.engine.refresh();
  assert.equal(sounding.stops.length, 1);
  assert.equal(h.context.sources.filter(source => Math.abs(source.startTime - 0.3) < 0.00001).length, 1);
  assert.equal(h.engine.getPosition().state.sound, 'electronic');
  h.engine.stop();
});

test('meter edits wrap the current beat into the new meter while preserving its fractional phase', async () => {
  const h = harness();
  await h.engine.start();
  h.at(1.8);
  h.state.beats = 2;
  h.state.denominator = 8;
  h.engine.refresh();
  const active = h.engine.getPosition();
  assert.equal(active.beats, 2);
  assert.equal(active.denominator, 4);
  assert.equal(active.beat, 1);
  close(active.progress, 0.75);
  assert.equal(active.barIndex, 0);
  h.at(1.98);
  assert.equal(h.at(2.06).barIndex, 1);
  h.engine.stop();
});

test('master volume updates sounds that were already scheduled', async () => {
  const h = harness();
  await h.engine.start();
  const master = h.context.gains.find(node => node.connections.includes(h.context.destination));
  h.engine.setVolume(0.23);
  close(master.gain.value, 0.23);
  h.engine.setVolume(5);
  assert.equal(master.gain.value, 1);
  h.engine.setVolume(-1);
  assert.equal(master.gain.value, 0);
  h.engine.stop();
});

test('an edit during lookahead replaces both the active timing and the upcoming bar', async () => {
  const h = harness({ beats: 1 });
  await h.engine.start();
  h.at(0.46);
  const alreadyScheduled = h.context.sources.find(source => Math.abs(source.startTime - 0.55) < 0.00001);
  assert.ok(alreadyScheduled);
  h.state.bpm = 240;
  const active = h.at(0.51);
  assert.equal(active.bpm, 240);
  close(active.progress, 0.92);
  assert.ok(alreadyScheduled.stops.at(-1) <= 0.51);
  const next = h.at(0.531);
  assert.equal(next.barIndex, 1);
  assert.equal(next.bpm, 240);
  assert.equal(next.state.bpm, 240);
  h.engine.stop();
});

test('a synchronous state refresh applies an edit made between the last tick and the next bar', async () => {
  const h = harness({ beats: 1 });
  await h.engine.start();
  h.at(0.526);
  h.context.currentTime = 0.54;
  h.state.bpm = 240;
  h.engine.refresh();
  assert.equal(h.engine.getPosition().bpm, 240);
  assert.equal(h.at(0.551).bpm, 240);
  h.engine.stop();
});

test('the visual position advances through silent cells of a built-in rhythm', async () => {
  const h = harness({ advanced: true, beats: 1, preset: 'triplet-skip' });
  await h.engine.start();
  const rest = h.at(0.23);
  assert.equal(rest.beat, 0);
  assert.equal(rest.cell, 1);
  assert.equal(rest.events.length, 2);
  h.engine.stop();
});

test('the visual position follows swung pairs in a four-cell custom beat', async () => {
  const h = harness({ advanced: true, beats: 1, preset: 'custom', swing: 75 });
  h.state.pattern = [{ divisions: 4, swing: true, cells: Array.from({ length: 4 }, () => ({ kind: 'normal', velocity: 80, sound: 'inherit' })) }];
  await h.engine.start();
  assert.equal(h.at(0.21).cell, 0);
  assert.equal(h.at(0.25).cell, 1);
  h.engine.stop();
});

test('stopping while audio resumes prevents a delayed accidental start', async () => {
  const h = harness();
  let releaseResume;
  h.context.resume = () => new Promise(resolve => {
    releaseResume = () => { h.context.state = 'running'; resolve(); };
  });
  const starting = h.engine.start();
  h.engine.stop();
  releaseResume();
  assert.equal(await starting, false);
  assert.equal(h.engine.getPosition(), null);
  assert.equal(h.context.sources.length, 0);
  assert.equal(h.intervals.size, 0);
  assert.deepEqual(h.stops, ['manual']);
});

test('stop cancels a pending preview while its audio context is resuming', async () => {
  const h = harness();
  let releaseResume;
  h.context.resume = () => new Promise(resolve => {
    releaseResume = () => { h.context.state = 'running'; resolve(); };
  });
  const previewing = h.engine.preview('electronic');
  h.engine.stop();
  releaseResume();
  assert.equal(await previewing, false);
  assert.equal(h.context.sources.length, 0);
  assert.equal(h.engine.getPosition(), null);
});

test('count-in occupies one audible bar before the first practice bar', async () => {
  const h = harness({ advanced: true, beats: 1, practice: { countIn: true } });
  await h.engine.start();
  const countIn = h.at(0.06);
  assert.equal(countIn.barIndex, -1);
  assert.equal(countIn.countIn, true);
  h.at(0.48);
  const first = h.at(0.56);
  assert.equal(first.barIndex, 0);
  assert.equal(first.countIn, false);
  h.engine.stop();
});

test('mute and ramp follow bar boundaries and automatic stop waits for the last bar to finish', async () => {
  const h = harness({
    advanced: true, beats: 1,
    practice: {
      muteEnabled: true, playBars: 1, muteBars: 1,
      rampEnabled: true, rampEvery: 1, rampStep: 30, rampMax: 180,
      stopEnabled: true, stopBars: 3
    }
  });
  await h.engine.start();
  assert.equal(h.at(0.06).bpm, 120);
  h.at(0.48);
  const muted = h.at(0.56);
  assert.equal(muted.barIndex, 1);
  assert.equal(muted.muted, true);
  assert.equal(muted.bpm, 150);
  assert.equal(h.context.sources.length, 1);
  h.at(0.86);
  const last = h.at(0.96);
  assert.equal(last.barIndex, 2);
  assert.equal(last.bpm, 180);
  assert.equal(last.muted, false);
  assert.equal(h.context.sources.length, 2);
  h.at(1.2);
  assert.deepEqual(h.stops, []);
  assert.equal(h.at(1.29), null);
  assert.deepEqual(h.stops, ['complete']);
  assert.equal(h.intervals.size, 0);
});

test('basic mode ignores count-in, mute, ramp and automatic stop', async () => {
  const h = harness({
    advanced: false, beats: 1,
    practice: { countIn: true, muteEnabled: true, playBars: 1, muteBars: 1, rampEnabled: true, rampEvery: 1, rampStep: 60, rampMax: 240, stopEnabled: true, stopBars: 1 }
  });
  await h.engine.start();
  assert.equal(h.at(0.06).barIndex, 0);
  h.at(0.48);
  const next = h.at(0.56);
  assert.equal(next.barIndex, 1);
  assert.equal(next.bpm, 120);
  assert.equal(next.muted, false);
  assert.equal(next.countIn, false);
  assert.deepEqual(h.stops, []);
  h.engine.stop();
});

test('mute settings and mode changes immediately rebuild the active rhythm', async () => {
  const h = harness({ advanced: true, beats: 1, preset: 'eighth' });
  await h.engine.start();
  h.at(0.46);
  h.at(0.6);
  h.at(0.71);
  const scheduled = h.context.sources.at(-1);
  close(scheduled.startTime, 0.8);
  h.state.practice.muteEnabled = true;
  h.state.practice.playBars = 1;
  h.state.practice.muteBars = 1;
  h.engine.refresh();
  assert.equal(h.engine.getPosition().muted, true);
  assert.ok(scheduled.stops.at(-1) <= 0.71);
  h.state.advanced = false;
  h.engine.refresh();
  assert.equal(h.engine.getPosition().muted, false);
  assert.equal(h.engine.getPosition().events.length, 1);
  h.state.advanced = true;
  h.state.practice.muteEnabled = false;
  h.engine.refresh();
  assert.equal(h.engine.getPosition().events.length, 2);
  const replacement = h.context.sources.at(-1);
  close(replacement.startTime, 0.8);
  assert.ok(replacement.stops.at(-1) > replacement.startTime);
  h.engine.stop();
});

test('manual ramp tempo edits start from the requested BPM at the current practice bar', async () => {
  const h = harness({ advanced: true, beats: 1, practice: { rampEnabled: true, rampEvery: 1, rampStep: 30, rampMax: 240 } });
  await h.engine.start();
  h.at(0.46);
  h.at(0.56);
  h.at(0.88);
  assert.equal(h.at(0.96).bpm, 180);
  h.state.bpm = 130;
  h.engine.refresh();
  assert.equal(h.engine.getPosition().bpm, 130);
  h.at(1.32);
  assert.equal(h.at(1.42).bpm, 160);
  h.engine.stop();
});

test('ramp configuration changes reset the ramp origin while rhythm edits retain it', async () => {
  const h = harness({ advanced: true, beats: 1, practice: { rampEnabled: true, rampEvery: 1, rampStep: 30, rampMax: 240 } });
  await h.engine.start();
  h.at(0.46);
  assert.equal(h.at(0.56).bpm, 150);
  h.state.sound = 'electronic';
  h.state.preset = 'eighth';
  h.engine.refresh();
  assert.equal(h.engine.getPosition().bpm, 150);
  h.state.practice.rampStep = 10;
  h.engine.refresh();
  assert.equal(h.engine.getPosition().bpm, 120);
  h.at(0.94);
  assert.equal(h.at(1.05).bpm, 130);
  h.engine.stop();
});

test('a manual tempo edit after a timer gap resets ramping at the resumed practice bar', async () => {
  const h = harness({ advanced: true, beats: 1, practice: { rampEnabled: true, rampEvery: 1, rampStep: 30, rampMax: 240 } });
  await h.engine.start();
  h.at(0.06);
  h.context.currentTime = 100;
  h.state.bpm = 130;
  h.engine.refresh();
  const resumed = h.at(100.06);
  assert.ok(resumed.barIndex > 0);
  assert.equal(resumed.bpm, 130);
  h.at(100.46);
  assert.equal(h.at(100.52).bpm, 160);
  h.engine.stop();
});

test('auto-stop edits can extend a queued stop and stop immediately when the current bar exceeds the new limit', async () => {
  const h = harness({ advanced: true, beats: 1, practice: { stopEnabled: true, stopBars: 1 } });
  await h.engine.start();
  h.at(0.46);
  h.context.currentTime = 0.55;
  h.state.practice.stopBars = 3;
  h.engine.refresh();
  assert.deepEqual(h.stops, []);
  assert.equal(h.engine.getPosition().barIndex, 1);
  h.state.practice.stopBars = 1;
  h.engine.refresh();
  assert.deepEqual(h.stops, ['complete']);
  assert.equal(h.engine.getPosition(), null);
});

test('count-in selection only affects startup while count-in tempo edits apply immediately', async () => {
  const h = harness({ advanced: true, beats: 1, practice: { countIn: true } });
  await h.engine.start();
  h.at(0.3);
  h.state.practice.countIn = false;
  h.state.bpm = 240;
  h.engine.refresh();
  const countIn = h.engine.getPosition();
  assert.equal(countIn.countIn, true);
  assert.equal(countIn.bpm, 240);
  close(countIn.progress, 0.5);
  h.at(0.4);
  assert.equal(h.at(0.426).barIndex, 0);
  h.state.practice.countIn = true;
  h.engine.refresh();
  assert.equal(h.engine.getPosition().countIn, false);
  h.engine.stop();
});

test('edits before the first onset retain startup delay and replace its sound', async () => {
  const h = harness();
  await h.engine.start();
  const obsolete = h.context.sources[0];
  h.context.currentTime = 0.02;
  h.state.sound = 'electronic';
  h.state.bpm = 240;
  h.engine.refresh();
  assert.equal(h.engine.getPosition(), null);
  assert.ok(obsolete.stops.at(-1) <= 0.02);
  const replacement = h.context.sources.at(-1);
  close(replacement.startTime, 0.05);
  assert.equal(replacement.frequency.changes[0].value, 1600);
  assert.equal(h.at(0.06).bpm, 240);
  h.engine.stop();
});

function decay(source) {
  const gain = source.connections.find(node => node.gain.changes.length > 0)
    || source.connections[0].connections[0];
  return gain.gain.changes.at(-1).time - source.startTime;
}

test('larger sounding intervals subtly extend decay while previews keep their base duration', async () => {
  const fast = harness({ bpm: 240, sound: 'wood' });
  const slow = harness({ bpm: 60, sound: 'wood' });
  await fast.engine.start();
  await slow.engine.start();
  const fastDecay = decay(fast.context.sources[0]);
  const slowDecay = decay(slow.context.sources[0]);
  assert.ok(slowDecay > fastDecay);
  assert.ok(slowDecay <= 0.095 + 0.00001);
  await slow.engine.preview('wood');
  close(decay(slow.context.sources.at(-1)), 0.075);
  fast.engine.stop();
  slow.engine.stop();
});

test('decay follows swung sounding gaps including the shorter interval across a bar edge', async () => {
  const h = harness({ advanced: true, beats: 1, preset: 'swing', swing: 75, accent: false });
  await h.engine.start();
  const longDecay = decay(h.context.sources[0]);
  h.at(0.33);
  const shortGap = h.context.sources.at(-1);
  close(shortGap.startTime, 0.425);
  assert.ok(longDecay > decay(shortGap));
  h.engine.stop();
});

test('decay uses the next audible note across rests and keeps both cowbell voices equal', async () => {
  const dense = harness({ advanced: true, beats: 1, preset: 'sixteenth', sound: 'cowbell', accent: false });
  const sparse = harness({ advanced: true, beats: 1, preset: 'custom', sound: 'cowbell', accent: false });
  sparse.state.pattern = [{ divisions: 4, swing: false, cells: [
    { kind: 'normal', velocity: 80, sound: 'inherit' },
    { kind: 'rest', velocity: 80, sound: 'inherit' },
    { kind: 'rest', velocity: 80, sound: 'inherit' },
    { kind: 'rest', velocity: 80, sound: 'inherit' }
  ] }];
  await dense.engine.start();
  await sparse.engine.start();
  assert.ok(decay(sparse.context.sources[0]) > decay(dense.context.sources[0]));
  close(decay(sparse.context.sources[0]), decay(sparse.context.sources[1]));
  assert.ok(decay(sparse.context.sources[0]) <= 0.15 + 0.00001);
  dense.engine.stop();
  sparse.engine.stop();
});

test('a long timer gap rebases future audio without a burst of overdue events', async () => {
  const h = harness();
  await h.engine.start();
  const before = h.context.sources.length;
  h.at(100);
  const added = h.context.sources.slice(before);
  assert.ok(added.length > 0 && added.length <= 2);
  assert.ok(added.every(source => source.startTime >= 100));
  const active = h.at(100.06);
  assert.ok(active.barIndex > 0);
  assert.ok(active.progress < 0.1);
  h.engine.stop();
});

test('a delayed tick near a dense bar boundary schedules only current and future notes', async () => {
  for (const resumedAt of [0.249, 0.25]) {
    const h = harness({ advanced: true, beats: 1, bpm: 300, preset: 'custom' });
    h.state.pattern = [{ divisions: 16, swing: false, cells: Array.from({ length: 16 }, () => (
      { kind: 'normal', velocity: 80, sound: 'inherit' }
    )) }];
    await h.engine.start();
    h.at(0.06);
    const before = h.context.sources.length;
    h.at(resumedAt);
    const added = h.context.sources.slice(before);
    close(added[0].startTime, 0.25);
    assert.equal(added.filter(source => Math.abs(source.startTime - 0.25) < 0.00001).length, 1);
    h.engine.stop();
  }
});

test('preview synthesizes every sound without starting or changing the transport', async () => {
  const h = harness();
  for (const sound of ['electronic', 'wood', 'sticks', 'cowbell', 'kick', 'hihat']) {
    const previous = h.context.sources.length;
    assert.equal(await h.engine.preview(sound, true), true);
    assert.ok(h.context.sources.length > previous, sound);
  }
  assert.equal(h.engine.getPosition(), null);
  assert.equal(h.intervals.size, 0);
  assert.deepEqual(h.bars, []);
  await h.engine.start();
  const position = h.at(0.06);
  await h.engine.preview('wood');
  assert.equal(h.engine.getPosition().barIndex, position.barIndex);
  h.engine.stop();
});

test('unsupported audio returns false and reports a useful error', async () => {
  const errors = [];
  const stops = [];
  const engine = new MetronomeEngine({
    getState: () => structuredClone(DEFAULT_STATE),
    createAudioContext: () => { throw new Error('此浏览器不支持 Web Audio'); },
    onError: error => errors.push(error),
    onStop: reason => stops.push(reason)
  });
  assert.equal(await engine.start(), false);
  assert.equal(engine.getPosition(), null);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /Web Audio/);
  assert.deepEqual(stops, ['error']);
});
