
(function (global) {
  'use strict';

  const Piano = global.Piano = global.Piano || {};

const SVG_NS = 'http://www.w3.org/2000/svg';

/* ---------------- 谱面几何 ---------------- */

const SPACE = 16;                       // 相邻两条谱线的距离
const STEP = SPACE / 2;                 // 相邻音级（线 → 间）的距离
const STAFF_HEIGHT = SPACE * 4;         // 五条线的总高
const SHEET_WIDTH = 178;                // 只放一个柱式和弦，留出余量
const SINGLE_HEIGHT = 296;              // 单谱表高度
const GRAND_HEIGHT = 360;               // 双声部（大谱表）高度
const COLUMN_X = 104;                   // 唯一那一列的水平位置（离谱号远一点）
const CLEF_X = 12;                      // 谱号左边距（归一化坐标再用）
const HEAD_RX = SPACE * 0.62;           // 符头半宽（约一个线距宽）
const HEAD_RY = SPACE * 0.5;            // 符头半高
const HEAD_SHIFT = HEAD_RX * 0.75;      // 左右错开的距离：二度相邻时符头略微重叠
const MAX_LEDGERS = 7;                  // 加线上限

/**
 * 谱号：
 *   bottomStep = 最下面那条线对应的谱表音级（E4 = 30、F3 = 24、G2 = 18）
 *   art        = 手绘线条（坐标系按「线间距 = 10」设计，谱线在 y = 0/10/20/30/40）
 */
const CLEFS = {
  treble: {
    label: '高音谱号',
    bottomStep: 30,
    art: [{
      type: 'path',
      d: 'M 5 54 C 4 46, 7 41, 11 36 L 11 8 C 11 2, 15 -4, 20 -2 C 24 0, 22 5, 17 6 '
        + 'C 9 8, 3 16, 2 26 C 1 36, 8 43, 16 42 C 24 41, 26 32, 23 24 C 20 16, 12 14, 9 20 '
        + 'C 7 25, 9 31, 14 33 C 18 34, 19 31, 17 29',
    }],
  },
  alto: {
    label: '中音谱号',
    bottomStep: 24,     // 最下面那条线 = F3，中间那条线 = C4
    art: [
      { type: 'path', d: 'M 16 3 C 11 3, 11 9, 16 11 L 16 29 C 11 31, 11 37, 16 37' },
      { type: 'path', d: 'M 22 3 C 27 3, 27 9, 22 11 L 22 29 C 27 31, 27 37, 22 37' },
      { type: 'path', d: 'M 19 20 L 28 15 L 28 25 Z', filled: true },
    ],
  },
  bass: {
    label: '低音谱号',
    bottomStep: 18,     // 最下面那条线 = G2，第四条线（上数第二条）= F3
    art: [
      // 起笔在 F 线上方，向左下兜一个大弯，到底部再向右勾回来
      { type: 'path', d: 'M 18 4 C 10 2, 5 7, 5 14 C 5 24, 7 34, 16 38 C 21 40, 26 38, 28 34' },
      // 右侧两个点夹住 F 线
      { type: 'circle', cx: 31, cy: 5, r: 1.9 },
      { type: 'circle', cx: 31, cy: 15, r: 1.9 },
    ],
  },
};
const CLEF_UNITS = 10;   // 上面图形使用的线间距

/** 双声部时两条谱表的位置：上高音、下低音，中间留出一个八度左右 */
const GRAND_STAVES = [
  { clef: 'treble', topY: 84 },
  { clef: 'bass', topY: 212 },
];

const LETTER_STEP = { C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6 };

/* ---------------- 小工具 ---------------- */

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** 音名首字母 + MIDI -> 谱表音级（C4 = 28、E4 = 30、B4 = 34） */
function noteStep(letter, midi) {
  const octave = Math.floor(midi / 12) - 1;
  return octave * 7 + (LETTER_STEP[letter] || 0);
}

function createStaff(config = {}) {
  const { container } = config;
  if (!container) throw new Error('createStaff 需要一个容器');

  const doc = container.ownerDocument || global.document;

  /** 当前正在响的音（与「当前音」读数同一份数据）：{ midi, spelling } */
  const notes = [];
  let signature = '';
  let visible = false;
  let dirty = true;
  let clefKey = 'treble';
  let grand = false;
  /** 当前布局：{ height, staves: [{ clefKey, topY, bottomStep, topStep, y }] } */
  let layout = null;

  /* ---------------- SVG 骨架 ---------------- */

  function svgEl(tag, attrs) {
    const node = doc.createElementNS(SVG_NS, tag);
    for (const name of Object.keys(attrs)) node.setAttribute(name, String(attrs[name]));
    return node;
  }

  const svg = svgEl('svg', {
    class: 'staff-svg',
    width: SHEET_WIDTH,
    height: SINGLE_HEIGHT,
    viewBox: `0 0 ${SHEET_WIDTH} ${SINGLE_HEIGHT}`,
    xmlns: SVG_NS,
  });

  const linesGroup = svgEl('g', { class: 'staff-lines' });
  const clefGroup = svgEl('g', { class: 'staff-clefs' });
  const notesGroup = svgEl('g', { class: 'staff-notes' });

  svg.appendChild(linesGroup);
  svg.appendChild(clefGroup);
  svg.appendChild(notesGroup);
  container.appendChild(svg);

  /* ---------------- 布局：谱表与谱号 ---------------- */

  function staffGeometry(clef, topY) {
    const bottomStep = CLEFS[clef].bottomStep;
    return {
      clefKey: clef,
      topY,
      bottomStep,
      topStep: bottomStep + 8,
      stepToY: step => topY + STAFF_HEIGHT - (step - bottomStep) * STEP,
    };
  }

  function computeLayout() {
    if (grand) {
      return {
        height: GRAND_HEIGHT,
        staves: GRAND_STAVES.map(item => staffGeometry(item.clef, item.topY)),
      };
    }
    return {
      height: SINGLE_HEIGHT,
      staves: [staffGeometry(clefKey, (SINGLE_HEIGHT - STAFF_HEIGHT) / 2)],
    };
  }

  function buildClefArt(part, topY) {
    const scale = SPACE / CLEF_UNITS;
    if (part.type === 'circle') {
      return svgEl('circle', {
        class: 'clef-fill',
        cx: part.cx * scale + CLEF_X,
        cy: topY + part.cy * scale,
        r: part.r * scale,
      });
    }
    return svgEl('path', {
      class: part.filled ? 'clef-fill' : 'clef-path',
      d: part.d,
      fill: part.filled ? 'currentColor' : 'none',
      transform: `translate(${CLEF_X}, ${topY}) scale(${scale})`,
    });
  }

  /** 谱线与谱号只在布局变化时重画 */
  function rebuildBase() {
    layout = computeLayout();
    svg.setAttribute('height', layout.height);
    svg.setAttribute('viewBox', `0 0 ${SHEET_WIDTH} ${layout.height}`);

    while (linesGroup.children && linesGroup.children.length) {
      linesGroup.removeChild(linesGroup.children[0]);
    }
    while (clefGroup.children && clefGroup.children.length) {
      clefGroup.removeChild(clefGroup.children[0]);
    }

    for (const staff of layout.staves) {
      for (let i = 0; i < 5; i++) {
        const y = staff.topY + i * SPACE;
        linesGroup.appendChild(svgEl('line', {
          class: 'staff-line', x1: 0, y1: y, x2: SHEET_WIDTH, y2: y,
        }));
      }
      for (const part of CLEFS[staff.clefKey].art) {
        clefGroup.appendChild(buildClefArt(part, staff.topY));
      }
    }
    dirty = true;
  }

  /* ---------------- 记谱：位置与拼写 ---------------- */

  /** 这一列该用升号还是降号（与顶部读数同一套规则） */
  function spellingOf() {
    const chords = Piano.Chords;
    if (!chords || typeof chords.analyzeChord !== 'function') return 'sharp';
    const result = chords.analyzeChord(notes.map(note => note.midi), { maxCandidates: 1 });
    return result.primary ? result.primary.spelling : 'sharp';
  }

  /** 单个音：字母、升降号、谱表音级（不含 y —— y 取决于画在哪条谱表上） */
  function layoutNote(note, fallbackSpelling) {
    const chords = Piano.Chords;
    const spelling = note.spelling || fallbackSpelling || 'sharp';
    const name = chords && chords.spellPitchClass
      ? chords.spellPitchClass(note.midi, spelling)
      : 'C';
    const letter = name.charAt(0);
    const accidental = name.length > 1 ? name.charAt(1) : null;
    return {
      midi: note.midi,
      letter,
      accidental,
      step: noteStep(letter, note.midi),
      split: false,
      side: 0,
    };
  }

  /**
   * 这条谱表上下各能画几条加线还留在谱面里。
   * 谱面是固定高度，所以极端的音（A0 / C8）会落到位居最外侧的那条加线上，
   * 而不是画到画面外面 —— 谱面上的音和「当前音」永远一一对应。
   */
  function ledgerSteps(staff) {
    const fit = pixels => Math.max(0, Math.min(MAX_LEDGERS, Math.floor(pixels / SPACE)));
    return {
      min: staff.bottomStep - fit(layout.height - (staff.topY + STAFF_HEIGHT) - HEAD_RY) * 2,
      max: staff.topStep + fit(staff.topY - HEAD_RY) * 2,
    };
  }

  function clampStep(step, staff) {
    const range = ledgerSteps(staff);
    return clamp(step, range.min, range.max);
  }

  /** 某条谱表离该音有多远（按加线数量计） */
  function ledgerCost(step, staff) {
    const fixed = clampStep(step, staff);
    if (fixed >= staff.bottomStep && fixed <= staff.topStep) return 0;
    const distance = fixed < staff.bottomStep
      ? staff.bottomStep - fixed
      : fixed - staff.topStep;
    return Math.ceil(distance / 2);
  }

  /**
   * 双声部：把这一列音分到两条谱表上。
   * 代价 = 两条谱表上各自的加线数量之和；同分时优先「少用一条谱表」，
   * 再优先「不切开近邻（三度以内）」，最后才偏向高音谱表。
   * 这样完整和弦一般不会被切到两个谱上，而低音 + 右手和弦会自然分开。
   */
  function distribute(laid, staves) {
    let best = null;
    for (let pivot = 0; pivot <= laid.length; pivot++) {
      const upper = laid.slice(pivot);
      const lower = laid.slice(0, pivot);
      let cost = 0;
      for (const note of upper) cost += ledgerCost(note.step, staves[0]);
      for (const note of lower) cost += ledgerCost(note.step, staves[1]);

      const stavesUsed = (upper.length ? 1 : 0) + (lower.length ? 1 : 0);
      const cuts = (pivot > 0 && pivot < laid.length && laid[pivot].step - laid[pivot - 1].step <= 2)
        ? 1
        : 0;

      const candidate = { pivot, cost, stavesUsed, cuts };
      if (!best
        || candidate.cost < best.cost
        || (candidate.cost === best.cost && (
          candidate.stavesUsed < best.stavesUsed
          || (candidate.stavesUsed === best.stavesUsed && candidate.cuts < best.cuts)
          || (candidate.stavesUsed === best.stavesUsed && candidate.cuts === best.cuts
            && candidate.pivot > best.pivot)     // 同分时偏上谱表
        ))) {
        best = candidate;
      }
    }
    return { upper: laid.slice(best.pivot), lower: laid.slice(0, best.pivot) };
  }

  function appendLedgers(group, staff, x, step) {
    const half = SPACE * 0.72;
    const line = lineStep => group.appendChild(svgEl('line', {
      class: 'staff-ledger',
      x1: x - half, y1: staff.stepToY(lineStep),
      x2: x + half, y2: staff.stepToY(lineStep),
    }));
    if (step < staff.bottomStep) {
      for (let s = staff.bottomStep - 2; s >= step; s -= 2) line(s);
    } else if (step > staff.topStep) {
      for (let s = staff.topStep + 2; s <= step; s += 2) line(s);
    }
  }

  function drawColumn(group, staff, laid) {
    for (const note of laid) {
      note.step = clampStep(note.step, staff);
      note.y = staff.stepToY(note.step);
    }

    // 左右错开只在「真正构成二度」时发生（一个在线上、一个在线间），其余居中
    for (let i = 0; i < laid.length; i++) {
      const note = laid[i];
      const previous = laid[i - 1];
      const next = laid[i + 1];
      const touchesPrevious = Boolean(previous) && note.step - previous.step <= 1;
      const touchesNext = Boolean(next) && next.step - note.step <= 1;
      note.split = touchesPrevious || touchesNext;
      note.side = 0;
    }
    for (let i = 0; i < laid.length; i++) {
      const note = laid[i];
      if (!note.split) continue;
      const previous = laid[i - 1];
      if (previous && previous.split && previous.step === note.step) {
        note.side = 1;              // 同一位置上的两个音：低音左、高音右
        previous.side = -1;
      } else {
        note.side = note.step % 2 === 0 ? -1 : 1;   // 线上偏左、线间偏右
      }
    }
    for (const note of laid) note.x = COLUMN_X + note.side * HEAD_SHIFT;

    // 加线（同一位置只画一条，跟着自己的符头走）
    const ledgerSteps = new Set();
    for (const note of laid) {
      if (note.step >= staff.bottomStep && note.step <= staff.topStep) continue;
      if (ledgerSteps.has(note.step)) continue;
      ledgerSteps.add(note.step);
      appendLedgers(group, staff, note.x, note.step);
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
        'font-size': SPACE * 1.32,
      });
      text.textContent = note.accidental === '#' ? '♯' : '♭';
      group.appendChild(text);
    }

    // 符头：实心、只有头（无符干），大小约等于线距
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
  }

  /* ---------------- 渲染 ---------------- */

  function clearGroup() {
    while (notesGroup.children && notesGroup.children.length) {
      notesGroup.removeChild(notesGroup.children[0]);
    }
  }

  /** 这一列音按谱表摆好的样子（纯计算，不碰 DOM） */
  function laidOut() {
    if (!layout) rebuildBase();
    const laid = notes
      .map(note => layoutNote(note, spellingOf()))
      .sort((a, b) => (a.step - b.step) || (a.midi - b.midi));
    if (layout.staves.length === 1) return [laid];
    const { upper, lower } = distribute(laid, layout.staves);
    return [upper, lower];
  }

  function render() {
    clearGroup();
    if (!layout) rebuildBase();
    if (!notes.length) return;

    const groups = laidOut();
    groups.forEach((laid, index) => {
      if (!laid.length) return;
      let className = 'staff-column';
      if (groups.length > 1) className += index === 0 ? ' upper' : ' lower';
      const group = svgEl('g', { class: className });
      drawColumn(group, layout.staves[index], laid);
      notesGroup.appendChild(group);
    });
  }

  function refresh() {
    // 隐藏时只记「待重画」，重新显示时再一次性画出来
    dirty = !visible;
    if (visible) render();
  }

  /* ---------------- 对外操作 ---------------- */

  /**
   * 直接画「当前正在响的音」。
   * 这一份数据就是「当前音」读数用的那一份（synth.sounding()），所以谱面和读数
   * 永远实时一致：留存的音就是此刻还在响的音，别的逻辑一概不需要。
   */
  function setNotes(midis, hints) {
    const list = (Array.isArray(midis) ? midis : [])
      .filter(midi => Number.isFinite(midi))
      .sort((a, b) => a - b);
    const spellingFor = midi => (
      hints && typeof hints.get === 'function' ? (hints.get(midi) || null) : null
    );

    // 内容没变就不用重画（读数刷新比音符变化频繁得多）
    const next = list.map(midi => `${midi}:${spellingFor(midi) || ''}`).join(',');
    if (next === signature) return;
    signature = next;

    notes.length = 0;
    for (const midi of list) notes.push({ midi, spelling: spellingFor(midi) });
    refresh();
  }

  /** 单谱表用哪个谱号（双声部时忽略，固定上高音下低音） */
  function setClef(next) {
    const key = CLEFS[next] ? next : 'treble';
    if (key === clefKey) return;
    clefKey = key;
    signature = '';        // 位置变了，必须重画
    rebuildBase();
    refresh();
  }

  /** 是否开启双声部（大谱表） */
  function setGrandStaff(next) {
    const value = Boolean(next);
    if (value === grand) return;
    grand = value;
    signature = '';
    rebuildBase();
    refresh();
  }

  function clear() {
    if (signature === '' && notes.length === 0) return;
    signature = '';
    notes.length = 0;
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
    const groups = laidOut();
    const staves = layout.staves.map((staff, index) => ({
      clef: staff.clefKey,
      // [最上面那条线的 y, 最下面那条线的 y]
      lines: [staff.stepToY(staff.topStep), staff.stepToY(staff.bottomStep)],
      // 分到这条谱表上的音（合起来正好是全部的音，不重不漏）
      notes: groups[index].map(note => note.midi),
    }));
    return {
      width: SHEET_WIDTH,
      height: layout.height,
      clef: grand ? 'treble' : clefKey,
      grand,
      staves,
      notes: notes.map(note => note.midi),
    };
  }

  rebuildBase();

  return {
    setNotes,
    setClef,
    setGrandStaff,
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
