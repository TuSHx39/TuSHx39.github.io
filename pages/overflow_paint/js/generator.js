/**
 * generator.js —— 出题器。
 *
 * 题目来源有两类，出题时都会用求解器实测难度，只保留「能在限制步数内解出来」的，
 * 并且把限制步数**收紧到我们能找到的最好解的长度** —— 题目有多难，限制就有多紧。
 *
 * ① 随机拼块（主力，最难）
 *    直接随机铺色，再用「多数邻居平滑」控制碎片度。实测这种不规则拼块远比
 *    逆向染色出来的盘面难：8×10 上贪心解平均 10 步（逆向染色只有 5 步左右），
 *    20×15 上平均 18 步。限制步数大时优先用这种题。
 *
 * ② 逆向染色（兜底，限制步数很小时必用）
 *    从「全是目标色」出发，每一步挑一个同色连通块 C，从里面切一块连通子区域 R
 *    染成别的颜色；正向「点 R 把它染回 C 的原色」即可还原，所以 k 步之内必定有解。
 *    还会尽量维持「任何一块的同色邻居不超过 1 个」的不变式，让盘面不能靠一步
 *    并掉好几块，题目更顶。
 *
 * 两类题目最终都交给求解器（贪心 + 迭代加深搜索）算出**经过模拟验证**的解，
 * 这个解同时就是「看答案」的参考答案。
 *
 * 传统脚本（非 ES Module），接口挂在全局 Yicai.Generator 上。
 */

(function (global) {
  'use strict';

  const Yicai = (global.Yicai = global.Yicai || {});

  /** 逆向染色时子区域的形状：圆润块 / 随机块 / 蛇形 / 框选矩形 */
  const SPLIT_STYLES = ['blob', 'blob', 'random', 'worm', 'rect'];

  function nowMs() {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
      return performance.now();
    }
    return Date.now();
  }

  /** mulberry32：小巧的可复现随机数发生器（传 seed 时用于测试） */
  function createRng(seed) {
    if (seed === undefined || seed === null) return Math.random;
    let a = seed >>> 0;
    return function rng() {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function randInt(rng, min, max) {
    return min + Math.floor(rng() * (max - min + 1));
  }

  function shuffled(list, rng) {
    const out = list.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = out[i];
      out[i] = out[j];
      out[j] = tmp;
    }
    return out;
  }

  // ------------------------------------------------------------ 通用小工具

  /** 在 allowed 集合内随机生长出一块 size 大小的连通子区域 */
  function growRegion(board, allowed, size, rng, mode) {
    const Core = Yicai.Core;
    const marked = new Uint8Array(board.cells.length);
    for (const i of allowed) marked[i] = 1;
    const owned = new Uint8Array(board.cells.length);
    const start = allowed[Math.floor(rng() * allowed.length)];
    const result = [start];
    owned[start] = 1;
    const frontier = [];
    const pushNeighbors = (node) => {
      for (const nb of Core.neighborsOf(board, node)) {
        if (marked[nb] && !owned[nb] && frontier.indexOf(nb) < 0) frontier.push(nb);
      }
    };
    pushNeighbors(start);
    while (result.length < size && frontier.length) {
      let pick = 0;
      if (mode === 'random') {
        pick = Math.floor(rng() * frontier.length);
      } else {
        let best = -1;
        const bestIdx = [];
        for (let k = 0; k < frontier.length; k++) {
          let score = 0;
          for (const nb of Core.neighborsOf(board, frontier[k])) if (owned[nb]) score++;
          if (score > best) {
            best = score;
            bestIdx.length = 0;
            bestIdx.push(k);
          } else if (score === best) {
            bestIdx.push(k);
          }
        }
        pick = bestIdx[Math.floor(rng() * bestIdx.length)];
      }
      const node = frontier.splice(pick, 1)[0];
      if (owned[node]) continue;
      owned[node] = 1;
      result.push(node);
      pushNeighbors(node);
    }
    return result;
  }

  /** 蛇形（随机游走）子区域 */
  function wormRegion(board, allowed, size, rng) {
    const Core = Yicai.Core;
    const marked = new Uint8Array(board.cells.length);
    for (const i of allowed) marked[i] = 1;
    const owned = new Uint8Array(board.cells.length);
    let cur = allowed[Math.floor(rng() * allowed.length)];
    owned[cur] = 1;
    const result = [cur];
    let dir = null;
    while (result.length < size) {
      const options = [];
      for (const nb of Core.neighborsOf(board, cur)) {
        if (marked[nb] && !owned[nb]) options.push(nb);
      }
      if (!options.length) break;
      let next;
      if (dir !== null && rng() < 0.72 && options.indexOf(cur + dir) >= 0) next = cur + dir;
      else next = options[Math.floor(rng() * options.length)];
      dir = next - cur;
      cur = next;
      owned[cur] = 1;
      result.push(cur);
    }
    return result;
  }

  /** 在 allowed 内随机「框选」一个矩形（与图形相交的部分） */
  function rectRegion(board, allowed, size, rng) {
    const Core = Yicai.Core;
    const marked = new Uint8Array(board.cells.length);
    let minRow = board.rows;
    let maxRow = -1;
    let minCol = board.cols;
    let maxCol = -1;
    for (const i of allowed) {
      marked[i] = 1;
      const r = Core.rowOf(board, i);
      const c = Core.colOf(board, i);
      if (r < minRow) minRow = r;
      if (r > maxRow) maxRow = r;
      if (c < minCol) minCol = c;
      if (c > maxCol) maxCol = c;
    }
    for (let attempt = 0; attempt < 18; attempt++) {
      const r1 = randInt(rng, minRow, maxRow);
      const r2 = randInt(rng, minRow, maxRow);
      const c1 = randInt(rng, minCol, maxCol);
      const c2 = randInt(rng, minCol, maxCol);
      const top = Math.min(r1, r2);
      const bottom = Math.max(r1, r2);
      const left = Math.min(c1, c2);
      const right = Math.max(c1, c2);
      const cells = [];
      for (let r = top; r <= bottom; r++) {
        for (let c = left; c <= right; c++) {
          const idx = r * board.cols + c;
          if (marked[idx]) cells.push(idx);
        }
      }
      if (cells.length === 0 || cells.length >= allowed.length) continue;
      if (cells.length > size * 1.9 + 2) continue;
      if (!subsetConnected(board, cells)) continue;
      return cells;
    }
    return null;
  }

  function subsetConnected(board, cells) {
    const Core = Yicai.Core;
    const inSet = new Uint8Array(board.cells.length);
    for (const i of cells) inSet[i] = 1;
    const seen = new Uint8Array(board.cells.length);
    const stack = [cells[0]];
    seen[cells[0]] = 1;
    let count = 1;
    while (stack.length) {
      const cur = stack.pop();
      for (const nb of Core.neighborsOf(board, cur)) {
        if (!inSet[nb] || seen[nb]) continue;
        seen[nb] = 1;
        count++;
        stack.push(nb);
      }
    }
    return count === cells.length;
  }

  // -------------------------------------------------- 逆向染色（兜底来源）

  /** 去掉 region 之后，剩下的 cells 是否仍然连通（保证「一刀切两块」） */
  function remainderConnected(board, cells, region) {
    const Core = Yicai.Core;
    const inCells = new Uint8Array(board.cells.length);
    for (const i of cells) inCells[i] = 1;
    const gone = new Uint8Array(board.cells.length);
    for (const i of region) gone[i] = 1;
    let start = -1;
    let total = 0;
    for (const i of cells) {
      if (gone[i]) continue;
      if (start < 0) start = i;
      total++;
    }
    if (start < 0) return false;
    const seen = new Uint8Array(board.cells.length);
    const stack = [start];
    seen[start] = 1;
    let count = 1;
    while (stack.length) {
      const cur = stack.pop();
      for (const nb of Core.neighborsOf(board, cur)) {
        if (!inCells[nb] || gone[nb] || seen[nb]) continue;
        seen[nb] = 1;
        count++;
        stack.push(nb);
      }
    }
    return count === total;
  }

  /** cells 中「四个邻居全都还在 cells 里」的格子 —— 在这些格子上切一刀不会惊动外层 */
  function interiorCells(board, cells) {
    const Core = Yicai.Core;
    const inCells = new Uint8Array(board.cells.length);
    for (const i of cells) inCells[i] = 1;
    const out = [];
    for (const i of cells) {
      let interior = true;
      for (const nb of Core.neighborsOf(board, i)) {
        if (!inCells[nb]) {
          interior = false;
          break;
        }
      }
      if (interior) out.push(i);
    }
    return out;
  }

  /** 某个连通块的邻居节点用到了哪些颜色（位掩码） */
  function neighborColorMask(board, compCells, ownColor) {
    const Core = Yicai.Core;
    const inComp = new Uint8Array(board.cells.length);
    for (const i of compCells) inComp[i] = 1;
    let mask = 0;
    for (const i of compCells) {
      for (const nb of Core.neighborsOf(board, i)) {
        if (inComp[nb]) continue;
        const c = board.cells[nb];
        if (c !== ownColor) mask |= 1 << c;
      }
    }
    return mask;
  }

  /** 每个连通块「邻居里出现过的颜色种数」——越多越难再切一刀（最多 3 种） */
  function componentDegrees(board, comps) {
    const Core = Yicai.Core;
    const idOf = new Int32Array(board.cells.length).fill(-1);
    for (let i = 0; i < comps.length; i++) {
      for (const cell of comps[i].cells) idOf[cell] = i;
    }
    const seen = new Int32Array(comps.length).fill(-1);
    const degrees = new Int32Array(comps.length);
    for (let i = 0; i < comps.length; i++) {
      let mask = 0;
      for (const cell of comps[i].cells) {
        for (const nb of Core.neighborsOf(board, cell)) {
          const j = idOf[nb];
          if (j === i || j < 0 || seen[j] === i) continue;
          seen[j] = i;
          mask |= 1 << comps[j].color;
        }
      }
      let n = 0;
      while (mask) {
        n += mask & 1;
        mask >>= 1;
      }
      degrees[i] = n;
    }
    return degrees;
  }

  /** 兜底切法：找一格「挖掉它剩下的部分还连通」的格子（一定是非割点） */
  function leafRegion(board, cells, rng) {
    if (cells.length < 2) return null;
    for (const cell of shuffled(cells, rng || Math.random)) {
      if (remainderConnected(board, cells, [cell])) return [cell];
    }
    return null;
  }

  /**
   * 从连通块 comp 里切一块连通子区域，且要求切完剩下的部分仍然连通。
   * 优先在 comp 的**内部**切：这样外层各块的邻居关系完全没变，
   * 「任何一块的同色邻居 ≤ 1 个」的不变式能一直维持，正向一步最多并两块。
   */
  function pickSplitRegion(board, comp, rng, options) {
    const opts = options || {};
    const total = comp.cells.length;
    if (total < 2) return null;
    const minRatio = opts.minRatio == null ? 0.25 : opts.minRatio;
    const ratio = minRatio + (0.9 - minRatio) * Math.pow(rng(), 1.1);
    const interior = opts.interior === false ? [] : interiorCells(board, comp.cells);
    const pools = interior.length >= 2 ? [interior, comp.cells] : [comp.cells];
    for (const pool of pools) {
      const size = Math.max(1, Math.min(pool.length, Math.round(total * ratio)));
      for (const style of shuffled(SPLIT_STYLES, rng)) {
        for (let attempt = 0; attempt < 3; attempt++) {
          let region = null;
          if (style === 'rect') region = rectRegion(board, pool, size, rng);
          else if (style === 'worm') region = wormRegion(board, pool, size, rng);
          else region = growRegion(board, pool, size, rng, style === 'random' ? 'random' : 'compact');
          if (!region || !region.length) continue;
          if (region.length >= total) continue;
          if (!remainderConnected(board, comp.cells, region)) continue;
          return region;
        }
      }
    }
    return leafRegion(board, comp.cells, rng);
  }

  /** region 之外是否有同色格紧贴（有的话 R 会被并进别的同色块，正向不再是「只染这一块」） */
  function leaksColor(board, region, color) {
    const Core = Yicai.Core;
    const inRegion = new Uint8Array(board.cells.length);
    for (const i of region) inRegion[i] = 1;
    for (const i of region) {
      for (const nb of Core.neighborsOf(board, i)) {
        if (inRegion[nb]) continue;
        if (board.cells[nb] === color) return true;
      }
    }
    return false;
  }

  function paintRegion(board, region, color) {
    for (const i of region) board.cells[i] = color;
  }

  /**
   * 盘面统计：worst = 单个连通块同色邻居的最大个数（1 表示一步最多并两块）
   */
  function neighborColorStats(board) {
    const Core = Yicai.Core;
    const comps = Core.componentList(board);
    const idOf = new Int32Array(board.cells.length).fill(-1);
    const colorOf = new Int32Array(comps.length);
    for (let i = 0; i < comps.length; i++) {
      colorOf[i] = comps[i].color;
      for (const cell of comps[i].cells) idOf[cell] = i;
    }
    const seen = new Int32Array(comps.length).fill(-1);
    const perColor = [0, 0, 0, 0];
    let worst = 0;
    for (let i = 0; i < comps.length; i++) {
      perColor[0] = perColor[1] = perColor[2] = perColor[3] = 0;
      for (const cell of comps[i].cells) {
        for (const nb of Core.neighborsOf(board, cell)) {
          const j = idOf[nb];
          if (j === i || j < 0 || seen[j] === i) continue;
          seen[j] = i;
          perColor[colorOf[j]]++;
        }
      }
      for (let c = 0; c < 4; c++) {
        if (c !== colorOf[i] && perColor[c] > worst) worst = perColor[c];
      }
    }
    return { worst, count: comps.length };
  }

  function keepsDistinctNeighbors(board, maxSame) {
    return neighborColorStats(board).worst <= (maxSame == null ? 1 : maxSame);
  }

  function pickComponent(comps, rng) {
    if (rng() < 0.25) return comps[Math.floor(rng() * comps.length)];
    let total = 0;
    const weights = comps.map((c) => {
      const w = Math.pow(c.cells.length, 0.85);
      total += w;
      return w;
    });
    let roll = rng() * total;
    for (let i = 0; i < comps.length; i++) {
      roll -= weights[i];
      if (roll <= 0) return comps[i];
    }
    return comps[comps.length - 1];
  }

  /**
   * 逆向染色：返回正向解法（顺序与游玩顺序一致）。
   * @returns {{index:number,color:number}[]} 长度 ≤ limit
   */
  function reverseGenerate(board, target, limit, rng, options) {
    const Core = Yicai.Core;
    const opts = options || {};
    const strict = opts.strict !== false;
    const maxSame = opts.maxSameNeighbors == null ? 1 : opts.maxSameNeighbors;
    const allowTarget = !!opts.allowTarget;
    const byDegree = opts.byDegree !== false;
    const tryComponents = opts.tryComponents == null ? 16 : opts.tryComponents;
    const reversed = [];

    for (let step = 0; step < limit; step++) {
      const comps = Core.componentList(board).filter((c) => c.cells.length >= 2);
      if (!comps.length) break;

      let order = comps;
      if (byDegree) {
        const degrees = componentDegrees(board, comps);
        order = comps
          .map((comp, i) => ({ comp, degree: degrees[i], tie: rng() }))
          .sort(
            (a, b) =>
              a.degree - b.degree ||
              b.comp.cells.length - a.comp.cells.length ||
              a.tie - b.tie
          )
          .slice(0, tryComponents)
          .map((item) => item.comp);
      } else {
        const preferred = pickComponent(comps, rng);
        order = [preferred].concat(shuffled(comps.filter((c) => c !== preferred), rng));
      }

      let painted = false;
      for (const comp of order) {
        const used = neighborColorMask(board, comp.cells, comp.color);
        const palette = [0, 1, 2, 3].filter(
          (c) => c !== comp.color && (allowTarget || c !== target) && !(used & (1 << c))
        );
        const fallback = [0, 1, 2, 3].filter(
          (c) => c !== comp.color && (allowTarget || c !== target)
        );
        const colors = shuffled(palette.length ? palette : fallback, rng);
        if (!colors.length) continue;
        for (let attempt = 0; attempt < 3 && !painted; attempt++) {
          const region = pickSplitRegion(board, comp, rng, opts);
          if (!region) continue;
          for (const color of colors) {
            if (leaksColor(board, region, color)) continue;
            paintRegion(board, region, color);
            if (!strict || keepsDistinctNeighbors(board, maxSame)) {
              reversed.push({ index: Core.representativeIndex(board, region), color: comp.color });
              painted = true;
              break;
            }
            paintRegion(board, region, comp.color);
          }
        }
        if (painted) break;
      }
      if (!painted) break;
    }
    return reversed.reverse();
  }

  // ------------------------------------------------------ 随机拼块（主力）

  function fillRandom(board, rng) {
    const Core = Yicai.Core;
    for (let i = 0; i < board.cells.length; i++) {
      if (board.cells[i] === Core.HOLE) continue;
      board.cells[i] = Math.floor(rng() * Core.COLOR_COUNT);
    }
  }

  /** 一遍「多数邻居平滑」：把一部分格子改成邻居里最多的颜色，拼块变大、碎片变少 */
  function smoothOnce(board, rng, strength) {
    const Core = Yicai.Core;
    const before = Int8Array.from(board.cells);
    const rate = strength == null ? 0.5 : strength;
    const counts = [0, 0, 0, 0];
    for (let i = 0; i < board.cells.length; i++) {
      if (before[i] === Core.HOLE) continue;
      if (rng() > rate) continue;
      counts[0] = counts[1] = counts[2] = counts[3] = 0;
      let bestCount = 0;
      for (const nb of Core.neighborsOf(board, i)) counts[before[nb]]++;
      const best = [];
      for (let c = 0; c < 4; c++) {
        if (counts[c] > bestCount) {
          bestCount = counts[c];
          best.length = 0;
          best.push(c);
        } else if (counts[c] === bestCount && bestCount > 0) {
          best.push(c);
        }
      }
      if (!best.length) continue;
      board.cells[i] = best[Math.floor(rng() * best.length)];
    }
  }

  /**
   * 随机拼块候选：全盘随机铺色 + 若干次平滑（平滑次数越多越不碎、越好解）
   */
  function randomPuzzle(rows, cols, mask, target, rng, passes) {
    const Core = Yicai.Core;
    const board = Core.createBoard(rows, cols, Core.HOLE);
    for (let i = 0; i < board.cells.length; i++) {
      board.cells[i] = !mask || mask[i] ? 0 : Core.HOLE;
    }
    fillRandom(board, rng);
    for (let p = 0; p < passes; p++) smoothOnce(board, rng, 0.45 + 0.25 * rng());
    return board;
  }

  /** 逆向染色候选 */
  function reversePuzzle(rows, cols, mask, target, limit, rng) {
    const Core = Yicai.Core;
    const board = Core.createBoard(rows, cols, Core.HOLE);
    for (let i = 0; i < board.cells.length; i++) {
      board.cells[i] = !mask || mask[i] ? target : Core.HOLE;
    }
    reverseGenerate(board, target, limit, rng, {
      strict: true,
      maxSameNeighbors: 2,
      byDegree: true,
      allowTarget: true,
    });
    return board;
  }

  // ------------------------------------------------------------ 出题主流程

  /** 用贪心求一个可行解（顺带确认盘面不是已经完成） */
  function feasibleSolution(board, target, cap) {
    const Core = Yicai.Core;
    const Solver = Yicai.Solver;
    if (!Solver || Core.isSolved(board, target)) return null;
    const moves = Solver.greedy(board, target, { maxSteps: cap + 6 });
    if (!moves || !moves.length || moves.length > cap) return null;
    const check = Core.simulate(board, moves, target);
    if (!check.solved) return null;
    return moves;
  }

  /** 在预算内尝试把解压短（解越短，限制步数就越紧、题目越难） */
  function refine(board, target, moves, budgetMs, opts) {
    const Solver = Yicai.Solver;
    const Core = Yicai.Core;
    if (!Solver || moves.length <= 1) return { moves, source: 'greedy', improved: false };
    const budget = Math.min(opts.timeMs == null ? 500 : opts.timeMs, Math.max(0, budgetMs));
    if (budget < 60) return { moves, source: 'greedy', improved: false };
    const probe = Solver.search(board, target, moves.length - 1, {
      timeMs: budget,
      nodeLimit: opts.nodeLimit == null ? 150000 : opts.nodeLimit,
      minDepth: Math.max(1, moves.length - 5),
    });
    if (probe.moves && probe.moves.length && probe.moves.length < moves.length) {
      const check = Core.simulate(board, probe.moves, target);
      if (check.solved) {
        return { moves: probe.moves, source: 'shortest', improved: true };
      }
    }
    return { moves, source: 'greedy', improved: false };
  }

  /**
   * 生成一道题。
   *
   * @param {object} options
   * @param {number} options.rows 行数
   * @param {number} options.cols 列数
   * @param {Int8Array} [options.mask] 1=图形，0=空洞；不传表示整块矩形
   * @param {number} options.target 目标颜色
   * @param {number} options.limit 限制步数（1..15）—— 同时是难度上限
   * @param {number} [options.seed] 随机种子（可复现）
   * @param {function} [options.rng] 自定义随机函数
   * @param {number} [options.timeBudgetMs] 出题时间预算
   * @param {boolean} [options.checkUnique] 是否顺带验证「解是否唯一」
   */
  function generate(options) {
    const Core = Yicai.Core;
    const Solver = Yicai.Solver;
    const opts = options || {};
    const rows = Math.max(1, Math.round(opts.rows));
    const cols = Math.max(1, Math.round(opts.cols));
    const target = Core.isValidColor(opts.target) ? opts.target : Core.DEFAULT_TARGET;
    const cap = Core.clampLimit(opts.limit);
    const mask = opts.mask || null;
    const rng = opts.rng || createRng(opts.seed);
    const started = nowMs();
    const timeBudget = opts.timeBudgetMs == null ? 700 : opts.timeBudgetMs;
    const attempts = opts.attempts == null ? 26 : opts.attempts;
    const preferUnique = !!opts.preferUnique;
    const deadline = started + timeBudget * (preferUnique ? 4 : 2);

    const candidates = [];
    const consider = (board, source) => {
      if (!board) return;
      const moves = feasibleSolution(board, target, cap);
      if (!moves) return;
      candidates.push({ board, moves, source, components: Core.componentList(board).length });
    };

    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0 && nowMs() - started > timeBudget * 0.45) break;
      if (rng() < 0.78) {
        // 随机拼块：平滑次数决定碎片度，越碎越难
        const passes = Math.floor(Math.pow(rng(), 1.4) * 5);
        consider(randomPuzzle(rows, cols, mask, target, rng, passes), 'random');
      } else {
        consider(reversePuzzle(rows, cols, mask, target, cap, rng), 'reverse');
      }
    }

    // 兜底 1：逆向染色保证 k 步内有解，限制步数很小时基本都靠它
    for (let i = 0; i < 12 && !candidates.length; i++) {
      consider(reversePuzzle(rows, cols, mask, target, cap, rng), 'reverse');
    }

    // 兜底 2：极小盘面（例如只剩几格）给一块异色，至少 1 步能完成
    if (!candidates.length) {
      const board = Core.createBoard(rows, cols, Core.HOLE);
      const active = [];
      for (let i = 0; i < board.cells.length; i++) {
        if (!mask || mask[i]) {
          board.cells[i] = target;
          active.push(i);
        }
      }
      if (active.length >= 2) {
        board.cells[active[0]] = (target + 1) % Core.COLOR_COUNT;
        consider(board, 'fallback');
      }
    }

    if (!candidates.length) {
      // 理论上到不了这里（图形全空 / 只有一格）
      const board = Core.createBoard(rows, cols, Core.HOLE);
      for (let i = 0; i < board.cells.length; i++) {
        if (!mask || mask[i]) board.cells[i] = target;
      }
      return {
        rows,
        cols,
        target,
        limit: 0,
        board,
        solution: [],
        steps: 0,
        components: Core.componentList(board).length,
        colors: Core.colorsPresent(board).length,
        source: 'trivial',
        solutionSource: 'none',
        trivial: true,
        unique: null,
        uniqueCount: null,
        verified: true,
      };
    }

    // 解越长（在限制之内）说明题目越难，优先要它；同分要连通块更多的
    candidates.sort(
      (a, b) => b.moves.length - a.moves.length || b.components - a.components
    );

    const tries = preferUnique ? Math.min(candidates.length, 10) : 1;
    let bestUnique = null;
    let fallback = null;
    for (let i = 0; i < tries; i++) {
      if (i > 0 && nowMs() > deadline) break;
      const cand = candidates[i];
      const left = deadline - nowMs();
      const refined = refine(cand.board, target, cand.moves, left * (preferUnique ? 0.3 : 0.55), opts);
      const puzzle = {
        rows,
        cols,
        target,
        limit: refined.moves.length, // 收紧到已知最好的解：题目有多难，限制就有多紧
        board: cand.board,
        solution: refined.moves,
        steps: refined.moves.length,
        components: cand.components,
        colors: Core.colorsPresent(cand.board).length,
        source: cand.source,
        solutionSource: refined.source,
        trivial: false,
        unique: null,
        uniqueCount: null,
        verified: true,
      };
      fallback = fallback || puzzle;
      if (Solver && Solver.countOptimal) {
        const budget = Math.min(preferUnique ? 320 : 500, deadline - nowMs());
        if (budget > 60) {
          const counted = Solver.countOptimal(cand.board, target, puzzle.limit, {
            timeMs: budget,
            nodeLimit: opts.uniqueNodeLimit == null ? 150000 : opts.uniqueNodeLimit,
            maxCount: 2,
          });
          if (!counted.timedOut) {
            puzzle.uniqueCount = counted.count;
            puzzle.unique = counted.count === 1;
          }
        }
      }
      if (!preferUnique) return puzzle;
      // 勾了「尽量出唯一解」时，把所有唯一解题都试一遍，留下最难的（步数最多）
      if (puzzle.unique === true) {
        if (!bestUnique || puzzle.steps > bestUnique.steps) bestUnique = puzzle;
        if (puzzle.steps >= cap) break;
      }
    }
    return bestUnique || fallback;
  }

  Yicai.Generator = {
    createRng,
    growRegion,
    wormRegion,
    rectRegion,
    leafRegion,
    subsetConnected,
    remainderConnected,
    interiorCells,
    neighborColorMask,
    componentDegrees,
    pickSplitRegion,
    neighborColorStats,
    keepsDistinctNeighbors,
    leaksColor,
    paintRegion,
    pickComponent,
    reverseGenerate,
    reversePuzzle,
    randomPuzzle,
    smoothOnce,
    fillRandom,
    feasibleSolution,
    refine,
    generate,
  };
})(typeof window !== 'undefined' ? window : globalThis);
