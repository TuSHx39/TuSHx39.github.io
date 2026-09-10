/**
 * 集成自检：用极简 DOM / Web Audio 桩真正把 main.js 跑起来。
 *
 * 目的不是替代浏览器，而是挡住「语法没错、逻辑接错线」这类问题：
 * 键盘是否真的建出 88 键、踏板三种模式的状态机、演奏 → 发声 → 显示
 * 是否连贯、设置项是否真的生效。
 *
 * 运行：cd pages/piano && npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { loadPianoScripts } from './helpers/load-piano.mjs';

/* ------------------------------------------------------------------ *
 * DOM 桩
 * ------------------------------------------------------------------ */

const WHITE_WIDTH = 44;
const BLACK_WIDTH = 26;
const KEY_HEIGHT = 190;

function matchesSelector(element, selector) {
  const classes = selector.trim().split('.').filter(Boolean);
  return classes.every(name => element.classList.contains(name));
}

class FakeClassList {
  constructor() {
    this.set = new Set();
  }

  add(...names) {
    for (const name of names) if (name) this.set.add(name);
  }

  remove(...names) {
    for (const name of names) this.set.delete(name);
  }

  contains(name) {
    return this.set.has(name);
  }

  toggle(name, force) {
    const on = force === undefined ? !this.set.has(name) : Boolean(force);
    if (on) this.set.add(name);
    else this.set.delete(name);
    return on;
  }

  toString() {
    return [...this.set].join(' ');
  }
}

class FakeElement {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.classList = new FakeClassList();
    this.dataset = {};
    this.style = {};
    this.listeners = new Map();
    this.textContent = '';
    this.checked = false;
    this.value = '';
    this.isFragment = false;
    this.left = 0;
  }

  get className() {
    return this.classList.toString();
  }

  set className(value) {
    this.classList = new FakeClassList();
    this.classList.add(...String(value).split(/\s+/).filter(Boolean));
  }

  get offsetWidth() {
    if (this.classList.contains('white')) return WHITE_WIDTH;
    if (this.classList.contains('black')) return BLACK_WIDTH;
    return Number.parseFloat(this.style.width) || 0;
  }

  get offsetHeight() {
    if (this.classList.contains('white')) return KEY_HEIGHT;
    return Number.parseFloat(this.style.height) || 0;
  }

  get offsetLeft() {
    return this.left;
  }

  appendChild(node) {
    if (node && node.isFragment) {
      for (const child of [...node.children]) this.appendChild(child);
      node.children.length = 0;
      return node;
    }
    node.parentElement = this;
    if (this.id === 'piano' && node.classList.contains('white')) {
      const whites = this.children.filter(child => child.classList.contains('white')).length;
      node.left = whites * WHITE_WIDTH;
    }
    this.children.push(node);
    return node;
  }

  contains(node) {
    for (let current = node; current; current = current.parentElement) {
      if (current === this) return true;
    }
    return false;
  }

  closest(selector) {
    for (let current = this; current; current = current.parentElement) {
      if (matchesSelector(current, selector)) return current;
    }
    return null;
  }

  setPointerCapture() {}

  releasePointerCapture() {}

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(handler);
  }

  dispatchEvent(type, event = {}) {
    const payload = {
      type,
      target: this,
      currentTarget: this,
      preventDefault() {},
      stopPropagation() {},
      ...event,
    };
    for (const handler of this.listeners.get(type) || []) handler(payload);
    return payload;
  }
}

/* ------------------------------------------------------------------ *
 * Web Audio 桩
 * ------------------------------------------------------------------ */

class FakeAudioParam {
  constructor(value = 0) {
    this.value = value;
    this.history = [];
  }

  setValueAtTime(value) {
    this.history.push(['setValueAtTime', value]);
    this.value = value;
    return this;
  }

  linearRampToValueAtTime(value) {
    this.history.push(['linearRampToValueAtTime', value]);
    this.value = value;
    return this;
  }

  setTargetAtTime(value, start, tau) {
    this.history.push(['setTargetAtTime', value, tau]);
    this.value = value;
    return this;
  }

  cancelScheduledValues() {
    this.history.push(['cancelScheduledValues']);
    return this;
  }
}

class FakeNode {
  constructor() {
    this.outputs = [];
  }

  connect(node) {
    this.outputs.push(node);
    return node;
  }

  disconnect() {}
}

class FakeGain extends FakeNode {
  constructor() {
    super();
    this.gain = new FakeAudioParam(1);
  }
}

class FakeOscillator extends FakeNode {
  constructor() {
    super();
    this.type = 'sine';
    this.frequency = new FakeAudioParam(440);
    this.periodicWave = null;
    this.startedAt = null;
    this.stopped = false;
    this.stopTime = null;
    this.ended = false;
    this.onended = null;
  }

  setPeriodicWave(wave) {
    this.periodicWave = wave;
  }

  start(time = 0) {
    this.startedAt = time;
  }

  stop(time) {
    this.stopped = true;
    // 与真实实现一致：未结束前最后一次 stop() 生效
    if (!this.ended && Number.isFinite(time)) this.stopTime = time;
  }
}

class FakeBiquadFilter extends FakeNode {
  constructor() {
    super();
    this.type = 'lowpass';
    this.Q = new FakeAudioParam(0);
    this.frequency = new FakeAudioParam(350);
  }
}

class FakeBufferSource extends FakeNode {
  constructor() {
    super();
    this.buffer = null;
    this.started = false;
    this.stopped = false;
    this.onended = null;
  }

  start() {
    this.started = true;
  }

  stop() {
    this.stopped = true;
  }
}

class FakeAudioBuffer {
  constructor(channels, length, sampleRate) {
    this.numberOfChannels = channels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.duration = length / sampleRate;
    this.channel = new Float32Array(length);
  }

  getChannelData() {
    return this.channel;
  }
}

class FakeCompressor extends FakeNode {
  constructor() {
    super();
    for (const name of ['threshold', 'knee', 'ratio', 'attack', 'release']) {
      this[name] = new FakeAudioParam();
    }
  }
}

class FakeAudioContext {
  static instances = [];

  constructor() {
    this.currentTime = 1;
    this.state = 'running';
    this.destination = new FakeNode();
    this.oscillators = [];
    this.bufferSources = [];
    FakeAudioContext.instances.push(this);
  }

  createGain() {
    return new FakeGain();
  }

  createOscillator() {
    const oscillator = new FakeOscillator();
    this.oscillators.push(oscillator);
    return oscillator;
  }

  createBiquadFilter() {
    return new FakeBiquadFilter();
  }

  createBufferSource() {
    const source = new FakeBufferSource();
    this.bufferSources.push(source);
    return source;
  }

  createBuffer(channels, length, sampleRate) {
    return new FakeAudioBuffer(channels, length, sampleRate);
  }

  createPeriodicWave() {
    return { kind: 'periodic' };
  }

  createDynamicsCompressor() {
    return new FakeCompressor();
  }

  resume() {
    this.state = 'running';
    return Promise.resolve();
  }
}

/* ------------------------------------------------------------------ *
 * 环境搭建
 * ------------------------------------------------------------------ */

function createEnvironment() {
  const elements = new Map();
  const windowListeners = new Map();
  const documentListeners = new Map();
  let hitTarget = null;

  function track(element) {
    if (element.id) elements.set(element.id, element);
    return element;
  }

  const document = {
    readyState: 'complete',
    body: track(new FakeElement('body')),
    createElement(tagName) {
      return new FakeElement(tagName);
    },
    createDocumentFragment() {
      const fragment = new FakeElement('#fragment');
      fragment.isFragment = true;
      return fragment;
    },
    getElementById(id) {
      if (!elements.has(id)) track(Object.assign(new FakeElement('div'), { id }));
      return elements.get(id);
    },
    querySelector(selector) {
      if (selector === '.settings-pages' && !elements.has('__pages')) {
        const pages = new FakeElement('div');
        pages.className = 'settings-pages';
        elements.set('__pages', pages);
      }
      return elements.get('__pages') || null;
    },
    addEventListener(type, handler) {
      if (!documentListeners.has(type)) documentListeners.set(type, new Set());
      documentListeners.get(type).add(handler);
    },
    dispatchEvent(type, event = {}) {
      const payload = { type, target: document.body, preventDefault() {}, ...event };
      for (const handler of documentListeners.get(type) || []) handler(payload);
      return payload;
    },
    elementFromPoint() {
      return hitTarget;
    },
  };

  const memory = new Map();
  const window = {
    document,
    localStorage: {
      getItem: key => (memory.has(key) ? memory.get(key) : null),
      setItem: (key, value) => memory.set(key, String(value)),
      removeItem: key => memory.delete(key),
    },
    AudioContext: FakeAudioContext,
    addEventListener(type, handler) {
      if (!windowListeners.has(type)) windowListeners.set(type, new Set());
      windowListeners.get(type).add(handler);
    },
    removeEventListener(type, handler) {
      if (windowListeners.has(type)) windowListeners.get(type).delete(handler);
    },
    dispatchEvent(type, event = {}) {
      const payload = { type, preventDefault() {}, ...event };
      for (const handler of windowListeners.get(type) || []) handler(payload);
      return payload;
    },
  };

  return {
    document,
    window,
    memory,
    setHit(element) {
      hitTarget = element;
    },
    element: id => document.getElementById(id),
  };
}

const env = createEnvironment();

// 测试自己的辅助函数要用到 window / document（应用代码是从沙箱里取，
// 见下面的 loadPianoScripts 参数）
globalThis.window = env.window;
globalThis.document = env.document;

// 按浏览器的方式加载：传统脚本 + 全局命名空间，不依赖 ES Module
loadPianoScripts({
  window: env.window,
  document: env.document,
  requestAnimationFrame: callback => {
    callback(0);
    return 1;
  },
  setTimeout,
  clearTimeout,
  console,
});

const el = id => env.element(id);
const piano = el('piano');

/* ------------------------------------------------------------------ *
 * 快捷操作
 * ------------------------------------------------------------------ */

function keyElement(midi) {
  const found = piano.children.find(child => child.dataset.midi === String(midi));
  assert.ok(found, `键位上没有 MIDI ${midi} 的琴键`);
  return found;
}

function press(pointerId, midi) {
  env.setHit(keyElement(midi));
  piano.dispatchEvent('pointerdown', {
    pointerId,
    pointerType: 'mouse',
    button: 0,
    clientX: 0,
    clientY: 0,
  });
}

function release(pointerId) {
  piano.dispatchEvent('pointerup', { pointerId });
}

function releaseAll() {
  for (const id of [1, 2, 3, 4, 5, 6]) release(id);
}

function pressSpace() {
  document.dispatchEvent('keydown', { code: 'Space', key: ' ', repeat: false, target: document.body });
}

function releaseSpace() {
  document.dispatchEvent('keyup', { code: 'Space', key: ' ', target: document.body });
}

/** 模拟电脑键盘：code 用 KeyboardEvent.code（与物理位置对应） */
function computerKey(code, type, modifiers = {}) {
  let prevented = false;
  const payload = document.dispatchEvent(type, {
    code,
    key: code.replace(/^Key/, '').toLowerCase(),
    repeat: false,
    target: document.body,
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    preventDefault: () => { prevented = true; },
    ...modifiers,
  });
  return { ...payload, defaultPrevented: prevented };
}

function sustainVisible() {
  return document.body.classList.contains('sustain-on');
}

function chordText() {
  return el('current-chord').textContent;
}

/**
 * 推进假时钟：让所有「已经排好停止时间」的振荡器走到终点并触发 onended。
 * 真实浏览器里这一步由 Web Audio 自己完成（synth 靠 onended 回收声部），
 * 桩里必须手动模拟，否则上一个用例的声部会一直留在 sounding() 里。
 */
function advanceTime(seconds) {
  const context = FakeAudioContext.instances.at(-1);
  if (!context) return;
  context.currentTime += seconds;
  for (const oscillator of context.oscillators) {
    if (oscillator.ended) continue;
    if (oscillator.stopTime === null || oscillator.stopTime > context.currentTime) continue;
    oscillator.ended = true;
    if (typeof oscillator.onended === 'function') oscillator.onended();
  }
}

/** 每个用例开始前恢复到干净状态（等价于用户离开窗口后重新开始） */
function resetAll() {
  window.dispatchEvent('blur'); // 停掉所有声音并复位踏板
  releaseAll();
  advanceTime(600);             // 走完所有停止时间，回收全部声部

  el('invert-pedal-toggle').checked = false;
  el('invert-pedal-toggle').dispatchEvent('change');
  el('toggle-pedal-toggle').checked = false;
  el('toggle-pedal-toggle').dispatchEvent('change');
  el('inversion-toggle').checked = true;
  el('inversion-toggle').dispatchEvent('change');
}

/* ------------------------------------------------------------------ *
 * 测试
 * ------------------------------------------------------------------ */

test('键盘按 A0–C8 建成 88 键', () => {
  const whites = piano.children.filter(child => child.classList.contains('white'));
  const blacks = piano.children.filter(child => child.classList.contains('black'));

  assert.equal(whites.length, 52, '白键数量');
  assert.equal(blacks.length, 36, '黑键数量');
  assert.equal(whites[0].dataset.midi, '21', '第一个键应为 A0');
  assert.equal(whites.at(-1).dataset.midi, '108', '最后一个键应为 C8');
  assert.equal(whites[0].dataset.note, 'A0');
});

test('黑键按白键实测像素定位，且中心落在相邻白键的分界线上', () => {
  for (const black of piano.children.filter(child => child.classList.contains('black'))) {
    const left = Number.parseFloat(black.style.left);
    const width = Number.parseFloat(black.style.width);
    const height = Number.parseFloat(black.style.height);
    assert.ok(Number.isFinite(left) && left >= 0, `黑键 left 异常：${black.style.left}`);
    assert.equal(width, BLACK_WIDTH);
    assert.equal(height, Math.round(KEY_HEIGHT * 0.62));
  }

  // C#4 应跨在 C4 与 D4 之间：中心正好在分界线上（不再偏左半格）
  const c4 = keyElement(60);
  const d4 = keyElement(62);
  const cSharp4 = keyElement(61);
  const boundary = c4.offsetLeft + c4.offsetWidth;
  assert.equal(d4.offsetLeft, boundary, 'D4 应紧接在 C4 右侧');

  const left = Number.parseFloat(cSharp4.style.left);
  const width = Number.parseFloat(cSharp4.style.width);
  const center = left + width / 2;
  assert.ok(
    Math.abs(center - boundary) <= 1,
    `黑键中心应落在白键分界线上：中心 ${center}，分界线 ${boundary}`,
  );
});

test('按下三和弦：发声、音名与和弦读数同步', () => {
  resetAll();
  press(1, 60);
  press(2, 64);
  press(3, 67);

  const context = FakeAudioContext.instances.at(-1);
  assert.equal(context.oscillators.length, 3, '应创建三个振荡器');
  assert.equal(el('current-note').textContent, '当前音: C4 , E4 , G4');
  assert.equal(chordText(), '当前和弦：C');
  assert.ok(el('current-chord-alt').classList.contains('is-hidden'), '只有一个读法时不显示候选');

  releaseAll();
  assert.equal(chordText(), '当前和弦：-');
  assert.equal(el('current-note').textContent, '当前音: -');
});

test('同一组音给出多个读法时显示候选', () => {
  resetAll();
  press(1, 60);
  press(2, 64);
  press(3, 67);
  press(4, 69);

  assert.equal(chordText(), '当前和弦：C6');
  assert.ok(!el('current-chord-alt').classList.contains('is-hidden'));
  assert.match(el('current-chord-alt').textContent, /Am7\/C/);

  releaseAll();
});

test('踏板：按住空格延音，松开停音', () => {
  resetAll();
  press(1, 60);
  press(2, 64);
  press(3, 67);

  pressSpace();
  assert.ok(sustainVisible(), '踩下踏板后应进入延音状态');

  releaseAll();
  // 松键但踏板仍踩着：声音与读数都保留
  assert.equal(chordText(), '当前和弦：C', '延音期间和弦读数不应消失');

  releaseSpace();
  assert.ok(!sustainVisible(), '松开踏板后延音结束');
  assert.equal(chordText(), '当前和弦：-', '抬起踏板后延音音符立即停止');
});

test('踏板切换模式：踩一次保持，再踩一次放开', () => {
  resetAll();
  el('toggle-pedal-toggle').checked = true;
  el('toggle-pedal-toggle').dispatchEvent('change');

  pressSpace();
  releaseSpace();
  assert.ok(sustainVisible(), '切换模式下松开踏板应保持延音');

  pressSpace(); // 再踩一次：翻转回关闭
  assert.ok(!sustainVisible(), '再次踩下应关闭延音');

  el('toggle-pedal-toggle').checked = false;
  el('toggle-pedal-toggle').dispatchEvent('change');
  resetAll();
});

test('踏板反转模式：不踩即延音，踩下反而放音', () => {
  resetAll();
  el('invert-pedal-toggle').checked = true;
  el('invert-pedal-toggle').dispatchEvent('change');
  assert.ok(sustainVisible(), '反转模式下未踩踏板应处于延音状态');

  pressSpace();
  assert.ok(!sustainVisible(), '反转模式下踩下踏板应放音');

  releaseSpace();
  assert.ok(sustainVisible(), '松开后又回到延音');

  el('invert-pedal-toggle').checked = false;
  el('invert-pedal-toggle').dispatchEvent('change');
  resetAll();
});

test('点击底栏同样能踩踏板', () => {
  resetAll();
  el('pedal').dispatchEvent('pointerdown', { pointerId: 9 });
  assert.ok(sustainVisible());

  window.dispatchEvent('pointerup', { pointerId: 9 });
  assert.ok(!sustainVisible());
});

test('低音 + 上层三和弦只按八度内解读（没有复合和弦模式了）', () => {
  resetAll();
  // D3 + C4-E4-G4
  press(1, 50);
  press(2, 60);
  press(3, 64);
  press(4, 67);

  // 最低音 D 本身就是和弦音，优先按 D 当根音读作 D9sus4；
  // 把 C 当根音的读法（Cadd9/D）留在候选里 —— 不会再出现 C/D 这种复合读法。
  assert.equal(chordText(), '当前和弦：D9sus4');
  assert.match(el('current-chord-alt').textContent, /Cadd9\/D/);
  assert.ok(!/C\/D/.test(el('current-chord-alt').textContent), '不应再有复合读法');

  releaseAll();
});

test('转位开关：关闭后只认原位', () => {
  resetAll();
  press(1, 64);
  press(2, 67);
  press(3, 72);
  assert.equal(chordText(), '当前和弦：C/E');

  el('inversion-toggle').checked = false;
  el('inversion-toggle').dispatchEvent('change');
  assert.equal(chordText(), '当前和弦：-');

  el('inversion-toggle').checked = true;
  el('inversion-toggle').dispatchEvent('change');
  assert.equal(chordText(), '当前和弦：C/E');

  releaseAll();
});

test('显示音名开关同时控制读数与琴键音名', () => {
  resetAll();
  el('note-name-toggle').checked = false;
  el('note-name-toggle').dispatchEvent('change');
  assert.ok(el('current-note').classList.contains('is-hidden'));
  assert.ok(piano.classList.contains('hide-note-label'));

  el('note-name-toggle').checked = true;
  el('note-name-toggle').dispatchEvent('change');
  assert.ok(!el('current-note').classList.contains('is-hidden'));
  assert.ok(!piano.classList.contains('hide-note-label'));
});

test('识别和弦开关会收起次级设置（只剩转位开关）', () => {
  resetAll();
  el('chord-toggle').checked = false;
  el('chord-toggle').dispatchEvent('change');
  assert.ok(el('current-chord').classList.contains('is-hidden'));
  assert.ok(!el('inversion-setting').classList.contains('show'));

  el('chord-toggle').checked = true;
  el('chord-toggle').dispatchEvent('change');
  assert.ok(el('inversion-setting').classList.contains('show'));
});

test('显示踏板开关会把底栏与读数一起收起', () => {
  resetAll();
  el('pedal-toggle').checked = false;
  el('pedal-toggle').dispatchEvent('change');
  assert.ok(document.body.classList.contains('pedal-hidden'));

  el('pedal-toggle').checked = true;
  el('pedal-toggle').dispatchEvent('change');
  assert.ok(!document.body.classList.contains('pedal-hidden'));
});

test('拖动连奏：指针划过的键依次发声，前一个音松开', () => {
  resetAll();
  press(1, 60);
  assert.equal(el('current-note').textContent, '当前音: C4');

  env.setHit(keyElement(62));
  piano.dispatchEvent('pointermove', { pointerId: 1 });
  assert.equal(el('current-note').textContent, '当前音: D4', '划过后应切换到新音');

  env.setHit(keyElement(64));
  piano.dispatchEvent('pointermove', { pointerId: 1 });
  assert.equal(el('current-note').textContent, '当前音: E4');

  assert.ok(!keyElement(60).classList.contains('is-down'), '离开的琴键应取消按下状态');
  assert.ok(keyElement(64).classList.contains('is-down'));

  release(1);
  assert.equal(el('current-note').textContent, '当前音: -');
});

test('窗口失焦会停掉所有声音并复位踏板', () => {
  resetAll();
  press(1, 60);
  pressSpace();
  assert.ok(sustainVisible());

  window.dispatchEvent('blur');
  assert.ok(!sustainVisible(), '失焦后延音状态应复位');
  assert.equal(el('current-note').textContent, '当前音: -');
  assert.ok(!keyElement(60).classList.contains('is-down'));
});

test('设置会写入 localStorage，并能被重新读出', async () => {
  resetAll();
  el('volume-slider').value = '0.25';
  el('volume-slider').dispatchEvent('input');
  el('waveform-select').value = 'square';
  el('waveform-select').dispatchEvent('change');
  el('inversion-toggle').checked = false;
  el('inversion-toggle').dispatchEvent('change');

  await new Promise(resolve => setTimeout(resolve, 260)); // 持久化有 200ms 去抖

  const raw = env.memory.get('tushx39.piano.settings.v2');
  assert.ok(raw, 'localStorage 里应有设置');
  const saved = JSON.parse(raw);
  assert.equal(saved.volume, 0.25);
  assert.equal(saved.waveform, 'square');
  assert.equal(saved.allowInversion, false);
  assert.equal(saved.chordMode, undefined, '和弦模式已删除，不应再写入');
});

/* ------------------------------------------------------------------ *
 * 新增行为：单音不算和弦、踏板衰减模型、升降号、键盘映射
 * ------------------------------------------------------------------ */

test('单音（含同音八度）不显示和弦', () => {
  resetAll();
  press(1, 60);
  assert.equal(el('current-note').textContent, '当前音: C4');
  assert.equal(chordText(), '当前和弦：-', '单音不应给出和弦读法');

  // 再叠一个同音八度，仍然只有一个音级 → 依然不算和弦
  press(2, 72);
  assert.equal(el('current-note').textContent, '当前音: C4 , C5');
  assert.equal(chordText(), '当前和弦：-');

  releaseAll();
});

test('piano 波形用 PeriodicWave + 击槌噪声合成', () => {
  resetAll();
  el('waveform-select').value = 'piano';
  el('waveform-select').dispatchEvent('change');

  const context = FakeAudioContext.instances.at(-1);
  const hammersBefore = context.bufferSources.length;
  press(1, 60);

  const oscillator = context.oscillators.at(-1);
  assert.ok(oscillator.periodicWave, 'piano 波形应使用自建谐波频谱');
  assert.equal(context.bufferSources.length, hammersBefore + 1, '每个音应有一次击槌噪声');
  assert.ok(context.bufferSources.at(-1).started);

  releaseAll();
});

test('松手即清空，之后踩踏板不会产生虚空音', () => {
  resetAll();
  press(1, 60);
  const context = FakeAudioContext.instances.at(-1);
  // 声部链路：osc -> filter -> gain，取声部增益这个 AudioParam
  const osc = context.oscillators.at(-1);
  const voiceParam = osc.outputs[0].outputs[0].gain;
  assert.ok(voiceParam && voiceParam.history, '能定位到声部增益');

  // 松开琴键：未踩踏板 → 制音器快速放音（时间常数很小），并且这个音立刻不再算正在弹奏
  release(1);
  const releaseOps = voiceParam.history.filter(op => op[0] === 'setTargetAtTime');
  const lastRelease = releaseOps.at(-1);
  assert.ok(lastRelease[2] < 0.2, `未踩踏板应快速放音，实际 τ=${lastRelease[2]}`);
  assert.equal(el('current-note').textContent, '当前音: -', '松手即清空缓存');

  // 停顿一下（此时仍在快速放音的余音里）再踩踏板：不能复活这个音，也不能插手它的包络
  const mark = voiceParam.history.length;
  pressSpace();
  assert.equal(el('current-note').textContent, '当前音: -', '已被制音的音不允许被踏板复活');
  assert.equal(voiceParam.history.length, mark, '踏板不应再改动这个音');

  releaseSpace();
});

test('踩踏板时松开的音才由踏板保持（缓速衰减）', () => {
  resetAll();
  pressSpace();          // 先踩踏板
  press(1, 60);
  const context = FakeAudioContext.instances.at(-1);
  const osc = context.oscillators.at(-1);
  const voiceParam = osc.outputs[0].outputs[0].gain;

  release(1);            // 松键 → 交给踏板保持
  assert.match(el('current-note').textContent, /C4/);

  // 踏板保持期间停止时间被推远（缓速衰减而不是快速放音）
  assert.ok(osc.stopTime - context.currentTime > 100, '踏板保持中不应排快速停止');
  const releaseOps = voiceParam.history.filter(op => op[0] === 'setTargetAtTime');
  assert.ok(
    releaseOps.every(op => op[2] > 0.2),
    '未被制音的音不应出现快速放音',
  );

  releaseSpace();
  assert.equal(el('current-note').textContent, '当前音: -');
});

test('放音完成的音不会被再次踩下的踏板复活', () => {
  resetAll();
  press(1, 60);
  release(1);
  advanceTime(2);   // 走完快速放音 → 声部结束、被清除

  pressSpace();
  assert.equal(el('current-note').textContent, '当前音: -', '已经清掉的音不应因踩踏板重新出现');
  releaseSpace();
});

test('踏板踩下时松开的音：一直算正在弹奏，抬踏板才清除', () => {
  resetAll();
  pressSpace();          // 先踩踏板
  press(1, 60);
  press(2, 64);
  press(3, 67);
  releaseAll();          // 松键，但踏板还踩着

  assert.equal(chordText(), '当前和弦：C', '踏板保持期间和弦读数应保留');
  advanceTime(30);       // 即使已经衰减到极小
  assert.equal(chordText(), '当前和弦：C', '衰减到极小也算正在弹奏，直到抬踏板');

  releaseSpace();
  assert.equal(el('current-note').textContent, '当前音: -');
});

test('抬踏板不会掐掉仍然按住的琴键', () => {
  resetAll();
  pressSpace();
  press(1, 60);          // 踏板踩着的同时按住琴键

  const context = FakeAudioContext.instances.at(-1);
  const voiceOsc = context.oscillators.at(-1);
  const voiceGain = voiceOsc.outputs[0].outputs[0].gain;
  const mark = voiceGain.history.length;

  releaseSpace();        // 松开踏板：被踏板保持的音要放掉，但按住的键不能放

  assert.match(el('current-note').textContent, /C4/, '琴键还按着，应继续发声');
  assert.equal(voiceGain.history.length, mark, '按住的音不应因抬踏板而被改动（更不该被制音）');
  assert.ok(
    voiceOsc.stopTime - context.currentTime > 5,
    '按住的琴键仍应保留自然衰减的停止时间',
  );

  release(1);
  assert.equal(el('current-note').textContent, '当前音: -');
});

test('升降号：单音默认升号，和弦按音程关系，键盘映射按键优先', () => {
  resetAll();
  // 鼠标点一个黑键：默认升号
  press(1, 63);
  assert.equal(el('current-note').textContent, '当前音: D#4');
  releaseAll();

  // C 小三和弦：按音程关系应写成 Eb
  press(1, 60);
  press(2, 63);
  press(3, 67);
  assert.equal(el('current-note').textContent, '当前音: C4 , Eb4 , G4');
  assert.equal(chordText(), '当前和弦：Cm');
  releaseAll();

  // C# 小三和弦：C#m 习惯用升号
  press(1, 61);
  press(2, 64);
  press(3, 68);
  assert.equal(el('current-note').textContent, '当前音: C#4 , E4 , G#4');
  assert.equal(chordText(), '当前和弦：C#m');
  releaseAll();
});

test('电脑键盘映射：从数字排开始读，E 落在 C3', () => {
  resetAll();

  // 第一行是数字排，从 C1 起
  computerKey('Digit1', 'keydown');
  assert.equal(el('current-note').textContent, '当前音: C1');
  computerKey('Digit1', 'keyup');
  assert.equal(el('current-note').textContent, '当前音: -');

  // 一行读完换下一行，音继续升高：Q=A2、W=B2、E=C3（锚点）
  computerKey('KeyQ', 'keydown');
  assert.equal(el('current-note').textContent, '当前音: A2');
  computerKey('KeyQ', 'keyup');

  computerKey('KeyW', 'keydown');
  assert.equal(el('current-note').textContent, '当前音: B2');
  computerKey('KeyW', 'keyup');

  computerKey('KeyE', 'keydown');
  assert.equal(el('current-note').textContent, '当前音: C3', '键盘上的 E 必须是 C3');
  computerKey('KeyE', 'keyup');

  // 中排继续往右：P=C4、[=D4；下排 Z=C6（再往下换行又升高）
  computerKey('KeyP', 'keydown');
  assert.equal(el('current-note').textContent, '当前音: C4');
  computerKey('KeyP', 'keyup');

  computerKey('KeyZ', 'keydown');
  assert.equal(el('current-note').textContent, '当前音: C6');
  computerKey('KeyZ', 'keyup');

  // 黑键：Shift + 左侧白键（升号），Alt + 右侧白键（降号），同一个音
  computerKey('KeyE', 'keydown', { shiftKey: true });
  assert.equal(el('current-note').textContent, '当前音: C#3');
  computerKey('KeyE', 'keyup', { shiftKey: true });

  computerKey('KeyR', 'keydown', { altKey: true });
  assert.equal(el('current-note').textContent, '当前音: Db3');
  computerKey('KeyR', 'keyup', { altKey: true });

  // 电脑键盘也能按出和弦，并且和弦读法正常（E=C3、T=E3、U=G3）
  computerKey('KeyE', 'keydown');
  computerKey('KeyT', 'keydown');
  computerKey('KeyU', 'keydown');
  assert.equal(chordText(), '当前和弦：C');
  computerKey('KeyE', 'keyup');
  computerKey('KeyT', 'keyup');
  computerKey('KeyU', 'keyup');
  assert.equal(el('current-note').textContent, '当前音: -');
});

test('降号用 Alt，并屏蔽 Alt 的原生快捷键', () => {
  resetAll();

  // Alt + 右侧白键 → 降号写法
  computerKey('KeyR', 'keydown', { altKey: true });
  assert.equal(el('current-note').textContent, '当前音: Db3');
  computerKey('KeyR', 'keyup', { altKey: true });
  assert.equal(el('current-note').textContent, '当前音: -');

  // Alt 组合的原生行为被拦下（keydown 上 preventDefault）
  const withAlt = computerKey('KeyR', 'keydown', { altKey: true });
  assert.equal(withAlt.defaultPrevented, true, 'Alt+键 应被 preventDefault');
  computerKey('KeyR', 'keyup', { altKey: true });

  // 单独按 Alt 也不该去聚焦浏览器菜单栏
  const bareAlt = computerKey('AltLeft', 'keydown', { altKey: true });
  assert.equal(bareAlt.defaultPrevented, true, '单独按 Alt 应被 preventDefault');
  computerKey('AltLeft', 'keyup', { altKey: true });

  // Ctrl / Cmd 组合不再接管，免得跟浏览器快捷键打架
  computerKey('KeyR', 'keydown', { ctrlKey: true });
  assert.equal(el('current-note').textContent, '当前音: -', 'Ctrl 组合不应弹出音符');
  computerKey('KeyR', 'keyup', { ctrlKey: true });

  computerKey('KeyR', 'keydown', { metaKey: true });
  assert.equal(el('current-note').textContent, '当前音: -', 'Cmd 组合也不接管');
  computerKey('KeyR', 'keyup', { metaKey: true });
});

test('每个键都有音名标注，映射标注一个不漏', () => {
  resetAll();
  const noteLabelOf = key => {
    const found = key.children.find(child => child.classList.contains('note-label'));
    return found ? found.textContent : null;
  };
  const hintOf = key => {
    const found = key.children.find(child => child.classList.contains('key-hint'));
    return found ? found.children.map(item => item.textContent) : null;
  };

  // 音名标注：白键、黑键都要有（不再只有 C）
  assert.equal(noteLabelOf(keyElement(60)), 'C4');
  assert.equal(noteLabelOf(keyElement(62)), 'D4');
  assert.equal(noteLabelOf(keyElement(61)), 'C#4');
  assert.equal(noteLabelOf(keyElement(21)), 'A0');

  // 映射标注：数字排 → QWERTY → ASDF → ZXCV，连续分配
  assert.deepEqual(hintOf(keyElement(24)), ['1'], 'C1 = 1');
  assert.deepEqual(hintOf(keyElement(31)), ['5'], 'G1 = 5');
  assert.deepEqual(hintOf(keyElement(40)), ['0'], 'E2 = 0（数字排走完）');
  assert.deepEqual(hintOf(keyElement(43)), ['='], 'G2 = =');
  assert.deepEqual(hintOf(keyElement(45)), ['Q'], 'A2 = Q（换到下一行）');
  assert.deepEqual(hintOf(keyElement(48)), ['E'], 'C3 = E');
  assert.deepEqual(hintOf(keyElement(60)), ['P'], 'C4 = P');
  assert.deepEqual(hintOf(keyElement(84)), ['Z'], 'C6 = Z');
  assert.deepEqual(hintOf(keyElement(100)), ['/'], 'E7 = /');

  // 没有右侧黑键的白键（E、B）以前会被漏掉，现在同样有标注
  assert.deepEqual(hintOf(keyElement(52)), ['T'], 'E3 = T（右侧没有黑键）');
  assert.deepEqual(hintOf(keyElement(59)), ['O'], 'B3 = O（右侧没有黑键）');

  // 黑键：升 / 降两种按法都标出来
  assert.deepEqual(hintOf(keyElement(61)), ['⇧P', '⌥['], 'C#4 = Shift+P 或 Alt+[');
  assert.deepEqual(hintOf(keyElement(49)), ['⇧E', '⌥R'], 'C#3 = Shift+E 或 Alt+R');

  // 超出映射范围的琴键：只有音名，没有映射标注
  assert.equal(hintOf(keyElement(21)), null, 'A0 不在映射范围内');
  assert.equal(hintOf(keyElement(108)), null, 'C8 不在映射范围内');

  // 开关
  assert.ok(!piano.classList.contains('hide-key-hints'), '默认应显示键位');
  el('key-hint-toggle').checked = false;
  el('key-hint-toggle').dispatchEvent('change');
  assert.ok(piano.classList.contains('hide-key-hints'));

  el('key-hint-toggle').checked = true;
  el('key-hint-toggle').dispatchEvent('change');
  assert.ok(!piano.classList.contains('hide-key-hints'));
});
