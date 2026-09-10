/**
 * minsteps.js —— 可中断的「精确最短步数」计算器。
 *
 * 算法：迭代加深 + 显式栈（所以可以随时暂停 / 继续，不会阻塞页面）。
 *   · 下界从「颜色数-1」起步（每步最多消掉一种颜色，这是合法下界）；
 *   · 对当前深度 d 做一次完整 DFS：搜完仍无解 → 说明最短步数 > d，
 *     已证下界提升到 d+1，再加深一层；一旦找到解，那个 d 就是**确切的最短步数**
 *     （因为更短的深度已经被完整排除过了）。
 *   · 剪枝：同状态去重（记录「该局面在剩余 r 步内已证无解」）+ 下界剪枝。
 *
 * step(budgetMs) 每次只算一小片（默认 10ms），由调用方用 setTimeout 反复驱动，
 * 所以玩家可以边算边玩、也可以随时停。
 *
 * 传统脚本（非 ES Module），接口挂在全局 Yicai.MinSteps 上。
 */

(function (global) {
  'use strict';

  const Yicai = (global.Yicai = global.Yicai || {});

  function nowMs() {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
      return performance.now();
    }
    return Date.now();
  }

  /**
   * 建一个计算任务。
   * @param {object} board 题目初始盘面
   * @param {number} target 目标颜色
   * @param {object} [options] {maxDepth, visitedCap}
   * @returns {object} job：{state, step(ms), stop()}
   */
  function createJob(board, target, options) {
    const Core = Yicai.Core;
    const Solver = Yicai.Solver;
    const opts = options || {};
    const n = board.cells.length;
    const maxDepth = opts.maxDepth == null ? 40 : opts.maxDepth;
    const visitedCap = opts.visitedCap == null ? 300000 : opts.visitedCap;
    /** 找到最优解后是否继续数「最优解的个数」（唯一解判定）。默认关闭，行为与以前一致 */
    const countOptimal = !!opts.countOptimal;
    const adj = Core.buildAdjacency(board);
    const work = Int8Array.from(board.cells);
    const buf = Solver.createBuffer(n);
    const visited = new Map();

    // 非目标色格子数：增量维护，用来 O(1) 判断「是否已经全部染成目标色」
    let nonTarget = 0;
    for (let i = 0; i < n; i++) {
      const v = work[i];
      if (v !== Core.HOLE && v !== target) nonTarget++;
    }

    const state = {
      status: 'running', // running | done | stopped
      exact: null,
      provenLower: 0, // 已证明：最短步数 ≥ provenLower
      depth: 0, // 正在验证的深度
      nodes: 0,
      elapsed: 0,
      solution: null,
      /** 开了 countOptimal 时：最优解的个数（封顶 2；1 = 唯一解，2 = 多解） */
      optimalCount: null,
    };

    Solver.analyzeInto(work, adj, buf);
    state.provenLower = Solver.lowerBoundOf(buf, target);
    state.depth = state.provenLower;

    let stack = [];
    let path = [];
    let currentDepth = state.provenLower;
    let solutions = 0;
    let firstSolution = null;

    function prepareCandidates() {
      return Solver.listCandidates(work, adj, buf, target).map((cand) => ({
        index: cand.index,
        color: cand.color,
        prevColor: buf.color[cand.cid],
        ownCells: buf.flat.slice(buf.offset[cand.cid], buf.offset[cand.cid + 1]),
      }));
    }

    function applyMove(move) {
      for (let p = 0; p < move.ownCells.length; p++) work[move.ownCells[p]] = move.color;
      if (move.prevColor !== target) nonTarget -= move.ownCells.length;
      if (move.color !== target) nonTarget += move.ownCells.length;
      path.push({ index: move.index, color: move.color });
    }

    function undoMove(move) {
      if (!move) return;
      for (let p = 0; p < move.ownCells.length; p++) work[move.ownCells[p]] = move.prevColor;
      if (move.color !== target) nonTarget -= move.ownCells.length;
      if (move.prevColor !== target) nonTarget += move.ownCells.length;
      path.pop();
    }

    /** 从根局面开始验证 depth 步内是否有解 */
    function startDepth(depth) {
      stack = [];
      path = [];
      Solver.analyzeInto(work, adj, buf);
      stack.push({
        remaining: depth,
        candidates: prepareCandidates(),
        idx: 0,
        entry: null,
        key: Solver.hashState(work),
        hasSolution: false,
      });
      state.depth = depth;
    }

    if (nonTarget === 0) {
      state.status = 'done';
      state.exact = 0;
      state.solution = [];
      state.optimalCount = countOptimal ? 1 : null;
    } else {
      startDepth(currentDepth);
    }

    /**
     * 算一小片。
     * @param {number} [budgetMs] 这一片最多占用多少毫秒（默认 10）
     * @returns {boolean} 是否还需要继续算
     */
    function step(budgetMs) {
      if (state.status !== 'running') return false;
      const started = nowMs();
      const deadline = started + (budgetMs == null ? 10 : budgetMs);
      let guard = 0;

      while (state.status === 'running') {
        // 每 64 个节点看一次时间，避免频繁调用计时器
        if ((++guard & 63) === 0 && nowMs() > deadline) break;

        if (!stack.length) {
          if (solutions > 0) {
            // 当前深度的解已经全部数完：这个深度就是最短步数
            state.exact = currentDepth;
            state.solution = firstSolution;
            state.optimalCount = countOptimal ? Math.min(solutions, 2) : null;
            state.status = 'done';
            break;
          }
          // 这一层搜完还是没有解 → 最短步数至少是「这个深度 + 1」
          state.provenLower = currentDepth + 1;
          state.solution = null;
          if (state.provenLower > maxDepth) {
            state.status = 'stopped';
            break;
          }
          currentDepth = state.provenLower;
          startDepth(currentDepth);
          continue;
        }

        const frame = stack[stack.length - 1];
        if (frame.idx >= frame.candidates.length) {
          // 子树里出现过解的帧不能记成「死状态」，否则会漏数最优解
          if (!frame.hasSolution && visited.size < visitedCap) {
            visited.set(frame.key, frame.remaining);
          }
          stack.pop();
          undoMove(frame.entry);
          continue;
        }

        const cand = frame.candidates[frame.idx++];
        applyMove(cand);
        state.nodes++;

        if (nonTarget === 0) {
          solutions++;
          if (!firstSolution) firstSolution = path.slice();
          state.exact = currentDepth;
          state.solution = firstSolution;
          for (let s = 0; s < stack.length; s++) stack[s].hasSolution = true;
          if (!countOptimal || solutions >= 2) {
            state.optimalCount = countOptimal ? Math.min(solutions, 2) : null;
            state.status = 'done';
            break;
          }
          // 开了唯一性统计：退回来继续在同一个深度上找第二个解
          undoMove(cand);
          continue;
        }
        if (frame.remaining - 1 <= 0) {
          undoMove(cand);
          continue;
        }
        const key = Solver.hashState(work);
        const seen = visited.get(key);
        if (seen !== undefined && seen >= frame.remaining - 1) {
          undoMove(cand);
          continue;
        }
        Solver.analyzeInto(work, adj, buf);
        if (Solver.lowerBoundOf(buf, target) > frame.remaining - 1) {
          if (visited.size < visitedCap) visited.set(key, frame.remaining - 1);
          undoMove(cand);
          continue;
        }
        stack.push({
          remaining: frame.remaining - 1,
          candidates: prepareCandidates(),
          idx: 0,
          entry: cand,
          key,
          hasSolution: false,
        });
      }

      state.elapsed += nowMs() - started;
      return state.status === 'running';
    }

    function stop() {
      if (state.status === 'running') state.status = 'stopped';
      // 把棋盘恢复成初始局面
      while (stack.length) undoMove(stack.pop().entry);
      return state;
    }

    return { state, step, stop };
  }

  Yicai.MinSteps = { createJob };
})(typeof window !== 'undefined' ? window : globalThis);
