/**
 * chords.js —— 和弦识别引擎
 *
 * 纯逻辑模块：不接触 DOM，也不接触音频，因此可以直接在 Node 里跑单元测试。
 *
 * 识别方式（八度内）：把所有音压成一个八度内的音级集合（pitch class set），
 * 遍历每个出现过的音作为「假定根音」查表。
 *   · 任意排列、任意重复八度都能识别；
 *   · 最低音不是根音时得到转位读法（斜杠和弦 X/Y），可用 allowInversion 关掉；
 *   · 单音（含同音重复八度）不算和弦，不产生读法。
 *
 * 音符表示：和全站一致，使用 MIDI 编号（60 = C4）。
 *
 * 以传统脚本（非 ES Module）加载，因此可以直接双击 piano.html 打开：
 * 浏览器禁止 file:// 页面加载 module 脚本，但普通 <script src> 不受此限制。
 * 每个文件把自己的接口挂到全局命名空间 Piano 上。
 */

(function (global) {
  'use strict';

  const Piano = global.Piano = global.Piano || {};

const NOTE_NAMES = Object.freeze([
  'C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B',
]);

/** 降号拼写表（与 NOTE_NAMES 逐项对应） */
const FLAT_NAMES = Object.freeze([
  'C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B',
]);

const SHARP = 'sharp';
const FLAT = 'flat';

/**
 * 拼写规则（升号 / 降号）：
 *   · 小调、减和弦类：C#m / F#m / G#m 习惯用升号，其余黑键（Eb、Bb）用降号；
 *   · 其余（大调、属和弦、sus、加音…）：只有 F# 比 Gb 更常用，其他黑键都用降号
 *     （Db / Eb / Ab / Bb 才是常见写法，A# 大调、D# 大调几乎不写）。
 * 这个规则只看和弦性质（= 音程结构）与根音音级，所以「按音程关系定升降」。
 */
const MINOR_LIKE = new Set([
  'm', 'm6', 'm7', 'm9', 'm11', 'm13', 'm6/9', 'madd9', 'mMaj7', 'mMaj9',
  'dim', 'dim7', 'm7b5', 'dimMaj7', 'm7add13',
]);
const SHARP_PCS_MINOR_LIKE = new Set([1, 6, 8]);  // C# / F# / G#
const SHARP_PCS_OTHER = new Set([6]);             // F#

function normalizeSpelling(spelling) {
  return spelling === FLAT || spelling === true ? FLAT : SHARP;
}

function spellPitchClass(pc, spelling) {
  const names = normalizeSpelling(spelling) === FLAT ? FLAT_NAMES : NOTE_NAMES;
  return names[mod12(pc)];
}

/** 某和弦性质在某根音上的默认拼写 */
function defaultSpelling(quality, rootPc) {
  const sharpPcs = MINOR_LIKE.has(quality) ? SHARP_PCS_MINOR_LIKE : SHARP_PCS_OTHER;
  return sharpPcs.has(mod12(rootPc)) ? SHARP : FLAT;
}

/** 键盘映射带进来的拼写提示（pc -> 'sharp' | 'flat'） */
function hintFor(hints, pc) {
  if (!hints) return null;
  const value = typeof hints.get === 'function' ? hints.get(mod12(pc)) : hints[mod12(pc)];
  return value ? normalizeSpelling(value) : null;
}

/** 打分用常量 */
const BASS_IS_ROOT_BONUS = 45; // 最低音正好是根音：优先读作原位
const ENTRIES_PER_ROOT = 2;    // 同一根音下最多取两种解释
const DEFAULT_MAX_CANDIDATES = 6;

/**
 * 和弦词典：[后缀, 根音相对半音集合, 常用度]
 *
 * 同一组半音可以对应多个后缀（例如 0,3,6 既是 dim，也可读作省略五音的 m7b5），
 * 它们在同一 key 下共存，由常用度与「最低音是否为根音」共同决定排序。
 * 这里刻意不使用重复对象键——重复键会被后者静默覆盖（旧版本正是这样丢掉了
 * add9 / 9 / 13 等读法），buildIndex() 会显式合并并保留最高常用度。
 */
const CHORD_TYPES = Object.freeze([
  // —— 三和弦 ——
  ['', [0, 4, 7], 100],
  ['m', [0, 3, 7], 100],
  ['dim', [0, 3, 6], 72],
  ['aug', [0, 4, 8], 72],
  ['sus2', [0, 2, 7], 86],
  ['sus4', [0, 5, 7], 88],
  ['5', [0, 7], 62],

  // —— 六和弦 ——
  ['6', [0, 4, 7, 9], 90],
  ['m6', [0, 3, 7, 9], 86],
  ['6/9', [0, 2, 4, 7, 9], 78],
  ['m6/9', [0, 2, 3, 7, 9], 60],
  ['6/9sus4', [0, 2, 5, 7, 9], 52],

  // —— 七和弦 ——
  ['7', [0, 4, 7, 10], 100],
  ['maj7', [0, 4, 7, 11], 100],
  ['m7', [0, 3, 7, 10], 100],
  ['m7b5', [0, 3, 6, 10], 84],
  ['dim7', [0, 3, 6, 9], 84],
  ['mMaj7', [0, 3, 7, 11], 58],
  ['7#5', [0, 4, 8, 10], 66],
  ['maj7#5', [0, 4, 8, 11], 54],
  ['7b5', [0, 4, 6, 10], 62],
  ['dimMaj7', [0, 3, 6, 11], 42],
  ['7sus4', [0, 5, 7, 10], 82],
  ['7sus2', [0, 2, 7, 10], 56],

  // —— 加音 / 九和弦 ——
  ['add9', [0, 2, 4, 7], 86],
  ['madd9', [0, 2, 3, 7], 70],
  ['add11', [0, 4, 5, 7], 50],
  ['sus4add9', [0, 2, 5, 7], 44],
  ['add9#5', [0, 2, 4, 8], 40],
  ['9', [0, 2, 4, 7, 10], 96],
  ['m9', [0, 2, 3, 7, 10], 92],
  ['maj9', [0, 2, 4, 7, 11], 92],
  ['mMaj9', [0, 2, 3, 7, 11], 40],
  ['9sus4', [0, 2, 5, 7, 10], 66],
  ['9#5', [0, 2, 4, 8, 10], 52],
  ['9b5', [0, 2, 4, 6, 10], 46],
  ['7b9', [0, 1, 4, 7, 10], 76],
  ['7#9', [0, 3, 4, 7, 10], 76],
  ['7#11', [0, 4, 6, 7, 10], 66],
  ['7b13', [0, 4, 7, 8, 10], 56],
  ['maj7#11', [0, 4, 6, 7, 11], 58],

  // —— 十一 / 十三和弦 ——
  ['11', [0, 2, 4, 5, 7, 10], 72],
  ['m11', [0, 2, 3, 5, 7, 10], 66],
  ['maj11', [0, 2, 4, 5, 7, 11], 42],
  ['13', [0, 2, 4, 7, 9, 10], 88],
  ['m13', [0, 2, 3, 7, 9, 10], 78],
  ['maj13', [0, 2, 4, 7, 9, 11], 80],
  ['13sus4', [0, 2, 5, 7, 9, 10], 52],
  ['7add13', [0, 4, 7, 9, 10], 48],
  ['m7add13', [0, 3, 7, 9, 10], 44],
  ['13#11', [0, 2, 4, 6, 7, 9, 10], 34],
  ['maj13#11', [0, 2, 4, 6, 7, 9, 11], 32],

  // —— 省略五音的常用形态（钢琴左手常见） ——
  ['7', [0, 4, 10], 74],
  ['maj7', [0, 4, 11], 74],
  ['m7', [0, 3, 10], 78],
  ['m7b5', [0, 3, 6], 45],
  ['dim7', [0, 3, 9], 56],
  ['6', [0, 4, 9], 56],
  ['m6', [0, 3, 9], 52],
  ['add9', [0, 2, 4], 40],
  ['madd9', [0, 2, 3], 34],
  ['add11', [0, 4, 5], 38],
  ['9', [0, 2, 4, 10], 52],
  ['m9', [0, 2, 3, 10], 48],
  ['maj9', [0, 2, 4, 11], 48],
  ['9sus4', [0, 2, 5, 10], 44],
  ['7sus4', [0, 5, 10], 50],
  ['7b9', [0, 1, 4, 10], 46],
  ['7#9', [0, 3, 4, 10], 46],
  ['13', [0, 2, 4, 9, 10], 54],
  ['m13', [0, 2, 3, 9, 10], 46],
  ['maj13', [0, 2, 4, 9, 11], 50],
]);

const CHORD_INDEX = buildIndex(CHORD_TYPES);

/* ------------------------------------------------------------------ *
 * 基础工具
 * ------------------------------------------------------------------ */

function mod12(value) {
  return ((Math.round(value) % 12) + 12) % 12;
}

/** 音级集合 -> 查表用的字符串键（升序、逗号分隔） */
function intervalKey(intervals) {
  return [...intervals].sort((a, b) => a - b).join(',');
}

function buildIndex(types) {
  const index = new Map();
  for (const [quality, intervals, priority] of types) {
    const key = intervalKey(intervals);
    const list = index.get(key) || [];
    const duplicate = list.find(entry => entry.quality === quality);
    if (duplicate) {
      // 同一 key 同一后缀：保留更高的常用度，绝不静默丢失
      duplicate.priority = Math.max(duplicate.priority, priority);
      continue;
    }
    list.push({ quality, priority, intervals: [...intervals].sort((a, b) => a - b) });
    index.set(key, list);
  }
  for (const list of index.values()) list.sort((a, b) => b.priority - a.priority);
  return index;
}

/* ------------------------------------------------------------------ *
 * 对外的小工具
 * ------------------------------------------------------------------ */

/** 带八度的音名：60 -> C4；spelling 传 'flat' 时 63 -> Eb4，默认升号 -> D#4 */
function noteName(midi, spelling) {
  return spellPitchClass(midi, spelling) + (Math.floor(midi / 12) - 1);
}

/** 只有音名：60 -> C */
function pitchClassName(midi, spelling) {
  return spellPitchClass(midi, spelling);
}

/**
 * 词典快照（诊断 / 测试用）。
 * @returns {Record<string, Array<{quality: string, priority: number}>>}
 */
function chordDictionary() {
  const snapshot = {};
  for (const [key, list] of CHORD_INDEX) {
    snapshot[key] = list.map(entry => ({ quality: entry.quality, priority: entry.priority }));
  }
  return snapshot;
}

/** 和弦后缀 -> 常用度（没有该后缀时返回 0），供测试与调试使用 */
function chordPriority(quality, intervals) {
  const list = CHORD_INDEX.get(intervalKey(intervals));
  const hit = list && list.find(entry => entry.quality === quality);
  return hit ? hit.priority : 0;
}

/* ------------------------------------------------------------------ *
 * 识别核心
 * ------------------------------------------------------------------ */

/** 去掉重复的半音（保留音高信息由调用方另行处理） */
function uniquePitchClasses(notes) {
  const seen = new Set();
  const out = [];
  for (const midi of notes) {
    const pc = mod12(midi);
    if (seen.has(pc)) continue;
    seen.add(pc);
    out.push(pc);
  }
  return out.sort((a, b) => a - b);
}

function dedupeBySymbol(candidates) {
  const best = new Map();
  for (const candidate of candidates) {
    const existing = best.get(candidate.symbol);
    if (!existing || candidate.score > existing.score) best.set(candidate.symbol, candidate);
  }
  return [...best.values()];
}

function byScore(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  return a.symbol.localeCompare(b.symbol);
}

/**
 * 按「音级集合」识别：把每个出现过的音级当作假定根音试探。
 *
 * @param {number[]} pcs        去重、升序的音级集合
 * @param {number}   bassPc     实际最低音的音级（决定斜杠低音与优先级）
 * @param {boolean}  allowInversion 是否接受最低音不是根音的读法
 * @param {Map<number,string>} [hints] 音级 -> 拼写偏好（键盘映射带进来的升降号选择）
 */
function identifyPitchClasses(pcs, bassPc, allowInversion, hints) {
  const results = [];
  for (const rootPc of pcs) {
    const key = intervalKey(pcs.map(pc => mod12(pc - rootPc)));
    const entries = CHORD_INDEX.get(key);
    if (!entries) continue;

    const isBassRoot = rootPc === bassPc;
    if (!isBassRoot && !allowInversion) continue;

    for (const entry of entries.slice(0, ENTRIES_PER_ROOT)) {
      const spelling = hintFor(hints, rootPc) || defaultSpelling(entry.quality, rootPc);
      const root = spellPitchClass(rootPc, spelling);
      const bass = spellPitchClass(bassPc, hintFor(hints, bassPc) || spelling);
      results.push({
        symbol: isBassRoot ? `${root}${entry.quality}` : `${root}${entry.quality}/${bass}`,
        quality: entry.quality,
        spelling,
        root,
        rootPc,
        bass,
        bassPc,
        inversion: !isBassRoot,
        intervals: entry.intervals,
        priority: entry.priority,
        score: entry.priority + (isBassRoot ? BASS_IS_ROOT_BONUS : 0),
      });
    }
  }
  return dedupeBySymbol(results).sort(byScore);
}

/**
 * 识别一组正在发声的音。
 *
 * @param {number[]} midiNotes 任意顺序的 MIDI 音高（允许重复八度）
 * @param {object}   [options]
 * @param {boolean}  [options.allowInversion=true] 是否给出转位（斜杠）读法
 * @param {number}   [options.maxCandidates=6]
 * @param {Map<number,string>} [options.spellingHints] 音级 -> 升降号偏好
 * @returns {{
 *   notes: number[],
 *   primary: object|null,
 *   candidates: object[],
 * }}
 */
function analyzeChord(midiNotes, options = {}) {
  const allowInversion = options.allowInversion !== false;
  const maxCandidates = Number.isFinite(options.maxCandidates)
    ? Math.max(1, Math.floor(options.maxCandidates))
    : DEFAULT_MAX_CANDIDATES;
  const hints = options.spellingHints || null;

  const notes = [...new Set((midiNotes || [])
    .filter(n => Number.isFinite(n))
    .map(n => Math.round(n)))]
    .sort((a, b) => a - b);

  const result = { notes, primary: null, candidates: [] };
  if (notes.length === 0) return result;

  const bassPc = mod12(notes[0]);
  const pcs = uniquePitchClasses(notes);

  // 单音（含同音重复八度）不是和弦，不显示和弦读法
  if (pcs.length === 1) return result;

  const ranked = identifyPitchClasses(pcs, bassPc, allowInversion, hints).slice(0, maxCandidates);
  result.candidates = ranked;
  result.primary = ranked[0] || null;
  return result;
}

/* ------------------------------------------------------------------ *
 * 对外接口
 * ------------------------------------------------------------------ */

Piano.Chords = {
  NOTE_NAMES,
  FLAT_NAMES,
  SPELLINGS: { SHARP, FLAT },
  noteName,
  pitchClassName,
  spellPitchClass,
  defaultSpelling,
  analyzeChord,
  chordDictionary,
  chordPriority,
};

})(typeof window !== 'undefined' ? window : globalThis);
