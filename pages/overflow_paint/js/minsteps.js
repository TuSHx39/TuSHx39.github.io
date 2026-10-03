/**
 * 精确最短步数：初始连通块压缩图 + 迭代加深 + 可暂停的记忆化计数。
 * 区域只会整体变色或合并，搜索规模由色块数量决定。完整状态编码避免碰撞。
 */
(function (global) {
  'use strict';
  const Yicai = (global.Yicai = global.Yicai || {});
  const nowMs = () => typeof performance !== 'undefined' ? performance.now() : Date.now();

  function createJob(board, target, options) {
    const Solver = Yicai.Solver;
    const opts = options || {};
    const maxDepth = Math.max(0, Math.floor(opts.maxDepth == null ? 40 : opts.maxDepth));
    const visitedCap = Math.max(0, opts.visitedCap == null ? 300000 : opts.visitedCap);
    const countCap = opts.countOptimal ? 2 : 1;
    const graph = Solver.createRegionGraph(board);
    const work = Int8Array.from(graph.cells);
    const buf = Solver.createBuffer(work.length);
    const memo = new Map();
    const dead = new Map();
    const path = [];
    const stack = [];
    Solver.analyzeInto(work, graph.adj, buf);
    const lower = Solver.lowerBoundOf(buf, target);
    const state = {
      status: lower === 0 ? 'done' : lower > maxDepth ? 'stopped' : 'running',
      exact: lower === 0 ? 0 : null,
      provenLower: lower,
      depth: lower,
      nodes: 0,
      elapsed: 0,
      solution: lower === 0 ? [] : null,
      optimalCount: lower === 0 && opts.countOptimal ? 1 : null,
      regions: work.length,
    };

    function pushFrame(remaining, entry) {
      stack.push({ remaining, entry, key: Solver.hashState(work), candidates: null, idx: 0, count: 0 });
    }
    if (state.status === 'running') pushFrame(lower, null);

    function apply(move) {
      for (const i of move.ownCells) work[i] = move.color;
      path.push({ index: graph.representatives[move.index], color: move.color });
    }
    function undo(move) {
      if (!move) return;
      for (const i of move.ownCells) work[i] = move.prevColor;
      path.pop();
    }
    function cache(map, key, value) {
      if (memo.size + dead.size < visitedCap || map.has(key)) map.set(key, value);
    }

    // 每条到达缓存状态的路径都累加计数，避免把多解误判为唯一解。
    function complete(count) {
      const frame = stack.pop();
      cache(memo, frame.key + '|' + frame.remaining, count);
      if (count === 0) cache(dead, frame.key, Math.max(dead.get(frame.key) || 0, frame.remaining));
      undo(frame.entry);
      if (stack.length) {
        const parent = stack[stack.length - 1];
        parent.count = Math.min(countCap, parent.count + count);
      } else if (count > 0) {
        state.status = 'done';
        state.provenLower = state.exact = state.depth;
        state.optimalCount = opts.countOptimal ? count : null;
      } else {
        state.provenLower = ++state.depth;
        if (state.depth > maxDepth) state.status = 'stopped';
        else pushFrame(state.depth, null);
      }
    }

    function step(budgetMs) {
      if (state.status !== 'running') return false;
      const started = nowMs();
      const budget = Math.max(0, budgetMs == null ? 10 : budgetMs);
      let operations = 0;
      while (state.status === 'running') {
        if ((operations++ & 15) === 0 && nowMs() - started >= budget) break;
        const frame = stack[stack.length - 1];
        if (!frame.candidates) {
          const cached = memo.get(frame.key + '|' + frame.remaining);
          if (cached !== undefined) { complete(cached); continue; }
          if ((dead.get(frame.key) ?? -1) >= frame.remaining) { complete(0); continue; }
          Solver.analyzeInto(work, graph.adj, buf);
          const bound = Solver.lowerBoundOf(buf, target);
          if (bound === 0) {
            if (!state.solution) {
              state.solution = path.slice();
              state.exact = state.provenLower = state.depth;
            }
            complete(1);
            continue;
          }
          if (frame.remaining <= 0 || bound > frame.remaining) { complete(0); continue; }
          const members = new Map();
          frame.candidates = Solver.listCandidates(work, graph.adj, buf, target).map((cand) => {
            if (!members.has(cand.cid)) members.set(cand.cid, buf.flat.slice(buf.offset[cand.cid], buf.offset[cand.cid + 1]));
            return {
              index: cand.index, color: cand.color, prevColor: buf.color[cand.cid],
              ownCells: members.get(cand.cid),
            };
          });
        }
        if (frame.count >= countCap || frame.idx === frame.candidates.length) { complete(frame.count); continue; }
        const move = frame.candidates[frame.idx++];
        apply(move);
        state.nodes++;
        pushFrame(frame.remaining - 1, move);
      }
      state.elapsed += nowMs() - started;
      return state.status === 'running';
    }

    function stop() {
      if (state.status === 'running') state.status = 'stopped';
      while (stack.length) undo(stack.pop().entry);
      memo.clear();
      dead.clear();
      return state;
    }
    return { state, step, stop };
  }
  Yicai.MinSteps = { createJob };
})(typeof window !== 'undefined' ? window : globalThis);
