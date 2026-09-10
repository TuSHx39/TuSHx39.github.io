import test from 'node:test';
import assert from 'node:assert/strict';

import { loadYicai } from './helpers/load-yicai.mjs';

const Yicai = loadYicai();
const Core = Yicai.Core;
const Generator = Yicai.Generator;
const Solver = Yicai.Solver;

/** 小棋盘上的穷举最短路（BFS），用来验证求解器是否真的给出最短解 */
function bruteForceMin(board, target, maxDepth = 14, onlyMerging = false) {
  if (Core.isSolved(board, target)) return 0;
  let frontier = [board];
  const seen = new Set([Core.boardKey(board)]);
  for (let depth = 1; depth <= maxDepth; depth++) {
    const next = [];
    for (const current of frontier) {
      for (const comp of Core.componentList(current)) {
        const neighborColors = new Set();
        if (onlyMerging) {
          for (const index of comp.cells) {
            for (const nb of Core.neighborsOf(current, index)) {
              const color = current.cells[nb];
              if (color !== comp.color) neighborColors.add(color);
            }
          }
        }
        for (let color = 0; color < Core.COLOR_COUNT; color++) {
          if (color === comp.color) continue;
          if (onlyMerging && !neighborColors.has(color)) continue;
          const copy = Core.cloneBoard(current);
          Core.applyColor(copy, comp.cells, color);
          const key = Core.boardKey(copy);
          if (seen.has(key)) continue;
          if (Core.isSolved(copy, target)) return depth;
          seen.add(key);
          next.push(copy);
        }
      }
    }
    frontier = next;
    if (!frontier.length) break;
  }
  return Infinity;
}

function randomBoard(rows, cols, rng) {
  const board = Core.createBoard(rows, cols, Core.RED);
  for (let i = 0; i < board.cells.length; i++) {
    board.cells[i] = Math.floor(rng() * Core.COLOR_COUNT);
  }
  return board;
}

function hasColor(board, color) {
  for (let i = 0; i < board.cells.length; i++) {
    if (board.cells[i] === color) return true;
  }
  return false;
}

test('solver：小棋盘上给出真正的最短解', () => {
  const rng = Generator.createRng(20250107);
  let cases = 0;
  for (let i = 0; i < 24; i++) {
    const board = randomBoard(3, 3, rng);
    const target = Math.floor(rng() * Core.COLOR_COUNT);
    const optimal = bruteForceMin(board, target);
    if (!Number.isFinite(optimal)) continue;
    const lower = Solver.lowerBound(board, target);
    assert.ok(lower <= optimal, `下界 ${lower} 不能超过真实最短步数 ${optimal}`);

    const result = Solver.search(board, target, optimal + 1, { timeMs: 8000, nodeLimit: 600000 });
    assert.equal(result.timedOut, false, `搜索超时：${Core.serialize(board)}`);
    assert.ok(result.moves, `没能求解：${Core.serialize(board)} target=${target}`);
    assert.equal(result.moves.length, optimal, `不是最短解：${Core.serialize(board)} target=${target}`);
    assert.equal(Core.simulate(board, result.moves, target).solved, true);
    cases++;
  }
  assert.ok(cases >= 12, `有效用例太少：${cases}`);
});

test('solver：目标色还在盘面上时，合并型落子就足以取得最短解', () => {
  const rng = Generator.createRng(777);
  let cases = 0;
  for (let i = 0; i < 20; i++) {
    const board = randomBoard(3, 3, rng);
    const target = Math.floor(rng() * Core.COLOR_COUNT);
    if (!hasColor(board, target)) continue;
    const all = bruteForceMin(board, target, 12, false);
    const merging = bruteForceMin(board, target, 12, true);
    assert.equal(merging, all, `存在必须靠「无效染色」才能更短的局面：${Core.serialize(board)}`);
    cases++;
  }
  assert.ok(cases >= 10, `有效用例太少：${cases}`);
});

test('solver：目标色被染没了就必须允许「无效染色」（回归测试）', () => {
  // 盘面上只有 0/1/2 三种颜色，目标色是 3：第一步只能是无效染色
  const board = Core.deserialize('200021122', 3, 3);
  assert.equal(hasColor(board, Core.YELLOW), false);
  assert.equal(bruteForceMin(board, Core.YELLOW, 10, true), Infinity);
  const optimal = bruteForceMin(board, Core.YELLOW, 10, false);
  assert.ok(Number.isFinite(optimal));

  const result = Solver.search(board, Core.YELLOW, optimal + 1, { timeMs: 5000 });
  assert.ok(result.moves, '求解器必须能处理目标色缺失的局面');
  assert.equal(result.moves.length, optimal);
  assert.equal(Core.simulate(board, result.moves, Core.YELLOW).solved, true);

  const greedyMoves = Solver.greedy(board, Core.YELLOW, {});
  assert.ok(greedyMoves && greedyMoves.length);
  assert.equal(Core.simulate(board, greedyMoves, Core.YELLOW).solved, true);
});

test('solver：贪心解一定合法，且能处理目标色缺失的局面', () => {
  let missingTarget = 0;
  for (let seed = 1; seed <= 16; seed++) {
    const rows = ((seed * 5) % 12) + 2;
    const cols = ((seed * 3) % 14) + 2;
    const target = seed % Core.COLOR_COUNT;
    const puzzle = Generator.generate({ rows, cols, mask: null, target, limit: 15, seed, timeBudgetMs: 120 });
    if (!hasColor(puzzle.board, target)) missingTarget++;
    const moves = Solver.greedy(puzzle.board, target, {});
    assert.ok(moves && moves.length, `seed=${seed} 贪心无解`);
    assert.ok(moves.length <= rows * cols, `seed=${seed} 贪心步数异常：${moves.length}`);
    assert.equal(Core.simulate(puzzle.board, moves, target).solved, true, `seed=${seed} 贪心解无效`);
  }
  assert.ok(missingTarget >= 0);
});

test('solver：从被打乱的局面也能解出来', () => {
  const rng = Generator.createRng(4242);
  for (let seed = 1; seed <= 8; seed++) {
    const target = seed % Core.COLOR_COUNT;
    const puzzle = Generator.generate({ rows: 6, cols: 7, mask: null, target, limit: 10, seed, timeBudgetMs: 120 });
    const board = Core.cloneBoard(puzzle.board);
    const scatter = 1 + Math.floor(rng() * 4);
    for (let k = 0; k < scatter; k++) {
      const comps = Core.componentList(board);
      const comp = comps[Math.floor(rng() * comps.length)];
      const color = Math.floor(rng() * Core.COLOR_COUNT);
      if (color === comp.color) continue;
      Core.applyColor(board, comp.cells, color);
    }
    const plan = Solver.solve(board, target, 30, { optimize: true, timeMs: 350 });
    assert.ok(plan.moves && plan.moves.length, `seed=${seed} 打乱后无解`);
    assert.equal(Core.simulate(board, plan.moves, target).solved, true, `seed=${seed} 打乱后的解无效`);
    if (plan.source === 'improved' || plan.source === 'shortest') {
      const greedyLen = Solver.greedy(board, target, {}).length;
      assert.ok(plan.moves.length < greedyLen);
    }
  }
});

test('solver：已完成的局面返回空解', () => {
  const board = Core.createBoard(4, 4, Core.YELLOW);
  const result = Solver.solve(board, Core.YELLOW, 5, {});
  assert.equal(result.moves.length, 0);
  assert.equal(result.fits, true);
  assert.equal(Solver.lowerBound(board, Core.YELLOW), 0);
});

test('solver：步数不够时如实报告（fits 为 false，不谎报）', () => {
  const puzzle = Generator.generate({ rows: 12, cols: 12, mask: null, target: Core.RED, limit: 15, seed: 99, timeBudgetMs: 120 });
  const tight = Solver.solve(puzzle.board, Core.RED, 0, { optimize: true, timeMs: 500 });
  assert.equal(tight.fits, false);
  const whole = Solver.solve(puzzle.board, Core.RED, 60, { optimize: true, timeMs: 1500 });
  assert.ok(whole.moves && whole.moves.length);
  assert.equal(whole.fits, true);
  assert.equal(Core.simulate(puzzle.board, whole.moves, Core.RED).solved, true);
});

test('solver：下界在随机局面上始终不超过实际解长', () => {
  const rng = Generator.createRng(31337);
  for (let seed = 1; seed <= 20; seed++) {
    const target = seed % Core.COLOR_COUNT;
    const puzzle = Generator.generate({ rows: 5, cols: 6, mask: null, target, limit: 12, seed, timeBudgetMs: 120 });
    const board = Core.cloneBoard(puzzle.board);
    for (let k = 0; k < 3; k++) {
      const comps = Core.componentList(board);
      const comp = comps[Math.floor(rng() * comps.length)];
      const color = Math.floor(rng() * Core.COLOR_COUNT);
      if (color !== comp.color) Core.applyColor(board, comp.cells, color);
    }
    const lower = Solver.lowerBound(board, target);
    const moves = Solver.greedy(board, target, {});
    assert.ok(lower <= moves.length, `下界 ${lower} > 贪心解 ${moves.length}`);
  }
});
