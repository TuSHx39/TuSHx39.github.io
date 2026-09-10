/**
 * main.js —— 虚拟钢琴主控
 *
 * 只做「粘合」：读写设置、踏板状态机、演奏与显示联动、初始化。
 * 具体职责分别落在 chords.js（乐理）、synth.js（发声）、keyboard.js（琴键）、
 * panel.js（设置面板）、store.js（持久化）。
 *
 * 传统脚本（非 ES Module）：可以直接双击 piano.html 打开（file:// 下浏览器
 * 禁止加载 module 脚本）。各模块通过全局 Piano 命名空间协作，
 * piano.html 里按 chords → synth → keyboard → panel → store → main 的顺序引入。
 */

(function (global) {
  'use strict';

  const Piano = global.Piano = global.Piano || {};
  const { analyzeChord, noteName } = Piano.Chords || {};

const FIRST_MIDI = 21;  // A0
const LAST_MIDI = 108;  // C8
const MAX_ALTERNATIVES = 4;
const WAVEFORMS = ['piano', 'triangle', 'sine', 'square', 'sawtooth'];
const loadSettings = (Piano.Store && Piano.Store.loadSettings) || (() => ({}));

const DEFAULTS = {
  volume: 0.5,
  baseFreq: 440,
  waveform: 'piano',
  showNoteName: true,
  showKeyHints: true,
  showStaff: true,
  showChord: true,
  allowInversion: true,
  showPedal: true,
  invertPedal: false,
  togglePedal: false,
};

const state = { ...DEFAULTS, ...loadSettings() };

/** DOM 引用：等到 init() 时再取，避免脚本位置影响初始化 */
const el = {};

function collectElements() {
  el.body = document.body;
  el.piano = document.getElementById('piano');
  el.pianoWrapper = document.getElementById('piano-wrapper');
  el.pedal = document.getElementById('pedal');
  el.noteEl = document.getElementById('current-note');
  el.chordEl = document.getElementById('current-chord');
  el.chordSide = document.getElementById('chord-side');
  el.chordAltEl = document.getElementById('current-chord-alt');
  el.settingsBtn = document.getElementById('settings-btn');
  el.settingsPanel = document.getElementById('settings-panel');
  el.pages = document.querySelector('.settings-pages');
  el.volumeSlider = document.getElementById('volume-slider');
  el.baseFreqInput = document.getElementById('base-freq-input');
  el.waveformSelect = document.getElementById('waveform-select');
  el.noteNameToggle = document.getElementById('note-name-toggle');
  el.keyHintToggle = document.getElementById('key-hint-toggle');
  el.staffToggle = document.getElementById('staff-toggle');
  el.scoreSheet = document.getElementById('score-sheet');
  el.chordToggle = document.getElementById('chord-toggle');
  el.inversionToggle = document.getElementById('inversion-toggle');
  el.inversionSetting = document.getElementById('inversion-setting');
  el.pedalToggle = document.getElementById('pedal-toggle');
  el.invertPedalToggle = document.getElementById('invert-pedal-toggle');
  el.togglePedalToggle = document.getElementById('toggle-pedal-toggle');
}

/* ------------------------------------------------------------------ *
 * 状态：踏板
 * ------------------------------------------------------------------ */

let sustainOn = false;      // 延音当前是否生效
let pedalPressed = false;   // 踏板是否被实际踩下（空格 / 点击底栏）
let pedalPointerId = null;  // 用指针踩踏板时记录的 pointerId
let spacePressed = false;

function setSustain(on) {
  const next = Boolean(on);
  if (next === sustainOn) return;
  sustainOn = next;
  el.body.classList.toggle('sustain-on', next);
  synth.setSustain(next);
  // 抬踏板：五线谱先留着，下一次演奏时才清空
  if (!next && staff) staff.pedalReleased();
  scheduleRefresh();
}

/** 依据「踏板是否踩下 + 反转开关」推出延音状态；切换（toggle）模式由踩下动作翻转 */
function applyPedalState() {
  if (state.togglePedal) return;
  setSustain(state.invertPedal ? !pedalPressed : pedalPressed);
}

function handlePedalDown() {
  if (pedalPressed) return;
  pedalPressed = true;
  if (state.togglePedal) {
    setSustain(!sustainOn);
    return;
  }
  applyPedalState();
}

function handlePedalUp() {
  if (!pedalPressed) return;
  pedalPressed = false;
  if (state.togglePedal) return; // 切换模式：松开不改变状态
  applyPedalState();
}

/* ------------------------------------------------------------------ *
 * 状态：演奏与显示
 * ------------------------------------------------------------------ */

let synth = null;
let keyboard = null;
let panel = null;
let staff = null;

/** 实际按着（琴键 / 电脑键盘）的音：五线谱用它判断「同一个和弦」 */
const heldKeys = new Set();

/** 弹一个音：发声 + 记谱 */
function playNote(midi) {
  synth.resume();
  synth.noteOn(midi);
  heldKeys.add(midi);
  if (staff) staff.pushNote(midi, { spelling: spellingHints.get(midi) });
  scheduleRefresh();
}

/** 松开一个音 */
function endNote(midi) {
  synth.noteOff(midi);
  heldKeys.delete(midi);
  scheduleRefresh();
}

/** 创建各模块实例；缺少任何脚本时给出可读的提示（而不是一行 TypeError） */
function setup() {
  for (const name of ['Chords', 'Synth', 'Keyboard', 'Panel', 'Store', 'Staff']) {
    if (!Piano[name]) {
      throw new Error(`piano: 缺少 js/${name.toLowerCase()}.js，请检查 piano.html 里的脚本引用顺序`);
    }
  }

  synth = Piano.Synth.createSynth({
    getVolume: () => state.volume,
    getWaveform: () => state.waveform,
    getBaseFreq: () => state.baseFreq,
    onVoicesChanged: () => scheduleRefresh(),
  });

  staff = Piano.Staff.createStaff({
    container: el.scoreSheet,
    isHeld: midi => heldKeys.has(midi),
    isSustain: () => sustainOn,
  });

  keyboard = Piano.Keyboard.createKeyboard({
    container: el.piano,
    wrapper: el.pianoWrapper,
    firstMidi: FIRST_MIDI,
    lastMidi: LAST_MIDI,
    onNoteOn: midi => playNote(midi),
    onNoteOff: midi => endNote(midi),
    onPointerUp: () => {
      synth.releaseAllHeld();
      heldKeys.clear();
      scheduleRefresh();
    },
    onInteract: () => synth.resume(),
  });

  panel = Piano.Panel.createPanel({
    trigger: el.settingsBtn,
    panel: el.settingsPanel,
    pages: el.pages,
  });
}

let refreshQueued = false;

function scheduleRefresh() {
  if (refreshQueued) return;
  refreshQueued = true;
  requestAnimationFrame(() => {
    refreshQueued = false;
    refreshDisplay();
  });
}

function refreshDisplay() {
  const notes = synth.sounding();

  const analysis = state.showChord
    ? analyzeChord(notes, {
      allowInversion: state.allowInversion,
      maxCandidates: MAX_ALTERNATIVES + 1,
      spellingHints: spellingHintsByPc(),
    })
    : null;

  if (state.showNoteName) {
    // 单音默认升号；成和弦时按和弦的音程关系定升降；
    // 用键盘映射按下的音优先用它自己那套升降号（Shift = 升，Alt = 降）
    const chordSpelling = analysis && analysis.primary ? analysis.primary.spelling : 'sharp';
    el.noteEl.textContent = notes.length
      ? `当前音: ${notes
        .map(midi => noteName(midi, spellingHints.get(midi) || chordSpelling))
        .join(' , ')}`
      : '当前音: -';
  }

  if (!state.showChord) return;

  if (!analysis || !analysis.primary) {
    // 没有和弦：不显示 "-"，整块留空
    el.chordEl.textContent = '';
    el.chordSide.classList.add('is-empty');
    el.chordAltEl.textContent = '';
    el.chordAltEl.classList.add('is-hidden');
    return;
  }

  el.chordEl.textContent = analysis.primary.symbol;
  el.chordSide.classList.remove('is-empty');

  const alternatives = analysis.candidates
    .slice(1, 1 + MAX_ALTERNATIVES)
    .map(candidate => candidate.symbol);

  if (alternatives.length) {
    el.chordAltEl.textContent = `候选：${alternatives.join(' · ')}`;
    el.chordAltEl.classList.remove('is-hidden');
  } else {
    el.chordAltEl.textContent = '';
    el.chordAltEl.classList.add('is-hidden');
  }
}

/* ------------------------------------------------------------------ *
 * 设置：读 / 写 / 应用
 * ------------------------------------------------------------------ */

let saveTimer = null;

function persist() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    Piano.Store.saveSettings(state);
  }, 200);
}

/** 把 state 写回控件（初始化或外部改动时） */
function applySettingsToControls() {
  el.volumeSlider.value = String(state.volume);
  el.baseFreqInput.value = String(state.baseFreq);
  if (WAVEFORMS.includes(state.waveform)) el.waveformSelect.value = state.waveform;
  el.noteNameToggle.checked = Boolean(state.showNoteName);
  el.keyHintToggle.checked = Boolean(state.showKeyHints);
  el.staffToggle.checked = Boolean(state.showStaff);
  el.chordToggle.checked = Boolean(state.showChord);
  el.inversionToggle.checked = Boolean(state.allowInversion);
  el.pedalToggle.checked = Boolean(state.showPedal);
  el.invertPedalToggle.checked = Boolean(state.invertPedal);
  el.togglePedalToggle.checked = Boolean(state.togglePedal);
}

/** 把 state 反映到「非表单」的界面状态 */
function applyUiState() {
  el.body.classList.toggle('pedal-hidden', !state.showPedal);
  el.noteEl.classList.toggle('is-hidden', !state.showNoteName);
  el.chordSide.classList.toggle('is-hidden', !state.showChord);
  if (!state.showChord) el.chordAltEl.classList.add('is-hidden');
  keyboard.setLabelsVisible(state.showNoteName);
  keyboard.setHintsVisible(state.showKeyHints);
  if (staff) staff.setVisible(state.showStaff);

  const showChordSub = Boolean(state.showChord);
  el.inversionSetting.classList.toggle('show', showChordSub);
}

function clampVolume(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function bindControls() {
  el.volumeSlider.addEventListener('input', () => {
    state.volume = clampVolume(parseFloat(el.volumeSlider.value));
    synth.setVolume(state.volume);
    persist();
  });

  el.baseFreqInput.addEventListener('input', () => {
    const value = parseFloat(el.baseFreqInput.value);
    if (Number.isFinite(value) && value > 0) {
      state.baseFreq = value;
      persist();
    }
  });
  el.baseFreqInput.addEventListener('blur', () => {
    el.baseFreqInput.value = String(state.baseFreq);
  });

  el.waveformSelect.addEventListener('change', () => {
    const value = el.waveformSelect.value;
    if (!WAVEFORMS.includes(value)) return;
    state.waveform = value;
    synth.setWaveform(value);
    persist();
  });

  el.noteNameToggle.addEventListener('change', () => {
    state.showNoteName = el.noteNameToggle.checked;
    applyUiState();
    refreshDisplay();
    persist();
  });

  el.keyHintToggle.addEventListener('change', () => {
    state.showKeyHints = el.keyHintToggle.checked;
    applyUiState();
    persist();
  });

  el.staffToggle.addEventListener('change', () => {
    state.showStaff = el.staffToggle.checked;
    applyUiState();
    persist();
  });

  el.chordToggle.addEventListener('change', () => {
    state.showChord = el.chordToggle.checked;
    applyUiState();
    refreshDisplay();
    persist();
  });

  el.inversionToggle.addEventListener('change', () => {
    state.allowInversion = el.inversionToggle.checked;
    refreshDisplay();
    persist();
  });

  el.pedalToggle.addEventListener('change', () => {
    state.showPedal = el.pedalToggle.checked;
    applyUiState();
    persist();
  });

  el.invertPedalToggle.addEventListener('change', () => {
    state.invertPedal = el.invertPedalToggle.checked;
    applyPedalState();
    persist();
  });

  el.togglePedalToggle.addEventListener('change', () => {
    state.togglePedal = el.togglePedalToggle.checked;
    applyPedalState();
    persist();
  });
}

/* ------------------------------------------------------------------ *
 * 输入：电脑键盘演奏
 * ------------------------------------------------------------------ */

/** code -> { midi, spelling }：正在用电脑键盘按住的音 */
const computerKeys = new Map();
/** midi -> 'sharp' | 'flat'：由键盘映射带进来的升降号偏好 */
const spellingHints = new Map();

/** 音级 -> 升降号偏好（给和弦根音 / 低音用） */
function spellingHintsByPc() {
  if (spellingHints.size === 0) return null;
  const hints = new Map();
  for (const [midi, spelling] of spellingHints) hints.set(midi % 12, spelling);
  return hints;
}

function releaseComputerKey(code) {
  const entry = computerKeys.get(code);
  if (!entry) return;
  computerKeys.delete(code);

  const stillHeld = [...computerKeys.values()].some(item => item.midi === entry.midi);
  if (!stillHeld) spellingHints.delete(entry.midi);

  endNote(entry.midi);
}

function bindComputerKeys() {
  document.addEventListener('keydown', event => {
    if (event.code === 'Space' || event.key === ' ') return;   // 空格留给踏板
    if (isFormControl(event.target)) return;

    // Alt 是「降号黑键」的修饰键：把它的原生行为一并屏蔽
    // （聚焦浏览器菜单栏、Alt+字母加速键、Alt+左右后退等）
    if (event.altKey || event.code === 'AltLeft' || event.code === 'AltRight') {
      event.preventDefault();
    }

    const resolved = keyboard.resolveComputerKey(event);
    if (!resolved) return;
    event.preventDefault();
    if (event.repeat || computerKeys.has(event.code)) return;

    computerKeys.set(event.code, resolved);
    spellingHints.set(resolved.midi, resolved.spelling);
    playNote(resolved.midi);
  });

  document.addEventListener('keyup', event => {
    if (event.code === 'Space' || event.key === ' ') return;
    releaseComputerKey(event.code);
  });
}

/* ------------------------------------------------------------------ *
 * 输入：踏板、空格、失焦
 * ------------------------------------------------------------------ */

function isFormControl(target) {
  if (!target || !target.tagName) return false;
  return ['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(target.tagName);
}

function bindPedal() {
  el.pedal.addEventListener('pointerdown', event => {
    event.preventDefault();
    pedalPointerId = event.pointerId;
    handlePedalDown();
  });

  const releasePedalPointer = event => {
    if (pedalPointerId === null || event.pointerId !== pedalPointerId) return;
    pedalPointerId = null;
    handlePedalUp();
  };
  window.addEventListener('pointerup', releasePedalPointer);
  window.addEventListener('pointercancel', releasePedalPointer);

  document.addEventListener('keydown', event => {
    if (event.code !== 'Space' && event.key !== ' ') return;
    if (isFormControl(event.target)) return;
    event.preventDefault();
    if (event.repeat || spacePressed) return;
    spacePressed = true;
    handlePedalDown();
  });

  document.addEventListener('keyup', event => {
    if (event.code !== 'Space' && event.key !== ' ') return;
    if (!spacePressed) return;
    spacePressed = false;
    if (!isFormControl(event.target)) event.preventDefault();
    handlePedalUp();
  });

  // 切换到别的窗口：停掉所有声音，并复位踏板 / 按键状态，避免延音卡住
  window.addEventListener('blur', () => {
    synth.stopAll();
    keyboard.clearPressed();
    computerKeys.clear();
    spellingHints.clear();
    heldKeys.clear();
    pedalPressed = false;
    pedalPointerId = null;
    spacePressed = false;
    applyPedalState();
    scheduleRefresh();
  });
}

/* ------------------------------------------------------------------ *
 * 初始化
 * ------------------------------------------------------------------ */

function init() {
  collectElements();
  if (!el.piano) {
    console.error('piano: 找不到 #piano，piano.html 结构可能被改坏了');
    return;
  }

  setup();

  keyboard.build();
  keyboard.center();

  applySettingsToControls();
  applyUiState();
  bindControls();
  bindComputerKeys();
  bindPedal();
  panel.init();

  synth.setVolume(state.volume);

  // 踏板初始状态：反转模式下「未踩下」即为延音生效
  pedalPressed = false;
  if (state.togglePedal) setSustain(false);
  else applyPedalState();

  refreshDisplay();
}

/** 方便在控制台里排查问题 */
Piano.App = {
  init,
  refreshDisplay,
  get state() { return state; },
  get synth() { return synth; },
  get keyboard() { return keyboard; },
  get staff() { return staff; },
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}

})(typeof window !== 'undefined' ? window : globalThis);
