const DIVISIONS = [1, 2, 3, 4, 5, 6, 7, 8, 12, 16];
// Accept previous version-1 beat units on import, then migrate them to quarters.
const IMPORT_DENOMINATORS = [2, 4, 8, 16];
const NOTE_KINDS = ['normal', 'accent', 'rest'];

export const SOUNDS = [
  { id: 'electronic', label: '电子' },
  { id: 'wood', label: '木块' },
  { id: 'sticks', label: '鼓棒' },
  { id: 'cowbell', label: '牛铃' },
  { id: 'kick', label: '底鼓' },
  { id: 'hihat', label: '踩镲' },
];

export const PRESETS = [
  { id: 'quarter', label: '四分节拍', notation: '♩' },
  { id: 'eighth', label: '八分音符', notation: '♫' },
  { id: 'sixteenth', label: '十六分音符', notation: '♬ ♬' },
  { id: 'eighth-sixteenth', label: '前八后十六', notation: '♪ ♬' },
  { id: 'sixteenth-eighth', label: '前十六后八', notation: '♬ ♪' },
  { id: 'dotted', label: '附点节奏', notation: '♪· ♬' },
  { id: 'swing', label: 'Swing', notation: '♪ ♫' },
  { id: 'triplet', label: '三连音', notation: '♪ ♪ ♪ ₃' },
  { id: 'triplet-skip', label: '三连音跳拍', notation: '♪ – ♪ ₃' },
  { id: 'syncopated', label: '切分节奏', notation: '– ♪ – ♪' },
  { id: 'sextuplet', label: '六连音', notation: '♬ ♬ ♬ ₆' },
  { id: 'custom', label: '自定义', notation: '···' },
];

const SOUND_IDS = SOUNDS.map((sound) => sound.id);
const PRESET_IDS = PRESETS.map((preset) => preset.id);
const BASE_SETTINGS = {
  version: 1, bpm: 120, beats: 4, denominator: 4, advanced: false,
  preset: 'quarter', swing: 67, accent: true, sound: 'wood', volume: 0.7,
};
const BASE_PRACTICE = {
  countIn: false, muteEnabled: false, playBars: 3, muteBars: 1,
  rampEnabled: false, rampEvery: 4, rampStep: 5, rampMax: 180,
  stopEnabled: false, stopBars: 32,
};

const NUMBER_RULES = {
  bpm: [20, 300, false, '速度 bpm'],
  beats: [1, 12, true, '每小节拍数 beats'],
  swing: [50, 75, false, 'Swing 比例 swing'],
  volume: [0, 1, false, '音量 volume'],
};
const PRACTICE_RULES = {
  playBars: [1, 32, true, '有声小节数 playBars'],
  muteBars: [1, 32, true, '静音小节数 muteBars'],
  rampEvery: [1, 64, true, '提速间隔小节数 rampEvery'],
  rampStep: [1, 30, true, '每次提速 rampStep'],
  rampMax: [20, 300, false, '提速上限 rampMax'],
  stopBars: [1, 999, true, '停止小节数 stopBars'],
};

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeNumber(value, fallback, rule) {
  const [minimum, maximum, integer] = rule;
  const numeric = typeof value === 'number' ? value
    : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  if (!Number.isFinite(numeric)) return fallback;
  const result = integer ? Math.round(numeric) : numeric;
  return Math.min(maximum, Math.max(minimum, result));
}

function validateNumber(value, rule) {
  const [minimum, maximum, integer, label] = rule;
  if (typeof value !== 'number' || !Number.isFinite(value)
    || value < minimum || value > maximum || (integer && !Number.isInteger(value))) {
    throw new Error(`${label} 必须为 ${minimum}–${maximum} 范围内的${integer ? '整数' : '数字'}。`);
  }
}

function validateChoice(value, choices, label) {
  if (!choices.includes(value)) {
    throw new Error(`${label} 不受支持，请使用：${choices.join('、')}。`);
  }
}

function validateBoolean(value, label) {
  if (typeof value !== 'boolean') throw new Error(`${label} 必须为 true 或 false。`);
}

function validateShape(value, keys, label) {
  if (!isObject(value)) throw new Error(`${label} 必须为对象。`);
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new Error(`${label} 包含未知字段 ${key}，请移除后重试。`);
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) throw new Error(`${label} 缺少 ${key} 字段，请使用完整导出文件。`);
  }
}

export function createBeat(divisions = 1) {
  validateChoice(divisions, DIVISIONS, '每拍网格 divisions');
  return {
    divisions,
    swing: false,
    cells: Array.from({ length: divisions }, () => ({
      kind: 'normal', velocity: 80, sound: 'inherit',
    })),
  };
}

export function createPattern(beats = 4, preset = 'quarter', swing = 67) {
  validateNumber(beats, NUMBER_RULES.beats);
  validateChoice(preset, PRESET_IDS, '节奏预设 preset');
  validateNumber(swing, NUMBER_RULES.swing);
  const recipes = {
    quarter: [1, [0]],
    eighth: [2, [0, 1]],
    sixteenth: [4, [0, 1, 2, 3]],
    'eighth-sixteenth': [4, [0, 2, 3]],
    'sixteenth-eighth': [4, [0, 1, 2]],
    dotted: [4, [0, 3]],
    swing: [2, [0, 1]],
    triplet: [3, [0, 1, 2]],
    'triplet-skip': [3, [0, 2]],
    syncopated: [4, [1, 3]],
    sextuplet: [6, [0, 1, 2, 3, 4, 5]],
    custom: [1, [0]],
  };
  const [divisions, sounding] = recipes[preset];
  return Array.from({ length: beats }, () => {
    const beat = createBeat(divisions);
    beat.swing = preset === 'swing';
    beat.cells.forEach((cell, index) => {
      if (!sounding.includes(index)) cell.kind = 'rest';
    });
    return beat;
  });
}

function bindFirstCell(pattern, accent) {
  const firstCell = pattern[0].cells[0];
  if (firstCell.kind !== 'rest') firstCell.kind = accent ? 'accent' : 'normal';
  return pattern;
}

export const DEFAULT_STATE = {
  ...BASE_SETTINGS,
  pattern: bindFirstCell(createPattern(4, 'quarter', 67), BASE_SETTINGS.accent),
  practice: { ...BASE_PRACTICE },
};

function normalizeBeat(input, fallback) {
  if (!isObject(input)) return fallback;
  const divisions = DIVISIONS.includes(input.divisions) ? input.divisions : fallback.divisions;
  const beat = createBeat(divisions);
  beat.swing = divisions % 2 === 0 && input.swing === true;
  beat.cells = beat.cells.map((cell, index) => {
    const note = Array.isArray(input.cells) && isObject(input.cells[index]) ? input.cells[index] : cell;
    return {
      kind: NOTE_KINDS.includes(note.kind) ? note.kind : 'normal',
      velocity: normalizeNumber(note.velocity, 80, [0, 100]),
      sound: note.sound === 'inherit' || SOUND_IDS.includes(note.sound) ? note.sound : 'inherit',
    };
  });
  return beat;
}

// Local storage is recoverable: normalize bad values and copy every nested cell.
export function normalizeState(input) {
  const raw = isObject(input) ? input : {};
  const state = { ...BASE_SETTINGS };
  for (const [key, rule] of Object.entries(NUMBER_RULES)) {
    state[key] = normalizeNumber(raw[key], BASE_SETTINGS[key], rule);
  }
  state.denominator = 4;
  for (const key of ['advanced', 'accent']) {
    state[key] = typeof raw[key] === 'boolean' ? raw[key] : BASE_SETTINGS[key];
  }
  state.preset = PRESET_IDS.includes(raw.preset) ? raw.preset : 'quarter';
  state.sound = SOUND_IDS.includes(raw.sound) ? raw.sound : 'wood';
  const fallbackPattern = createPattern(state.beats, state.preset, state.swing);
  if (state.preset !== 'custom') {
    if (fallbackPattern[0].cells[0].kind === 'rest') state.accent = false;
    bindFirstCell(fallbackPattern, state.accent);
  }
  state.pattern = fallbackPattern.map((beat, index) => normalizeBeat(
    Array.isArray(raw.pattern) ? raw.pattern[index] : null, beat,
  ));
  if (state.preset === 'custom') {
    state.accent = state.pattern[0].cells[0].kind === 'accent';
  } else {
    bindFirstCell(state.pattern, state.accent);
  }
  const practice = isObject(raw.practice) ? raw.practice : {};
  state.practice = { ...BASE_PRACTICE };
  for (const [key, rule] of Object.entries(PRACTICE_RULES)) {
    state.practice[key] = normalizeNumber(practice[key], BASE_PRACTICE[key], rule);
  }
  for (const key of ['countIn', 'muteEnabled', 'rampEnabled', 'stopEnabled']) {
    state.practice[key] = typeof practice[key] === 'boolean' ? practice[key] : BASE_PRACTICE[key];
  }
  return state;
}

// Editors and playback share these actual note kinds, including the first accent.
export function getPattern(input) {
  const state = normalizeState(input);
  return state.preset === 'custom' ? state.pattern
    : bindFirstCell(createPattern(state.beats, state.preset, state.swing), state.accent);
}

// Offsets are measured in quarter-note beats; BPM always counts quarter notes.
export function compileBar(input, barIndex = 0) {
  const state = normalizeState(input);
  const index = Number.isFinite(barIndex) ? Math.trunc(barIndex) : 0;
  const countIn = index < 0;
  const advanced = state.advanced && !countIn;
  const practice = state.practice;
  let bpm = state.bpm;
  if (advanced && practice.rampEnabled) {
    bpm = Math.max(state.bpm, Math.min(practice.rampMax,
      state.bpm + Math.floor(index / practice.rampEvery) * practice.rampStep));
  }
  const finished = advanced && practice.stopEnabled && index >= practice.stopBars;
  const muted = advanced && practice.muteEnabled
    && index % (practice.playBars + practice.muteBars) >= practice.playBars;
  const events = [];
  if (!finished) {
    const pattern = advanced
      ? getPattern(state)
      : bindFirstCell(createPattern(state.beats), state.accent);
    pattern.forEach((beat, beatIndex) => {
      beat.cells.forEach((cell, cellIndex) => {
        if (cell.kind === 'rest') return;
        const offset = beat.swing && beat.divisions % 2 === 0
          ? Math.floor(cellIndex / 2) * 2 / beat.divisions
            + (cellIndex % 2 === 1 ? state.swing / 100 * 2 / beat.divisions : 0)
          : cellIndex / beat.divisions;
        events.push({
          offset: beatIndex + offset,
          accent: cell.kind === 'accent',
          velocity: cell.velocity / 100,
          sound: cell.sound === 'inherit' ? state.sound : cell.sound,
          beat: beatIndex,
          cell: cellIndex,
        });
      });
    });
  }
  return { bpm, beats: state.beats, denominator: state.denominator, events, muted, countIn, finished };
}

function validateState(input) {
  if (!isObject(input)) throw new Error('设置 JSON 必须为对象。');
  if (input.version !== 1) throw new Error('设置版本 version 不受支持，请导入版本 1 的文件。');
  validateShape(input, [...Object.keys(BASE_SETTINGS), 'pattern', 'practice'], '设置');
  for (const [key, rule] of Object.entries(NUMBER_RULES)) validateNumber(input[key], rule);
  validateChoice(input.denominator, IMPORT_DENOMINATORS, '拍号分母 denominator');
  validateChoice(input.preset, PRESET_IDS, '节奏预设 preset');
  validateChoice(input.sound, SOUND_IDS, '音色 sound');
  for (const key of ['advanced', 'accent']) validateBoolean(input[key], key);
  validateShape(input.practice, Object.keys(BASE_PRACTICE), '练习设置 practice');
  for (const [key, rule] of Object.entries(PRACTICE_RULES)) validateNumber(input.practice[key], rule);
  for (const key of ['countIn', 'muteEnabled', 'rampEnabled', 'stopEnabled']) {
    validateBoolean(input.practice[key], `练习设置 ${key}`);
  }
  if (!Array.isArray(input.pattern) || input.pattern.length !== input.beats) {
    throw new Error('单小节编排 pattern 的拍数必须与每小节拍数 beats 一致。');
  }
  input.pattern.forEach((beat, index) => {
    const label = `编排第 ${index + 1} 拍`;
    validateShape(beat, ['divisions', 'swing', 'cells'], label);
    validateChoice(beat.divisions, DIVISIONS, `${label}网格 divisions`);
    validateBoolean(beat.swing, `${label} Swing`);
    if (beat.swing && beat.divisions % 2 !== 0) throw new Error(`${label} Swing 仅支持偶数网格，请选择 2、4、6、8、12 或 16 格。`);
    if (!Array.isArray(beat.cells) || beat.cells.length !== beat.divisions) {
      throw new Error(`${label}音符 cells 数量必须等于网格 divisions。`);
    }
    beat.cells.forEach((cell, cellIndex) => {
      const noteLabel = `${label}第 ${cellIndex + 1} 格音符`;
      validateShape(cell, ['kind', 'velocity', 'sound'], noteLabel);
      validateChoice(cell.kind, NOTE_KINDS, `${noteLabel}类型 kind`);
      validateNumber(cell.velocity, [0, 100, false, `${noteLabel}力度 velocity`]);
      validateChoice(cell.sound, ['inherit', ...SOUND_IDS], `${noteLabel}音色 sound`);
    });
  });
}

export function serializeState(state) {
  return JSON.stringify(normalizeState(state), null, 2);
}

export function parseState(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('JSON 格式无效，请检查文件中的引号、逗号和括号。');
  }
  validateState(value);
  return normalizeState(value);
}
