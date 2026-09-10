/**
 * 和弦识别引擎的单元测试
 *
 * 运行：cd pages/piano && npm test   （等价于 node --test tests）
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { loadPianoScripts } from './helpers/load-piano.mjs';

// chords.js 是传统脚本，按浏览器的方式加载（只加载它，不牵扯 DOM）
const { Piano } = loadPianoScripts({}, ['js/chords.js']);
const {
  analyzeChord,
  chordDictionary,
  chordPriority,
  noteName,
  pitchClassName,
} = Piano.Chords;

/** 便捷取主读法 */
function primary(notes, options) {
  return analyzeChord(notes, options).primary;
}

function symbol(notes, options) {
  const result = primary(notes, options);
  return result ? result.symbol : null;
}

/** 半音集合 -> MIDI，默认从 C4 开始 */
function stack(intervals, root = 60) {
  return intervals.map(interval => root + interval);
}

/* ------------------------------------------------------------------ *
 * 基础：音名
 * ------------------------------------------------------------------ */

test('音名换算与旧版一致（60 = C4）', () => {
  assert.equal(noteName(60), 'C4');
  assert.equal(noteName(21), 'A0');
  assert.equal(noteName(108), 'C8');
  assert.equal(pitchClassName(61), 'C#');
});

/* ------------------------------------------------------------------ *
 * 三和弦与转位
 * ------------------------------------------------------------------ */

test('原位三和弦', () => {
  assert.equal(symbol([60, 64, 67]), 'C');
  assert.equal(symbol([57, 60, 64]), 'Am');
  assert.equal(symbol([60, 63, 66]), 'Cdim');
  assert.equal(symbol([60, 64, 68]), 'Caug');
  assert.equal(symbol([60, 62, 67]), 'Csus2');
  assert.equal(symbol([60, 65, 67]), 'Csus4');
  assert.equal(symbol([60, 67]), 'C5');
});

test('转位：最低音不是根音时给出斜杠读法', () => {
  // E-G-C 是 C 的第一转位
  const inverted = primary([64, 67, 72]);
  assert.equal(inverted.symbol, 'C/E');
  assert.equal(inverted.root, 'C');
  assert.equal(inverted.bass, 'E');
  assert.equal(inverted.inversion, true);
});

test('关闭「允许转位」后只接受原位', () => {
  assert.equal(symbol([64, 67, 72], { allowInversion: false }), null);
  assert.equal(symbol([60, 64, 67], { allowInversion: false }), 'C');
  assert.equal(symbol([57, 60, 64], { allowInversion: false }), 'Am');
});

test('转位读法与同音异名的另一读法同时给出', () => {
  // C6（C-E-G-A）同时可以读成 Am7 的第一转位
  const result = analyzeChord([60, 64, 67, 69]);
  assert.equal(result.primary.symbol, 'C6');
  const symbols = result.candidates.map(candidate => candidate.symbol);
  assert.ok(symbols.includes('Am7/C'), `候选里应包含 Am7/C，实际：${symbols.join(' / ')}`);
});

/* ------------------------------------------------------------------ *
 * 七和弦与更复杂的和弦
 * ------------------------------------------------------------------ */

test('常见七和弦', () => {
  assert.equal(symbol(stack([0, 4, 7, 10])), 'C7');
  assert.equal(symbol(stack([0, 4, 7, 11])), 'Cmaj7');
  assert.equal(symbol(stack([0, 3, 7, 10])), 'Cm7');
  assert.equal(symbol(stack([0, 3, 6, 10])), 'Cm7b5');
  assert.equal(symbol(stack([0, 3, 6, 9])), 'Cdim7');
  assert.equal(symbol(stack([0, 3, 7, 11])), 'CmMaj7');
  assert.equal(symbol(stack([0, 5, 7, 10])), 'C7sus4');
});

test('六和弦、加音与九和弦', () => {
  assert.equal(symbol(stack([0, 4, 7, 9])), 'C6');
  assert.equal(symbol(stack([0, 3, 7, 9])), 'Cm6');
  assert.equal(symbol(stack([0, 2, 4, 7])), 'Cadd9');
  assert.equal(symbol(stack([0, 2, 3, 7])), 'Cmadd9');
  assert.equal(symbol(stack([0, 2, 4, 7, 10])), 'C9');
  assert.equal(symbol(stack([0, 2, 3, 7, 10])), 'Cm9');
  assert.equal(symbol(stack([0, 2, 4, 7, 11])), 'Cmaj9');
  assert.equal(symbol(stack([0, 2, 4, 7, 9])), 'C6/9');
});

test('变化音与十一 / 十三和弦', () => {
  assert.equal(symbol(stack([0, 1, 4, 7, 10])), 'C7b9');
  assert.equal(symbol(stack([0, 3, 4, 7, 10])), 'C7#9');
  assert.equal(symbol(stack([0, 4, 6, 7, 10])), 'C7#11');
  assert.equal(symbol(stack([0, 2, 4, 5, 7, 10])), 'C11');
  assert.equal(symbol(stack([0, 2, 3, 5, 7, 10])), 'Cm11');
  assert.equal(symbol(stack([0, 2, 4, 7, 9, 10])), 'C13');
  assert.equal(symbol(stack([0, 2, 3, 7, 9, 10])), 'Cm13');
  assert.equal(symbol(stack([0, 2, 4, 7, 9, 11])), 'Cmaj13');
});

test('回归：省略五音的 13 和弦不会被误读成 maj13', () => {
  // 旧版 ALL_CHORD_MAP 里 "0,4,7,14" / "0,4,21" 一类键被后面的定义静默覆盖，
  // 于是这些音只可能读到 maj 系和弦。这里锁死正确结果。
  assert.equal(symbol(stack([0, 4, 7, 10, 14, 21])), 'C13');
  assert.equal(symbol(stack([0, 4, 7, 11, 14, 21])), 'Cmaj13');
  assert.equal(symbol(stack([0, 4, 7, 10, 14])), 'C9');
  assert.equal(symbol(stack([0, 4, 7, 11, 14])), 'Cmaj9');
  // 旧版把下面三组音分别错标成 maj9 / m9 / maj13
  assert.equal(symbol(stack([0, 2, 4, 7])), 'Cadd9');
  assert.equal(symbol(stack([0, 2, 3, 7])), 'Cmadd9');
  assert.equal(symbol(stack([0, 2, 4, 7, 9])), 'C6/9');
});

test('键盘上的实际排列不影响八度内读法', () => {
  // C9 从低到高打乱 / 跨两个八度排列，仍应读作 C9
  assert.equal(symbol([60, 64, 67, 70, 74]), 'C9');
  assert.equal(symbol([48, 62, 64, 67, 70]), 'C9');
  // 最低音变成 9 音（D）时，读作 C9 的转位
  assert.equal(symbol([62, 64, 67, 70, 72]), 'C9/D');
  // 关掉转位就只剩原位读法
  assert.equal(symbol([62, 64, 67, 70, 72], { allowInversion: false }), null);
});

/* ------------------------------------------------------------------ *
 * 单音、八度与空输入
 * ------------------------------------------------------------------ */

test('单音与同音八度都不算和弦', () => {
  assert.equal(primary([60]), null, '单音不显示和弦');
  assert.equal(primary([60, 72]), null, '同音重复八度仍然只是一个音级，也不算和弦');
  assert.equal(analyzeChord([60, 72]).candidates.length, 0);
});

test('升降号拼写：单音默认升号，和弦按音程关系定', () => {
  assert.equal(noteName(63), 'D#4', '单音默认升号');
  assert.equal(noteName(63, 'sharp'), 'D#4');
  assert.equal(noteName(63, 'flat'), 'Eb4');
  assert.equal(pitchClassName(70), 'A#');
  assert.equal(pitchClassName(70, 'flat'), 'Bb');

  // 小三和弦含小三度 → 习惯写降号
  const cMinor = primary([60, 63, 67]);
  assert.equal(cMinor.symbol, 'Cm');
  assert.equal(cMinor.spelling, 'flat');

  // 但 C#m 比 Dbm 常用 → 升号
  const cSharpMinor = primary([61, 64, 68]);
  assert.equal(cSharpMinor.symbol, 'C#m');
  assert.equal(cSharpMinor.spelling, 'sharp');

  // 大三和弦：Eb / Bb / Ab / Db 才是常用写法，F# 用升号
  assert.equal(primary([63, 67, 70]).symbol, 'Eb');
  assert.equal(primary([70, 74, 77]).symbol, 'Bb');
  assert.equal(primary([66, 70, 73]).symbol, 'F#');

  // 属七和弦带降七度音
  assert.equal(primary([60, 64, 67, 70]).spelling, 'flat');

  // 转位：根音与斜杠低音用同一套拼写
  assert.equal(primary([65, 68, 73]).symbol, 'Db/F');
});

test('键盘映射带进来的升降号可以覆盖默认拼写', () => {
  // 按音程关系 Db 大三和弦默认写 Db；但用户是按 Shift+Q（C#）弹的
  assert.equal(primary([61, 65, 68]).symbol, 'Db');
  assert.equal(primary([61, 65, 68], { spellingHints: new Map([[1, 'sharp']]) }).symbol, 'C#');
});

test('没有音在响时不产生读法', () => {
  const result = analyzeChord([]);
  assert.equal(result.primary, null);
  // 沙箱里的数组与宿主的 Array 原型不同，deepEqual 会误判，所以比长度
  assert.equal(result.candidates.length, 0);
  assert.equal(analyzeChord(null).primary, null);
});

test('无法归类的两音不硬凑和弦', () => {
  // C + D 既不是三和弦也不是五度，旧版会直接显示 -
  assert.equal(symbol([60, 62]), null);
});

test('不再有复合和弦读法：低音 + 上层和弦只按音级集合解读', () => {
  // D2 + C4-E4-G4 以前会读成 C/D，现在只按音级集合读作 D9sus4（候选里保留 Cadd9/D）
  const result = analyzeChord([38, 60, 64, 67]);
  assert.equal(result.primary.symbol, 'D9sus4');
  const symbols = result.candidates.map(candidate => candidate.symbol);
  assert.equal(symbols.join(' , '), 'D9sus4 , Cadd9/D');
  for (const candidate of result.candidates) {
    assert.equal(candidate.kind, undefined, '候选不再带来源标注');
    assert.equal(candidate.upper, undefined, '候选不再带上层和弦');
  }

  // G2 + D4-F4-A4-C5：只读成 G9sus4，不再给 Dm7/G
  const spread = analyzeChord([43, 62, 65, 69, 72]);
  assert.equal(spread.primary.symbol, 'G9sus4');
  assert.ok(!spread.candidates.some(candidate => candidate.symbol.includes('Dm7/G')));
});

test('候选数量受限，且不再返回 mode 字段', () => {
  const result = analyzeChord([60, 64, 67], { maxCandidates: 2 });
  assert.equal(result.mode, undefined, '识别只有一个模式，不再返回 mode');
  assert.ok(result.candidates.length <= 2);
});

/* ------------------------------------------------------------------ *
 * 词典自身的完整性
 * ------------------------------------------------------------------ */

test('词典没有重复定义，也没有被覆盖的键', () => {
  const dictionary = chordDictionary();
  const keys = Object.keys(dictionary);

  assert.ok(keys.length >= 68, `和弦形态太少：${keys.length}`);

  let entryCount = 0;
  for (const key of keys) {
    const entries = dictionary[key];
    entryCount += entries.length;

    const qualities = entries.map(entry => entry.quality);
    assert.equal(
      new Set(qualities).size,
      qualities.length,
      `key ${key} 存在重复后缀：${qualities.join(',')}`,
    );

    const intervals = key.split(',').map(Number);
    assert.equal(intervals[0], 0, `key ${key} 必须以根音 0 开头`);
    assert.deepEqual(
      intervals,
      [...intervals].sort((a, b) => a - b),
      `key ${key} 未按升序排列`,
    );
    for (const interval of intervals) {
      assert.ok(
        Number.isInteger(interval) && interval >= 0 && interval <= 11,
        `key ${key} 出现八度外音程 ${interval}（应全部压到 0–11）`,
      );
    }
    // 常用度必须降序，主读法永远取第一个
    for (let i = 1; i < entries.length; i++) {
      assert.ok(entries[i - 1].priority >= entries[i].priority, `key ${key} 常用度未降序`);
    }
  }

  // 目前 70 个音级集合 / 72 条形态：其中 0,3,6 与 0,3,9 各带两种解释。
  // 这里只卡下限，防止后续增删和弦时又出现「同一 key 被静默覆盖」。
  assert.ok(entryCount >= 70, `和弦条目太少：${entryCount}`);
});

test('同一组音可以有多种解释（不再被覆盖）', () => {
  const dictionary = chordDictionary();
  assert.ok(dictionary['0,3,6'].some(entry => entry.quality === 'dim'));
  assert.ok(dictionary['0,3,6'].some(entry => entry.quality === 'm7b5'));
  assert.ok(dictionary['0,3,9'].some(entry => entry.quality === 'm6'));
  assert.ok(dictionary['0,3,9'].some(entry => entry.quality === 'dim7'));
});

test('常用和弦的常用度排序', () => {
  assert.equal(chordDictionary()['0,4,7'][0].quality, '');
  assert.equal(chordDictionary()['0,3,6'][0].quality, 'dim');
  assert.equal(chordDictionary()['0,2,4,7,10'][0].quality, '9');
  assert.equal(chordDictionary()['0,2,4,7,9,10'][0].quality, '13');
  assert.equal(chordDictionary()['0,2,4,7,9,11'][0].quality, 'maj13');
  assert.equal(chordDictionary()['0,2,4,7,11'][0].quality, 'maj9');

  // 该后缀必须真的存在，而不是 0（0 表示"没这条"）
  assert.ok(chordPriority('add9', [0, 2, 4, 7]) > 0);
  assert.equal(chordPriority('add9', [0, 4, 7]), 0);
});
