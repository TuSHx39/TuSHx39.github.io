import { compileBar, createPattern } from './rhythm.js';

const LOOKAHEAD = 0.1;
const START_DELAY = 0.05;
const TICK_MS = 25;
const EPSILON = 0.000001;
const MAX_DECAY_EXTENSION = 0.02;
const DECAY_PER_SECOND = 0.01;

function defaultContext() {
  const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!Context) throw new Error('此浏览器不支持 Web Audio，请使用支持音频播放的浏览器。');
  return new Context();
}

function copyState(state) {
  return typeof structuredClone === 'function' ? structuredClone(state) : JSON.parse(JSON.stringify(state));
}

function timingKey(state) {
  const { volume, ...timing } = state;
  return JSON.stringify(timing);
}

function rampKey(state) {
  const practice = state.practice;
  return JSON.stringify([state.bpm, practice?.rampEnabled, practice?.rampEvery, practice?.rampStep, practice?.rampMax]);
}

/** Schedules sound with the audio clock and exposes that same clock to the UI. */
export class MetronomeEngine {
  constructor({ getState, onBar = () => {}, onStop = () => {}, onError = () => {}, createAudioContext = defaultContext, setInterval: interval = globalThis.setInterval.bind(globalThis), clearInterval: clear = globalThis.clearInterval.bind(globalThis) } = {}) {
    this._getState = getState;
    this._onBar = onBar;
    this._onStop = onStop;
    this._onError = onError;
    this._createContext = createAudioContext;
    this._setInterval = interval;
    this._clearInterval = clear;
    this._context = null;
    this._master = null;
    this._noise = null;
    this._volume = 0.8;
    this._volumeExplicit = false;
    this._sources = new Set();
    this._bars = [];
    this._interval = null;
    this._playing = false;
    this._starting = null;
    this._epoch = 0;
    this._notifiedBar = null;
    this._completeAt = null;
    this._finishedPlan = null;
  }

  async start() {
    if (this._playing) return true;
    if (this._starting) return this._starting;
    const epoch = ++this._epoch;
    const pending = this._beginStart(epoch);
    this._starting = pending;
    try { return await pending; }
    finally { if (this._starting === pending) this._starting = null; }
  }

  async _beginStart(epoch) {
    try {
      await this._readyAudio();
      if (epoch !== this._epoch) return false;
      const state = copyState(this._getState());
      if (!this._volumeExplicit) this.setVolume(state.volume);
      this._bars = [];
      this._appliedState = state;
      this._rampOrigin = 0;
      this._nextBarIndex = state.advanced && state.practice?.countIn ? -1 : 0;
      this._nextStart = this._context.currentTime + START_DELAY;
      this._transportStart = this._nextStart;
      this._lastDuration = state.beats * 60 / state.bpm;
      this._notifiedBar = null;
      this._completeAt = null;
      this._finishedPlan = null;
      this._playing = true;
      this._tick();
      if (!this._playing) return false;
      this._interval = this._setInterval(() => this._tick(), TICK_MS);
      return true;
    } catch (error) {
      if (epoch === this._epoch) this._fail(error);
      return false;
    }
  }

  stop() { this._halt('manual'); }

  // Recompile the active plan immediately, keeping the audio clock's beat phase.
  refresh() { this._tick(); }

  _halt(reason, force = false) {
    const wasActive = this._playing || this._starting !== null;
    this._epoch += 1;
    this._playing = false;
    this._starting = null;
    if (this._interval !== null) this._clearInterval(this._interval);
    this._interval = null;
    this._bars = [];
    this._completeAt = null;
    this._finishedPlan = null;
    this._notifiedBar = null;
    const now = this._context?.currentTime || 0;
    for (const entry of [...this._sources]) {
      try { entry.source.stop(now); } catch { /* Already ended sources cannot be stopped twice. */ }
      this._releaseSource(entry);
    }
    if (wasActive || force) this._onStop(reason);
  }

  setVolume(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return;
    this._volume = Math.min(1, Math.max(0, number));
    this._volumeExplicit = true;
    if (this._master) this._master.gain.setTargetAtTime(this._volume, this._context.currentTime, 0.008);
  }

  async preview(sound, accent = false) {
    const epoch = this._epoch;
    try {
      await this._readyAudio();
      if (epoch !== this._epoch) return false;
      this._synthesize({ sound, accent, velocity: 0.8 }, this._context.currentTime + 0.005);
      return true;
    } catch (error) {
      if (epoch === this._epoch) this._onError(error instanceof Error ? error : new Error(String(error)));
      return false;
    }
  }

  async _readyAudio() {
    if (!this._context || this._context.state === 'closed') {
      this._context = this._createContext();
      if (!this._context) throw new Error('无法创建 Web Audio 音频上下文。');
      this._master = this._context.createGain();
      this._master.gain.setValueAtTime(this._volume, this._context.currentTime);
      this._master.connect(this._context.destination);
      this._noise = null;
    }
    if (this._context.state !== 'running') await this._context.resume();
    if (this._context.state !== 'running') throw new Error('音频播放未能启动，请再次点击开始。');
  }

  _tick() {
    if (!this._playing) return;
    try {
      const now = this._context.currentTime;
      if (!Number.isFinite(now) || this._context.state === 'closed') throw new Error('音频时钟已停止，请重新开始。');
      const rampReset = this._refreshPlans(copyState(this._getState()), now);
      if (this._completeAt !== null && now + EPSILON >= this._completeAt) {
        this._halt('complete');
        return;
      }

      // A throttled timer never catches up by emitting a backlog of old notes.
      if (this._nextStart < now - LOOKAHEAD) {
        const duration = Math.max(0.2, this._lastDuration || 0.5);
        const missed = Math.floor((now - this._nextStart) / duration) + 1;
        this._nextBarIndex += missed;
        if (rampReset) this._rampOrigin = Math.max(0, this._nextBarIndex);
        this._nextStart = now + START_DELAY;
        this._bars = [];
      }

      const horizon = now + LOOKAHEAD;
      let generated = 0;
      while (this._completeAt === null && this._nextStart < horizon + EPSILON && generated++ < 32) {
        const state = this._appliedState;
        const compiled = this._compileBar(state, this._nextBarIndex);
        if (compiled.finished) {
          this._completeAt = this._nextStart;
          this._finishedPlan = { state, barIndex: this._nextBarIndex, start: this._nextStart };
          break;
        }
        const bar = this._makeBar(state, this._nextBarIndex, this._nextStart, compiled);
        this._bars.push(bar);
        this._lastDuration = bar.end - bar.start;
        this._nextStart = bar.end;
        this._nextBarIndex += 1;
      }

      for (const bar of this._bars) {
        while (bar.nextEvent < bar.events.length) {
          const event = bar.events[bar.nextEvent];
          const time = bar.start + event.offset * bar.secondsPerBeat;
          if (time > horizon + EPSILON) break;
          bar.nextEvent += 1;
          if (time < now - EPSILON || bar.muted || event.velocity <= 0) continue;
          this._synthesize(event, Math.max(now, time), bar, this._nextSoundInterval(bar, event));
        }
      }
      this._bars = this._bars.filter(bar => bar.end > now - LOOKAHEAD);
      for (const entry of [...this._sources]) {
        if (entry.end < now - LOOKAHEAD) this._releaseSource(entry);
      }
      this._readPosition(now);
    } catch (error) { this._fail(error); }
  }

  _compileBar(state, barIndex) {
    const compiled = compileBar(state, barIndex);
    // Mute and stop count actual practice bars; ramp counts from its latest edit.
    if (state.advanced && state.practice?.rampEnabled && !compiled.countIn) {
      const { rampEvery, rampStep, rampMax } = state.practice;
      const steps = Math.floor(Math.max(0, barIndex - this._rampOrigin) / rampEvery);
      compiled.bpm = Math.max(state.bpm, Math.min(rampMax, state.bpm + steps * rampStep));
    }
    return compiled;
  }

  _makeBar(state, barIndex, start, compiled = this._compileBar(state, barIndex)) {
    const secondsPerBeat = 60 / compiled.bpm;
    const duration = compiled.beats * secondsPerBeat;
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('节拍参数无法生成有效的小节。');
    return {
      ...compiled, state, barIndex, start, end: start + duration, secondsPerBeat, nextEvent: 0,
      grid: state.advanced && !compiled.countIn
        ? state.preset === 'custom' ? state.pattern : createPattern(compiled.beats, state.preset, state.swing)
        : createPattern(compiled.beats)
    };
  }

  _refreshPlans(state, now) {
    if (timingKey(state) === timingKey(this._appliedState)) return false;
    const active = this._bars.find(bar => now + EPSILON >= bar.start && now < bar.end);
    const pending = this._bars.find(bar => bar.start > now + EPSILON) || this._finishedPlan;
    const barIndex = active?.barIndex ?? pending?.barIndex ?? this._nextBarIndex;
    const rampReset = rampKey(state) !== rampKey(this._appliedState);
    if (rampReset) this._rampOrigin = Math.max(0, barIndex);
    this._appliedState = state;

    // Sounded voices finish their tails; scheduled future voices must be replaced.
    for (const entry of [...this._sources]) {
      if (!entry.bar || entry.time <= now + EPSILON) continue;
      try { entry.source.stop(now); } catch { /* This source may have already been cancelled. */ }
      this._releaseSource(entry);
    }
    this._bars = [];
    this._nextBarIndex = barIndex;
    this._nextStart = active?.start ?? pending?.start ?? this._nextStart;
    this._completeAt = null;
    this._finishedPlan = null;

    if (active) {
      const compiled = this._compileBar(state, barIndex);
      if (compiled.finished) {
        this._completeAt = now;
        return rampReset;
      }
      const beatPosition = Math.max(0, (now - active.start) / active.secondsPerBeat) % compiled.beats;
      const bar = this._makeBar(state, barIndex, now - beatPosition * 60 / compiled.bpm, compiled);
      // Never replay a past or currently sounding onset after recompilation.
      while (bar.nextEvent < bar.events.length
        && bar.events[bar.nextEvent].offset <= beatPosition + EPSILON) bar.nextEvent += 1;
      this._bars.push(bar);
      this._lastDuration = bar.end - bar.start;
      this._nextStart = bar.end;
      this._nextBarIndex += 1;
    }
    return rampReset;
  }

  _nextSoundInterval(bar, event) {
    const next = bar.events.find(item => item.offset > event.offset + EPSILON && item.velocity > 0);
    if (next) return (next.offset - event.offset) * bar.secondsPerBeat;
    const onset = bar.start + event.offset * bar.secondsPerBeat;
    const maximum = MAX_DECAY_EXTENSION / DECAY_PER_SECOND;
    let nextStart = bar.end;
    let barIndex = bar.barIndex + 1;
    // Rest cells and muted practice bars count toward the actual sounding gap.
    while (nextStart - onset < maximum) {
      const compiled = this._compileBar(bar.state, barIndex++);
      if (compiled.finished) return Math.max(0, nextStart - onset);
      const first = !compiled.muted && compiled.events.find(item => item.velocity > 0);
      if (first) return nextStart + first.offset * 60 / compiled.bpm - onset;
      nextStart += compiled.beats * 60 / compiled.bpm;
    }
    return maximum;
  }

  getPosition() {
    if (!this._playing) return null;
    return this._readPosition(this._context.currentTime);
  }

  _readPosition(now) {
    if (this._completeAt !== null && now + EPSILON >= this._completeAt) {
      this._halt('complete');
      return null;
    }
    const bar = this._bars.find(item => now + EPSILON >= item.start && now < item.end);
    if (!bar) return null;
    const beatPosition = Math.min(bar.beats - EPSILON, Math.max(0, (now - bar.start) / bar.secondsPerBeat));
    const beat = Math.floor(beatPosition);
    const local = beatPosition - beat;
    const grid = bar.grid[beat];
    let cell = Math.min(grid.divisions - 1, Math.floor(local * grid.divisions));
    if (grid.swing && grid.divisions % 2 === 0) {
      const pair = Math.floor(local * grid.divisions / 2);
      const split = (pair * 2 + 2 * bar.state.swing / 100) / grid.divisions;
      cell = pair * 2 + Number(local + EPSILON >= split);
    }
    const position = {
      progress: beatPosition / bar.beats, beat, cell, barIndex: bar.barIndex,
      bpm: bar.bpm, muted: bar.muted, countIn: bar.countIn,
      elapsed: Math.max(0, now - this._transportStart), events: bar.events,
      beats: bar.beats, denominator: bar.denominator, state: bar.state
    };
    if (this._notifiedBar !== bar) {
      this._notifiedBar = bar;
      this._onBar(position);
    }
    return this._playing ? position : null;
  }

  _fail(error) {
    const exception = error instanceof Error ? error : new Error(String(error));
    this._halt('error', true);
    this._onError(exception);
  }

  _releaseSource(entry) {
    this._sources.delete(entry);
    entry.source.onended = null;
    for (const node of entry.nodes) {
      try { node.disconnect(); } catch { /* Disconnection is best effort after cancellation. */ }
    }
  }

  _noiseBuffer() {
    if (!this._noise) {
      const size = Math.ceil(this._context.sampleRate * 0.4);
      this._noise = this._context.createBuffer(1, size, this._context.sampleRate);
      const samples = this._noise.getChannelData(0);
      for (let index = 0; index < samples.length; index += 1) samples[index] = Math.random() * 2 - 1;
    }
    return this._noise;
  }

  _voice(time, duration, amplitude, setup, filterSetup, bar) {
    const source = setup();
    const gain = this._context.createGain();
    const nodes = [source, gain];
    if (filterSetup) {
      const filter = this._context.createBiquadFilter();
      filterSetup(filter);
      source.connect(filter);
      filter.connect(gain);
      nodes.push(filter);
    } else source.connect(gain);
    gain.connect(this._master);
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.linearRampToValueAtTime(Math.max(0.0001, amplitude), time + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + duration);
    const entry = { source, nodes, time, end: time + duration + 0.005, bar };
    this._sources.add(entry);
    source.onended = () => this._releaseSource(entry);
    source.start(time);
    source.stop(entry.end);
  }

  _synthesize(event, time, bar = null, interval = 0) {
    const accent = Boolean(event.accent);
    const velocity = Math.min(1, Math.max(0, event.velocity));
    const level = velocity * (accent ? 0.8 : 0.6);
    const oscillator = (type, frequency, endFrequency) => () => {
      const source = this._context.createOscillator();
      source.type = type;
      source.frequency.setValueAtTime(frequency, time);
      if (endFrequency) source.frequency.exponentialRampToValueAtTime(endFrequency, time + 0.15);
      return source;
    };
    const noise = () => {
      const source = this._context.createBufferSource();
      source.buffer = this._noiseBuffer();
      return source;
    };
    const extension = Math.min(MAX_DECAY_EXTENSION, Math.max(0, interval) * DECAY_PER_SECOND);
    const voice = (duration, amplitude, setup, filterSetup) => this._voice(time, duration + extension, amplitude, setup, filterSetup, bar);
    switch (event.sound) {
      case 'wood':
        voice(0.075, level, oscillator('triangle', accent ? 1320 : 880));
        break;
      case 'sticks':
        voice(0.035, level * 0.7, noise, filter => {
          filter.type = 'bandpass'; filter.frequency.value = accent ? 3200 : 2400; filter.Q.value = 2.5;
        });
        break;
      case 'cowbell':
        voice(0.13, level * 0.28, oscillator('square', accent ? 700 : 560));
        voice(0.13, level * 0.22, oscillator('square', accent ? 1050 : 845));
        break;
      case 'kick':
        voice(0.22, level, oscillator('sine', accent ? 190 : 150, accent ? 55 : 45));
        break;
      case 'hihat':
        voice(accent ? 0.085 : 0.055, level * 0.65, noise, filter => {
          filter.type = 'highpass'; filter.frequency.value = accent ? 6500 : 5000;
        });
        break;
      default:
        voice(0.045, level, oscillator('sine', accent ? 1600 : 1100));
    }
  }
}
