/**
 * panel.js —— 设置面板的开关与子页导航
 *
 * 保持原有交互：齿轮按钮开合、Esc 逐级返回、子页左右滑动。
 * 额外补上「点击面板外部收起」，这条在旧代码里只留了注释没有实现。
 *
 * 传统脚本（非 ES Module），接口挂在全局 Piano.Panel 上。
 */

(function (global) {
  'use strict';

  const Piano = global.Piano = global.Piano || {};

function createPanel(config = {}) {
  const { trigger, panel, pages } = config;
  let open = false;

  function setOpen(next) {
    open = Boolean(next);
    if (panel) panel.classList.toggle('open', open);
    if (trigger) trigger.classList.toggle('active', open);
  }

  function inSubPage() {
    return Boolean(pages && pages.classList.contains('show-sub'));
  }

  function init() {
    if (trigger && panel) {
      trigger.addEventListener('click', () => setOpen(!open));
    }

    if (panel) {
      panel.addEventListener('click', event => {
        const target = event.target;
        if (!target || !target.closest) return;
        if (target.closest('.setting-item.has-sub')) {
          if (pages) pages.classList.add('show-sub');
          return;
        }
        if (target.closest('.back-btn') && pages) {
          pages.classList.remove('show-sub');
        }
      });
    }

    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || !open) return;
      if (inSubPage()) {
        pages.classList.remove('show-sub');
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

  return { init, setOpen, isOpen: () => open };
}

Piano.Panel = { createPanel };

})(typeof window !== 'undefined' ? window : globalThis);
