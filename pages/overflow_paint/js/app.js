/**
 * app.js —— 页面交互层：棋盘渲染、调色盘、提示 / 答案 / 演示、自定义选项与进度保存。
 *
 * 传统脚本（非 ES Module），依赖同目录下的 core / generator / solver / store，
 * 由 overflow_paint.html 按顺序引入。
 */

(function (global) {
  'use strict';

  const Yicai = (global.Yicai = global.Yicai || {});
  const Core = Yicai.Core;
  const Generator = Yicai.Generator;
  const Solver = Yicai.Solver;
  const Store = Yicai.Store;
  const Share = Yicai.Share;
  const MinSteps = Yicai.MinSteps;

  const MASK_ROWS = 10;
  const MASK_COLS = 10;
  /** 「步数 +1」的额外上限，防止无意义地一直加 */
  const EXTRA_CAP = 15;
  const DEMO_INTERVAL = 380;
  /** 最短步数计算每一片最多占用的毫秒数（越小越不影响操作） */
  const MINSTEPS_SLICE = 10;
  /** 两片之间让出多少毫秒，避免一直占着主线程 */
  const MINSTEPS_DELAY = 8;

  /** 自绘图形默认形状（心形） */
  const DEFAULT_PATTERN = [
    '..........', '.###..###.', '##########', '##########', '##########',
    '.########.', '..######..', '...####...', '....##....', '..........',
  ];

  /** 自绘图形预设按钮（'#' = 选中） */
  const PRESETS = [
    {
      key: 'full',
      name: '全选',
      pattern: [
        '##########', '##########', '##########', '##########', '##########',
        '##########', '##########', '##########', '##########', '##########',
      ],
    },
  ];

  const demoState = { timer: 0 };

  const state = {
    settings: {
      mode: 'rect',
      rows: 8,
      cols: 10,
      limit: 8,
      target: Core.YELLOW,
      mask: defaultMask(),
      marks: false,
      preferUnique: false,
      computeMinSteps: false,
    },
    draft: null,
    puzzle: null,
    board: null,
    history: [],
    extra: 0,
    status: 'playing',
    selectedColor: Core.RED,
    hoverIndex: -1,
    hint: null,
    planMoves: null,
    codeMode: 'share',
    minSteps: null,
    demo: null,
    busy: false,
    message: '',
    messageKind: 'info',
  };

  let els = {};
  let cellEls = [];
  let domSignature = '';
  let hoverCells = [];
  let hintTimer = 0;
  let paintValue = 1;
  let painting = false;
  let minStepsJob = null;
  let minStepsTimer = 0;

  // ------------------------------------------------------------------ 工具

  function byId(id) {
    return document.getElementById(id);
  }

  function colorName(index) {
    return Core.COLORS[index] ? Core.COLORS[index].name : '?';
  }

  function colorHex(index) {
    return Core.COLORS[index] ? Core.COLORS[index].hex : '#ccc';
  }

  function defaultMask() {
    return patternToMask(DEFAULT_PATTERN);
  }

  function patternToMask(pattern) {
    const parsed = Core.maskFromPattern(pattern);
    return parsed.mask;
  }

  function maskToText(mask) {
    if (!mask) return '';
    let out = '';
    for (let i = 0; i < mask.length; i++) out += mask[i] ? '1' : '0';
    return out;
  }

  function textToMask(text, length) {
    const mask = new Int8Array(length);
    for (let i = 0; i < length; i++) mask[i] = text && text[i] === '1' ? 1 : 0;
    return mask;
  }

  function cloneSettings(s) {
    return {
      mode: s.mode,
      rows: s.rows,
      cols: s.cols,
      limit: s.limit,
      target: s.target,
      mask: Int8Array.from(s.mask || defaultMask()),
      marks: !!s.marks,
      preferUnique: !!s.preferUnique,
      computeMinSteps: !!s.computeMinSteps,
    };
  }

  function totalSteps() {
    return state.puzzle ? state.puzzle.limit + state.extra : 0;
  }

  function usedSteps() {
    return state.history.length;
  }

  function remainingSteps() {
    return Math.max(0, totalSteps() - usedSteps());
  }

  function countNonTarget(board, target) {
    let n = 0;
    for (let i = 0; i < board.cells.length; i++) {
      if (board.cells[i] !== Core.HOLE && board.cells[i] !== target) n++;
    }
    return n;
  }

  function setMessage(text, kind) {
    state.message = text || '';
    state.messageKind = kind || 'info';
  }

  // ------------------------------------------------------------- 出题 / 存档

  function generatePuzzle(settings) {
    const s = settings || state.settings;
    let rows;
    let cols;
    let mask = null;
    if (s.mode === 'mask') {
      rows = MASK_ROWS;
      cols = MASK_COLS;
      mask = Int8Array.from(s.mask || defaultMask());
      if (Core.maskCount(mask) < 2) {
        setMessage('自绘图形至少要选中 2 格。', 'warn');
        render();
        return false;
      }
    } else {
      rows = s.rows;
      cols = s.cols;
    }

    const puzzle = Generator.generate({
      rows,
      cols,
      mask,
      target: s.target,
      limit: s.limit,
      timeBudgetMs: 450,
      preferUnique: !!s.preferUnique,
    });

    state.puzzle = {
      rows,
      cols,
      mask: mask ? Int8Array.from(mask) : null,
      target: puzzle.target,
      limit: puzzle.limit,
      cap: s.limit,
      board: puzzle.board,
      solution: puzzle.solution,
      steps: puzzle.steps,
      components: puzzle.components,
      source: puzzle.source,
      unique: puzzle.unique,
      uniqueCount: puzzle.uniqueCount,
      trivial: puzzle.trivial,
    };
    state.board = Core.cloneBoard(puzzle.board);
    state.history = [];
    state.extra = 0;
    state.status = puzzle.trivial ? 'won' : 'playing';
    state.hint = null;
    state.demo = null;
    state.hoverIndex = -1;
    state.selectedColor = (puzzle.target + 1) % Core.COLOR_COUNT;
    domSignature = '';
    if (puzzle.trivial) {
      setMessage('这个图形太碎了（每块只有一格），开局就已经是目标色，换一个图形试试。', 'warn');
    } else {
      setMessage('选择一种颜色，然后点击棋盘上的色块。本题参考解 ' + puzzle.steps + ' 步。');
    }
    render();
    persist();
    restartMinSteps();
    return true;
  }

  /** 出题可能要几百毫秒，先给个「出题中」的反馈，再让浏览器把手画出来 */
  function requestPuzzle(settings) {
    if (state.busy) return;
    state.busy = true;
    setMessage('正在出题…（棋盘越大越慢，勾选「唯一解」会更慢）');
    render();
    setTimeout(() => {
      state.busy = false;
      generatePuzzle(settings);
    }, 30);
  }

  function settingsSnapshot() {
    return {
      mode: state.settings.mode,
      rows: state.settings.rows,
      cols: state.settings.cols,
      limit: state.settings.limit,
      target: state.settings.target,
      marks: !!state.settings.marks,
      preferUnique: !!state.settings.preferUnique,
      computeMinSteps: !!state.settings.computeMinSteps,
      mask: maskToText(state.settings.mask),
    };
  }

  function applySettingsSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return;
    const s = state.settings;
    if (snapshot.mode === 'rect' || snapshot.mode === 'mask') s.mode = snapshot.mode;
    if (Number.isFinite(snapshot.rows)) s.rows = Math.min(15, Math.max(1, Math.round(snapshot.rows)));
    if (Number.isFinite(snapshot.cols)) s.cols = Math.min(20, Math.max(1, Math.round(snapshot.cols)));
    if (Number.isFinite(snapshot.limit)) s.limit = Core.clampLimit(snapshot.limit);
    if (Core.isValidColor(snapshot.target)) s.target = snapshot.target;
    s.marks = !!snapshot.marks;
    s.preferUnique = !!snapshot.preferUnique;
    s.computeMinSteps = !!snapshot.computeMinSteps;
    if (typeof snapshot.mask === 'string' && snapshot.mask.length === MASK_ROWS * MASK_COLS) {
      s.mask = textToMask(snapshot.mask, MASK_ROWS * MASK_COLS);
    }
  }

  function persist() {
    if (!state.puzzle) return;
    const game = {
      rows: state.puzzle.rows,
      cols: state.puzzle.cols,
      target: state.puzzle.target,
      limit: state.puzzle.limit,
      cap: state.puzzle.cap || state.puzzle.limit,
      unique: state.puzzle.unique,
      uniqueCount: state.puzzle.uniqueCount == null ? null : state.puzzle.uniqueCount,
      components: state.puzzle.components || 0,
      source: state.puzzle.source || '',
      answerSource: state.puzzle.answerSource || '',
      mask: state.puzzle.mask ? maskToText(state.puzzle.mask) : '',
      cells: Core.serialize(state.puzzle.board),
      solution: (state.puzzle.solution || []).map((m) => [m.index, m.color]),
      board: Core.serialize(state.board),
      history: state.history.map((h) => [h.index, h.color, h.from, h.cells.join(',')]),
      extra: state.extra,
      status: state.status,
    };
    Store.save({ v: 1, settings: settingsSnapshot(), game });
  }

  function restore() {
    const data = Store.load();
    if (!data || typeof data !== 'object') return false;
    try {
      applySettingsSnapshot(data.settings);
      const g = data.game;
      if (!g || !Number.isFinite(g.rows) || !Number.isFinite(g.cols)) return false;
      const rows = Math.round(g.rows);
      const cols = Math.round(g.cols);
      if (rows < 1 || cols < 1 || rows > 15 || cols > 20) return false;
      if (!Core.isValidColor(g.target)) return false;
      const initial = Core.deserialize(g.cells, rows, cols);
      const board = Core.deserialize(g.board, rows, cols);
      if (!initial || !board) return false;

      state.puzzle = {
        rows,
        cols,
        mask:
          typeof g.mask === 'string' && g.mask.length === rows * cols
            ? textToMask(g.mask, rows * cols)
            : null,
        target: g.target,
        limit: Core.clampLimit(g.limit),
        cap: Number.isFinite(g.cap) ? Core.clampLimit(g.cap) : Core.clampLimit(g.limit),
        unique: g.unique === true ? true : g.unique === false ? false : null,
        uniqueCount: Number.isFinite(g.uniqueCount) ? g.uniqueCount : null,
        components: Number.isFinite(g.components) ? g.components : 0,
        source: typeof g.source === 'string' ? g.source : '',
        answerSource: typeof g.answerSource === 'string' ? g.answerSource : '',
        board: initial,
        solution: Array.isArray(g.solution)
          ? g.solution
              .filter((pair) => Array.isArray(pair) && Number.isInteger(pair[0]) && Core.isValidColor(pair[1]))
              .map((pair) => ({ index: pair[0], color: pair[1] }))
          : [],
        steps: 0,
        layers: 0,
        groups: 0,
        trivial: false,
      };      state.puzzle.steps = state.puzzle.solution.length;
      state.board = board;
      state.history = Array.isArray(g.history)
        ? g.history
            .filter((h) => Array.isArray(h) && Number.isInteger(h[0]) && Core.isValidColor(h[1]))
            .map((h) => ({
              index: h[0],
              color: h[1],
              from: Core.isValidColor(h[2]) ? h[2] : Core.HOLE,
              cells: String(h[3] || '')
                .split(',')
                .filter((t) => t !== '')
                .map(Number),
            }))
            .filter((h) => h.cells.length)
        : [];
      state.extra = Math.min(EXTRA_CAP, Math.max(0, Math.round(g.extra) || 0));
      state.status = g.status === 'won' || g.status === 'lost' ? g.status : 'playing';
      state.selectedColor = (state.puzzle.target + 1) % Core.COLOR_COUNT;
      state.hint = null;
      state.demo = null;
      domSignature = '';
      setMessage('已恢复上次的进度。');
      render();
      restartMinSteps();
      return true;
    } catch (error) {
      return false;
    }
  }

  // ------------------------------------------------- 精确最短步数（后台计算）

  function stopMinSteps(reason) {
    if (minStepsTimer) {
      clearTimeout(minStepsTimer);
      minStepsTimer = 0;
    }
    if (minStepsJob) {
      minStepsJob.stop();
      minStepsJob = null;
    }
    if (state.minSteps && state.minSteps.status === 'running') {
      state.minSteps = Object.assign({}, state.minSteps, { status: 'stopped', reason: reason || 'stopped' });
    }
  }

  /** 换题时调用：清掉旧任务，按设置决定是否开新任务 */
  function restartMinSteps() {
    stopMinSteps('replaced');
    state.minSteps = null;
    if (!state.settings.computeMinSteps || !state.puzzle || state.puzzle.trivial) {
      renderStats();
      return;
    }
    if (!MinSteps) {
      renderStats();
      return;
    }
    minStepsJob = MinSteps.createJob(state.puzzle.board, state.puzzle.target, {
      maxDepth: 40,
      countOptimal: true, // 顺带数出「最优解有几个」，用来标唯一解 / 多解
    });
    state.minSteps = snapshotMinSteps(minStepsJob.state);
    renderStats();
    minStepsTimer = setTimeout(pumpMinSteps, 0);
  }

  function snapshotMinSteps(jobState) {
    return {
      status: jobState.status,
      exact: jobState.exact,
      lower: jobState.provenLower,
      depth: jobState.depth,
      nodes: jobState.nodes,
      elapsed: jobState.elapsed,
      optimalCount: jobState.optimalCount,
    };
  }

  /** 每次只算一小片，让玩家可以边算边玩 */
  function pumpMinSteps() {
    minStepsTimer = 0;
    if (!minStepsJob) return;
    const running = minStepsJob.step(MINSTEPS_SLICE);
    state.minSteps = snapshotMinSteps(minStepsJob.state);
    if (state.minSteps.exact != null && !state.minSteps.adopted) {
      // 最短解一找到就先换答案，之后继续确认唯一性不影响它
      state.minSteps.adopted = true;
      adoptOptimalSolution(minStepsJob.state.solution);
    }
    if (running) {
      renderStats();
      minStepsTimer = setTimeout(pumpMinSteps, MINSTEPS_DELAY);
      return;
    }
    const finished = minStepsJob;
    minStepsJob = null;
    if (state.minSteps.status === 'done') {
      state.minSteps.finishedAt = Date.now();
      if (state.minSteps.optimalCount == null) ensureUniqueLabel();
      adoptOptimalSolution(finished.state.solution);
      persist();
    }
    // 收尾时整体重绘一次：提示文字可能也被换掉了
    render();
  }

  function formatNodes(nodes) {
    if (nodes >= 1e8) return (nodes / 1e8).toFixed(2) + ' 亿';
    if (nodes >= 1e4) return (nodes / 1e4).toFixed(1) + ' 万';
    return String(nodes);
  }

  /** 题目「唯一解 / 多解」的标识（出题时的判定，未验证时返回 null） */
  function uniqueLabel() {
    if (!state.puzzle) return null;
    if (state.puzzle.unique === true) return '唯一解';
    if (state.puzzle.unique === false) return '多解';
    return null;
  }

  /**
   * 精确计算给出的「最优解个数」更权威（它数的是最短步数的解有几个），有它就优先用；
   * 没有才退回出题时的判定。两者都与「尽量出唯一解」开关无关。
   */
  function effectiveUniqueLabel() {
    const info = state.minSteps;
    if (info && info.status === 'done' && info.optimalCount != null) {
      return info.optimalCount === 1 ? '唯一解' : '多解';
    }
    return uniqueLabel();
  }

  /** 已经算出的最短步数（还在确认唯一性也算；没开 / 没算到则返回 null） */
  function exactMinSteps() {
    return state.minSteps && state.minSteps.exact != null ? state.minSteps.exact : null;
  }

  function minStepsText() {
    const info = state.minSteps;
    if (!info) return '–';
    if (info.status === 'done') {
      // 算完就一并标出唯一解 / 多解（勾不勾「尽量出唯一解」都一样）
      const label = effectiveUniqueLabel();
      return info.exact + ' 步' + (label ? ' · ' + label : '');
    }
    if (info.status === 'stopped') {
      if (info.exact != null) return '已停止 · 最短 ' + info.exact + ' 步（唯一性未验证）';
      return '已停止 · 最少 ≥ ' + info.lower + ' 步';
    }
    if (info.exact != null) {
      // 已经找到最短解，正在继续数「还有没有同样短的解」
      return (
        '最短 ' +
        info.exact +
        ' 步 · 正在确认唯一性… · ' +
        formatNodes(info.nodes) +
        ' 节点 · ' +
        Math.round(info.elapsed) +
        'ms'
      );
    }
    return (
      '计算中… 最少 ≥ ' +
      info.lower +
      ' 步 · ' +
      formatNodes(info.nodes) +
      ' 节点 · ' +
      Math.round(info.elapsed) +
      'ms'
    );
  }

  /** 出题时的唯一性判定超时、且精确计算也没给出个数时，补一次（限制步数内的解的个数） */
  function ensureUniqueLabel() {
    const puzzle = state.puzzle;
    if (!puzzle || puzzle.unique !== null || !Solver || !Solver.countOptimal) return;
    const counted = Solver.countOptimal(puzzle.board, puzzle.target, puzzle.limit, {
      timeMs: 250,
      nodeLimit: 120000,
      maxCount: 2,
    });
    if (!counted.timedOut) {
      puzzle.uniqueCount = counted.count;
      puzzle.unique = counted.count === 1;
    }
  }

  /**
   * 算出确切最短步数后：如果比现在的参考解更短，就把「答案」换成这条最短解。
   * 限制步数不动（那是玩家正在用的游戏规则），只让提示 / 看答案给最优解。
   */
  function adoptOptimalSolution(moves) {
    const puzzle = state.puzzle;
    if (!puzzle || !moves || !moves.length) return false;
    const current = puzzle.solution ? puzzle.solution.length : Infinity;
    if (moves.length >= current) return false;
    if (!Core.simulate(puzzle.board, moves, puzzle.target).solved) return false;
    puzzle.solution = moves.map((move) => ({ index: move.index, color: move.color }));
    puzzle.steps = puzzle.solution.length;
    puzzle.answerSource = 'shortest';
    clearHint();
    setMessage('已算出确切最短步数 ' + moves.length + ' 步，参考答案也换成了这条最短解。', 'good');
    return true;
  }

  function renderMinSteps() {
    const enabled = !!state.settings.computeMinSteps && !!state.puzzle && !state.puzzle.trivial;
    els.statMinWrap.hidden = !enabled;
    if (!enabled) {
      // 关掉之后要彻底清干净，别留着最后一次的结果
      els.statMinSteps.textContent = '';
      els.statMinSteps.classList.remove('computing', 'unique');
      els.statMinSteps.title = '';
      return;
    }
    const info = state.minSteps;
    els.statMinSteps.textContent = minStepsText();
    els.statMinSteps.classList.toggle('computing', !!info && info.status === 'running');
    els.statMinSteps.classList.toggle('unique', !!info && info.status === 'done');
    els.statMinSteps.title =
      info && info.status === 'running' ? '正在精确穷举，点一下可以停止计算' : '点一下可以重新开始计算';
  }

  // ------------------------------------------------------------------ 渲染

  function ensureBoardDom() {
    const board = state.board;
    if (!board) return;
    const signature =
      board.rows + 'x' + board.cols + ':' + Core.serialize(board).replace(/[0-3]/g, '.');
    if (signature === domSignature && cellEls.length === board.cells.length) return;

    domSignature = signature;
    const fragment = document.createDocumentFragment();
    cellEls = new Array(board.cells.length);
    for (let i = 0; i < board.cells.length; i++) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      if (board.cells[i] === Core.HOLE) {
        cell.classList.add('hole');
      } else {
        cell.dataset.index = String(i);
        cell.dataset.mark = Core.COLORS[board.cells[i]].mark;
      }
      fragment.appendChild(cell);
      cellEls[i] = cell;
    }
    els.board.innerHTML = '';
    els.board.appendChild(fragment);
    clearHover();
  }

  function paintBoard() {
    const board = state.board;
    if (!board) return;
    for (let i = 0; i < board.cells.length; i++) {
      const cell = cellEls[i];
      if (!cell) continue;
      const value = board.cells[i];
      if (value === Core.HOLE) {
        cell.style.background = '';
        cell.dataset.mark = '';
        continue;
      }
      const hex = colorHex(value);
      if (cell.dataset.color !== String(value)) {
        cell.dataset.color = String(value);
        cell.dataset.mark = Core.COLORS[value].mark;
      }
      cell.style.background = hex;
    }
    els.board.classList.toggle('marks', !!state.settings.marks);
    els.board.classList.toggle('solved', Core.isSolved(board, state.puzzle.target));
  }

  function layoutBoard() {
    const board = state.board;
    if (!board) return;
    const wrapWidth = els.boardWrap.clientWidth || 600;
    const viewportHeight = global.innerHeight || 800;
    const maxHeight = Math.max(220, Math.min(viewportHeight * 0.6, 620));
    const gap = board.cols > 14 || board.rows > 11 ? 2 : 4;
    const cellSize = Math.max(
      9,
      Math.floor(
        Math.min(
          (wrapWidth - gap * (board.cols - 1)) / board.cols,
          (maxHeight - gap * (board.rows - 1)) / board.rows
        )
      )
    );
    els.board.style.setProperty('--gap', gap + 'px');
    els.board.style.setProperty('--cell', cellSize + 'px');
    els.board.style.gridTemplateColumns = 'repeat(' + board.cols + ', ' + cellSize + 'px)';
    els.board.style.gridTemplateRows = 'repeat(' + board.rows + ', ' + cellSize + 'px)';
  }

  function renderStats() {
    const left = remainingSteps();
    els.statLeft.textContent = String(left);
    els.statLeft.classList.toggle('danger', left === 0 && state.status === 'playing');
    els.statUsed.textContent = usedSteps() + ' / ' + totalSteps();
    const puzzle = state.puzzle;
    const target = puzzle ? puzzle.target : Core.DEFAULT_TARGET;
    els.statTarget.style.background = colorHex(target);
    els.statTarget.textContent = colorName(target);

    // 「本题」这一栏的排布：
    //   · 没开强制计算：上限 M 步 · 参考解 N 步 · 唯一解/多解（唯一解标识放最右）
    //   · 开了强制计算：算之前显示「上限 + 参考解」；算出确切最短步数后
    //     参考解隐去，步数只由右边那栏「最短步数」负责
    const cap = puzzle ? puzzle.cap || puzzle.limit : 0;
    const parts = ['上限 ' + cap + ' 步'];
    if (!state.settings.computeMinSteps || exactMinSteps() == null) {
      parts.push('参考解 ' + (puzzle ? puzzle.limit : 0) + ' 步');
    }
    if (!state.settings.computeMinSteps) {
      const label = uniqueLabel();
      if (label) parts.push(label);
    }
    els.statDifficulty.textContent = parts.join(' · ');
    els.statDifficulty.classList.toggle('unique', !!(puzzle && puzzle.unique === true));
    renderMinSteps();
  }

  function renderSlots() {
    const total = totalSteps();
    const used = usedSteps();
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < total; i++) {
      const dot = document.createElement('span');
      dot.className = 'slot';
      if (i >= (state.puzzle ? state.puzzle.limit : total)) dot.classList.add('extra');
      if (i < used) {
        dot.classList.add('filled');
        dot.style.background = colorHex(state.history[i].color);
      } else if (i === used && state.status === 'playing') {
        dot.classList.add('current');
      }
      fragment.appendChild(dot);
    }
    els.slots.innerHTML = '';
    els.slots.appendChild(fragment);
  }

  function buildPalette() {
    els.palette.innerHTML = '';
    Core.COLORS.forEach((color, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'swatch';
      button.dataset.color = String(index);
      button.style.setProperty('--swatch', color.hex);
      button.innerHTML =
        '<span class="swatch-dot"></span><span class="swatch-name">' +
        color.name +
        '色</span><span class="swatch-key">' +
        (index + 1) +
        '</span>';
      button.addEventListener('click', () => selectColor(index));
      els.palette.appendChild(button);
    });
  }

  function renderPalette() {
    const target = state.puzzle ? state.puzzle.target : Core.DEFAULT_TARGET;
    for (const button of els.palette.children) {
      const index = Number(button.dataset.color);
      button.classList.toggle('selected', index === state.selectedColor);
      button.classList.toggle('target', index === target);
      button.classList.toggle('hint', !!state.hint && state.hint.color === index);
      button.setAttribute('aria-pressed', index === state.selectedColor ? 'true' : 'false');
    }
  }

  function renderButtons() {
    const playing = state.status === 'playing' && !state.busy && !state.demo;
    els.btnHint.disabled = !playing || remainingSteps() <= 0;
    els.btnAnswer.disabled = state.busy || !!state.demo || !state.puzzle;
    els.btnPlus.disabled = state.busy || !!state.demo || state.extra >= EXTRA_CAP;
    els.btnUndo.disabled = !playing || state.history.length === 0;
    els.btnRestart.disabled = state.busy || !!state.demo;
    els.btnNew.disabled = state.busy;
    els.btnShare.disabled = state.busy || !state.puzzle;
    els.btnImport.disabled = state.busy;
    els.btnOptions.disabled = state.busy;
  }

  function renderDemoControls() {
    const demo = state.demo;
    els.demoControls.hidden = !demo;
    if (!demo) return;
    els.demoProgress.textContent = '演示：' + demo.i + ' / ' + demo.moves.length + ' 步';
    els.btnDemoNext.disabled = demo.i >= demo.moves.length;
    els.btnDemoAll.disabled = demo.auto || demo.i >= demo.moves.length;
    els.btnDemoAll.textContent = demo.auto ? '演示中…' : '完整演示';
  }

  function renderMessage() {
    els.message.textContent = state.message;
    els.message.className = 'message ' + (state.messageKind || 'info');
  }

  function renderBanner() {
    if (state.demo || !state.puzzle || state.status === 'playing') {
      els.banner.hidden = true;
      return;
    }
    const target = state.puzzle.target;
    const won = state.status === 'won';
    els.banner.hidden = false;
    els.bannerTitle.textContent = won ? '🎉 完成！' : '步数用完了';
    els.bannerText.textContent = won
      ? '共 ' +
        usedSteps() +
        ' 步' +
        (state.extra ? '（其中 ' + state.extra + ' 步额外步数）' : '') +
        '，整幅图都染成了' +
        colorName(target) +
        '色。'
      : '还剩 ' +
        countNonTarget(state.board, target) +
        ' 格不是' +
        colorName(target) +
        '色，可以用「步数 +1」继续，或者重开 / 换一题。';
    els.bannerActions.innerHTML = '';
    if (!won) {
      els.bannerActions.appendChild(makeButton('步数 +1 继续', 'primary', addStep));
    }
    els.bannerActions.appendChild(makeButton('重开本题', '', restart));
    els.bannerActions.appendChild(makeButton('随机新题', '', () => requestPuzzle(state.settings)));
    els.bannerActions.appendChild(makeButton('自定义选项', '', openOptions));
  }

  function makeButton(label, className, handler) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    if (className) button.className = className;
    button.addEventListener('click', handler);
    return button;
  }

  function renderHint() {
    if (!state.hint || !state.board) return;
    const { cells, index, color } = state.hint;
    for (const i of cells) {
      if (cellEls[i]) cellEls[i].classList.add('hint');
    }
    if (cellEls[index]) {
      cellEls[index].classList.add('hint-anchor');
      cellEls[index].style.setProperty('--hint-color', colorHex(color));
    }
    els.board.classList.add('has-hint');
  }

  function clearHint() {
    if (hintTimer) {
      clearTimeout(hintTimer);
      hintTimer = 0;
    }
    state.hint = null;
    for (const cell of cellEls) {
      if (cell) {
        cell.classList.remove('hint', 'hint-anchor');
        cell.style.removeProperty('--hint-color');
      }
    }
    if (els.board) els.board.classList.remove('has-hint');
  }

  function scheduleHintClear() {
    if (hintTimer) clearTimeout(hintTimer);
    hintTimer = setTimeout(() => {
      clearHint();
      renderPalette();
    }, 7000);
  }

  function flash(cells) {
    for (const i of cells) {
      const cell = cellEls[i];
      if (!cell) continue;
      cell.classList.remove('pop');
      // 触发一次重排，让动画能重新播放
      void cell.offsetWidth;
      cell.classList.add('pop');
    }
    setTimeout(() => {
      for (const i of cells) {
        if (cellEls[i]) cellEls[i].classList.remove('pop');
      }
    }, 320);
  }

  function render() {
    if (!state.board) return;
    ensureBoardDom();
    paintBoard();
    layoutBoard();
    renderStats();
    renderSlots();
    renderPalette();
    renderButtons();
    renderDemoControls();
    renderMessage();
    renderBanner();
    renderHint();
  }

  // ------------------------------------------------------------ 交互：落子

  function selectColor(index) {
    if (!Core.isValidColor(index)) return;
    state.selectedColor = index;
    renderPalette();
    updateHover(state.hoverIndex);
  }

  function handleCellClick(index) {
    if (state.demo) {
      stopDemo();
      return;
    }
    if (state.busy || state.status !== 'playing' || !state.puzzle) return;
    const board = state.board;
    if (!Core.isActive(board, index)) return;
    const from = board.cells[index];
    const color = state.selectedColor;
    if (from === color) {
      setMessage('这一块已经是' + colorName(color) + '色了，换一种颜色再点。', 'warn');
      renderMessage();
      return;
    }

    const cells = Core.componentAt(board, index);
    Core.applyColor(board, cells, color);
    state.history.push({ index, color, from, cells: cells.slice() });
    clearHint();
    state.hoverIndex = -1;
    hoverCells = [];

    const total = totalSteps();
    const target = state.puzzle.target;
    if (Core.isSolved(board, target)) {
      state.status = 'won';
      setMessage('完成！共 ' + usedSteps() + ' 步，全部染成了' + colorName(target) + '色。', 'good');
    } else if (usedSteps() >= total) {
      state.status = 'lost';
      setMessage('步数用完了，还剩 ' + countNonTarget(board, target) + ' 格不是目标色。', 'warn');
    } else {
      setMessage(
        '把 ' +
          Core.cellLabel(board, index) +
          ' 的' +
          colorName(from) +
          '色块（' +
          cells.length +
          ' 格）染成了' +
          colorName(color) +
          '色 · 剩余 ' +
          remainingSteps() +
          ' 步。'
      );
    }
    render();
    flash(cells);
    persist();
  }

  function updateHover(index) {
    if (index === state.hoverIndex) return;
    clearHover();
    state.hoverIndex = index;
    if (index < 0 || !state.board || !Core.isActive(state.board, index)) {
      els.board.classList.remove('same-color');
      return;
    }
    const cells = Core.componentAt(state.board, index);
    for (const i of cells) {
      if (cellEls[i]) cellEls[i].classList.add('hover');
    }
    hoverCells = cells;
    els.board.classList.toggle('same-color', state.board.cells[index] === state.selectedColor);
  }

  function clearHover() {
    for (const i of hoverCells) {
      if (cellEls[i]) cellEls[i].classList.remove('hover');
    }
    hoverCells = [];
    if (els.board) els.board.classList.remove('same-color');
  }

  // ------------------------------------------------- 提示 / 答案 / 演示

  /** 若当前局面正好走在出题时留下的参考解路径上，直接返回剩余部分 */
  function builtinSuffix() {
    const puzzle = state.puzzle;
    if (!puzzle || !puzzle.solution || !puzzle.solution.length) {
      return puzzle && Core.boardEquals(state.board, puzzle.board) ? [] : null;
    }
    if (Core.boardEquals(state.board, puzzle.board)) return puzzle.solution.slice();
    const work = Core.cloneBoard(puzzle.board);
    const adj = Core.buildAdjacency(work);
    for (let i = 0; i < puzzle.solution.length; i++) {
      if (Core.boardEquals(work, state.board)) return puzzle.solution.slice(i);
      const move = puzzle.solution[i];
      if (Core.isActive(work, move.index) && work.cells[move.index] !== move.color) {
        Core.applyMove(work, move.index, move.color, adj);
      }
    }
    return Core.boardEquals(work, state.board) ? [] : null;
  }

  function computePlan(limit, options) {
    const suffix = builtinSuffix();
    if (suffix && suffix.length <= limit) {
      return { moves: suffix, source: 'builtin', fits: true };
    }
    const result = Solver.solve(state.board, state.puzzle.target, limit, options);
    const searched = result.moves && result.moves.length ? result.moves : null;
    if (searched && searched.length <= limit) {
      return { moves: searched, source: result.source, fits: true, lowerBound: result.lowerBound };
    }
    // 两个候选都超出步数上限时，取更短的那个交给 UI 去提示
    const candidates = [];
    if (suffix && suffix.length) candidates.push({ moves: suffix, source: 'builtin' });
    if (searched) candidates.push({ moves: searched, source: result.source });
    if (!candidates.length) {
      return { moves: null, source: 'none', fits: false, timedOut: result.timedOut };
    }
    candidates.sort((a, b) => a.moves.length - b.moves.length);
    return {
      moves: candidates[0].moves,
      source: candidates[0].source,
      fits: false,
      lowerBound: result.lowerBound,
      timedOut: result.timedOut,
    };
  }

  function doHint() {
    if (!state.puzzle || state.busy || state.demo || state.status !== 'playing') return;
    const remaining = remainingSteps();
    if (remaining <= 0) {
      setMessage('没有剩余步数了，先「步数 +1」或者「重开本题」。', 'warn');
      render();
      return;
    }
    const plan = computePlan(remaining, { optimize: false, timeMs: 250 });
    if (!plan.moves || !plan.moves.length) {
      setMessage(
        '当前局面在剩余 ' +
          remaining +
          ' 步内没能算出解' +
          (plan.timedOut ? '（搜索超时）' : '') +
          '，可以「步数 +1」或者「重开本题」。',
        'warn'
      );
      render();
      return;
    }
    const move = plan.moves[0];
    const work = Core.cloneBoard(state.board);
    const adj = Core.buildAdjacency(work);
    const from = work.cells[move.index];
    const cells = Core.componentAt(work, move.index, adj);
    state.hint = { index: move.index, color: move.color, from, cells };
    const howTo =
      '点击 ' +
      Core.cellLabel(state.board, move.index) +
      ' 的' +
      colorName(from) +
      '色块（' +
      cells.length +
      ' 格），染成' +
      colorName(move.color) +
      '色';
    if (!plan.fits) {
      setMessage(
        '提示：' +
          howTo +
          '。不过当前局面至少还需要 ' +
          plan.moves.length +
          ' 步，而只剩 ' +
          remaining +
          ' 步，建议「步数 +1」或「重开本题」。',
        'warn'
      );
    } else {
      setMessage(
        '提示：' +
          howTo +
          (plan.moves.length > 1 ? '（参考解还需 ' + plan.moves.length + ' 步）' : '（最后一步）') +
          '。',
        'hint'
      );
    }
    render();
    scheduleHintClear();
  }

  function doAnswer() {
    if (!state.puzzle || state.busy || state.demo) return;
    state.busy = true;
    setMessage('正在计算参考解…');
    render();
    setTimeout(() => {
      const limit = totalSteps() + 20;
      const plan = computePlan(limit, { optimize: true, timeMs: 1100 });
      state.busy = false;
      if (!plan.moves || !plan.moves.length) {
        setMessage('没能在预算内算出解。可以「重开本题」——初始局面的参考解一定存在。', 'warn');
        render();
        return;
      }
      openAnswerModal(plan);
      render();
    }, 40);
  }

  function describePlan(moves) {
    const adj = Core.buildAdjacency(state.board);
    const work = Core.cloneBoard(state.board);
    const items = [];
    for (const move of moves) {
      if (!Core.isActive(work, move.index)) break;
      const from = work.cells[move.index];
      if (from === move.color) continue;
      const cells = Core.componentAt(work, move.index, adj);
      Core.applyColor(work, cells, move.color);
      items.push({ index: move.index, from, to: move.color, size: cells.length });
    }
    return { items, board: work };
  }

  function openAnswerModal(plan) {
    const described = describePlan(plan.moves);
    const remaining = remainingSteps();
    state.planMoves = plan.moves.slice();

    const sourceText =
      plan.source === 'builtin'
        ? state.puzzle && state.puzzle.answerSource === 'shortest'
          ? '精确计算得到的最短解'
          : '出题时的参考解'
        : plan.source === 'shortest'
          ? '搜索得到的最短解'
          : plan.source === 'improved'
            ? '搜索得到的更短解'
            : plan.source === 'greedy'
              ? '贪心解（够用，但未必最短）'
              : '参考解';

    els.answerSummary.textContent =
      sourceText +
      '：共 ' +
      described.items.length +
      ' 步 · 当前剩余 ' +
      remaining +
      ' 步' +
      (plan.fits
        ? '，按此操作可以通关。'
        : '，超出 ' + Math.max(0, described.items.length - remaining) + ' 步，可以「步数 +1」。');

    els.answerList.innerHTML = '';
    described.items.forEach((item, i) => {
      const li = document.createElement('li');
      const step = document.createElement('span');
      step.className = 'answer-step';
      step.textContent = '第 ' + (i + 1) + ' 步';
      const text = document.createElement('span');
      text.className = 'answer-text';
      text.innerHTML =
        '点击 ' +
        Core.cellLabel(state.board, item.index) +
        ' 的 <b style="color:' +
        colorHex(item.from) +
        '">' +
        colorName(item.from) +
        '</b> 色块（' +
        item.size +
        ' 格）→ 染成 <b style="color:' +
        colorHex(item.to) +
        '">' +
        colorName(item.to) +
        '</b>';
      li.appendChild(step);
      li.appendChild(text);
      els.answerList.appendChild(li);
    });

    els.answerEmpty.hidden = described.items.length > 0;
    els.answerDemo.disabled = described.items.length === 0;
    openModal(els.answerModal);
  }

  function startDemo() {
    const moves = state.planMoves || [];
    if (!moves.length) return;
    closeModal(els.answerModal);
    stopDemo(true);
    clearHint();
    state.demo = { saved: Core.cloneBoard(state.board), moves: moves.slice(), i: 0, auto: false };
    state.hoverIndex = -1;
    setMessage('演示：点「下一步」一步一步看，或点「完整演示」一次演到底。');
    render();
  }

  function applyDemoMove(move) {
    if (!Core.isActive(state.board, move.index)) return false;
    if (state.board.cells[move.index] === move.color) return false;
    const cells = Core.componentAt(state.board, move.index);
    Core.applyColor(state.board, cells, move.color);
    return cells;
  }

  /** 前进一步 */
  function demoNext() {
    const demo = state.demo;
    if (!demo || demo.i >= demo.moves.length) return false;
    const cells = applyDemoMove(demo.moves[demo.i]);
    demo.i++;
    if (demo.i >= demo.moves.length) {
      setMessage('演示完毕：这就是通关后的样子。点「结束演示」回到原局面。', 'good');
    } else {
      setMessage('演示：已演 ' + demo.i + ' / ' + demo.moves.length + ' 步。');
    }
    render();
    if (cells) flash(cells);
    return true;
  }

  /** 一路演到底 */
  function demoAll() {
    const demo = state.demo;
    if (!demo || demo.auto) return;
    demo.auto = true;
    const tick = () => {
      const current = state.demo;
      if (!current || !current.auto) return;
      if (current.i >= current.moves.length) return;
      demoNext();
      if (state.demo === current && current.i < current.moves.length) {
        demoState.timer = setTimeout(tick, DEMO_INTERVAL);
      }
    };
    tick();
  }

  function stopDemo(silent) {
    if (!state.demo) return;
    if (demoState.timer) {
      clearTimeout(demoState.timer);
      demoState.timer = 0;
    }
    state.board = state.demo.saved;
    state.demo = null;
    if (!silent) setMessage('已回到原来的局面。');
    render();
  }

  // -------------------------------------------------------------- 步数与重开

  function addStep() {
    if (!state.puzzle || state.busy || state.demo) return;
    if (state.extra >= EXTRA_CAP) {
      setMessage('额外步数已达上限（+' + EXTRA_CAP + '）。', 'warn');
      render();
      return;
    }
    state.extra++;
    if (state.status === 'lost') state.status = 'playing';
    setMessage('限制步数 +1，当前共 ' + totalSteps() + ' 步。', 'info');
    render();
    persist();
  }

  function undo() {
    if (!state.puzzle || state.demo || state.busy) return;
    if (state.status !== 'playing' && state.status !== 'lost') return;
    const last = state.history.pop();
    if (!last) return;
    for (const i of last.cells) state.board.cells[i] = last.from;
    state.status = 'playing';
    clearHint();
    state.hoverIndex = -1;
    setMessage('已撤销上一步，剩余 ' + remainingSteps() + ' 步。');
    render();
    persist();
  }

  function restart() {
    if (!state.puzzle || state.demo) return;
    stopDemo(true);
    state.board = Core.cloneBoard(state.puzzle.board);
    state.history = [];
    state.status = 'playing';
    clearHint();
    state.hoverIndex = -1;
    setMessage('已重开本题（限制 ' + totalSteps() + ' 步）。');
    render();
    persist();
  }

  // ------------------------------------------------------------ 分享 / 导入

  /** 把当前题目存成一串分享码 */
  function openShare() {
    if (!state.puzzle) return;
    let code = '';
    try {
      code = Share.encode({
        rows: state.puzzle.rows,
        cols: state.puzzle.cols,
        target: state.puzzle.target,
        limit: state.puzzle.limit,
        board: state.puzzle.board,
        solution: state.puzzle.solution,
      });
    } catch (error) {
      setMessage('这道题暂时没法编码成分享码。', 'warn');
      render();
      return;
    }
    els.codeTitle.textContent = '分享题目';
    els.codeHint.textContent =
      '把下面这串字符发给别人，对方点「导入」粘贴即可得到同一道题（' + code.length + ' 个字符）。';
    els.codeText.value = code;
    els.codeText.readOnly = true;
    els.codeConfirm.textContent = '复制';
    els.codeError.hidden = true;
    state.codeMode = 'share';
    openModal(els.codeModal);
    els.codeText.focus();
    els.codeText.select();
  }

  function openImport() {
    els.codeTitle.textContent = '导入题目';
    els.codeHint.textContent = '粘贴一串分享码（以 YC 开头），点「导入」载入这道题。';
    els.codeText.value = '';
    els.codeText.readOnly = false;
    els.codeConfirm.textContent = '导入';
    els.codeError.hidden = true;
    state.codeMode = 'import';
    openModal(els.codeModal);
    els.codeText.focus();
  }

  function copyCode() {
    els.codeText.select();
    let ok = false;
    try {
      if (global.navigator && global.navigator.clipboard && global.navigator.clipboard.writeText) {
        global.navigator.clipboard.writeText(els.codeText.value);
        ok = true;
      } else if (document.execCommand) {
        ok = document.execCommand('copy');
      }
    } catch (error) {
      ok = false;
    }
    setMessage(ok ? '分享码已复制到剪贴板。' : '复制失败，请手动选中复制。', ok ? 'good' : 'warn');
    render();
  }

  /** 载入分享码里的题目 */
  function applyImported(data) {
    const Core2 = Core;
    let solution = data.solution;
    let limit = data.limit;
    // 分享码没带解法（或解法对不上）时现场算一个，保证「提示 / 答案」能用
    if (!solution.length && !Core2.isSolved(data.board, data.target)) {
      const found =
        Generator.feasibleSolution(data.board, data.target, limit) ||
        Solver.greedy(data.board, data.target, {});
      if (found && found.length) {
        solution = found;
        if (found.length > limit) limit = found.length;
      }
    }
    state.puzzle = {
      rows: data.rows,
      cols: data.cols,
      mask: data.mask.mask.some((v) => !v) ? Int8Array.from(data.mask.mask) : null,
      target: data.target,
      limit,
      cap: limit,
      board: data.board,
      solution,
      steps: solution.length,
      components: Core2.componentList(data.board).length,
      source: 'import',
      unique: null,
      uniqueCount: null,
      answerSource: 'import',
      trivial: solution.length === 0,
    };
    state.board = Core2.cloneBoard(data.board);
    state.history = [];
    state.extra = 0;
    state.status = state.puzzle.trivial ? 'won' : 'playing';
    state.hint = null;
    state.demo = null;
    state.hoverIndex = -1;
    state.selectedColor = (data.target + 1) % Core2.COLOR_COUNT;

    // 让「自定义选项」也跟着同步，之后随机新题会沿用导入题目的形状
    state.settings.mode = state.puzzle.mask ? 'mask' : 'rect';
    state.settings.rows = Math.min(15, data.rows);
    state.settings.cols = Math.min(20, data.cols);
    state.settings.limit = Core2.clampLimit(limit);
    state.settings.target = data.target;
    if (state.puzzle.mask) state.settings.mask = Int8Array.from(state.puzzle.mask);

    domSignature = '';
    setMessage('已导入题目：参考解 ' + solution.length + ' 步，限制 ' + limit + ' 步。');
    render();
    persist();
    restartMinSteps();
  }

  function confirmImport() {
    const text = els.codeText.value || '';
    const data = Share.decode(text);
    if (!data) {
      els.codeError.textContent = '这串分享码看不懂（可能复制不全或抄错了），请检查后重试。';
      els.codeError.hidden = false;
      return;
    }
    closeModal(els.codeModal);
    applyImported(data);
  }

  // ------------------------------------------------------------ 自定义选项

  function openOptions() {
    if (state.demo) stopDemo(true);
    state.draft = cloneSettings(state.settings);
    syncOptionsUi();
    openModal(els.optionsModal);
  }

  function syncOptionsUi() {
    const d = state.draft || state.settings;
    for (const tab of els.optionTabs) {
      tab.classList.toggle('active', tab.dataset.mode === d.mode);
    }
    els.paneRect.hidden = d.mode !== 'rect';
    els.paneMask.hidden = d.mode !== 'mask';
    els.optCols.value = String(d.cols);
    els.optRows.value = String(d.rows);
    els.optLimit.value = String(d.limit);
    els.optLimitOut.textContent = d.limit + ' 步';
    els.optMarks.checked = !!d.marks;
    els.optUnique.checked = !!d.preferUnique;
    els.optMinSteps.checked = !!d.computeMinSteps;
    for (const chip of els.optTargetChips.children) {
      const index = Number(chip.dataset.color);
      chip.classList.toggle('selected', index === d.target);
      chip.setAttribute('aria-pressed', index === d.target ? 'true' : 'false');
    }
    for (let i = 0; i < els.maskGrid.children.length; i++) {
      const button = els.maskGrid.children[i];
      const on = d.mask && d.mask[i] ? true : false;
      button.classList.toggle('on', on);
      button.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    updateMaskInfo();
  }

  function updateMaskInfo() {
    const d = state.draft;
    if (!d) return;
    const count = Core.maskCount(d.mask);
    const board = Core.boardFromMask(MASK_ROWS, MASK_COLS, d.mask, d.target);
    const groups = Core.connectedGroups(board).length;
    let text = '已选 ' + count + ' 格 · ' + groups + ' 个连通块';
    let warn = false;
    if (count < 2) {
      text += ' · 至少要选 2 格';
      warn = true;
    } else if (groups > 1) {
      text += ' · 图形不连通，将按块分别出题（仍然可以完成）';
    }
    els.maskInfo.textContent = text;
    els.maskInfo.classList.toggle('warn', warn);
    els.optApply.disabled = d.mode === 'mask' && count < 2;
  }

  function buildOptionsPanel() {
    els.optionTabs = Array.from(els.optionsModal.querySelectorAll('.tab'));
    els.paneRect = byId('pane-rect');
    els.paneMask = byId('pane-mask');
    els.optCols = byId('opt-cols');
    els.optRows = byId('opt-rows');
    els.optLimit = byId('opt-limit');
    els.optLimitOut = byId('opt-limit-out');
    els.optMarks = byId('opt-marks');
    els.optUnique = byId('opt-unique');
    els.optMinSteps = byId('opt-minsteps');
    els.optTargetChips = byId('opt-target-chips');
    els.maskGrid = byId('mask-grid');
    els.maskInfo = byId('mask-info');
    els.optApply = byId('opt-apply');

    // 目标颜色
    Core.COLORS.forEach((color, index) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.dataset.color = String(index);
      chip.style.setProperty('--chip', color.hex);
      chip.textContent = color.name;
      chip.addEventListener('click', () => {
        if (!state.draft) return;
        state.draft.target = index;
        syncOptionsUi();
      });
      els.optTargetChips.appendChild(chip);
    });

    // 自绘图形：10×10 网格
    for (let i = 0; i < MASK_ROWS * MASK_COLS; i++) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'mask-cell';
      button.dataset.index = String(i);
      button.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        if (!state.draft) return;
        paintValue = state.draft.mask[i] ? 0 : 1;
        painting = true;
        state.draft.mask[i] = paintValue;
        syncOptionsUi();
      });
      button.addEventListener('pointerenter', () => {
        if (!painting || !state.draft) return;
        state.draft.mask[i] = paintValue;
        syncOptionsUi();
      });
      els.maskGrid.appendChild(button);
    }

    const presetsBox = byId('mask-presets');
    for (const preset of PRESETS) {
      presetsBox.appendChild(
        makeButton(preset.name, '', () => {
          if (!state.draft) return;
          state.draft.mask = patternToMask(preset.pattern);
          syncOptionsUi();
        })
      );
    }
    presetsBox.appendChild(
      makeButton('反选', '', () => {
        if (!state.draft) return;
        for (let i = 0; i < state.draft.mask.length; i++) state.draft.mask[i] = state.draft.mask[i] ? 0 : 1;
        syncOptionsUi();
      })
    );
    presetsBox.appendChild(
      makeButton('清除', '', () => {
        if (!state.draft) return;
        state.draft.mask = new Int8Array(MASK_ROWS * MASK_COLS);
        syncOptionsUi();
      })
    );
    presetsBox.appendChild(
      makeButton('随机', '', () => {
        if (!state.draft) return;
        const mask = new Int8Array(MASK_ROWS * MASK_COLS);
        for (let i = 0; i < mask.length; i++) mask[i] = Math.random() < 0.58 ? 1 : 0;
        state.draft.mask = mask;
        syncOptionsUi();
      })
    );
  }

  // ---------------------------------------------------------------- 弹窗

  function openModal(modal) {
    modal.hidden = false;
    document.body.classList.add('modal-open');
  }

  function closeModal(modal) {
    modal.hidden = true;
    const anyOpen =
      !els.optionsModal.hidden || !els.answerModal.hidden || !els.codeModal.hidden;
    if (anyOpen) return;
    document.body.classList.remove('modal-open');
  }

  function closeAllModals() {
    els.optionsModal.hidden = true;
    els.answerModal.hidden = true;
    els.codeModal.hidden = true;
    document.body.classList.remove('modal-open');
  }

  function anyModalOpen() {
    return !els.optionsModal.hidden || !els.answerModal.hidden || !els.codeModal.hidden;
  }

  // ---------------------------------------------------------------- 事件

  function bindEvents() {
    els.board.addEventListener('click', (event) => {
      const cell = event.target.closest('.cell');
      if (!cell || cell.classList.contains('hole')) return;
      handleCellClick(Number(cell.dataset.index));
    });
    els.board.addEventListener('pointerover', (event) => {
      const cell = event.target.closest('.cell');
      if (!cell || cell.classList.contains('hole')) return;
      updateHover(Number(cell.dataset.index));
    });
    els.board.addEventListener('pointerleave', () => updateHover(-1));

    els.btnHint.addEventListener('click', doHint);
    els.btnAnswer.addEventListener('click', doAnswer);
    els.btnPlus.addEventListener('click', addStep);
    els.btnUndo.addEventListener('click', undo);
    els.btnRestart.addEventListener('click', restart);
    els.btnNew.addEventListener('click', () => requestPuzzle(state.settings));
    els.btnShare.addEventListener('click', openShare);
    els.btnImport.addEventListener('click', openImport);
    els.btnOptions.addEventListener('click', openOptions);
    els.btnDemoNext.addEventListener('click', demoNext);
    els.btnDemoAll.addEventListener('click', demoAll);
    els.btnDemoStop.addEventListener('click', () => stopDemo());

    els.statMinWrap.addEventListener('click', () => {
      if (!state.settings.computeMinSteps || !state.puzzle || state.puzzle.trivial) return;
      if (state.minSteps && state.minSteps.status === 'running') {
        const lower = state.minSteps.lower;
        stopMinSteps('stopped');
        renderStats();
        setMessage('已停止计算最短步数（目前只证明了最少 ≥ ' + lower + ' 步）。');
      } else {
        restartMinSteps();
        setMessage('重新开始精确计算最短步数…（可以边玩边算）');
      }
      renderMessage();
    });

    els.answerDemo.addEventListener('click', startDemo);
    els.answerClose.addEventListener('click', () => closeModal(els.answerModal));

    els.codeConfirm.addEventListener('click', () => {
      if (state.codeMode === 'import') confirmImport();
      else copyCode();
    });
    els.codeCancel.addEventListener('click', () => closeModal(els.codeModal));
    els.codeClose.addEventListener('click', () => closeModal(els.codeModal));
    els.codeModal.addEventListener('click', (event) => {
      if (event.target === els.codeModal) closeModal(els.codeModal);
    });
    els.codeText.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        if (state.codeMode === 'import') confirmImport();
        else copyCode();
      } else if (event.key === 'Enter' && state.codeMode === 'import' && !event.shiftKey) {
        event.preventDefault();
        confirmImport();
      }
    });

    els.optionsModal.addEventListener('click', (event) => {
      if (event.target === els.optionsModal) closeModal(els.optionsModal);
    });
    els.answerModal.addEventListener('click', (event) => {
      if (event.target === els.answerModal) closeModal(els.answerModal);
    });
    byId('opt-close').addEventListener('click', () => closeModal(els.optionsModal));
    byId('opt-cancel').addEventListener('click', () => closeModal(els.optionsModal));

    for (const tab of els.optionTabs) {
      tab.addEventListener('click', () => {
        if (!state.draft) return;
        state.draft.mode = tab.dataset.mode;
        syncOptionsUi();
      });
    }
    els.optCols.addEventListener('input', () => {
      if (!state.draft) return;
      state.draft.cols = Math.min(20, Math.max(1, Math.round(Number(els.optCols.value) || 1)));
      syncOptionsUi();
    });
    els.optRows.addEventListener('input', () => {
      if (!state.draft) return;
      state.draft.rows = Math.min(15, Math.max(1, Math.round(Number(els.optRows.value) || 1)));
      syncOptionsUi();
    });
    els.optLimit.addEventListener('input', () => {
      if (!state.draft) return;
      state.draft.limit = Core.clampLimit(els.optLimit.value);
      els.optLimitOut.textContent = state.draft.limit + ' 步';
    });
    els.optMarks.addEventListener('change', () => {
      if (!state.draft) return;
      state.draft.marks = els.optMarks.checked;
    });
    els.optUnique.addEventListener('change', () => {
      if (!state.draft) return;
      state.draft.preferUnique = els.optUnique.checked;
    });
    els.optMinSteps.addEventListener('change', () => {
      const on = els.optMinSteps.checked;
      if (state.draft) state.draft.computeMinSteps = on;
      // 「强制计算」是显示/计算开关，立刻生效，不用重新出题
      state.settings.computeMinSteps = on;
      if (!on) {
        stopMinSteps('disabled');
        state.minSteps = null;
      }
      restartMinSteps();
      persist();
    });
    els.optApply.addEventListener('click', () => {
      if (!state.draft) return;
      state.settings = cloneSettings(state.draft);
      closeModal(els.optionsModal);
      requestPuzzle(state.settings);
    });

    global.addEventListener('pointerup', () => {
      painting = false;
    });
    global.addEventListener('pointercancel', () => {
      painting = false;
    });
    global.addEventListener('resize', layoutBoard);

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        if (anyModalOpen()) {
          closeAllModals();
          return;
        }
        if (state.demo) stopDemo();
        return;
      }
      const tag = (event.target && event.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (anyModalOpen()) return;
      const key = event.key.toLowerCase();
      if (key >= '1' && key <= '4') {
        selectColor(Number(key) - 1);
      } else if (key === 'h') {
        doHint();
      } else if (key === 'u') {
        undo();
      } else if (key === 'r') {
        restart();
      }
    });
  }

  // ---------------------------------------------------------------- 启动

  function init() {
    els = {
      board: byId('board'),
      boardWrap: byId('board-wrap'),
      slots: byId('slots'),
      message: byId('message'),
      palette: byId('palette'),
      statLeft: byId('stat-left'),
      statUsed: byId('stat-used'),
      statTarget: byId('stat-target'),
      statDifficulty: byId('stat-difficulty'),
      statMinWrap: byId('stat-min-wrap'),
      statMinSteps: byId('stat-minsteps'),
      banner: byId('banner'),
      bannerTitle: byId('banner-title'),
      bannerText: byId('banner-text'),
      bannerActions: byId('banner-actions'),
      btnHint: byId('btn-hint'),
      btnAnswer: byId('btn-answer'),
      btnPlus: byId('btn-plus'),
      btnUndo: byId('btn-undo'),
      btnRestart: byId('btn-restart'),
      btnNew: byId('btn-new'),
      btnShare: byId('btn-share'),
      btnImport: byId('btn-import'),
      btnOptions: byId('btn-options'),
      btnDemoStop: byId('btn-demo-stop'),
      btnDemoNext: byId('btn-demo-next'),
      btnDemoAll: byId('btn-demo-all'),
      demoControls: byId('demo-controls'),
      demoProgress: byId('demo-progress'),
      codeModal: byId('code-modal'),
      codeTitle: byId('code-title'),
      codeHint: byId('code-hint'),
      codeText: byId('code-text'),
      codeError: byId('code-error'),
      codeConfirm: byId('code-confirm'),
      codeCancel: byId('code-cancel'),
      codeClose: byId('code-close'),
      optionsModal: byId('options-modal'),
      answerModal: byId('answer-modal'),
      answerList: byId('answer-list'),
      answerSummary: byId('answer-summary'),
      answerEmpty: byId('answer-empty'),
      answerDemo: byId('answer-demo'),
      answerClose: byId('answer-close'),
    };

    buildPalette();
    buildOptionsPanel();
    bindEvents();

    if (!restore()) {
      generatePuzzle(state.settings);
    }
  }

  Yicai.App = { init, state };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(typeof window !== 'undefined' ? window : globalThis);
