/**
 * panel.js —— 设置面板的开关与子页导航
 *
 * 保持原有交互：齿轮按钮开合、Esc 逐级返回、子页左右滑动。
 * 额外补上「点击面板外部收起」，这条在旧代码里只留了注释没有实现。
 *
 * 页面结构：.settings-pages 里平铺若干张 .page（第 0 张是主页面，后面每张
 * 对应一个 data-sub="xxx" 的设置行，元素 id 为 sub-xxx）。
 * 翻页靠 CSS 变量 --page-index 驱动 transform，想做几张就加几张。
 *
 * 传统脚本（非 ES Module），接口挂在全局 Piano.Panel 上。
 */

(function (global) {
  'use strict';

  const Piano = global.Piano = global.Piano || {};

function createPanel(config = {}) {
  const { trigger, panel, pages } = config;
  const pageList = pages && pages.children ? Array.from(pages.children) : [];
  let open = false;
  let index = 0;

  function setOpen(next) {
    open = Boolean(next);
    if (panel) panel.classList.toggle('open', open);
    if (trigger) trigger.classList.toggle('active', open);
  }

  /** 翻到第 n 张（0 = 主页面）；同时只让当前这张能点 */
  function setPage(next) {
    const clamped = Math.max(0, Math.min(pageList.length - 1, Number(next) || 0));
    index = clamped;
    if (!pages) return;
    if (pages.style && pages.style.setProperty) {
      pages.style.setProperty('--page-index', String(clamped));
    }
    pageList.forEach((page, i) => {
      if (page.classList) page.classList.toggle('is-active', i === clamped);
    });
  }

  /** 设置行上的 data-sub="xxx" 对应 id 为 sub-xxx 的那张子页 */
  function pageIndexForName(name) {
    if (!name) return -1;
    return pageList.findIndex(page => page.getAttribute && page.getAttribute('id') === `sub-${name}`);
  }

  function inSubPage() {
    return index > 0;
  }

  function init() {
    setPage(0);

    if (trigger && panel) {
      trigger.addEventListener('click', () => setOpen(!open));
    }

    if (panel) {
      panel.addEventListener('click', event => {
        const target = event.target;
        if (!target || !target.closest) return;

        const row = target.closest('.setting-item.has-sub');
        if (row) {
          const found = pageIndexForName(row.getAttribute && row.getAttribute('data-sub'));
          setPage(found >= 0 ? found : (pageList.length > 1 ? 1 : 0));
          return;
        }

        if (target.closest('.back-btn')) setPage(0);
      });
    }

    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || !open) return;
      if (inSubPage()) {
        setPage(0);
        return;
      }
      setOpen(false);
    });

    document.addEventListener('pointerdown', event => {
      if (!open) return;
      const target = event.target;
      const insidePanel = panel && target && panel.contains(target);
      const insideTrigger = trigger && target && trigger.contains(target);
      if (insidePanel || insideTrigger) return;
      setOpen(false);
    });
  }

  return {
    init,
    setOpen,
    setPage,
    isOpen: () => open,
    pageIndex: () => index,
  };
}

Piano.Panel = { createPanel };

})(typeof window !== 'undefined' ? window : globalThis);
