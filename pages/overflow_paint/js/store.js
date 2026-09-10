/**
 * store.js —— 设置与当前进度的本地持久化。
 * 任何异常（隐私模式、禁用 storage、脏数据）都退化为「不持久化」，绝不影响游戏本身。
 *
 * 传统脚本（非 ES Module），接口挂在全局 Yicai.Store 上。
 */

(function (global) {
  'use strict';

  const Yicai = (global.Yicai = global.Yicai || {});
  const STORAGE_KEY = 'tushx39.overflow_paint.v1';

  function load() {
    try {
      const raw = global.localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
    } catch (error) {
      return null;
    }
  }

  function save(data) {
    try {
      global.localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      return true;
    } catch (error) {
      return false;
    }
  }

  function clear() {
    try {
      global.localStorage.removeItem(STORAGE_KEY);
    } catch (error) {
      /* 忽略 */
    }
  }

  Yicai.Store = { STORAGE_KEY, load, save, clear };
})(typeof window !== 'undefined' ? window : globalThis);
