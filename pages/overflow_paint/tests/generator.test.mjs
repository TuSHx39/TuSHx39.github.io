import test from 'node:test';
import assert from 'node:assert/strict';

import { loadYicai } from './helpers/load-yicai.mjs';

const Yicai = loadYicai();
const Core = Yicai.Core;
const Generator = Yicai.Generator;
const Solver = Yicai.Solver;

const SHAPES = {
  rect_10x8: { rows: 8, cols: 10 },
  rect_2x1: { rows: 1, cols: 2 },
  rect_6x5: { rows: 5, cols: 6 },
  rect_12x9: { rows: 9, cols: 12 },
};

function maskOf(pattern) {
  return Core.maskFromPattern(pattern).mask;
}

/** 出题都会返回一个经过模拟验证的解，这里统一检查 */
function assertSolvable(puzzle, label) {
  assert.equal(puzzle.verified, true, `${label}: verified 应为 true`);
  assert.ok(puzzle.steps >= 0);
  assert.ok(puzzle.steps <= puzzle.limit, `${label}: 解 ${puzzle.steps} 步 > 限制 ${puzzle.limit} 步`);
  const result = Core.simulate(puzzle.board, puzzle.solution, puzzle.target);
  assert.equal(result.solved, true, `${label}: 参考解无效`);
  for (const applied of result.applied) assert.equal(applied.noop, false, `${label}: 参考解含空操作`);
  if (puzzle.steps === 0) return;
  assert.equal(Core.isSolved(puzzle.board, puzzle.target), false, `${label}: 题目不应开局即完成`);
}

test('generator：逆向染色严格可逆（切出来的块一定是独立连通块）', () => {
  for (let seed = 1; seed <= 12; seed++) {
    const board = Core.createBoard(8, 10, Core.YELLOW);
    const rng = Generator.createRng(seed);
    const moves = Generator.reverseGenerate(board, Core.YELLOW, 8, rng, {
      strict: true,
      maxSameNeighbors: 2,
      byDegree: true,
      allowTarget: true,
    });
    assert.ok(moves.length > 0);
    // 反向步骤倒过来就是正向解法：逐步回放必须每步都能合并
    const work = Core.cloneBoard(board);
    let components = Core.componentList(work).length;
    for (const move of moves) {
      const color = work.cells[move.index];
      assert.notEqual(color, move.color, '不该出现空操作');
      const region = Core.componentAt(work, move.index);
      Core.applyColor(work, region, move.color);
      const after = Core.componentList(work).length;
      assert.ok(after < components, '每一步都应该并掉至少一块');
      components = after;
    }
    assert.equal(Core.isSolved(work, Core.YELLOW), true);
  }
});

test('generator：逆向染色的盘面满足「同色邻居不超过 maxSame」', () => {
  for (let seed = 1; seed <= 10; seed++) {
    const board = Core.createBoard(9, 9, Core.RED);
    const rng = Generator.createRng(seed * 31);
    Generator.reverseGenerate(board, Core.RED, 9, rng, {
      strict: true,
      maxSameNeighbors: 1,
      byDegree: true,
      allowTarget: true,
    });
    const stats = Generator.neighborColorStats(board);
    assert.ok(stats.worst <= 1, `worst=${stats.worst} 超过 1`);
  }
});

test('generator：切分必须保持「剩下的部分仍然连通」', () => {
  const board = Core.deserialize('000000111111', 2, 6);
  const comp = Core.componentList(board).find((c) => c.cells.length === 6);
  assert.ok(comp);
  for (let seed = 1; seed <= 30; seed++) {
    const rng = Generator.createRng(seed);
    const region = Generator.pickSplitRegion(board, comp, rng, {});
    if (!region) continue;
    assert.ok(region.length < comp.cells.length);
    assert.equal(Generator.remainderConnected(board, comp.cells, region), true);
    assert.equal(Generator.subsetConnected(board, region), true);
  }
});

test('generator：随机拼块生成器可复现', () => {
  const a = Generator.randomPuzzle(8, 10, null, Core.YELLOW, Generator.createRng(2024), 2);
  const b = Generator.randomPuzzle(8, 10, null, Core.YELLOW, Generator.createRng(2024), 2);
  assert.equal(Core.serialize(a), Core.serialize(b));
  const c = Generator.randomPuzzle(8, 10, null, Core.YELLOW, Generator.createRng(2025), 2);
  assert.notEqual(Core.serialize(a), Core.serialize(c));
  // 平滑之后碎片应该更少
  const raw = Generator.randomPuzzle(8, 10, null, Core.YELLOW, Generator.createRng(7), 0);
  const smooth = Generator.randomPuzzle(8, 10, null, Core.YELLOW, Generator.createRng(7), 3);
  assert.ok(Core.componentList(smooth).length <= Core.componentList(raw).length);
});

test('generator：出题一定给出可解、且贴合限制步数的题目', () => {
  for (const [name, shape] of Object.entries(SHAPES)) {
    for (let seed = 1; seed <= 3; seed++) {
      const cap = ((seed * 5) % Core.MAX_LIMIT) + 1;
      const puzzle = Generator.generate({
        rows: shape.rows,
        cols: shape.cols,
        mask: null,
        target: seed % Core.COLOR_COUNT,
        limit: cap,
        seed,
        timeBudgetMs: 150,
      });
      assert.ok(puzzle.limit <= cap, `${name}: 收紧后的限制 ${puzzle.limit} 不能超过上限 ${cap}`);
      assertSolvable(puzzle, `${name} seed=${seed}`);
      assert.ok(puzzle.components >= 1);
      assert.ok(puzzle.colors >= 1);
      assert.ok(['random', 'reverse', 'fallback', 'trivial'].includes(puzzle.source));
    }
  }
});

test('generator：自绘图形（含空洞、断开的图形）同样能出题', () => {
  const shapes = {
    heart: [
      '..........', '.###..###.', '##########', '##########', '##########',
      '.########.', '..######..', '...####...', '....##....', '..........',
    ],
    split: [
      '##......##', '##......##', '..........', '..........', '..........',
      '..........', '..........', '..........', '.........#', '.........#',
    ],
  };
  for (const [name, pattern] of Object.entries(shapes)) {
    const mask = maskOf(pattern);
    for (let seed = 1; seed <= 3; seed++) {
      const puzzle = Generator.generate({
        rows: 10,
        cols: 10,
        mask,
        target: Core.YELLOW,
        limit: 10,
        seed,
        timeBudgetMs: 150,
      });
      assertSolvable(puzzle, `${name} seed=${seed}`);
      for (let i = 0; i < mask.length; i++) {
        if (!mask[i]) assert.equal(puzzle.board.cells[i], Core.HOLE, '图形之外必须留空');
        else assert.ok(Core.isValidColor(puzzle.board.cells[i]));
      }
    }
  }
});

test('generator：小限制步数也能出题（走逆向染色兜底）', () => {
  for (let cap = 1; cap <= 4; cap++) {
    const puzzle = Generator.generate({
      rows: 8,
      cols: 10,
      mask: null,
      target: Core.GREEN,
      limit: cap,
      seed: cap * 13,
      timeBudgetMs: 150,
    });
    assert.ok(puzzle.limit <= cap);
    assert.ok(puzzle.limit >= 1, '小限制下也不该给出 0 步的题');
    assertSolvable(puzzle, `cap=${cap}`);
  }
});

test('generator：极小图形不会崩，且给出的题目能完成', () => {
  const mask = maskOf([
    '#.........', '..........', '..........', '..........', '..........',
    '.........#', '..........', '..........', '..........', '..........',
  ]);
  const puzzle = Generator.generate({ rows: 10, cols: 10, mask, target: Core.YELLOW, limit: 5, seed: 3, timeBudgetMs: 120 });
  assert.equal(puzzle.trivial, false);
  assert.ok(puzzle.limit >= 1);
  assertSolvable(puzzle, 'tiny');
});

test('generator：唯一解标记只可能是 true / false / null（未验证）', () => {
  for (let seed = 1; seed <= 6; seed++) {
    const puzzle = Generator.generate({
      rows: 5,
      cols: 5,
      mask: null,
      target: Core.YELLOW,
      limit: 5,
      seed,
      timeBudgetMs: 200,
    });
    assert.ok([true, false, null].includes(puzzle.unique), `unique=${puzzle.unique}`);
    if (puzzle.unique === true) assert.equal(puzzle.uniqueCount, 1);
    if (puzzle.unique === false) assert.ok(puzzle.uniqueCount >= 2);
    assertSolvable(puzzle, `unique seed=${seed}`);
  }
});

test('generator：勾选「尽量出唯一解」时优先交回已校验的唯一解题', () => {
  let uniqueFound = 0;
  for (let seed = 1; seed <= 6; seed++) {
    const puzzle = Generator.generate({
      rows: 4,
      cols: 4,
      mask: null,
      target: Core.YELLOW,
      limit: 4,
      seed,
      preferUnique: true,
      timeBudgetMs: 200,
    });
    assertSolvable(puzzle, `preferUnique seed=${seed}`);
    if (puzzle.unique === true) uniqueFound++;
  }
  assert.ok(uniqueFound >= 1, '小棋盘上应该能出到唯一解题');
});

test('solver：countOptimal 数出来的解的个数与穷举一致', () => {
  const rng = Generator.createRng(99);
  for (let seed = 1; seed <= 8; seed++) {
    const board = Generator.randomPuzzle(4, 4, null, Core.YELLOW, rng, 1);
    const cap = 4;
    const counted = Solver.countOptimal(board, Core.YELLOW, cap, { timeMs: 3000, nodeLimit: 500000, maxCount: 8 });
    if (counted.timedOut) continue;
    // 暴力枚举对照
    let brute = 0;
    const adj = Core.buildAdjacency(board);
    const work = Core.cloneBoard(board);
    const walk = (remaining) => {
      if (Core.isSolved(work, Core.YELLOW)) {
        brute++;
        return;
      }
      if (remaining <= 0) return;
      for (const comp of Core.componentList(work)) {
        for (let color = 0; color < 4; color++) {
          if (color === comp.color) continue;
          const saved = comp.cells.map((i) => work.cells[i]);
          Core.applyColor(work, comp.cells, color);
          walk(remaining - 1);
          comp.cells.forEach((cell, k) => {
            work.cells[cell] = saved[k];
          });
        }
      }
    };
    walk(cap);
    assert.equal(counted.count, Math.min(brute, 8), `seed=${seed} 解的个数不一致`);
    assert.ok(Solver.hashState(adj ? work.cells : work.cells).length > 0);
  }
});
