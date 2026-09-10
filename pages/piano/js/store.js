/**
 * store.js —— 设置的本地持久化
 *
 * 任何异常（隐私模式、禁用 storage、脏数据）都退化为「不持久化」，
 * 绝不影响页面本身可用。
 *
 * 传统脚本（非 ES Module），接口挂在全局 Piano.Store 上。
 */

(function (global) {
  'use strict';

  const Piano = global.Piano = global.Piano || {};

const STORAGE_KEY = 'tushx39.piano.settings.v2';

function loadSettings() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const data = JSON.parse(raw);
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

function saveSettings(settings) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    return true;
  } catch {
    return false;
  }
}

function clearSettings() {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* 忽略 */
  }
}

Piano.Store = { loadSettings, saveSettings, clearSettings };

})(typeof window !== 'undefined' ? window : globalThis);
