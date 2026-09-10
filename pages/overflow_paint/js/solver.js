/**
 * solver.js —— 求解器：从「当前局面」算出通关步骤。
 *
 * 「看答案」时的用法：题目初始局面直接沿用逆向出题时留下的参考解，
 * 只有玩家已经走过几步、局面偏离参考解时才需要现场求解。
 *
 * 两级策略：
 *   1. greedy —— 每步在所有落子里选合并后连通块最少（同分优先染成目标色、再取合并面积最大）的一步，
 *      必定在有限步内收敛，速度极快，作为可靠上界；
 *   2. search —— 迭代加深 + 下界剪枝 + 状态查重，尝试找出更短（最短）的解，
 *      有时间 / 节点预算，超时即返回已有的贪心解，绝不卡死页面。
 *
 * 关于落子集合：所有「把某块染成它相邻块的颜色」的合并型落子都会参与搜索；
 * 但目标色在盘面上消失时（玩家把最后一块目标色也染掉了），必须允许「无效染色」
 * 才能重新造出目标色，因此候选中始终保留全部颜色，只把合并型落子排在前面。
 *
 * 传统脚本（非 ES Module），接口挂在全局 Yicai.Solver 上。
 */

(function (global) {
  'use strict';

  const Yicai = (global.Yicai = global.Yicai || {});

  function defaultNow() {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
      return () => performance.now();
    }
    return () => Date.now();
  }

  /** 分析缓冲区：把一片 cells 切成同色连通块，供求解器复用，避免反复分配 */
  function createBuffer(n) {
    return {
      count: 0,
      ids: new Int32Array(n),
      seen: new Uint8Array(n),
      stack: new Int32Array(n),
      size: new Int32Array(n + 1),
      color: new Int8Array(n + 1),
      offset: new Int32Array(n + 2),
      cursor: new Int32Array(n + 1),
      flat: new Int32Array(n),
      stamp: new Int32Array(n + 1),
      nbrs: new Int32Array(n + 1),
      stampValue: 0,
    };
  }

  /**
   * 标注连通块并把成员压平成 flat[offset[c]..offset[c+1])。
   * @returns {number} 连通块数量；结果写在 buf 上
   */
  function analyzeInto(cells, adj, buf) {
    const Core = Yicai.Core;
    const n = cells.length;
    const { ids, seen, stack, size, color, offset, cursor, flat } = buf;
    for (let i = 0; i < n; i++) {
      ids[i] = -1;
      seen[i] = 0;
    }
    let count = 0;
    for (let i = 0; i < n; i++) {
      if (cells[i] === Core.HOLE || seen[i]) continue;
      const c = cells[i];
      let sp = 0;
      stack[sp++] = i;
      seen[i] = 1;
      ids[i] = count;
      let cellCount = 0;
      while (sp > 0) {
        const cur = stack[--sp];
        cellCount++;
        const list = adj[cur];
        for (let k = 0; k < list.length; k++) {
          const nb = list[k];
          if (seen[nb] || cells[nb] !== c) continue;
          seen[nb] = 1;
          ids[nb] = count;
          stack[sp++] = nb;
        }
      }
      size[count] = cellCount;
      color[count] = c;
      count++;
    }
    offset[0] = 0;
    for (let c = 0; c < count; c++) {
      offset[c + 1] = offset[c] + size[c];
      cursor[c] = offset[c];
    }
    for (let i = 0; i < n; i++) {
      const cid = ids[i];
      if (cid >= 0) flat[cursor[cid]++] = i;
    }
    buf.count = count;
    return count;
  }

  /** 当前局面里还剩下几种颜色 */
  function distinctColors(buf) {
    let mask = 0;
    for (let i = 0; i < buf.count; i++) mask |= 1 << buf.color[i];
    let n = 0;
    while (mask) {
      n += mask & 1;
      mask >>= 1;
    }
    return n;
  }

  /** 当前局面里是否存在某种颜色的连通块 */
  function hasColor(buf, color) {
    for (let i = 0; i < buf.count; i++) {
      if (buf.color[i] === color) return true;
    }
    return false;
  }

  /**
   * 是否已经全部染成目标色。
   * 注意不能写成「只剩一个连通块」：图形带空洞、或者本身断开时，
   * 目标色可以分成好几块，那也已经通关了。
   */
  function allTarget(buf, target) {
    for (let i = 0; i < buf.count; i++) {
      if (buf.color[i] !== target) return false;
    }
    return true;
  }

  /**
   * 可用的下界（必须真实、不能超过最短步数）：
   *   · 每步最多让棋盘少一种颜色，而终局只剩目标色一种 → 至少 颜色数-1 步；
   *   · 盘面上没有目标色时，至少还要多花 1 步把它造出来。
   * 注意：「连通块数-1」不是合法下界（一次落子可以同时并掉好几块）。
   */
  function lowerBoundOf(buf, target) {
    let lb = Math.max(0, distinctColors(buf) - 1);
    if (lb === 0 && buf.count > 0 && !hasColor(buf, target)) lb = 1;
    return lb;
  }

  /**
   * 列出所有落子候选并按启发式排序：
   * 合并型落子（能并掉更多块、合并后更大）优先，其次优先染成目标色。
   */
  function listCandidates(cells, adj, buf, target) {
    const out = [];
    const { ids, color, size, offset, flat, stamp, nbrs } = buf;
    const absorbed = [0, 0, 0, 0];
    const merged = [0, 0, 0, 0];
    for (let cid = 0; cid < buf.count; cid++) {
      const start = offset[cid];
      const end = offset[cid + 1];
      const own = color[cid];
      absorbed[0] = absorbed[1] = absorbed[2] = absorbed[3] = 0;
      merged[0] = merged[1] = merged[2] = merged[3] = 0;
      buf.stampValue++;
      let drained = 0;
      for (let p = start; p < end; p++) {
        const list = adj[flat[p]];
        for (let k = 0; k < list.length; k++) {
          const nb = list[k];
          const ncid = ids[nb];
          if (ncid === cid || ncid < 0) continue;
          if (stamp[ncid] === buf.stampValue) continue;
          stamp[ncid] = buf.stampValue;
          nbrs[drained++] = ncid;
        }
      }
      for (let k = 0; k < drained; k++) {
        const ncid = nbrs[k];
        const ncolor = color[ncid];
        absorbed[ncolor]++;
        merged[ncolor] += size[ncid];
      }
      for (let c = 0; c < 4; c++) {
        if (c === own) continue;
        const isMerge = absorbed[c] > 0;
        out.push({
          cid,
          color: c,
          index: flat[start],
          absorbed: absorbed[c],
          merged: merged[c] + size[cid],
          toTarget: c === target ? 1 : 0,
          merging: isMerge ? 1 : 0,
        });
      }
    }
    out.sort(
      (a, b) =>
        b.merging - a.merging ||
        b.absorbed - a.absorbed ||
        b.merged - a.merged ||
        b.toTarget - a.toTarget ||
        a.color - b.color ||
        a.cid - b.cid
    );
    return out;
  }

  /**
   * 贪心解：每步精确比较所有候选落子，优先选能直接通关的，
   * 否则选合并后连通块最少、更偏向目标色、合并面积更大的一步。
   */
  function greedy(board, target, options) {
    const Core = Yicai.Core;
    const opts = options || {};
    const adj = Core.buildAdjacency(board);
    const work = Int8Array.from(board.cells);
    const probe = Int8Array.from(board.cells);
    const buf = createBuffer(work.length);
    const probeBuf = createBuffer(work.length);
    const moves = [];
    const stepCap = opts.maxSteps || work.length + 16;

    for (let step = 0; step < stepCap; step++) {
      const count = analyzeInto(work, adj, buf);
      if (allTarget(buf, target)) return moves;
      const candidates = listCandidates(work, adj, buf, target);
      if (!candidates.length) return null;

      let best = null;
      let bestKey = null;
      for (const cand of candidates) {
        probe.set(work);
        const start = buf.offset[cand.cid];
        const end = buf.offset[cand.cid + 1];
        for (let p = start; p < end; p++) probe[buf.flat[p]] = cand.color;
        const probeCount = analyzeInto(probe, adj, probeBuf);
        const mergedSize = probeBuf.size[probeBuf.ids[cand.index]];
        const solved = allTarget(probeBuf, target);
        // 打分：先看是否直接完成，再看连通块数量、是否朝目标色、合并面积
        const key = [
          solved ? 1 : 0,
          -probeCount,
          cand.toTarget,
          mergedSize,
          cand.merging,
        ];
        if (!best || compareKey(key, bestKey) > 0) {
          best = cand;
          bestKey = key;
        }
      }
      if (!best) return null;

      const start = buf.offset[best.cid];
      const end = buf.offset[best.cid + 1];
      for (let p = start; p < end; p++) work[buf.flat[p]] = best.color;
      moves.push({ index: best.index, color: best.color });
    }
    return null;
  }

  function compareKey(a, b) {
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return a[i] - b[i];
    }
    return 0;
  }

  /** 64 位近似指纹（两个 32 位 hash 拼起来），用于搜索去重 */
  function hashState(cells) {
    let h1 = 0x811c9dc5;
    let h2 = 0x01000193;
    for (let i = 0; i < cells.length; i++) {
      const v = cells[i] + 2;
      h1 = Math.imul(h1 ^ v, 16777619);
      h2 = Math.imul(h2 + v, 2246822519) ^ (h2 << 5);
    }
    return (h1 >>> 0).toString(36) + ':' + (h2 >>> 0).toString(36);
  }

  /**
   * 迭代加深搜索：从下界（或 options.minDepth）逐层加深，找到的第一层即最短解。
   * @returns {{moves:(null|{index:number,color:number}[]), optimal:boolean, nodes:number, timedOut:boolean, lowerBound:number}}
   */
  function search(board, target, maxSteps, options) {
    const Core = Yicai.Core;
    const opts = options || {};
    const timeMs = opts.timeMs == null ? 1200 : opts.timeMs;
    const nodeLimit = opts.nodeLimit == null ? 150000 : opts.nodeLimit;
    const now = opts.now || defaultNow();
    const started = now();
    const cap = Math.max(0, Math.floor(maxSteps));
    const adj = Core.buildAdjacency(board);
    const work = Int8Array.from(board.cells);
    const buf = createBuffer(work.length);
    const path = [];
    const visited = new Map();
    let nodes = 0;

    analyzeInto(work, adj, buf);
    if (allTarget(buf, target)) {
      return { moves: [], optimal: true, nodes: 0, timedOut: false, lowerBound: 0 };
    }
    const rootLb = lowerBoundOf(buf, target);
    const startDepth = Math.max(rootLb, Math.floor(opts.minDepth || 0));
    if (startDepth > cap) {
      return { moves: null, optimal: false, nodes: 0, timedOut: false, lowerBound: rootLb };
    }

    function dfs(remaining) {
      nodes++;
      if (nodes > nodeLimit) return 'timeout';
      if ((nodes & 255) === 0 && now() - started > timeMs) return 'timeout';

      const count = analyzeInto(work, adj, buf);
      if (allTarget(buf, target)) return 'found';
      if (remaining <= 0) return 'fail';
      if (lowerBoundOf(buf, target) > remaining) return 'fail';

      // 先把候选的成员表快照下来：递归会复用 buf，不能再回头读它
      const prepared = listCandidates(work, adj, buf, target).map((cand) => ({
        index: cand.index,
        color: cand.color,
        prevColor: buf.color[cand.cid],
        ownCells: buf.flat.slice(buf.offset[cand.cid], buf.offset[cand.cid + 1]),
      }));

      for (const cand of prepared) {
        const ownCells = cand.ownCells;
        for (let p = 0; p < ownCells.length; p++) work[ownCells[p]] = cand.color;
        path.push({ index: cand.index, color: cand.color });
        const key = hashState(work);
        const seenWith = visited.get(key);
        if (seenWith !== undefined && seenWith >= remaining - 1) {
          path.pop();
          for (let p = 0; p < ownCells.length; p++) work[ownCells[p]] = cand.prevColor;
          continue;
        }
        const result = dfs(remaining - 1);
        if (result === 'found') return 'found';
        path.pop();
        for (let p = 0; p < ownCells.length; p++) work[ownCells[p]] = cand.prevColor;
        if (result === 'timeout') return 'timeout';
        visited.set(key, remaining - 1);
      }
      return 'fail';
    }

    for (let depth = startDepth; depth <= cap; depth++) {
      path.length = 0;
      const result = dfs(depth);
      if (result === 'found') {
        return {
          moves: path.slice(),
          optimal: depth === startDepth && startDepth === rootLb,
          nodes,
          timedOut: false,
          lowerBound: rootLb,
        };
      }
      if (result === 'timeout') {
        return { moves: null, optimal: false, nodes, timedOut: true, lowerBound: rootLb };
      }
    }
    return { moves: null, optimal: false, nodes, timedOut: false, lowerBound: rootLb };
  }

  /**
   * 数一数「在 maxSteps 步以内通关」的走法有几种（最多数到 maxCount 就收手）。
   *
   * 用记忆化 DP：solutions(状态, 剩余步数) = Σ solutions(走一步后的状态, 剩余-1)，
   * 所以同一个局面被不同路径重复到达时不会重复展开，小盘面上跑得动。
   *
   * @returns {{count:number, timedOut:boolean, nodes:number}} count=1 即「唯一解」
   */
  function countOptimal(board, target, maxSteps, options) {
    const Core = Yicai.Core;
    const opts = options || {};
    const maxCount = opts.maxCount == null ? 2 : opts.maxCount;
    const timeMs = opts.timeMs == null ? 400 : opts.timeMs;
    const nodeLimit = opts.nodeLimit == null ? 150000 : opts.nodeLimit;
    const now = opts.now || defaultNow();
    const started = now();
    const cap = Math.max(0, Math.floor(maxSteps));
    const adj = Core.buildAdjacency(board);
    const work = Int8Array.from(board.cells);
    const buf = createBuffer(work.length);
    const memo = new Map();
    let nodes = 0;
    let timedOut = false;

    function dfs(remaining) {
      nodes++;
      if (nodes > nodeLimit || ((nodes & 255) === 0 && now() - started > timeMs)) {
        timedOut = true;
        return 0;
      }
      analyzeInto(work, adj, buf);
      if (allTarget(buf, target)) return 1;
      if (remaining <= 0) return 0;
      if (lowerBoundOf(buf, target) > remaining) return 0;

      const key = hashState(work) + '|' + remaining;
      const cached = memo.get(key);
      if (cached !== undefined) return cached;

      const prepared = listCandidates(work, adj, buf, target).map((cand) => ({
        color: cand.color,
        prevColor: buf.color[cand.cid],
        ownCells: buf.flat.slice(buf.offset[cand.cid], buf.offset[cand.cid + 1]),
      }));

      let total = 0;
      for (const cand of prepared) {
        for (let p = 0; p < cand.ownCells.length; p++) work[cand.ownCells[p]] = cand.color;
        total += dfs(remaining - 1);
        for (let p = 0; p < cand.ownCells.length; p++) work[cand.ownCells[p]] = cand.prevColor;
        if (timedOut) return 0;
        if (total >= maxCount) {
          total = maxCount;
          break;
        }
      }
      memo.set(key, total);
      return total;
    }

    const count = timedOut ? 0 : dfs(cap);
    return { count, timedOut, nodes };
  }

  /**
   * 综合求解：先贪心拿到可靠解，再在预算内尝试搜更短解。
   * @returns {{moves:(null|{index:number,color:number}[]), source:string, fits:boolean, lowerBound:number, timedOut:boolean}}
   */
  function solve(board, target, maxSteps, options) {
    const Core = Yicai.Core;
    const opts = options || {};
    const cap = Math.max(0, Math.floor(maxSteps));
    if (Core.isSolved(board, target)) {
      return { moves: [], source: 'exact', fits: true, lowerBound: 0, timedOut: false };
    }

    const greedyMoves = greedy(board, target, opts);
    if (!greedyMoves) {
      return { moves: null, source: 'none', fits: false, lowerBound: 0, timedOut: false };
    }
    const greedyFits = greedyMoves.length <= cap;
    if (opts.optimize === false || greedyMoves.length <= 1) {
      return { moves: greedyMoves, source: 'greedy', fits: greedyFits, lowerBound: 0, timedOut: false };
    }

    // 只在「可能比贪心更短、且不超过限制」的深度区间里找，避免无谓的深搜
    const window = opts.window == null ? 4 : opts.window;
    const searchCap = Math.min(cap, greedyMoves.length - 1);
    if (searchCap >= 1) {
      const lower = lowerBound(board, target);
      const minDepth = Math.max(lower, greedyMoves.length - Math.max(0, window) - 1);
      const result = search(board, target, searchCap, {
        timeMs: opts.timeMs == null ? 700 : opts.timeMs,
        nodeLimit: opts.nodeLimit,
        now: opts.now,
        minDepth,
      });
      if (result.moves && result.moves.length < greedyMoves.length) {
        return {
          moves: result.moves,
          source: result.optimal ? 'shortest' : 'improved',
          fits: result.moves.length <= cap,
          lowerBound: result.lowerBound,
          timedOut: false,
        };
      }
      return {
        moves: greedyMoves,
        source: 'greedy',
        fits: greedyFits,
        lowerBound: result.lowerBound,
        timedOut: result.timedOut,
      };
    }
    return { moves: greedyMoves, source: 'greedy', fits: greedyFits, lowerBound: 0, timedOut: false };
  }

  function lowerBound(board, target) {
    const Core = Yicai.Core;
    const adj = Core.buildAdjacency(board);
    const buf = createBuffer(board.cells.length);
    analyzeInto(Int8Array.from(board.cells), adj, buf);
    return lowerBoundOf(buf, target);
  }

  Yicai.Solver = {
    createBuffer,
    analyzeInto,
    distinctColors,
    hasColor,
    lowerBoundOf,
    lowerBound,
    listCandidates,
    greedy,
    search,
    countOptimal,
    solve,
    hashState,
  };
})(typeof window !== 'undefined' ? window : globalThis);
