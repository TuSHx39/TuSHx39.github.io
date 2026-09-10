import test from 'node:test';
import assert from 'node:assert/strict';

import { readHtml, scriptSources, loadYicaiScripts } from './helpers/load-yicai.mjs';
import { createDom } from './helpers/fake-dom.mjs';

/** 可控定时器：让依赖 setTimeout 的流程（提示清除、答案计算、演示）在测试里可预期地跑完 */
function createTimers() {
  let nextId = 1;
  const pending = new Map();
  return {
    setTimeout(fn, ms) {
      const id = nextId++;
      pending.set(id, { fn, ms: ms || 0 });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    /** 按到期时间顺序执行挂起的回调（最多 limit 次，避免死循环） */
    run(limit = 400) {
      let count = 0;
      while (pending.size && count++ < limit) {
        const entries = [...pending.entries()].sort((a, b) => a[1].ms - b[1].ms);
        const [id, job] = entries[0];
        pending.delete(id);
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
