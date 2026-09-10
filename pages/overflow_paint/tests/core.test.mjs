import test from 'node:test';
import assert from 'node:assert/strict';

import { loadYicai, readHtml, scriptSources, projectRoot } from './helpers/load-yicai.mjs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const Yicai = loadYicai();
const Core = Yicai.Core;

test('core：颜色与常量', () => {
  assert.equal(Core.COLOR_COUNT, 4);
  assert.equal(Core.COLORS.length, 4);
  assert.deepEqual(
    Array.from(Core.COLORS, (c) => c.name),
    ['红', '绿', '蓝', '黄']
  );
  assert.equal(Core.isValidColor(0), true);
  assert.equal(Core.isValidColor(3), true);
  assert.equal(Core.isValidColor(4), false);
  assert.equal(Core.isValidColor(-1), false);
  assert.equal(Core.MAX_LIMIT, 15);
  assert.equal(Core.clampLimit(0), 1);
  assert.equal(Core.clampLimit(99), 15);
  assert.equal(Core.clampLimit(7.4), 7);
});

test('core：棋盘构造与序列化', () => {
  const board = Core.createBoard(3, 4, Core.RED);
  assert.equal(board.cells.length, 12);
  assert.equal(Core.activeCount(board), 12);
  assert.equal(Core.cellIndex(board, 2, 3), 11);
  assert.equal(Core.rowOf(board, 11), 2);
  assert.equal(Core.colOf(board, 11), 3);

  const text = Core.serialize(board);
  assert.equal(text, '0'.repeat(12));
  const back = Core.deserialize(text, 3, 4);
  assert.ok(Core.boardEquals(board, back));
  assert.equal(Core.deserialize('0'.repeat(11), 3, 4), null);
  assert.equal(Core.deserialize('0'.repeat(11) + 'z', 3, 4), null);
});

test('core：四连通块的识别与染色', () => {
  // 0 0 1
  // 0 1 1
  // 2 2 2
  const text = '001011222';
  const board = Core.deserialize(text, 3, 3);
  const comp = Array.from(Core.componentAt(board, 0)).sort((a, b) => a - b);
  assert.deepEqual(comp, [0, 1, 3]);
  assert.deepEqual(Array.from(Core.componentAt(board, 2)).sort((a, b) => a - b), [2, 4, 5]);
  assert.deepEqual(Array.from(Core.componentAt(board, 6)).sort((a, b) => a - b), [6, 7, 8]);

  const move = Core.applyMove(board, 0, Core.BLUE);
  assert.equal(move.from, Core.RED);
  assert.deepEqual(Array.from(move.cells).sort((a, b) => a - b), [0, 1, 3]);
  assert.equal(Core.serialize(board), '221211222');

  // 同色落子是无效操作
  assert.equal(Core.applyMove(board, 0, Core.BLUE), null);
  // 空洞不是合法落子点
  const holed = Core.boardFromMask(3, 3, Core.maskFromPattern(['##.', '###', '.##']).mask, Core.RED);
  assert.equal(Core.applyMove(holed, 2, Core.BLUE), null);
  assert.equal(Core.isActive(holed, 2), false);
});

test('core：胜负判定与连通分组', () => {
  const board = Core.deserialize('0011', 2, 2);
  assert.equal(Core.isSolved(Core.deserialize('1111', 2, 2), Core.GREEN), true);
  assert.equal(Core.isSolved(board, Core.GREEN), false);

  const mask = Core.maskFromPattern(['#.#', '.#.', '#.#']).mask;
  const holed = Core.boardFromMask(3, 3, mask, Core.YELLOW);
  assert.equal(Core.connectedGroups(holed).length, 5);
  assert.equal(Core.activeCount(holed), 5);
});

test('core：simulate 与实际落子一致', () => {
  const board = Core.deserialize('001011222', 3, 3);
  const moves = [
    { index: 0, color: Core.GREEN },
    { index: 6, color: Core.GREEN },
  ];
  const result = Core.simulate(board, moves, Core.GREEN);
  assert.equal(result.solved, true);
  assert.equal(result.applied.length, 2);
  assert.equal(result.applied[0].from, Core.RED);
  // 原棋盘不受影响
  assert.equal(Core.serialize(board), '001011222');
});

test('core：图案预设与代表格', () => {
  const heart = Core.maskFromPattern([
    '..........',
    '.###..###.',
    '##########',
  ]);
  assert.equal(heart.rows, 3);
  assert.equal(heart.cols, 10);
  assert.equal(Core.maskCount(heart.mask), 6 + 10);
  assert.throws(() => Core.maskFromPattern(['##', '#']), /长度/);

  const board = Core.deserialize('0011', 2, 2);
  const rep = Core.representativeIndex(board, [0, 1, 2, 3]);
  assert.ok([0, 1, 2, 3].includes(rep));
});

test('core：boardKey 只依赖内容', () => {
  const a = Core.deserialize('001011222', 3, 3);
  const b = Core.deserialize('001011222', 3, 3);
  const c = Core.deserialize('001011223', 3, 3);
  assert.equal(Core.boardKey(a), Core.boardKey(b));
  assert.notEqual(Core.boardKey(a), Core.boardKey(c));
});

test('页面：HTML 引用的脚本都存在，且加载顺序正确', () => {
  const sources = scriptSources();
  assert.ok(sources.length >= 5, 'HTML 应该引入 core/generator/solver/store/app');
  for (const src of sources) {
    assert.ok(existsSync(join(projectRoot, src)), `缺少脚本：${src}`);
  }
  assert.match(sources[sources.length - 1], /app\.js$/);
  const html = readHtml();
  for (const id of ['board', 'palette', 'btn-hint', 'btn-answer', 'options-modal', 'answer-modal', 'mask-grid']) {
    assert.ok(html.includes(`id="${id}"`), `HTML 缺少 #${id}`);
  }
});
