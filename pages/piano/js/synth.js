/**
 * synth.js —— 发音引擎（Web Audio）
 *
 * 声部模型按真实钢琴的「制音器」设计：
 *   · 按下琴键      → 起音后进入自然衰减：两段指数（先快后慢），低通截止随时间下滑，
 *                     高次谐波先消失，听感接近真实钢琴；
 *   · 松键、未踩踏板 → 制音器落下：快速放音，放完即从声部表删除；
 *   · 踩踏板时松键   → 制音器保持抬起：音继续缓速（自然）衰减，
 *                     这期间一直算「正在弹奏」，直到松开踏板才立刻放音；
 *   · 若在「快速放音」过程中踩下踏板 → 只放慢衰减速度，绝不抬高当前音量；
 *   · 声部一旦结束就删除，之后再踩踏板也不会把该音重新变成「正在弹奏」。
 *
 * 'piano' 波形不是浏览器内置波形，而是「谐波频谱（PeriodicWave）+ 击槌噪声瞬态
 * + 随时间下滑的低通」合成出来的钢琴音色。
 *
 * 传统脚本（非 ES Module），接口挂在全局 Piano.Synth 上。
 */

(function (global) {
  'use strict';

  const Piano = global.Piano = global.Piano || {};

/** 钢琴谐波幅度（下标 = 谐波次数），约 1/n^1.4：厚实但不刺耳 */
const PIANO_HARMONICS = [0, 1, 0.42, 0.28, 0.16, 0.11, 0.07, 0.045, 0.03, 0.02, 0.014, 0.009];

/** 包络 / 音色参数：piano 是复合音色，simple 给其余四种基础波形 */
const PROFILES = {
  piano: {
    attack: 0.005,
    peak: 0.30,
    tau1: 0.85,      // 自然衰减第一段（高次谐波先消失）
    stage2: 0.5,     // 进入第二段的时间
    tau2: 4.6,       // 第二段长尾
    release: 0.075,  // 制音器放音速度
    cutoffFrom: 8,   // 低通初值 = 基频 × 8，再按上下限裁剪
    cutoffTo: 2.2,   // 低通终值 = 基频 × 2.2（保证基频始终通过）
    cutoffClampFrom: [1400, 9000],
    cutoffClampTo: [520, 5200],
    sweep: 3.4,
    hammer: 0.085,   // 击槌噪声瞬态
    hammerTau: 0.028,
  },
  simple: {
    attack: 0.008,
    peak: 0.26,
    tau1: 1.1,
    stage2: 0.6,
    tau2: 4.0,
    release: 0.08,
    cutoffFrom: 14,
    cutoffTo: 4,
    cutoffClampFrom: [2200, 12000],
    cutoffClampTo: [800, 8000],
    sweep: 3.0,
    hammer: 0,
    hammerTau: 0.02,
  },
};

const DECAY_TAIL = 4.5;   // 自然衰减走多少个 τ 之后安排停止
const PEDAL_HOLD = 300;   // 踏板保持中的音：停止时间推远（实际由抬踏板决定），同时给个上限避免无限堆积

/** 真实钢琴：音越高衰减越快，低音弦拖得久 */
function pitchScaledProfile(base, freq) {
  const factor = clamp(Math.pow(440 / freq, 0.35), 0.45, 2.2);
  if (factor === 1) return base;
  return {
    ...base,
    tau1: base.tau1 * Math.min(factor, 1.4),
    tau2: base.tau2 * factor,
  };
}
const MIN_FREQ = 100;
const MAX_FREQ = 2000;

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function currentGain(param) {
  // 当前实际增益：指数衰减过程中不会是 0，兜底避免 setTargetAtTime 出问题
  return Math.max(param.value, 0.0001);
}

function createSynth(options = {}) {
  const getVolume = options.getVolume || (() => 0.5);
  const getWaveform = options.getWaveform || (() => 'piano');
  const getBaseFreq = options.getBaseFreq || (() => 440);
  const onVoicesChanged = options.onVoicesChanged || (() => {});

  const Ctor = typeof window !== 'undefined'
    ? (window.AudioContext || window.webkitAudioContext)
    : null;

  /** @type {Map<number, object>} midi -> 声部 */
  const voices = new Map();

  let ctx = null;
  let master = null;
  let compressor = null;
  let sustain = false;
  let periodicWave = null;
  let noise = null;

  /* ---------------- 上下文与共享资源 ---------------- */

  function ensureContext() {
    if (ctx || !Ctor) return ctx;
    ctx = new Ctor();
    master = ctx.createGain();
    master.gain.value = clamp(getVolume(), 0, 1);

    compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -14;
    compressor.knee.value = 24;
    compressor.ratio.value = 3.5;
    compressor.attack.value = 0.004;
    compressor.release.value = 0.25;

    master.connect(compressor);
    compressor.connect(ctx.destination);
    return ctx;
  }

  function resume() {
    const context = ensureContext();
    if (context && context.state === 'suspended') context.resume().catch(() => {});
    return context;
  }

  function pianoWave() {
    if (!periodicWave) {
      const size = PIANO_HARMONICS.length;
      const real = new Float32Array(size);
      const imag = new Float32Array(size);
      for (let n = 1; n < size; n++) imag[n] = PIANO_HARMONICS[n];
      periodicWave = ctx.createPeriodicWave(real, imag);
    }
    return periodicWave;
  }

  /** 击槌噪声：一小段带衰减的白噪声，只有钢琴音色用 */
  function noiseBuffer() {
    if (!noise) {
      const length = Math.max(1, Math.floor(ctx.sampleRate * 0.05));
      noise = ctx.createBuffer(1, length, ctx.sampleRate);
      const data = noise.getChannelData(0);
      for (let i = 0; i < length; i++) {
        data[i] = (Math.random() * 2 - 1) * (1 - i / length);
      }
    }
    return noise;
  }

  function midiToFreq(midi) {
    const base = clamp(getBaseFreq(), MIN_FREQ, MAX_FREQ);
    return base * Math.pow(2, (midi - 69) / 12);
  }

  function cutoffRange(profile, freq) {
    return {
      from: clamp(freq * profile.cutoffFrom, profile.cutoffClampFrom[0], profile.cutoffClampFrom[1]),
      to: clamp(freq * profile.cutoffTo, profile.cutoffClampTo[0], profile.cutoffClampTo[1]),
    };
  }

  /* ---------------- 包络 ---------------- */

  function scheduleStop(voice, when) {
    voice.stopAt = when;
    try {
      // stop() 可以重复调用：未结束前最后一次调用生效
      voice.osc.stop(Math.max(when, 0));
    } catch {
      /* 已经结束的振荡器：忽略 */
    }
  }

  /** 自然衰减：两段指数 + 低通下滑 */
  function applyNaturalDecay(voice, now) {
    const profile = voice.profile;
    const param = voice.gain.gain;

    param.cancelScheduledValues(now);
    param.setValueAtTime(0.0001, now);
    param.linearRampToValueAtTime(profile.peak, now + profile.attack);
    param.setTargetAtTime(0.0001, now + profile.attack, profile.tau1);
    param.setTargetAtTime(0.0001, now + profile.attack + profile.stage2, profile.tau2);

    const range = cutoffRange(profile, voice.freq);
    const filterFreq = voice.filter.frequency;
    filterFreq.cancelScheduledValues(now);
    filterFreq.setValueAtTime(range.from, now);
    filterFreq.linearRampToValueAtTime(range.to, now + profile.sweep);

    scheduleStop(voice, now + profile.attack + profile.stage2 + profile.tau2 * DECAY_TAIL + 0.4);
  }

  /**
   * 制音器落下：快速放音，并把这个声部「锁定」。
   * 锁定后踏板不能再接管它——松手就已经从「正在弹奏」里清掉，
   * 停顿一下再踩踏板也不会冒出虚空音。
   */
  function damp(voice, now) {
    if (voice.ended) return;
    const param = voice.gain.gain;
    const value = currentGain(param);

    param.cancelScheduledValues(now);
    param.setValueAtTime(value, now);
    param.setTargetAtTime(0.0001, now, voice.profile.release);

    voice.releasing = true;
    voice.pedalSustained = false;
    voice.latched = true;
    scheduleStop(voice, now + voice.profile.release * 7 + 0.06);
  }

  /**
   * 踏板把音接过来保持：
   * 本来就在自然衰减的音只是把停止时间推远（缓速衰减，音量不变）。
   * 已经被制音器锁定的音直接忽略——不允许复活。
   */
  function holdForPedal(voice, now) {
    if (voice.ended || voice.latched) return;

    voice.releasing = false;
    voice.pedalSustained = true;
    scheduleStop(voice, now + PEDAL_HOLD);
  }

  /* ---------------- 演奏 ---------------- */

  function createVoice(midi, waveform, now) {
    const freq = midiToFreq(midi);
    const base = waveform === 'piano' ? PROFILES.piano : PROFILES.simple;
    const profile = pitchScaledProfile(base, freq);
    const range = cutoffRange(profile, freq);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = 0.5;
    filter.frequency.setValueAtTime(range.from, now);
    filter.frequency.linearRampToValueAtTime(range.to, now + profile.sweep);

    const gain = ctx.createGain();
    filter.connect(gain);
    gain.connect(master);

    const osc = ctx.createOscillator();
    if (waveform === 'piano') osc.setPeriodicWave(pianoWave());
    else osc.type = waveform;
    osc.frequency.value = freq;
    osc.connect(filter);

    if (profile.hammer > 0) {
      const hammer = ctx.createBufferSource();
      hammer.buffer = noiseBuffer();
      const hammerGain = ctx.createGain();
      hammerGain.gain.setValueAtTime(profile.hammer, now);
      hammerGain.gain.setTargetAtTime(0.0001, now, profile.hammerTau);
      hammer.connect(hammerGain);
      hammerGain.connect(filter);
      hammer.start(now);
      try {
        hammer.stop(now + profile.hammerTau * 6 + 0.03);
      } catch {
        /* 忽略 */
      }
    }

    const voice = {
      midi,
      freq,
      waveform,
      profile,
      osc,
      gain,
      filter,
      held: true,
      pedalSustained: false,
      releasing: false,
      latched: false,
      ended: false,
      stopAt: 0,
    };

    osc.onended = () => {
      voice.ended = true;
      if (voices.get(midi) === voice) voices.delete(midi);
      onVoicesChanged();
    };

    // 先 start 再排停止时间：部分实现对「未 start 就 stop」会抛错
    osc.start(now);
    applyNaturalDecay(voice, now);
    return voice;
  }

  function noteOn(midi) {
    const context = resume();
    if (!context) return;

    const now = context.currentTime;
    const existing = voices.get(midi);
    if (existing) {
      // 同音重击：旧声部快速收掉，避免叠加爆音
      existing.held = false;
      damp(existing, now);
    }

    voices.set(midi, createVoice(midi, getWaveform(), now));
    onVoicesChanged();
  }

  function noteOff(midi) {
    const voice = voices.get(midi);
    if (!voice || !ctx) return;

    voice.held = false;
    if (sustain) holdForPedal(voice, ctx.currentTime);
    else damp(voice, ctx.currentTime);
    onVoicesChanged();
  }

  /** 松开所有「实际按键」：踏板踩下时交给踏板保持 */
  function releaseAllHeld() {
    if (!ctx) return;
    const now = ctx.currentTime;
    for (const voice of voices.values()) {
      voice.held = false;
      if (sustain) holdForPedal(voice, now);
      else damp(voice, now);
    }
    onVoicesChanged();
  }

  /** 强制停掉一切声音（窗口失焦等安全场景） */
  function stopAll() {
    if (!ctx) return;
    const now = ctx.currentTime;
    for (const voice of voices.values()) {
      voice.held = false;
      damp(voice, now);
    }
    onVoicesChanged();
  }

  function setSustain(on) {
    const next = Boolean(on);
    if (next === sustain) return;
    sustain = next;
    if (!ctx) return;

    const now = ctx.currentTime;
    for (const voice of voices.values()) {
      if (next) {
        if (voice.held || voice.pedalSustained || voice.releasing) holdForPedal(voice, now);
      } else if (voice.pedalSustained) {
        // 抬踏板：被踏板保持的音立刻放掉；
        // 但键还按着的音属于「制音器被琴键顶起」，不能掐掉
        voice.pedalSustained = false;
        if (!voice.held) damp(voice, now);
      }
    }
    onVoicesChanged();
  }

  /**
   * 「正在弹奏」的音：实际按住的 + 踏板保持中的。
   * 被踏板保持的音即使已经衰减到极小也算在内，直到抬踏板才清除；
   * 一旦被制音器锁定（松键 / 抬踏板），立刻不再算，也不能被踏板复活。
   */
  function sounding() {
    const out = [];
    for (const [midi, voice] of voices) {
      if (voice.ended || voice.latched) continue;
      if (voice.held || voice.pedalSustained) out.push(midi);
    }
    return out.sort((a, b) => a - b);
  }

  function setVolume(value) {
    const next = clamp(value, 0, 1);
    if (!master || !ctx) return next;
    master.gain.setTargetAtTime(next, ctx.currentTime, 0.02);
    return next;
  }

  /** 切换波形：影响之后弹的音，正在响的基础波形声部一起改（piano 是复合音色，改写不了） */
  function setWaveform(waveform) {
    if (waveform === 'piano') return;
    for (const voice of voices.values()) {
      if (voice.ended || voice.waveform === 'piano') continue;
      try {
        voice.osc.type = waveform;
      } catch {
        /* 非法波形：保持原样 */
      }
    }
  }

  return {
    noteOn,
    noteOff,
    releaseAllHeld,
    stopAll,
    setSustain,
    isSustain: () => sustain,
    sounding,
    setVolume,
    setWaveform,
    resume,
    voiceCount: () => voices.size,
    get context() { return ctx; },
  };
}

Piano.Synth = { createSynth };

})(typeof window !== 'undefined' ? window : globalThis);
