import test from 'node:test';
import assert from 'node:assert/strict';

import { loadYicai } from './helpers/load-yicai.mjs';

const Yicai = loadYicai();
const Core = Yicai.Core;
const Generator = Yicai.Generator;
const Share = Yicai.Share;

test('share：矩形题目分享码可逆，且长度够短', () => {
  for (const cfg of [
    { rows: 8, cols: 10, limit: 8 },
    { rows: 4, cols: 4, limit: 4 },
    { rows: 15, cols: 20, limit: 15 },
  ]) {
    const puzzle = Generator.generate({
      rows: cfg.rows,
      cols: cfg.cols,
      mask: null,
      target: Core.YELLOW,
      limit: cfg.limit,
      seed: cfg.rows * 100 + cfg.cols,
      timeBudgetMs: 120,
    });
    const code = Share.encode(puzzle);
    assert.ok(code.startsWith('YC'), '分享码应以 YC 开头');
    assert.ok(code.length > 8);
    // 「较短」的底线：总量不超过「格数 + 固定头部」，也就是每格远小于一个字符
    assert.ok(code.length <= cfg.rows * cfg.cols + 16, `分享码太长：${code.length}`);
    const back = Share.decode(code);
    assert.ok(back, '分享码应该能解回来');
    assert.equal(back.rows, cfg.rows);
    assert.equal(back.cols, cfg.cols);
    assert.equal(back.target, puzzle.target);
    assert.equal(back.limit, puzzle.limit);
    assert.equal(Core.serialize(back.board), Core.serialize(puzzle.board));
    assert.deepEqual(
      back.solution.map((m) => [m.index, m.color]),
      puzzle.solution.map((m) => [m.index, m.color])
    );
  }
});

test('share：自绘图形（带空洞）也能原样还原', () => {
  const mask = Core.maskFromPattern([
    '..........', '.###..###.', '##########', '##########', '##########',
    '.########.', '..######..', '...####...', '....##....', '..........',
  ]).mask;
  const puzzle = Generator.generate({
    rows: 10,
    cols: 10,
    mask,
    target: Core.BLUE,
    limit: 10,
    seed: 42,
    timeBudgetMs: 120,
  });
  const code = Share.encode(puzzle);
  const back = Share.decode(code);
  assert.ok(back);
  assert.equal(Core.serialize(back.board), Core.serialize(puzzle.board));
  // 空洞位置必须一模一样
  for (let i = 0; i < mask.length; i++) {
    assert.equal(back.board.cells[i] === Core.HOLE, mask[i] === 0, `第 ${i} 格空洞状态不一致`);
  }
});

test('share：只看题目本身（不含解法）也能编码', () => {
  const board = Core.deserialize('00112200', 2, 4);
  const code = Share.encode({ rows: 2, cols: 4, target: Core.YELLOW, limit: 3, board, solution: [] });
  const back = Share.decode(code);
  assert.ok(back);
  assert.equal(Core.serialize(back.board), Core.serialize(board));
  assert.equal(back.solution.length, 0);
});

test('share：坏码一律判为无效，不会抛异常', () => {
  const puzzle = Generator.generate({ rows: 5, cols: 5, mask: null, target: Core.RED, limit: 5, seed: 3, timeBudgetMs: 120 });
  const good = Share.encode(puzzle);
  assert.equal(Share.decode(''), null);
  assert.equal(Share.decode('hello world'), null);
  assert.equal(Share.decode('YC'), null);
  assert.equal(Share.decode(good.slice(0, good.length - 4)), null, '被截断的码应无效');
  const swapped = good.slice(0, 6) + (good[6] === 'A' ? 'B' : 'A') + good.slice(7);
  assert.equal(Share.decode(swapped), null, '被改动的码应无效');
  assert.equal(Share.decode(null), null);
  assert.equal(Share.decode(12345), null);
});

test('share：编码后再解码再编码是稳定的', () => {
  const puzzle = Generator.generate({ rows: 6, cols: 8, mask: null, target: Core.GREEN, limit: 9, seed: 11, timeBudgetMs: 120 });
  const first = Share.encode(puzzle);
  const back = Share.decode(first);
  const second = Share.encode(back);
  assert.equal(first, second);
});
