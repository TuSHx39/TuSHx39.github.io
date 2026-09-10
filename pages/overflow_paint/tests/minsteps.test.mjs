import test from 'node:test';
import assert from 'node:assert/strict';

import { loadYicai } from './helpers/load-yicai.mjs';

const Yicai = loadYicai();
const Core = Yicai.Core;
const Generator = Yicai.Generator;
const Solver = Yicai.Solver;
const MinSteps = Yicai.MinSteps;

/** 一直算到结束（分片驱动，模拟页面里的 setTimeout 循环） */
function runToEnd(job, sliceMs = 4, guard = 20000) {
  let n = 0;
  while (job.step(sliceMs) && n++ < guard) {
    /* 分片推进 */
  }
  return job.state;
}

/** 暴力枚举：逐步加深，找出最少步数（小盘面用） */
function bruteForceMin(board, target, cap) {
  const work = Core.cloneBoard(board);
  for (let limit = 0; limit <= cap; limit++) {
    if (dfs(0, limit)) return limit;
  }
  return Infinity;

  function dfs(depth, limit) {
    if (Core.isSolved(work, target)) return true;
    if (depth >= limit) return false;
    for (const comp of Core.componentList(work)) {
      for (let color = 0; color < 4; color++) {
        if (color === comp.color) continue;
        const saved = comp.cells.map((i) => work.cells[i]);
        Core.applyColor(work, comp.cells, color);
        const ok = dfs(depth + 1, limit);
        comp.cells.forEach((cell, k) => {
          work.cells[cell] = saved[k];
        });
        if (ok) return true;
      }
    }
    return false;
  }
}

test('minsteps：小盘面上算出的就是确切最短步数', () => {
  const rng = Generator.createRng(20250210);
  let cases = 0;
  for (let i = 0; i < 10; i++) {
    const board = Generator.randomPuzzle(4, 4, null, Core.YELLOW, rng, 1);
    const brute = bruteForceMin(board, Core.YELLOW, 8);
    assert.ok(Number.isFinite(brute), '暴力搜索应该能在 8 步内找到解');
    const job = MinSteps.createJob(board, Core.YELLOW, { maxDepth: 12 });
    const state = runToEnd(job);
    assert.equal(state.status, 'done', `没算完：${Core.serialize(board)}`);
    assert.equal(state.exact, brute, `最短步数不对：${Core.serialize(board)}`);
    // 找到的解法必须真的能通关
    assert.ok(state.solution && state.solution.length === brute);
    assert.equal(Core.simulate(board, state.solution, Core.YELLOW).solved, true);
    cases++;
  }
  assert.equal(cases, 10);
});

test('minsteps：与求解器搜索得到的最短解一致', () => {
  for (let seed = 1; seed <= 6; seed++) {
    const board = Generator.randomPuzzle(5, 5, null, Core.RED, Generator.createRng(seed * 97), 1);
    const job = MinSteps.createJob(board, Core.RED, { maxDepth: 14 });
    const state = runToEnd(job, 2);
    assert.equal(state.status, 'done');
    const reference = Solver.search(board, Core.RED, state.exact + 1, { timeMs: 8000 });
    assert.ok(reference.moves, '求解器也应该能解出来');
    assert.equal(reference.moves.length, state.exact, `与求解器不一致：${Core.serialize(board)}`);
  }
});

test('minsteps：分片大小不影响结果（可以随时暂停/继续）', () => {
  const board = Generator.randomPuzzle(4, 5, null, Core.GREEN, Generator.createRng(555), 1);
  const fast = runToEnd(MinSteps.createJob(board, Core.GREEN, { maxDepth: 12 }), 50);
  const slow = runToEnd(MinSteps.createJob(board, Core.GREEN, { maxDepth: 12 }), 1);
  assert.equal(fast.status, 'done');
  assert.equal(slow.status, 'done');
  assert.equal(fast.exact, slow.exact);
  assert.equal(fast.provenLower, slow.provenLower);
});

test('minsteps：下界只会往上抬，且永远不超过确切最短步数', () => {
  const board = Generator.randomPuzzle(5, 5, null, Core.BLUE, Generator.createRng(31337), 1);
  const job = MinSteps.createJob(board, Core.BLUE, { maxDepth: 14 });
  let last = job.state.provenLower;
  let steps = 0;
  // 一步一步推进，检查单调性与合法性
  while (job.step(1) && steps++ < 4000) {
    assert.ok(job.state.provenLower >= last, '下界不能下降');
    last = job.state.provenLower;
    if (job.state.exact != null) {
      assert.ok(job.state.provenLower <= job.state.exact, '下界不能超过确切最短步数');
    }
  }
  assert.equal(job.state.status, 'done');
  assert.ok(job.state.provenLower <= job.state.exact);
  assert.ok(job.state.nodes > 0);
});

test('minsteps：没算完就停下不会崩，且棋盘状态可复用', () => {
  const board = Generator.randomPuzzle(6, 6, null, Core.YELLOW, Generator.createRng(9), 1);
  const before = Core.serialize(board);
  const job = MinSteps.createJob(board, Core.YELLOW, { maxDepth: 20 });
  job.step(2);
  assert.equal(job.state.status, 'running');
  job.stop();
  assert.equal(job.state.status, 'stopped');
  assert.equal(job.step(2), false, '停下之后 step 应立刻返回 false');
  assert.equal(Core.serialize(board), before, '原始盘面不该被改动');
});

test('minsteps：已经完成的局面最短步数是 0', () => {
  const board = Core.createBoard(3, 3, Core.YELLOW);
  const job = MinSteps.createJob(board, Core.YELLOW, {});
  assert.equal(job.state.status, 'done');
  assert.equal(job.state.exact, 0);
  assert.equal(job.state.provenLower, 0);
});

test('minsteps：countOptimal 能数出最优解的个数（与暴力枚举一致）', () => {
  // 暴力数出「不超过 depth 步通关」的解法个数（depth 为确切最短步数时即最优解个数），封顶 2
  function bruteCount(board, target, depth) {
    const work = Core.cloneBoard(board);
    let count = 0;
    const walk = (d) => {
      if (count >= 2) return;
      if (Core.isSolved(work, target)) {
        count++;
        return;
      }
      if (d >= depth) return;
      for (const comp of Core.componentList(work)) {
        for (let color = 0; color < 4; color++) {
          if (color === comp.color) continue;
          const saved = comp.cells.map((i) => work.cells[i]);
          Core.applyColor(work, comp.cells, color);
          walk(d + 1);
          comp.cells.forEach((cell, k) => {
            work.cells[cell] = saved[k];
          });
          if (count >= 2) return;
        }
      }
    };
    walk(0);
    return count;
  }

  const rng = Generator.createRng(4242);
  let uniques = 0;
  let multis = 0;
  for (let i = 0; i < 8; i++) {
    const board = Generator.randomPuzzle(4, 4, null, Core.YELLOW, rng, 1);
    const job = MinSteps.createJob(board, Core.YELLOW, { maxDepth: 12, countOptimal: true });
    const state = runToEnd(job, 4, 40000);
    assert.equal(state.status, 'done', `没算完：${Core.serialize(board)}`);
    const brute = Math.min(2, bruteCount(board, Core.YELLOW, state.exact));
    assert.equal(
      state.optimalCount,
      brute,
      `最优解个数不一致：${Core.serialize(board)}（最短 ${state.exact} 步）`
    );
    assert.ok(state.optimalCount === 1 || state.optimalCount === 2);
    assert.equal(state.solution.length, state.exact, '给出的解就是最短解');
    assert.equal(Core.simulate(board, state.solution, Core.YELLOW).solved, true);
    if (state.optimalCount === 1) uniques++;
    else multis++;
  }
  // 小盘面上两种情形都有样本，说明统计确实在起作用
  assert.ok(uniques + multis === 8);
});

test('minsteps：不开 countOptimal 时行为与以前一致（不数个数、找到解就停）', () => {
  const board = Generator.randomPuzzle(4, 4, null, Core.YELLOW, Generator.createRng(77), 1);
  const job = MinSteps.createJob(board, Core.YELLOW, { maxDepth: 12 });
  const state = runToEnd(job, 4, 40000);
  assert.equal(state.status, 'done');
  assert.equal(state.optimalCount, null);
  assert.equal(Core.simulate(board, state.solution, Core.YELLOW).solved, true);
});

test('minsteps：唯一解 / 多解两个方向都能数准（手工构造）', () => {
  // 0011 → 目标 1：『00』一块，1 步即可，且只有这一种 1 步解法 → 唯一解
  const uniqueBoard = Core.deserialize('0011', 2, 2);
  const jobA = MinSteps.createJob(uniqueBoard, 1, { maxDepth: 6, countOptimal: true });
  const stateA = runToEnd(jobA, 4, 20000);
  assert.equal(stateA.exact, 1);
  assert.equal(stateA.optimalCount, 1);

  // 0110 → 目标 1：两个 0 格子互不相邻，各要点一次，先后顺序两种 → 多解
  const multiBoard = Core.deserialize('0110', 2, 2);
  const jobB = MinSteps.createJob(multiBoard, 1, { maxDepth: 6, countOptimal: true });
  const stateB = runToEnd(jobB, 4, 20000);
  assert.equal(stateB.exact, 2);
  assert.equal(stateB.optimalCount, 2);
});

test('minsteps：带空洞的图形也能精确计算', () => {
  const mask = Core.maskFromPattern(['##.##', '#...#', '#.#.#', '##.##', '.###.']).mask;
  const puzzle = Generator.generate({
    rows: 5,
    cols: 5,
    mask,
    target: Core.YELLOW,
    limit: 5,
    seed: 4,
    timeBudgetMs: 120,
  });
  const job = MinSteps.createJob(puzzle.board, puzzle.target, { maxDepth: 12 });
  const state = runToEnd(job, 4, 40000);
  assert.equal(state.status, 'done');
  assert.ok(state.exact <= puzzle.steps, '确切最短步数不该超过出题时给的参考解');
  assert.equal(Core.simulate(puzzle.board, state.solution, puzzle.target).solved, true);
});