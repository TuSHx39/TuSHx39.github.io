import test from 'node:test';
import assert from 'node:assert/strict';

import { readHtml, scriptSources, loadYicaiScripts } from './helpers/load-yicai.mjs';
import { createDom } from './helpers/fake-dom.mjs';

/**
 * 可控定时器（虚拟时钟）。
 * 按「到期时间」顺序执行，和浏览器的定时器队列一致 —— 这样 0/8ms 的自我重排定时器
 * （最短步数计算的分片）就不会把 30ms 的定时器饿死。
 */
function createTimers() {
  let nextId = 1;
  let now = 0;
  const pending = new Map();
  return {
    setTimeout(fn, ms) {
      const id = nextId++;
      pending.set(id, { fn, due: now + (ms || 0) });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    /** 执行到没有到期任务为止（最多 limit 次，避免死循环） */
    run(limit = 400) {
      let count = 0;
      while (pending.size && count++ < limit) {
        let bestId = null;
        let bestDue = Infinity;
        for (const [id, job] of pending) {
          if (job.due < bestDue || (job.due === bestDue && (bestId === null || id < bestId))) {
            bestDue = job.due;
            bestId = id;
          }
        }
        const job = pending.get(bestId);
        pending.delete(bestId);
        now = Math.max(now, bestDue);
        job.fn();
      }
      return count;
    },
    get size() {
      return pending.size;
    },
  };
}

function createStorage() {
  const map = new Map();
  return {
    map,
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      map.set(key, String(value));
    },
    removeItem(key) {
      map.delete(key);
    },
  };
}

function boot(storage) {
  const dom = createDom(readHtml());
  const timers = createTimers();
  const store = storage || createStorage();
  const sandbox = loadYicaiScripts(
    {
      document: dom.document,
      innerHeight: 900,
      localStorage: store,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      addEventListener() {},
      removeEventListener() {},
    },
    scriptSources()
  );
  const Yicai = sandbox.Yicai;
  return { sandbox, Yicai, Core: Yicai.Core, dom, timers, storage: store, app: Yicai.App.state };
}

function boardEl(dom) {
  return dom.document.getElementById('board');
}

function click(dom, id) {
  const el = dom.document.getElementById(id);
  assert.ok(el, `找不到 #${id}`);
  assert.equal(el.dispatch('click', { target: el }), true, `#${id} 没有绑定点击事件`);
  return el;
}

function clickCell(dom, index) {
  const board = boardEl(dom);
  const cell = board.children[index];
  assert.ok(cell, `棋盘上不存在第 ${index} 格`);
  board.dispatch('click', { target: cell });
}

function clickSwatch(dom, color) {
  const palette = dom.document.getElementById('palette');
  const swatch = palette.children[color];
  assert.ok(swatch, `调色盘上不存在第 ${color} 个颜色`);
  swatch.dispatch('click', { target: swatch });
}

function pressKey(dom, key) {
  for (const handler of dom.document.listeners.get('keydown') || []) {
    handler({ key, target: dom.document.body, preventDefault() {} });
  }
}

function textOf(dom, id) {
  return dom.document.getElementById(id).textContent;
}

function firstCellNotTarget(app) {
  for (let i = 0; i < app.board.cells.length; i++) {
    if (app.board.cells[i] !== -1 && app.board.cells[i] !== app.puzzle.target) return i;
  }
  return -1;
}

test('app：初始化后棋盘、步数、调色盘都就绪', () => {
  const { dom, app, Core } = boot();
  assert.ok(app.puzzle, '应该已经生成题目');
  assert.equal(app.board.rows, 8);
  assert.equal(app.board.cols, 10);
  assert.equal(boardEl(dom).children.length, 80);
  assert.equal(Number(textOf(dom, 'stat-left')), app.puzzle.limit);
  assert.equal(textOf(dom, 'stat-used'), `0 / ${app.puzzle.limit}`);
  assert.equal(dom.document.getElementById('palette').children.length, 4);
  assert.equal(dom.document.getElementById('slots').children.length, app.puzzle.limit);
  assert.equal(dom.document.getElementById('banner').hidden, true);
  assert.ok(textOf(dom, 'message').length > 0);
  for (let i = 0; i < app.board.cells.length; i++) {
    const cell = boardEl(dom).children[i];
    if (app.board.cells[i] === Core.HOLE) {
      assert.equal(cell.classList.contains('hole'), true);
      continue;
    }
    assert.equal(cell.style.background, Core.COLORS[app.board.cells[i]].hex);
  }
});

test('app：照着参考解点完就能通关', () => {
  const { dom, app, Core } = boot();
  const solution = app.puzzle.solution.slice();
  assert.ok(solution.length > 0);
  for (const move of solution) {
    clickSwatch(dom, move.color);
    clickCell(dom, move.index);
  }
  assert.equal(app.status, 'won');
  assert.equal(Core.isSolved(app.board, app.puzzle.target), true);
  assert.equal(dom.document.getElementById('banner').hidden, false);
  assert.match(textOf(dom, 'banner-title'), /完成/);
  // 参考解可能比限制步数更短，剩多少步取决于出题结果
  assert.equal(textOf(dom, 'stat-left'), String(app.puzzle.limit - solution.length));
  assert.equal(dom.document.getElementById('btn-hint').disabled, true);
  assert.equal(dom.document.getElementById('btn-undo').disabled, true);
});

test('app：同色点击不消耗步数，撤销与重开都正常', () => {
  const { dom, app, Core } = boot();
  const before = Core.serialize(app.board);
  const index = firstCellNotTarget(app);
  const target = index >= 0 ? index : 0;
  const cellColor = app.board.cells[target];
  const newColor = cellColor === app.puzzle.target ? (cellColor + 1) % 4 : app.puzzle.target;
  clickSwatch(dom, newColor);
  clickCell(dom, target);
  assert.equal(app.history.length, 1);
  assert.equal(Number(textOf(dom, 'stat-left')), app.puzzle.limit - 1);

  // 再点同一块（现在已是选中色）→ 不消耗步数
  clickCell(dom, target);
  assert.equal(app.history.length, 1);
  assert.match(textOf(dom, 'message'), /已经是/);

  click(dom, 'btn-undo');
  assert.equal(app.history.length, 0);
  assert.equal(Core.serialize(app.board), before);

  clickCell(dom, target);
  assert.equal(app.history.length, 1);
  click(dom, 'btn-restart');
  assert.equal(app.history.length, 0);
  assert.equal(Core.serialize(app.board), before);
});

test('app：提示会标出「点哪一块、染成什么颜色」', () => {
  const { dom, app, timers } = boot();
  click(dom, 'btn-hint');
  assert.ok(app.hint, '提示应该给出落子');
  assert.ok(app.hint.cells.length >= 1);
  assert.match(textOf(dom, 'message'), /提示/);
  const anchored = app.hint.cells.filter((i) => boardEl(dom).children[i].classList.contains('hint'));
  assert.equal(anchored.length, app.hint.cells.length);
  timers.run(); // 提示会在若干秒后自动清除
  assert.equal(app.hint, null);
});

test('app：看答案 → 列出步骤，演示默认一步一步，可一键演到底再退出', () => {
  const { dom, app, Core, timers } = boot();
  const before = Core.serialize(app.board);
  click(dom, 'btn-answer');
  timers.run(); // 答案计算放在 setTimeout 里，先让提示文案渲染出来
  const modal = dom.document.getElementById('answer-modal');
  assert.equal(modal.hidden, false);
  const list = dom.document.getElementById('answer-list');
  assert.ok(list.children.length > 0, '答案列表不应为空');
  assert.match(textOf(dom, 'answer-summary'), /步/);

  click(dom, 'answer-demo');
  assert.equal(modal.hidden, true);
  assert.ok(app.demo, '应该进入演示状态');
  assert.equal(app.demo.i, 0, '默认不自动演，先等「下一步」');
  assert.equal(dom.document.getElementById('demo-controls').hidden, false);
  assert.equal(textOf(dom, 'demo-progress'), '演示：0 / ' + app.demo.moves.length + ' 步');
  assert.equal(Core.serialize(app.board), before, '进入演示时盘面不该变');

  // 下一步：一次只走一步
  click(dom, 'btn-demo-next');
  assert.equal(app.demo.i, 1);
  assert.equal(textOf(dom, 'demo-progress'), '演示：1 / ' + app.demo.moves.length + ' 步');
  assert.equal(app.status, 'playing', '演示不改变真实进度');
  assert.match(textOf(dom, 'message'), /已演 1/);

  // 完整演示：一路演到底
  click(dom, 'btn-demo-all');
  timers.run();
  assert.equal(app.demo.i, app.demo.moves.length);
  assert.equal(Core.isSolved(app.board, app.puzzle.target), true, '演示应该演到通关');
  assert.equal(dom.document.getElementById('btn-demo-next').disabled, true);

  click(dom, 'btn-demo-stop');
  assert.equal(app.demo, null);
  assert.equal(Core.serialize(app.board), before, '退出演示应恢复原局面');
  assert.equal(dom.document.getElementById('demo-controls').hidden, true);
});

test('app：勾选「强制计算最短步数」后边算边玩，算完只剩最短步数', () => {
  const { dom, app, Yicai, timers } = boot();
  // 默认没开 → 栏目隐藏
  assert.equal(dom.document.getElementById('stat-min-wrap').hidden, true);
  assert.equal(app.minSteps, null);
  // 没开时「本题」是：上限 · 参考解 · 唯一解/多解
  assert.match(textOf(dom, 'stat-difficulty'), /^上限 \d+ 步 · 参考解 \d+ 步/);

  click(dom, 'btn-options');
  const uniqueBox = dom.document.getElementById('opt-unique');
  if (uniqueBox.checked) {
    uniqueBox.checked = false;
    uniqueBox.dispatch('change', { target: uniqueBox });
  }
  const box = dom.document.getElementById('opt-minsteps');
  box.checked = true;
  box.dispatch('change', { target: box });
  assert.equal(app.draft.computeMinSteps, true);
  // 用 4x4 的小盘面，计算能很快结束
  const cols = dom.document.getElementById('opt-cols');
  const rows = dom.document.getElementById('opt-rows');
  const limit = dom.document.getElementById('opt-limit');
  cols.value = '4';
  cols.dispatch('input', { target: cols });
  rows.value = '4';
  rows.dispatch('input', { target: rows });
  limit.value = '6';
  limit.dispatch('input', { target: limit });
  click(dom, 'opt-apply');
  timers.run(200); // 出题 + 计算分片都挂在定时器上（4x4 很快能算完）

  assert.equal(app.settings.computeMinSteps, true);
  assert.equal(dom.document.getElementById('stat-min-wrap').hidden, false);
  assert.ok(app.minSteps, '应该有一个最短步数任务');
  assert.equal(app.minSteps.status, 'done');
  const exact = app.minSteps.exact;
  assert.ok(exact >= 1 && exact <= app.puzzle.steps, `算出的最短步数不合理：${exact}`);
  assert.equal(app.minSteps.lower, exact, '算完后下界应等于确切最短步数');
  // 算完之后「本题」不再显示参考解，只剩上限
  const diff = textOf(dom, 'stat-difficulty');
  assert.match(diff, /^上限 \d+ 步$/);
  assert.doesNotMatch(diff, /参考解/);
  // 最短步数那栏只显示步数 + 唯一解/多解（与「尽量出唯一解」开关无关）
  const minText = textOf(dom, 'stat-minsteps');
  assert.match(minText, new RegExp('^' + exact + ' 步'));
  assert.doesNotMatch(minText, /已证明最短/);
  const expectLabel =
    app.minSteps.optimalCount === 1
      ? '唯一解'
      : app.minSteps.optimalCount >= 2
        ? '多解'
        : app.puzzle.unique === true
          ? '唯一解'
          : app.puzzle.unique === false
            ? '多解'
            : null;
  if (expectLabel) assert.match(minText, new RegExp('· ' + expectLabel + '$'));
  // 结果必须真的是最短：少一步应该无解
  const shorter = Yicai.Solver.search(app.puzzle.board, app.puzzle.target, exact - 1, { timeMs: 4000 });
  assert.equal(shorter.moves, null, '不该存在更短的解');
});

test('app：计算期间照常可以落子，也可以点栏目停下来', () => {
  const { dom, app, Core, Yicai, timers } = boot();
  click(dom, 'btn-options');
  const uniqueBox = dom.document.getElementById('opt-unique');
  if (uniqueBox.checked) {
    uniqueBox.checked = false;
    uniqueBox.dispatch('change', { target: uniqueBox });
  }
  const box = dom.document.getElementById('opt-minsteps');
  box.checked = true;
  box.dispatch('change', { target: box });

  // 用一道「确定很难精确穷举」的盘面（20x15 完全随机、不平滑）导入，
  // 这样它必然长时间处于计算中，测试不受随机出题影响。
  const board = Yicai.Generator.randomPuzzle(
    15,
    20,
    null,
    Core.YELLOW,
    Yicai.Generator.createRng(7),
    0
  );
  const code = Yicai.Share.encode({
    rows: 15,
    cols: 20,
    target: Core.YELLOW,
    limit: 15,
    board,
    solution: [],
  });
  click(dom, 'btn-import');
  dom.document.getElementById('code-text').value = code;
  click(dom, 'code-confirm');
  timers.run(120);

  assert.equal(app.minSteps.status, 'running', '大盘面应该还在计算中');
  assert.match(textOf(dom, 'stat-minsteps'), /计算中/);
  assert.match(textOf(dom, 'stat-minsteps'), /最少 ≥ \d+ 步/);
  // 还在算的时候，本题仍然显示「上限 + 参考解」
  assert.match(textOf(dom, 'stat-difficulty'), /^上限 \d+ 步 · 参考解 \d+ 步$/);

  // 计算中依然能落子
  const before = app.history.length;
  let index = -1;
  for (let i = 0; i < app.board.cells.length; i++) {
    if (app.board.cells[i] !== Core.HOLE && app.board.cells[i] !== app.selectedColor) {
      index = i;
      break;
    }
  }
  assert.ok(index >= 0);
  clickCell(dom, index);
  assert.equal(app.history.length, before + 1, '计算期间应该还能操作棋盘');

  // 点一下栏目 → 停止计算
  click(dom, 'stat-min-wrap');
  assert.equal(app.minSteps.status, 'stopped');
  assert.match(textOf(dom, 'stat-minsteps'), /已停止/);
  assert.match(textOf(dom, 'message'), /已停止计算最短步数/);

  // 再点一下 → 重新开始
  click(dom, 'stat-min-wrap');
  assert.equal(app.minSteps.status, 'running');
  assert.match(textOf(dom, 'stat-minsteps'), /计算中/);
});

test('app：关掉「强制计算最短步数」立刻清空并隐藏那一栏（不用重新出题）', () => {
  const { dom, app, Core, timers } = boot();
  const snapshot = Core.serialize(app.board);
  click(dom, 'btn-options');
  const uniqueBox = dom.document.getElementById('opt-unique');
  if (uniqueBox.checked) {
    uniqueBox.checked = false;
    uniqueBox.dispatch('change', { target: uniqueBox });
  }
  const box = dom.document.getElementById('opt-minsteps');
  box.checked = true;
  box.dispatch('change', { target: box });
  timers.run(30);
  assert.equal(dom.document.getElementById('stat-min-wrap').hidden, false);
  assert.ok(textOf(dom, 'stat-minsteps').length > 0);

  // 先停掉计算（免得它一直占着定时器队列），再关掉开关
  click(dom, 'stat-min-wrap');
  assert.equal(app.minSteps.status, 'stopped');
  const box2 = dom.document.getElementById('opt-minsteps');
  box2.checked = false;
  box2.dispatch('change', { target: box2 });

  assert.equal(app.settings.computeMinSteps, false);
  assert.equal(app.minSteps, null, '关掉后不该还留着最后一次结果');
  assert.equal(dom.document.getElementById('stat-min-wrap').hidden, true);
  assert.equal(textOf(dom, 'stat-minsteps'), '', '栏位文字要清空');
  assert.equal(Core.serialize(app.board), snapshot, '开关不该重新出题');
  // 「本题」恢复成 上限 · 参考解 的形式
  assert.match(textOf(dom, 'stat-difficulty'), /^上限 \d+ 步 · 参考解 \d+ 步/);

  // 再开一次应该能重新算
  const box3 = dom.document.getElementById('opt-minsteps');
  box3.checked = true;
  box3.dispatch('change', { target: box3 });
  assert.equal(dom.document.getElementById('stat-min-wrap').hidden, false);
  assert.ok(app.minSteps);
  click(dom, 'stat-min-wrap');
});

test('app：开了强制计算 + 唯一解时，算完只在最短步数旁标唯一解', () => {
  const { dom, app, timers } = boot();
  click(dom, 'btn-options');
  const uniqueBox = dom.document.getElementById('opt-unique');
  uniqueBox.checked = true;
  uniqueBox.dispatch('change', { target: uniqueBox });
  const box = dom.document.getElementById('opt-minsteps');
  box.checked = true;
  box.dispatch('change', { target: box });
  const cols = dom.document.getElementById('opt-cols');
  const rows = dom.document.getElementById('opt-rows');
  const limit = dom.document.getElementById('opt-limit');
  cols.value = '4';
  cols.dispatch('input', { target: cols });
  rows.value = '4';
  rows.dispatch('input', { target: rows });
  limit.value = '4';
  limit.dispatch('input', { target: limit });
  click(dom, 'opt-apply');

  // 起初：本题只显示「上限 + 参考解」（不带唯一解标识）
  const early = textOf(dom, 'stat-difficulty');
  assert.match(early, /^上限 \d+ 步 · 参考解 \d+ 步$/);
  assert.doesNotMatch(early, /唯一解|多解/);

  timers.run(400);
  assert.equal(app.minSteps.status, 'done');
  // 算完：本题不再显示参考解，唯一解标识挪到最短步数旁边
  const after = textOf(dom, 'stat-difficulty');
  assert.match(after, /^上限 \d+ 步$/);
  assert.doesNotMatch(after, /唯一解|多解/);
  const minText = textOf(dom, 'stat-minsteps');
  assert.match(minText, /^\d+ 步/);
  const expectLabel =
    app.minSteps.optimalCount === 1
      ? '唯一解'
      : app.minSteps.optimalCount >= 2
        ? '多解'
        : app.puzzle.unique === true
          ? '唯一解'
          : app.puzzle.unique === false
            ? '多解'
            : null;
  if (expectLabel) assert.match(minText, new RegExp('· ' + expectLabel + '$'));
});

test('app：没开强制计算时，「本题」是 上限 → 参考解 → 唯一解 的顺序', () => {
  const { dom, app } = boot();
  const text = textOf(dom, 'stat-difficulty');
  assert.match(text, /^上限 \d+ 步 · 参考解 \d+ 步/);
  const iCap = text.indexOf('上限');
  const iRef = text.indexOf('参考解');
  assert.ok(iCap < iRef, '步数上限应在参考解左边');
  if (app.puzzle.unique === true || app.puzzle.unique === false) {
    const label = app.puzzle.unique === true ? '唯一解' : '多解';
    assert.match(text, new RegExp(label + '$'), `${label} 标识应放最右边`);
    assert.ok(iRef < text.indexOf(label));
  }
});

test('app：算出最短解后，如果比原参考解更短就把答案也换掉', () => {
  const { dom, app, Core, Yicai, timers } = boot();
  // 手工造一道 2x2 的题：答案本来要 2 步，其实 1 步就能完成
  const board = Core.deserialize('0011', 2, 2);
  const suboptimal = [
    { index: 0, color: 2 },
    { index: 0, color: 1 },
  ];
  assert.equal(Core.simulate(board, suboptimal, 1).solved, true, '这条解法本身要有效');
  const code = Yicai.Share.encode({
    rows: 2,
    cols: 2,
    target: 1,
    limit: 2,
    board,
    solution: suboptimal,
  });
  click(dom, 'btn-import');
  dom.document.getElementById('code-text').value = code;
  click(dom, 'code-confirm');
  timers.run(20);
  assert.equal(app.puzzle.steps, 2, '导入时参考答案是 2 步');
  assert.equal(app.puzzle.solution.length, 2);

  // 打开强制计算 → 4 格的小题瞬间算完，最短 1 步
  click(dom, 'btn-options');
  const box = dom.document.getElementById('opt-minsteps');
  box.checked = true;
  box.dispatch('change', { target: box });
  timers.run(60);

  assert.equal(app.minSteps.status, 'done');
  assert.equal(app.minSteps.exact, 1);
  // 参考答案被换成最短解
  assert.equal(app.puzzle.solution.length, 1, '答案应该换成更短的最短解');
  assert.equal(app.puzzle.steps, 1);
  assert.equal(app.puzzle.answerSource, 'shortest');
  assert.equal(Core.simulate(app.puzzle.board, app.puzzle.solution, app.puzzle.target).solved, true);
  assert.match(textOf(dom, 'message'), /参考答案也换成了这条最短解/);
  // 看答案里的说明也跟着变
  click(dom, 'btn-answer');
  timers.run(20);
  assert.match(textOf(dom, 'answer-summary'), /精确计算得到的最短解/);
  assert.equal(dom.document.getElementById('answer-list').children.length, 1);
  click(dom, 'answer-close');
  // 限制步数不受影响（游戏规则不动）
  assert.equal(app.puzzle.limit, 2);
});

test('app：最短解没比参考解更短时保持原答案', () => {
  const { dom, app, timers } = boot();
  click(dom, 'btn-options');
  const uniqueBox = dom.document.getElementById('opt-unique');
  if (uniqueBox.checked) {
    uniqueBox.checked = false;
    uniqueBox.dispatch('change', { target: uniqueBox });
  }
  const box = dom.document.getElementById('opt-minsteps');
  box.checked = true;
  box.dispatch('change', { target: box });
  const cols = dom.document.getElementById('opt-cols');
  const rows = dom.document.getElementById('opt-rows');
  const limit = dom.document.getElementById('opt-limit');
  cols.value = '4';
  cols.dispatch('input', { target: cols });
  rows.value = '4';
  rows.dispatch('input', { target: rows });
  limit.value = '6';
  limit.dispatch('input', { target: limit });
  click(dom, 'opt-apply');
  timers.run(300);

  assert.equal(app.minSteps.status, 'done');
  const before = app.puzzle.solution.map((m) => [m.index, m.color]);
  // 最短步数只会 ≤ 参考解；只有严格更短时才替换
  if (app.minSteps.exact < before.length) {
    assert.equal(app.puzzle.solution.length, app.minSteps.exact);
  } else {
    assert.deepEqual(
      app.puzzle.solution.map((m) => [m.index, m.color]),
      before
    );
    assert.notEqual(app.puzzle.answerSource, 'shortest');
  }
});

test('app：没勾「唯一解」也按最优解个数标出唯一解 / 多解', () => {
  const { dom, app, Core, Yicai, timers } = boot();
  // 「唯一解」开关保持默认关闭
  assert.equal(app.settings.preferUnique, false);

  // 0011 → 目标 1：1 步就能完成，而且只有这一种 1 步解法（最优解唯一）
  const uniqueBoard = Core.deserialize('0011', 2, 2);
  const uniqueCode = Yicai.Share.encode({
    rows: 2,
    cols: 2,
    target: 1,
    limit: 2,
    board: uniqueBoard,
    solution: [
      { index: 0, color: 2 },
      { index: 0, color: 1 },
    ],
  });
  click(dom, 'btn-import');
  dom.document.getElementById('code-text').value = uniqueCode;
  click(dom, 'code-confirm');
  {
    const m = dom.document.getElementById('opt-minsteps');
    m.checked = true;
    m.dispatch('change', { target: m });
  }
  timers.run(80);
  assert.equal(app.minSteps.status, 'done');
  assert.equal(app.minSteps.exact, 1);
  assert.equal(app.minSteps.optimalCount, 1, '最优解个数应为 1');
  // 这条题是从分享码导入的，出题侧的唯一性标记是 null，所以标识只可能来自精确计算
  assert.equal(app.puzzle.unique, null);
  assert.match(textOf(dom, 'stat-minsteps'), /^1 步 · 唯一解$/);

  // 0110 → 目标 1：两个 0 格各点一次，先后顺序两种 → 多解
  const multiBoard = Core.deserialize('0110', 2, 2);
  const multiCode = Yicai.Share.encode({
    rows: 2,
    cols: 2,
    target: 1,
    limit: 2,
    board: multiBoard,
    solution: [
      { index: 0, color: 1 },
      { index: 3, color: 1 },
    ],
  });
  click(dom, 'btn-import');
  dom.document.getElementById('code-text').value = multiCode;
  click(dom, 'code-confirm');
  timers.run(80);
  assert.equal(app.minSteps.status, 'done');
  assert.equal(app.minSteps.exact, 2);
  assert.equal(app.minSteps.optimalCount, 2, '最优解个数应为 2');
  assert.match(textOf(dom, 'stat-minsteps'), /^2 步 · 多解$/);
});

test('app：确认唯一性期间也会显示进度，且答案已经先换成最短解', () => {
  const { dom, app, Core, Yicai, timers } = boot();
  const board = Core.deserialize('0011', 2, 2);
  const code = Yicai.Share.encode({
    rows: 2,
    cols: 2,
    target: 1,
    limit: 2,
    board,
    solution: [
      { index: 0, color: 2 },
      { index: 0, color: 1 },
    ],
  });
  click(dom, 'btn-import');
  dom.document.getElementById('code-text').value = code;
  click(dom, 'code-confirm');
  const m = dom.document.getElementById('opt-minsteps');
  m.checked = true;
  m.dispatch('change', { target: m });
  // 只推进一片：最短解已经找到并替换答案，唯一性可能还在确认
  timers.run(6);
  assert.ok(app.minSteps.exact != null || app.minSteps.status === 'done');
  if (app.minSteps.exact != null) {
    assert.equal(app.puzzle.solution.length, app.minSteps.exact, '一找到最短解就先换答案');
  }
  timers.run(80);
  assert.equal(app.minSteps.status, 'done');
});

test('app：分享 → 导入可以原样还原题目', () => {
  const { dom, app, Core, timers } = boot();
  const snapshot = Core.serialize(app.board);
  const before = {
    rows: app.puzzle.rows,
    cols: app.puzzle.cols,
    target: app.puzzle.target,
    limit: app.puzzle.limit,
    steps: app.puzzle.steps,
  };
  click(dom, 'btn-share');
  const modal = dom.document.getElementById('code-modal');
  assert.equal(modal.hidden, false);
  const code = dom.document.getElementById('code-text').value;
  assert.ok(code.startsWith('YC'));
  assert.equal(dom.document.getElementById('code-text').readOnly, true);
  assert.equal(textOf(dom, 'code-confirm'), '复制');
  click(dom, 'code-cancel');
  assert.equal(modal.hidden, true);

  // 换一题，再用分享码导入回来
  click(dom, 'btn-new');
  timers.run();
  assert.notEqual(Core.serialize(app.board), snapshot, '随机新题应该换一道');

  click(dom, 'btn-import');
  assert.equal(modal.hidden, false);
  assert.equal(dom.document.getElementById('code-text').readOnly, false);
  assert.equal(textOf(dom, 'code-confirm'), '导入');
  dom.document.getElementById('code-text').value = code;
  click(dom, 'code-confirm');
  assert.equal(modal.hidden, true);
  assert.equal(Core.serialize(app.board), snapshot, '导入后盘面应与分享时一致');
  assert.equal(app.puzzle.rows, before.rows);
  assert.equal(app.puzzle.cols, before.cols);
  assert.equal(app.puzzle.target, before.target);
  assert.equal(app.puzzle.limit, before.limit);
  assert.equal(app.puzzle.steps, before.steps);
  assert.equal(app.history.length, 0);
  assert.equal(app.status, 'playing');
  assert.match(textOf(dom, 'message'), /已导入题目/);
});

test('app：导入坏码会提示错误且不动当前题目', () => {
  const { dom, app, Core } = boot();
  const snapshot = Core.serialize(app.board);
  click(dom, 'btn-import');
  dom.document.getElementById('code-text').value = '这不是分享码';
  click(dom, 'code-confirm');
  assert.equal(dom.document.getElementById('code-modal').hidden, false, '坏码不该关闭弹窗');
  assert.equal(dom.document.getElementById('code-error').hidden, false);
  assert.match(textOf(dom, 'code-error'), /看不懂/);
  assert.equal(Core.serialize(app.board), snapshot);
  click(dom, 'code-cancel');
  assert.equal(dom.document.getElementById('code-modal').hidden, true);
});

test('app：分享自绘图形题目时，空洞也能一起带走', () => {
  const { dom, app, Core, timers } = boot();
  click(dom, 'btn-options');
  const tabs = dom.document.getElementById('options-modal').querySelectorAll('.tab');
  tabs[1].dispatch('click', { target: tabs[1] });
  click(dom, 'opt-apply');
  timers.run();
  const maskText = Array.from(app.puzzle.mask).join('');
  click(dom, 'btn-share');
  const code = dom.document.getElementById('code-text').value;
  click(dom, 'code-cancel');
  click(dom, 'btn-new');
  timers.run();
  click(dom, 'btn-import');
  dom.document.getElementById('code-text').value = code;
  click(dom, 'code-confirm');
  assert.equal(Array.from(app.puzzle.mask).join(''), maskText);
  assert.equal(app.puzzle.mask.reduce((a, b) => a + b, 0), 56);
  assert.equal(Core.simulate(app.puzzle.board, app.puzzle.solution, app.puzzle.target).solved, true);
});

test('app：步数用完 → 步数 +1 可以继续', () => {
  const { dom, app } = boot();
  const limit = app.puzzle.limit;
  const target = app.puzzle.target;
  // 只用两个「非目标色」来回染同一块：既能稳定耗步，又永远不会误通关
  const colorA = (target + 1) % 4;
  const colorB = (target + 2) % 4;
  let guard = 0;
  while (app.status === 'playing' && guard++ < 200) {
    let index = -1;
    for (let i = 0; i < app.board.cells.length; i++) {
      if (app.board.cells[i] !== -1 && app.board.cells[i] !== target) {
        index = i;
        break;
      }
    }
    if (index < 0) break;
    const next = app.board.cells[index] === colorA ? colorB : colorA;
    clickSwatch(dom, next);
    clickCell(dom, index);
  }
  assert.equal(app.status, 'lost');
  assert.equal(dom.document.getElementById('banner').hidden, false);
  assert.match(textOf(dom, 'banner-title'), /步数用完/);
  assert.equal(app.extra, 0);

  click(dom, 'btn-plus');
  assert.equal(app.extra, 1);
  assert.equal(app.status, 'playing');
  assert.equal(Number(textOf(dom, 'stat-left')), 1);
  assert.equal(dom.document.getElementById('slots').children.length, limit + 1);
});

test('app：自定义选项 —— 自绘图形出题（含空洞与断开的图形）', () => {
  const { dom, app, Core, timers } = boot();
  click(dom, 'btn-options');
  assert.ok(app.draft, '打开选项应创建草稿');
  const tabs = dom.document.getElementById('options-modal').querySelectorAll('.tab');
  assert.equal(tabs.length, 2);

  tabs[1].dispatch('click', { target: tabs[1] });
  assert.equal(app.draft.mode, 'mask');
  assert.equal(app.draft.mask.reduce((a, b) => a + b, 0), 56, '默认是心形预设');

  const presets = dom.document.getElementById('mask-presets').children;
  const findPreset = (name) => presets.find((b) => b.textContent === name);
  assert.deepEqual(
    Array.from(presets, (b) => b.textContent),
    ['全选', '反选', '清除', '随机']
  );
  const clearBtn = findPreset('清除');
  assert.ok(clearBtn);
  clearBtn.dispatch('click', { target: clearBtn });
  assert.equal(dom.document.getElementById('opt-apply').disabled, true, '太少格子应禁止生成');
  assert.match(textOf(dom, 'mask-info'), /至少/);

  const fullBtn = findPreset('全选');
  fullBtn.dispatch('click', { target: fullBtn });
  assert.equal(dom.document.getElementById('opt-apply').disabled, false);
  click(dom, 'opt-apply');
  assert.equal(dom.document.getElementById('options-modal').hidden, true);
  // 出题放在 setTimeout 里（好让「正在出题…」先画出来），测试里手动把定时器跑完
  timers.run();
  assert.equal(app.puzzle.rows, 10);
  assert.equal(app.puzzle.cols, 10);
  assert.equal(app.puzzle.mask.reduce((a, b) => a + b, 0), 100);
  assert.equal(boardEl(dom).children.length, 100);
  assert.equal(Core.simulate(app.puzzle.board, app.puzzle.solution, app.puzzle.target).solved, true);
});

test('app：自绘图形真的会在棋盘上留出空洞', () => {
  const { dom, app, Core, timers } = boot();
  click(dom, 'btn-options');
  const tabs = dom.document.getElementById('options-modal').querySelectorAll('.tab');
  tabs[1].dispatch('click', { target: tabs[1] });
  // 默认心形：先点掉一格，做出一个空洞
  const grid = dom.document.getElementById('mask-grid');
  const toRemove = Array.from(grid.children).findIndex((b) => b.classList.contains('on'));
  assert.ok(toRemove >= 0, '默认图形应该有选中的格子');
  grid.children[toRemove].dispatch('pointerdown', { target: grid.children[toRemove] });
  assert.equal(app.draft.mask[toRemove], 0);
  assert.match(textOf(dom, 'mask-info'), /已选 55 格/);

  click(dom, 'opt-apply');
  timers.run();
  assert.equal(app.puzzle.mask[toRemove], 0);
  assert.equal(boardEl(dom).children[toRemove].classList.contains('hole'), true);
  assert.equal(Core.simulate(app.puzzle.board, app.puzzle.solution, app.puzzle.target).solved, true);
});

test('app：选项里可以改尺寸、步数与目标色', () => {
  const { dom, app, timers } = boot();
  click(dom, 'btn-options');
  const cols = dom.document.getElementById('opt-cols');
  const rows = dom.document.getElementById('opt-rows');
  const limit = dom.document.getElementById('opt-limit');
  cols.value = '17';
  cols.dispatch('input', { target: cols });
  rows.value = '4';
  rows.dispatch('input', { target: rows });
  limit.value = '12';
  limit.dispatch('input', { target: limit });
  assert.equal(app.draft.cols, 17);
  assert.equal(app.draft.rows, 4);
  assert.equal(app.draft.limit, 12);
  assert.equal(textOf(dom, 'opt-limit-out'), '12 步');

  const chips = dom.document.getElementById('opt-target-chips').children;
  chips[0].dispatch('click', { target: chips[0] });
  assert.equal(app.draft.target, 0);
  click(dom, 'opt-apply');
  timers.run();
  assert.equal(app.puzzle.cols, 17);
  assert.equal(app.puzzle.rows, 4);
  // 限制步数会被收紧到题目的实际难度，但不会超过用户设置的上限
  assert.ok(app.puzzle.limit <= 12, `收紧后的限制 ${app.puzzle.limit} 不该超过上限 12`);
  assert.equal(app.puzzle.cap, 12);
  assert.equal(app.puzzle.target, 0);
  assert.equal(boardEl(dom).children.length, 68);
});

test('app：进度会写进 localStorage，重新打开能恢复', () => {
  const storage = createStorage();
  const first = boot(storage);
  clickSwatch(first.dom, (first.app.board.cells[0] + 1) % 4);
  clickCell(first.dom, 0);
  const snapshot = first.Core.serialize(first.app.board);
  assert.equal(first.app.history.length, 1);
  assert.ok(storage.map.size > 0, '应该写入了存档');

  const second = boot(storage);
  assert.equal(second.Core.serialize(second.app.board), snapshot);
  assert.equal(second.app.history.length, 1);
  assert.equal(second.app.puzzle.limit, first.app.puzzle.limit);
  assert.match(textOf(second.dom, 'message'), /恢复/);
});

test('app：脏存档不会让页面崩溃', () => {
  const storage = createStorage();
  storage.setItem('tushx39.overflow_paint.v1', '{"v":1,"settings":{"rows":"坏"},"game":{"rows":9999}}');
  const { app, dom } = boot(storage);
  assert.ok(app.puzzle, '脏数据应该退化成新题目');
  assert.ok(boardEl(dom).children.length > 0);
});

test('app：键盘 1–4 选色、H 提示、U 撤销、R 重开', () => {
  const { dom, app, Core } = boot();
  pressKey(dom, '3');
  assert.equal(app.selectedColor, 2);
  pressKey(dom, '1');
  assert.equal(app.selectedColor, 0);

  let index = -1;
  for (let i = 0; i < app.board.cells.length; i++) {
    if (app.board.cells[i] !== -1 && app.board.cells[i] !== app.selectedColor) {
      index = i;
      break;
    }
  }
  assert.ok(index >= 0, '应该能找到与当前选中色不同的色块');
  clickCell(dom, index);
  assert.equal(app.history.length, 1);
  pressKey(dom, 'u');
  assert.equal(app.history.length, 0);
  pressKey(dom, 'h');
  assert.ok(app.hint);
  pressKey(dom, 'r');
  assert.equal(Core.serialize(app.board), Core.serialize(app.puzzle.board));
});
