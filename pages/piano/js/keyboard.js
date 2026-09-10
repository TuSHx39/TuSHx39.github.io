/**
 * keyboard.js —— 键盘绘制与指针交互
 *
 * 设计要点：
 *   · 先渲染全部白键，再测量真实像素来摆放黑键（而不是在 JS 里写死键宽），
 *     所以 CSS 变量一改（包括响应式断点、窗口缩放）黑键依然严丝合缝。
 *   · 使用 Pointer Events：鼠标、触摸、触控笔一致；支持多指同时按键与拖动连奏。
 *   · 只负责「哪个琴键被按下 / 松开」，发声与踏板由 main.js 决定。
 *
 * 传统脚本（非 ES Module），接口挂在全局 Piano.Keyboard 上。
 */

(function (global) {
  'use strict';

  const Piano = global.Piano = global.Piano || {};

/** 音名换算来自和弦模块（延迟取用，脚本加载顺序更宽容） */
function theory() {
  const chords = Piano.Chords;
  if (!chords) throw new Error('keyboard.js 需要先加载 chords.js');
  return chords;
}

/** 这些白键右侧带黑键 */
const BLACK_AFTER = new Set(['C', 'D', 'F', 'G', 'A']);
const BLACK_WIDTH_RATIO = 0.58;
const BLACK_HEIGHT_RATIO = 0.62;
/** 黑键中心落在相邻两个白键的分界线上（= 跨在两个白键之间） */
const BLACK_CENTER_RATIO = 1;

/**
 * 电脑键盘映射：按「读一行、再读下一行」的顺序，把连续的琴键分配给连续的按键。
 *   · 第一行是数字排（`1234567890-=`），再往下依次是 QWERTY / ASDF / ZXCV 排；
 *   · 一行读完换下一行，音继续升高（每行第一个键接在上一行最后一个键右边）；
 *   · 起始音是 C1，于是 QWERTY 排的 `E` 恰好落在 **C3**，往右依次升高。
 *   白键 = 直接按那个键；
 *   黑键 = Shift + 它左边的白键（按升号显示）或 Alt + 它右边的白键（按降号显示）。
 */
const KEY_SEQUENCE = [
  // 数字排
  'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6',
  'Digit7', 'Digit8', 'Digit9', 'Digit0', 'Minus', 'Equal',
  // QWERTY 排
  'KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyY', 'KeyU', 'KeyI', 'KeyO', 'KeyP',
  'BracketLeft', 'BracketRight',
  // ASDF 排
  'KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK', 'KeyL',
  'Semicolon', 'Quote',
  // ZXCV 排
  'KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB', 'KeyN', 'KeyM', 'Comma', 'Period', 'Slash',
];

/** 映射的起始音（C1）：QWERTY 排的 E 因此正好是 C3 */
const MAP_START_MIDI = 24;

const CODE_LABELS = {
  Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
  Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
};

function codeLabel(code) {
  if (CODE_LABELS[code]) return CODE_LABELS[code];
  return code.replace(/^Key/, '').replace(/^Digit/, '');
}

const mod12 = value => ((Math.round(value) % 12) + 12) % 12;

function createKeyboard(config = {}) {
  const {
    container,
    wrapper,
    firstMidi = 21,
    lastMidi = 108,
    onNoteOn = () => {},
    onNoteOff = () => {},
    onPointerUp = () => {},
    onInteract = () => {},
  } = config;

  if (!container) throw new Error('createKeyboard 需要一个琴键容器');

  /** @type {Array<{el: HTMLElement, midi: number, pc: string}>} */
  const whiteKeys = [];
  /** @type {Array<{el: HTMLElement, white: HTMLElement}>} */
  const blackKeys = [];
  /** @type {Map<number, number|null>} pointerId -> 当前音 */
  const pointers = new Map();
  /** @type {Map<number, HTMLElement>} midi -> 琴键元素 */
  const keyElements = new Map();
  /** @type {Map<number, number>} midi -> 按住它的指针数（多指可能按同一键） */
  const downCounts = new Map();

  let built = false;
  let relayoutQueued = false;

  /* ---------------- 电脑键盘映射 ---------------- */

  /** code -> { white, sharp, flat }（半音编号） */
  const codeToNote = new Map();
  /** midi -> 键上标注（白键一行；黑键升 / 降两行） */
  const hintByMidi = new Map();

  function setHint(midi, lines, title) {
    hintByMidi.set(midi, { lines, title });
  }

  (function buildKeyMap() {
    const { NOTE_NAMES, noteName } = theory();

    // 琴键范围内的白键，按音高升序
    const whiteMidis = [];
    for (let midi = firstMidi; midi <= lastMidi; midi++) {
      if (!NOTE_NAMES[mod12(midi)].includes('#')) whiteMidis.push(midi);
    }

    // 从 C1 开始分配；按键序列顺序 = 数字排 → QWERTY → ASDF → ZXCV
    const found = whiteMidis.indexOf(MAP_START_MIDI);
    const offset = found >= 0 ? found : 0;

    KEY_SEQUENCE.forEach((code, position) => {
      const white = whiteMidis[offset + position];
      if (white === undefined) return;   // 超出 88 键范围

      const entry = codeToNote.get(code) || {};
      entry.white = white;
      codeToNote.set(code, entry);
      setHint(white, [codeLabel(code)], `${codeLabel(code)} → ${noteName(white)}`);

      // 下一个白键与本键相距两个半音 → 中间夹着一个黑键
      const nextWhite = whiteMidis[offset + position + 1];
      if (nextWhite === undefined || nextWhite - white !== 2) return;

      const nextCode = KEY_SEQUENCE[position + 1];
      const black = white + 1;
      entry.sharp = black;                        // Shift + 左边白键 → 升号
      const flatEntry = codeToNote.get(nextCode) || {};
      flatEntry.flat = black;                     // Alt + 右边白键 → 降号
      codeToNote.set(nextCode, flatEntry);

      setHint(
        black,
        [`⇧${codeLabel(code)}`, `⌥${codeLabel(nextCode)}`],
        `Shift+${codeLabel(code)} 或 Alt+${codeLabel(nextCode)} → ${noteName(black)}`,
      );
    });
  })();

  /**
   * 电脑键盘事件 -> 该弹哪个音。
   * Shift + 左侧白键给升号读法，Alt + 右侧白键给降号读法（同一个黑键）。
   * Ctrl / Meta（Cmd）组合一律不接管：那些是浏览器与系统的快捷键，冲突太多。
   */
  function resolveComputerKey(event) {
    if (!event || !event.code || !codeToNote.has(event.code)) return null;
    const entry = codeToNote.get(event.code);

    if (event.shiftKey && entry.sharp !== undefined) return { midi: entry.sharp, spelling: 'sharp' };
    if (event.altKey && entry.flat !== undefined) return { midi: entry.flat, spelling: 'flat' };
    if (event.ctrlKey || event.metaKey) return null;
    if (entry.white === undefined) return null;
    return { midi: entry.white, spelling: 'sharp' };
  }

  /** 键内顶部的小灰字：电脑键盘映射标注 */
  function appendKeyHint(key, midi) {
    const hint = hintByMidi.get(midi);
    if (!hint) return;
    const box = document.createElement('span');
    box.className = 'key-hint';
    for (const line of hint.lines) {
      const item = document.createElement('span');
      item.textContent = line;
      box.appendChild(item);
    }
    if (hint.title) key.title = hint.title;
    key.appendChild(box);
  }

  /** 键内底部的小灰字：这个键的音名（每个键都有，不再只有 C） */
  function appendNoteLabel(key, midi, noteName) {
    const label = document.createElement('span');
    label.className = 'note-label';
    label.textContent = noteName(midi);
    key.appendChild(label);
  }

  function build() {
    if (built) return;
    built = true;

    const { NOTE_NAMES, noteName } = theory();
    const whiteFragment = document.createDocumentFragment();
    for (let midi = firstMidi; midi <= lastMidi; midi++) {
      const pc = NOTE_NAMES[mod12(midi)];
      if (pc.includes('#')) continue;

      const key = document.createElement('div');
      key.className = 'key white';
      key.dataset.midi = String(midi);
      key.dataset.note = noteName(midi);
      appendNoteLabel(key, midi, noteName);
      appendKeyHint(key, midi);
      whiteFragment.appendChild(key);
      whiteKeys.push({ el: key, midi, pc });
      keyElements.set(midi, key);
    }
    container.appendChild(whiteFragment);

    const blackFragment = document.createDocumentFragment();
    for (const white of whiteKeys) {
      if (!BLACK_AFTER.has(white.pc)) continue;
      const midi = white.midi + 1;
      if (midi > lastMidi) continue;

      const key = document.createElement('div');
      key.className = 'key black';
      key.dataset.midi = String(midi);
      key.dataset.note = noteName(midi);
      appendNoteLabel(key, midi, noteName);
      appendKeyHint(key, midi);
      blackFragment.appendChild(key);
      blackKeys.push({ el: key, white: white.el });
      keyElements.set(midi, key);
    }
    container.appendChild(blackFragment);

    layoutBlackKeys();
  }

  /** 依据白键实测几何摆放黑键 */
  function layoutBlackKeys() {
    for (const { el, white } of blackKeys) {
      const whiteWidth = white.offsetWidth || 0;
      const whiteHeight = white.offsetHeight || 0;
      const blackWidth = Math.round(whiteWidth * BLACK_WIDTH_RATIO);
      el.style.width = `${blackWidth}px`;
      el.style.height = `${Math.round(whiteHeight * BLACK_HEIGHT_RATIO)}px`;
      el.style.left = `${Math.round(white.offsetLeft + whiteWidth * BLACK_CENTER_RATIO - blackWidth / 2)}px`;
    }
  }

  function queueRelayout() {
    if (relayoutQueued) return;
    relayoutQueued = true;
    requestAnimationFrame(() => {
      relayoutQueued = false;
      layoutBlackKeys();
    });
  }

  /** 让键盘一开始就停在中央（对齐 C4 附近） */
  function center() {
    if (!wrapper) return;
    requestAnimationFrame(() => {
      wrapper.scrollLeft = Math.max(0, (wrapper.scrollWidth - wrapper.clientWidth) / 2);
    });
  }

  function setLabelsVisible(visible) {
    container.classList.toggle('hide-note-label', !visible);
  }

  /** 键位标注开关 */
  function setHintsVisible(visible) {
    container.classList.toggle('hide-key-hints', !visible);
  }

  function midiAtPoint(clientX, clientY) {
    const target = document.elementFromPoint(clientX, clientY);
    const key = target && target.closest ? target.closest('.key') : null;
    if (!key || !container.contains(key)) return null;
    const midi = Number(key.dataset.midi);
    return Number.isFinite(midi) ? midi : null;
  }

  /** 视觉按下状态：由脚本维护，拖动连奏时高亮才会跟着手指走 */
  function markDown(midi) {
    const count = (downCounts.get(midi) || 0) + 1;
    downCounts.set(midi, count);
    if (count === 1) {
      const key = keyElements.get(midi);
      if (key) key.classList.add('is-down');
    }
  }

  function markUp(midi) {
    const count = downCounts.get(midi) || 0;
    if (count <= 1) {
      downCounts.delete(midi);
      const key = keyElements.get(midi);
      if (key) key.classList.remove('is-down');
      return;
    }
    downCounts.set(midi, count - 1);
  }

  function releaseMidi(midi) {
    if (midi === null || midi === undefined) return;
    markUp(midi);
    onNoteOff(midi);
  }

  function pressPointer(pointerId, midi) {
    pointers.set(pointerId, midi);
    markDown(midi);
    onInteract();
    onNoteOn(midi);
  }

  function endPointer(event) {
    if (!pointers.has(event.pointerId)) return;
    const midi = pointers.get(event.pointerId);
    pointers.delete(event.pointerId);
    releaseMidi(midi);
    if (pointers.size === 0) onPointerUp();
  }

  /** 丢掉所有按下状态（窗口失焦等场景） */
  function clearPressed() {
    pointers.clear();
    downCounts.clear();
    for (const key of keyElements.values()) key.classList.remove('is-down');
  }

  function bindPointerEvents() {
    container.addEventListener('pointerdown', event => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      const midi = midiAtPoint(event.clientX, event.clientY);
      if (midi === null) return;
      event.preventDefault();
      try {
        container.setPointerCapture(event.pointerId);
      } catch {
        /* 部分环境不支持指针捕获：下面的 window 监听仍能收尾 */
      }
      pressPointer(event.pointerId, midi);
    });

    container.addEventListener('pointermove', event => {
      if (!pointers.has(event.pointerId)) return;
      const previous = pointers.get(event.pointerId);
      const next = midiAtPoint(event.clientX, event.clientY);
      if (next === previous) return;

      releaseMidi(previous);
      if (next === null) {
        pointers.set(event.pointerId, null);
        return;
      }
      pressPointer(event.pointerId, next);
    });

    // 捕获成功时事件仍会回到 container；window 上的监听是兜底（endPointer 幂等）
    container.addEventListener('pointerup', endPointer);
    container.addEventListener('pointercancel', endPointer);
    window.addEventListener('pointerup', endPointer);
    window.addEventListener('pointercancel', endPointer);

    container.addEventListener('contextmenu', event => event.preventDefault());
    container.addEventListener('dragstart', event => event.preventDefault());
    window.addEventListener('resize', queueRelayout);
  }

  function bindWheel() {
    if (!wrapper) return;
    wrapper.addEventListener('wheel', event => {
      if (wrapper.scrollWidth <= wrapper.clientWidth) return;
      event.preventDefault();
      const delta = event.deltaY !== 0 ? event.deltaY : event.deltaX;
      wrapper.scrollLeft += delta;
    }, { passive: false });
  }

  return {
    build() {
      build();
      bindPointerEvents();
      bindWheel();
    },
    center,
    setLabelsVisible,
    setHintsVisible,
    clearPressed,
    resolveComputerKey,
    midiAtPoint,
    container,
  };
}

Piano.Keyboard = { createKeyboard };

})(typeof window !== 'undefined' ? window : globalThis);
