/**
 * core.js —— 溢彩画核心逻辑：颜色、棋盘、连通块、落子与胜负判定。
 *
 * 规则约定（与鸣潮「溢彩画」一致）：
 *   · 棋盘由若干方格组成，每格一种颜色（红/绿/蓝/黄）；
 *   · 一次操作 = 选中某个方格所在的那一整个「同色四连通块」，把它染成所选颜色；
 *   · 在限制步数内把全部方格染成目标颜色即为成功。
 *
 * 数据结构：
 *   board = { rows, cols, cells: Int8Array(rows*cols) }
 *   cells[i] === HOLE(-1) 表示该格不属于图形（自由图形模式的空洞），否则为 0..3 的颜色下标。
 *
 * 传统脚本（非 ES Module），接口挂在全局 Yicai.Core 上，file:// 直接双击也能跑。
 */

(function (global) {
  'use strict';

  const Yicai = (global.Yicai = global.Yicai || {});

  /** 空洞（图形之外的格子） */
  const HOLE = -1;
  const COLOR_COUNT = 4;
  const RED = 0;
  const GREEN = 1;
  const BLUE = 2;
  const YELLOW = 3;
  const DEFAULT_TARGET = YELLOW;
  /** 限制步数上限 */
  const MAX_LIMIT = 15;

  const COLORS = [
    { key: 'red', name: '红', hex: '#f2544b', mark: '●' },
    { key: 'green', name: '绿', hex: '#37b24d', mark: '▲' },
    { key: 'blue', name: '蓝', hex: '#3b7fd4', mark: '■' },
    { key: 'yellow', name: '黄', hex: '#f2c037', mark: '★' },
  ];

  function isValidColor(value) {
    return Number.isInteger(value) && value >= 0 && value < COLOR_COUNT;
  }

  function clampLimit(value) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return 1;
    return Math.min(MAX_LIMIT, Math.max(1, n));
  }

  function createBoard(rows, cols, fill) {
    const cells = new Int8Array(rows * cols);
    cells.fill(isValidColor(fill) ? fill : HOLE);
    return { rows, cols, cells };
  }

  function cloneBoard(board) {
    return { rows: board.rows, cols: board.cols, cells: Int8Array.from(board.cells) };
  }

  function boardEquals(a, b) {
    if (a.rows !== b.rows || a.cols !== b.cols) return false;
    for (let i = 0; i < a.cells.length; i++) {
      if (a.cells[i] !== b.cells[i]) return false;
    }
    return true;
  }

  function cellIndex(board, row, col) {
    return row * board.cols + col;
  }

  function rowOf(board, index) {
    return Math.floor(index / board.cols);
  }

  function colOf(board, index) {
    return index % board.cols;
  }

  function inBounds(board, row, col) {
    return row >= 0 && row < board.rows && col >= 0 && col < board.cols;
  }

  function isActive(board, index) {
    return Number.isInteger(index) && index >= 0 && index < board.cells.length && board.cells[index] !== HOLE;
  }

  function colorAt(board, index) {
    return isActive(board, index) ? board.cells[index] : HOLE;
  }

  /** 图形内（非空洞）的格子数 */
  function activeCount(board) {
    let n = 0;
    for (let i = 0; i < board.cells.length; i++) {
      if (board.cells[i] !== HOLE) n++;
    }
    return n;
  }

  /** 上下左右四个方向中仍属于图形的相邻格下标 */
  function neighborsOf(board, index) {
    const out = [];
    const row = rowOf(board, index);
    const col = colOf(board, index);
    if (row > 0 && isActive(board, index - board.cols)) out.push(index - board.cols);
    if (row < board.rows - 1 && isActive(board, index + board.cols)) out.push(index + board.cols);
    if (col > 0 && isActive(board, index - 1)) out.push(index - 1);
    if (col < board.cols - 1 && isActive(board, index + 1)) out.push(index + 1);
    return out;
  }

  /**
   * 预计算邻接表（空洞处为空数组），供求解器反复使用时提速。
   * @returns {Int32Array[]}
   */
  function buildAdjacency(board) {
    const adj = new Array(board.cells.length);
    for (let i = 0; i < board.cells.length; i++) {
      adj[i] = board.cells[i] === HOLE ? new Int32Array(0) : Int32Array.from(neighborsOf(board, i));
    }
    return adj;
  }

  /**
   * 取 index 所在的同色四连通块。
   * @param {object} board
   * @param {number} index
   * @param {Int32Array[]} [adjacency] 预计算邻接表
   * @param {Int32Array} [scratch] 复用的 visited 标记（长度 = 格子数），可省
   * @returns {number[]} 该连通块全部格子的下标（index 为空洞时返回 []）
   */
  function componentAt(board, index, adjacency, scratch) {
    if (!isActive(board, index)) return [];
    const color = board.cells[index];
    const adj = adjacency || buildAdjacency(board);
    const seen = scratch || new Int32Array(board.cells.length);
    const out = [];
    const stack = [index];
    seen[index] = 1;
    while (stack.length) {
      const cur = stack.pop();
      out.push(cur);
      const list = adj[cur];
      for (let k = 0; k < list.length; k++) {
        const next = list[k];
        if (seen[next]) continue;
        if (board.cells[next] !== color) continue;
        seen[next] = 1;
        stack.push(next);
      }
    }
    for (let k = 0; k < out.length; k++) seen[out[k]] = 0; // 复位，方便复用
    return out;
  }

  /** 图形（忽略颜色）的连通分组，用于「自绘图形」模式与逆向出题 */
  function connectedGroups(board) {
    const seen = new Uint8Array(board.cells.length);
    const groups = [];
    for (let i = 0; i < board.cells.length; i++) {
      if (board.cells[i] === HOLE || seen[i]) continue;
      const group = [];
      const stack = [i];
      seen[i] = 1;
      while (stack.length) {
        const cur = stack.pop();
        group.push(cur);
        for (const next of neighborsOf(board, cur)) {
          if (seen[next]) continue;
          seen[next] = 1;
          stack.push(next);
        }
      }
      groups.push(group);
    }
    return groups;
  }

  /** 全盘所有同色连通块 */
  function componentList(board) {
    const seen = new Uint8Array(board.cells.length);
    const list = [];
    for (let i = 0; i < board.cells.length; i++) {
      if (board.cells[i] === HOLE || seen[i]) continue;
      const color = board.cells[i];
      const cells = [];
      const stack = [i];
      seen[i] = 1;
      while (stack.length) {
        const cur = stack.pop();
        cells.push(cur);
        for (const next of neighborsOf(board, cur)) {
          if (seen[next] || board.cells[next] !== color) continue;
          seen[next] = 1;
          stack.push(next);
        }
      }
      list.push({ color, cells });
    }
    return list;
  }

  /** 棋盘上出现过的颜色（升序） */
  function colorsPresent(board) {
    const flag = [false, false, false, false];
    let n = 0;
    for (let i = 0; i < board.cells.length; i++) {
      const v = board.cells[i];
      if (v === HOLE || flag[v]) continue;
      flag[v] = true;
      n++;
    }
    const out = [];
    for (let c = 0; c < COLOR_COUNT; c++) if (flag[c]) out.push(c);
    return out;
  }

  /** 把一组格子染色（原地修改） */
  function applyColor(board, indices, color) {
    for (let i = 0; i < indices.length; i++) board.cells[indices[i]] = color;
    return indices;
  }

  /**
   * 落子：把 index 所在的同色连通块染成 color。
   * @returns {{cells:number[], from:number, to:number}|null} 无效落子（空洞 / 同色）返回 null
   */
  function applyMove(board, index, color, adjacency) {
    if (!isValidColor(color) || !isActive(board, index)) return null;
    const from = board.cells[index];
    if (from === color) return null;
    const cells = componentAt(board, index, adjacency);
    applyColor(board, cells, color);
    return { cells, from, to: color };
  }

  /** 是否已经全部染成目标色 */
  function isSolved(board, target) {
    for (let i = 0; i < board.cells.length; i++) {
      const v = board.cells[i];
      if (v !== HOLE && v !== target) return false;
    }
    return true;
  }

  /**
   * 按序模拟一串落子，返回每步的实际效果（不改动原棋盘）。
   * 落子点必须属于当期图形，否则该步记为无效并停止。
   */
  function simulate(board, moves, target) {
    const work = cloneBoard(board);
    const adjacency = buildAdjacency(work);
    const applied = [];
    for (const move of moves) {
      const index = move && Number.isInteger(move.index) ? move.index : -1;
      if (!isActive(work, index)) break;
      const from = work.cells[index];
      if (from === move.color) {
        // 该块已经是目标色：视为空操作（不影响棋盘，也不计入有效步）
        applied.push({ index, from, to: move.color, cells: componentAt(work, index, adjacency), noop: true });
        continue;
      }
      const result = applyMove(work, index, move.color, adjacency);
      applied.push({ index, from: result.from, to: result.to, cells: result.cells, noop: false });
    }
    return { board: work, applied, solved: isSolved(work, target) };
  }

  /** 稳定可比较的棋盘指纹（求解器查重用的紧凑字符串） */
  function boardKey(board) {
    const chars = new Array(board.cells.length);
    for (let i = 0; i < board.cells.length; i++) chars[i] = String.fromCharCode(board.cells[i] + 1);
    return board.rows + 'x' + board.cols + ':' + chars.join('');
  }

  /** 可持久化的棋盘序列（'x' 表示空洞，'0'..'3' 表示颜色） */
  function serialize(board) {
    let out = '';
    for (let i = 0; i < board.cells.length; i++) {
      const v = board.cells[i];
      out += v === HOLE ? 'x' : String(v);
    }
    return out;
  }

  function deserialize(text, rows, cols) {
    if (typeof text !== 'string' || text.length !== rows * cols) return null;
    const board = createBoard(rows, cols);
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === 'x' || ch === '-') {
        board.cells[i] = HOLE;
      } else if (ch >= '0' && ch <= '3') {
        board.cells[i] = Number(ch);
      } else {
        return null;
      }
    }
    return board;
  }

  /** 人类可读的坐标（1 起） */
  function cellLabel(board, index) {
    return '(' + (rowOf(board, index) + 1) + ',' + (colOf(board, index) + 1) + ')';
  }

  /** 取最靠近该连通块几何中心的格子，用于展示 / 演示时高亮 */
  function representativeIndex(board, cells) {
    if (!cells.length) return -1;
    let sumRow = 0;
    let sumCol = 0;
    for (const index of cells) {
      sumRow += rowOf(board, index);
      sumCol += colOf(board, index);
    }
    const centerRow = sumRow / cells.length;
    const centerCol = sumCol / cells.length;
    let best = cells[0];
    let bestDist = Infinity;
    for (const index of cells) {
      const dr = rowOf(board, index) - centerRow;
      const dc = colOf(board, index) - centerCol;
      const dist = dr * dr + dc * dc;
      if (dist < bestDist) {
        bestDist = dist;
        best = index;
      }
    }
    return best;
  }

  /** 矩形全满棋盘的所有格子下标 */
  function rectangleMask(rows, cols) {
    const mask = new Int8Array(rows * cols);
    mask.fill(1);
    return mask;
  }

  /** 由字符串图案（'#'=图形）生成 mask */
  function maskFromPattern(pattern) {
    const rows = pattern.length;
    const cols = rows ? pattern[0].length : 0;
    const mask = new Int8Array(rows * cols);
    for (let r = 0; r < rows; r++) {
      const line = pattern[r];
      if (line.length !== cols) throw new Error('图案每行长度必须一致');
      for (let c = 0; c < cols; c++) mask[r * cols + c] = line[c] === '#' ? 1 : 0;
    }
    return { rows, cols, mask };
  }

  /** 由 mask 构造「棋盘外壳」（全目标色），空洞标记为 HOLE */
  function boardFromMask(rows, cols, mask, target) {
    const board = createBoard(rows, cols);
    for (let i = 0; i < board.cells.length; i++) {
      board.cells[i] = mask && mask[i] ? target : HOLE;
    }
    return board;
  }

  function maskToBoard(mask, target) {
    return boardFromMask(mask.rows, mask.cols, mask.mask, target);
  }

  /** mask 中已选格子数 */
  function maskCount(mask) {
    let n = 0;
    for (let i = 0; i < mask.length; i++) if (mask[i]) n++;
    return n;
  }

  Yicai.Core = {
    HOLE,
    COLOR_COUNT,
    COLORS,
    RED,
    GREEN,
    BLUE,
    YELLOW,
    DEFAULT_TARGET,
    MAX_LIMIT,
    isValidColor,
    clampLimit,
    createBoard,
    cloneBoard,
    boardEquals,
    cellIndex,
    rowOf,
    colOf,
    inBounds,
    isActive,
    colorAt,
    activeCount,
    neighborsOf,
    buildAdjacency,
    componentAt,
    connectedGroups,
    componentList,
    colorsPresent,
    applyColor,
    applyMove,
    isSolved,
    simulate,
    boardKey,
    serialize,
    deserialize,
    cellLabel,
    representativeIndex,
    rectangleMask,
    maskFromPattern,
    boardFromMask,
    maskToBoard,
    maskCount,
  };
})(typeof window !== 'undefined' ? window : globalThis);
