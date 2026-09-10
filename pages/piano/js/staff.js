/**
 * staff.js —— 五线谱（单谱表，高音谱号，只显示一个柱式和弦）
 *
 * 记谱规则：
 *   · 谱面上永远只有一个柱式和弦（一列），宽度只留得下一个音符加余量；
 *   · 音符画成**实心符头、不画符干**，符头大小约等于线距；
 *   · 符头一律左右错开（没有居中这回事）：**谱线上的音偏左、谱线之间的音偏右**，
 *     于是二度相邻的两个符头必然一左一右、不会叠在一起；
 *   · 踩住踏板期间弹的所有音都并进这一列，穿成一串（柱式和弦）；
 *   · 没踩踏板时，与「这一列里还按着的音」重叠、或距上一笔极短（< 100ms）的音也并进同一列；
 *   · **松开踏板 = 这一段结束，立刻清空整个谱面**；没踩踏板时，下一次演奏（新的一笔）也会替换掉旧的一列；
 *   · 每个音按真实音高落位，超出谱表画加线（最多 7 条，再远的做钳制）；
 *   · 升降号：优先用键盘映射带来的拼写，否则按这一列和弦的音程关系决定（与读数同一套规则）。
 *
 * 传统脚本（非 ES Module），接口挂在全局 Piano.Staff 上。
 */

(function (global) {
  'use strict';

  const Piano = global.Piano = global.Piano || {};

const SVG_NS = 'http://www.w3.org/2000/svg';

/* ---------------- 谱面几何 ---------------- */

const SPACE = 16;                       // 相邻两条谱线的距离
const STEP = SPACE / 2;                 // 相邻音级（线 → 间）的距离
const STAFF_HEIGHT = SPACE * 4;         // 五条线的总高
const SHEET_HEIGHT = 296;               // 谱面高度
const SHEET_WIDTH = 178;                // 只放一个柱式和弦，留出余量
const STAFF_TOP_Y = (SHEET_HEIGHT - STAFF_HEIGHT) / 2;
const STAFF_BOTTOM_Y = STAFF_TOP_Y + STAFF_HEIGHT;
const COLUMN_X = 104;                   // 唯一那一列的水平位置（离谱号远一点）
const HEAD_RX = SPACE * 0.62;           // 符头半宽（约一个线距宽）
const HEAD_RY = SPACE * 0.46;           // 符头半高
const HEAD_SHIFT = HEAD_RX;             // 左右错开的距离：二度相邻时正好相切
const LINE_STEP_PARITY = 0;             // 谱表音级为偶数 = 落在线上（E4 = 30 是最下面那条线）
const JOIN_WINDOW_MS = 100;             // 与上一笔间隔小于这个值算同一柱
const MAX_LEDGERS = 7;                  // 加线上限（约 E2–F7）

/** 谱表音级编号：E4 = 30（最下面那条线），F5 = 38（最上面那条线） */
const BOTTOM_LINE_STEP = 30;
const TOP_LINE_STEP = 38;

const LETTER_STEP = { C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6 };

/**
 * 高音谱号：单笔画骨架（尾巴 → 主杆 → 顶部右钩 → 大圈 → 向内螺旋收尾）。
 * 路径按「线间距 = 10」设计：谱线在 y = 0 / 10 / 20 / 30 / 40，G 线是 y = 30；
 * 使用时整体缩放到真实线距，所以和 SPACE 无关。
 */
const CLEF_PATH = [
  'M 5 54',
  'C 4 46, 7 41, 11 36',
  'L 11 8',
  'C 11 2, 15 -4, 20 -2',
  'C 24 0, 22 5, 17 6',
  'C 9 8, 3 16, 2 26',
  'C 1 36, 8 43, 16 42',
  'C 24 41, 26 32, 23 24',
  'C 20 16, 12 14, 9 20',
  'C 7 25, 9 31, 14 33',
  'C 18 34, 19 31, 17 29',
].join(' ');
const CLEF_UNITS = 10;   // 上面路径使用的线间距

/* ---------------- 小工具 ---------------- */

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function nowMs() {
  return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
}

/** 音级编号 -> 谱面上的 y（越大越靠下） */
function stepToY(step) {
  return STAFF_BOTTOM_Y - (step - BOTTOM_LINE_STEP) * STEP;
}

/** 音名首字母 + MIDI -> 谱表音级（C4 = 28、E4 = 30、B4 = 34） */
function noteStep(letter, midi) {
  const octave = Math.floor(midi / 12) - 1;
  return octave * 7 + (LETTER_STEP[letter] || 0);
}

function createStaff(config = {}) {
  const {
    container,
    isHeld = () => false,
    isSustain = () => false,
    joinWindowMs = JOIN_WINDOW_MS,
  } = config;
  if (!container) throw new Error('createStaff 需要一个容器');

  const doc = container.ownerDocument || global.document;

  /** 唯一的柱式和弦：{ midi, spelling } */
  const notes = [];
  let lastTime = 0;
  let visible = false;
  let dirty = true;

  /* ---------------- SVG 骨架 ---------------- */

  function svgEl(tag, attrs) {
    const node = doc.createElementNS(SVG_NS, tag);
    for (const name of Object.keys(attrs)) node.setAttribute(name, String(attrs[name]));
    return node;
  }

  const svg = svgEl('svg', {
    class: 'staff-svg',
    width: SHEET_WIDTH,
    height: SHEET_HEIGHT,
    viewBox: `0 0 ${SHEET_WIDTH} ${SHEET_HEIGHT}`,
    xmlns: SVG_NS,
  });

  const linesGroup = svgEl('g', { class: 'staff-lines' });
  for (let i = 0; i < 5; i++) {
    const y = STAFF_TOP_Y + i * SPACE;
    linesGroup.appendChild(svgEl('line', {
      class: 'staff-line', x1: 0, y1: y, x2: SHEET_WIDTH, y2: y,
    }));
  }

  const clefGroup = svgEl('g', { class: 'staff-clef' });
  clefGroup.appendChild(svgEl('path', {
    class: 'clef-path',
    d: CLEF_PATH,
    transform: `translate(12, ${STAFF_TOP_Y}) scale(${SPACE / CLEF_UNITS})`,
  }));

  const notesGroup = svgEl('g', { class: 'staff-notes' });

  svg.appendChild(linesGroup);
  svg.appendChild(clefGroup);
  svg.appendChild(notesGroup);
  container.appendChild(svg);

  /* ---------------- 记谱：位置与拼写 ---------------- */

  /** 这一列该用升号还是降号（与顶部读数同一套规则） */
  function spellingOf() {
    const chords = Piano.Chords;
    if (!chords || typeof chords.analyzeChord !== 'function') return 'sharp';
    const result = chords.analyzeChord(notes.map(note => note.midi), { maxCandidates: 1 });
    return result.primary ? result.primary.spelling : 'sharp';
  }

  /** 单个音：字母、升降号、谱表音级、y */
  function layoutNote(note, fallbackSpelling) {
    const chords = Piano.Chords;
    const spelling = note.spelling || fallbackSpelling || 'sharp';
    const name = chords && chords.spellPitchClass
      ? chords.spellPitchClass(note.midi, spelling)
      : 'C';
    const letter = name.charAt(0);
    const accidental = name.length > 1 ? name.charAt(1) : null;
    const step = clamp(
      noteStep(letter, note.midi),
      BOTTOM_LINE_STEP - MAX_LEDGERS * 2,
      TOP_LINE_STEP + MAX_LEDGERS * 2,
    );
    return { midi: note.midi, letter, accidental, step, y: stepToY(step) };
  }

  function appendLedgers(group, x, step) {
    const half = SPACE * 0.72;
    const line = lineStep => group.appendChild(svgEl('line', {
      class: 'staff-ledger',
      x1: x - half, y1: stepToY(lineStep),
      x2: x + half, y2: stepToY(lineStep),
    }));
    if (step < BOTTOM_LINE_STEP) {
      for (let s = BOTTOM_LINE_STEP - 2; s >= step; s -= 2) line(s);
    } else if (step > TOP_LINE_STEP) {
      for (let s = TOP_LINE_STEP + 2; s <= step; s += 2) line(s);
    }
  }

  /* ---------------- 渲染 ---------------- */

  function clearGroup() {
    while (notesGroup.children && notesGroup.children.length) {
      notesGroup.removeChild(notesGroup.children[0]);
    }
  }

  /** 画这一列：加线 → 升降号 → 符头 → 符干 */
  function render() {
    clearGroup();
    const laid = notes
      .map(note => layoutNote(note, spellingOf()))
      .sort((a, b) => a.step - b.step);
    if (!laid.length) return;

    // 符头一律左右错开，没有「居中」这一档：
    // 落在谱线上的音偏左，落在谱线之间的音偏右。
    // 音级相邻（二度）必然一个在线上、一个在线间，所以符头自然一左一右，正好相切。
    for (const note of laid) {
      note.side = note.step % 2 === LINE_STEP_PARITY ? -1 : 1;
      note.x = COLUMN_X + note.side * HEAD_SHIFT;
    }

    const group = svgEl('g', { class: 'staff-column' });

    // 加线（同一位置只画一条，跟着自己的符头走）
    const ledgerSteps = new Set();
    for (const note of laid) {
      if (note.step >= BOTTOM_LINE_STEP && note.step <= TOP_LINE_STEP) continue;
      if (ledgerSteps.has(note.step)) continue;
      ledgerSteps.add(note.step);
      appendLedgers(group, note.x, note.step);
    }

    // 升降号：位置不冲突时共用一列，冲突了才往左让
    const placed = [];
    for (const note of laid) {
      if (!note.accidental) continue;
      let column = 0;
      while (placed.some(item => item.column === column && Math.abs(item.y - note.y) < SPACE * 1.2)) {
        column += 1;
      }
      placed.push({ y: note.y, column });
      const text = svgEl('text', {
        class: 'staff-accidental',
        x: note.x - SPACE * 0.95 - column * SPACE * 0.62,
        y: note.y,
        'font-size': SPACE * 1.32,     // 跟着线距走，改尺寸不用同步改样式表
      });
      text.textContent = note.accidental === '#' ? '♯' : '♭';
      group.appendChild(text);
    }

    // 符头：二分音符的样子（空心、无符干），大小约等于线距
    for (const note of laid) {
      group.appendChild(svgEl('ellipse', {
        class: 'note-head',
        cx: note.x,
        cy: note.y,
        rx: HEAD_RX,
        ry: HEAD_RY,
        transform: `rotate(-20 ${note.x} ${note.y})`,
      }));
    }

    notesGroup.appendChild(group);
  }

  function refresh() {
    // 隐藏时只记「待重画」，重新显示时再一次性画出来
    dirty = !visible;
    if (visible) render();
  }

  /* ---------------- 对外操作 ---------------- */

  /**
   * 记一个音。
   * 踏板踩着、或这一列里还有音按着、或距上一笔极短 → 并进同一柱；否则清空重画。
   */
  function pushNote(midi, options = {}) {
    if (!Number.isFinite(midi)) return;
    const stamp = nowMs();
    const heldInColumn = notes.some(note => isHeld(note.midi));
    const timingJoin = stamp - lastTime < joinWindowMs;
    const joins = isSustain() || heldInColumn || timingJoin;

    if (!joins) clear();     // 新的演奏：把上一柱清掉
    lastTime = stamp;

    if (notes.some(note => note.midi === midi)) return;   // 同一柱里同音只记一次
    notes.push({ midi, spelling: options.spelling || null });
    refresh();
  }

  /**
   * 踏板松开：这一段就算结束，立刻清空整个谱面。
   * （先清空再交给下一笔，所以不存在「暂时保留」的中间状态）
   */
  function pedalReleased() {
    clear();
    lastTime = 0;            // 下一笔一定另起一柱，而不是并进刚清掉的那一柱
  }

  function clear() {
    notes.length = 0;
    lastTime = 0;
    dirty = true;
    if (visible) {
      clearGroup();
      dirty = false;
    }
  }

  function setVisible(next) {
    visible = Boolean(next);
    if (container.classList) container.classList.toggle('is-hidden', !visible);
    if (visible && dirty) refresh();
  }

  /** 模型快照（测试 / 控制台调试用，不碰 DOM） */
  function snapshot() {
    return {
      width: SHEET_WIDTH,
      height: SHEET_HEIGHT,
      notes: notes.map(note => note.midi),
    };
  }

  return {
    pushNote,
    pedalReleased,
    clear,
    setVisible,
    snapshot,
    render,
    container,
    svg,
  };
}

Piano.Staff = { createStaff };

})(typeof window !== 'undefined' ? window : globalThis);
