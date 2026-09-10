/**
 * 测试辅助：按浏览器的方式加载 js/*.js。
 *
 * 页面脚本是「传统脚本」而不是 ES Module（为了能直接 file:// 双击打开），
 * 所以这里在 vm 沙箱里按 <script> 顺序求值，再从全局命名空间 Yicai 上取接口。
 * app.js 需要 DOM，默认不加载（可通过 files 参数显式加载）。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import vm from 'node:vm';

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function readHtml() {
  return readFileSync(join(projectRoot, 'overflow_paint.html'), 'utf8');
}

/** 从 overflow_paint.html 中按出现顺序取出脚本路径 */
export function scriptSources(html = readHtml()) {
  return [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((match) => match[1]);
}

/**
 * 在沙箱里按顺序执行脚本。
 * @param {object} [globals] 额外注入的宿主全局
 * @param {string[]} [files] 要加载的脚本，默认取 HTML 里声明的全部（除 app.js）
 * @returns {object} 沙箱全局对象（命名空间挂在 Yicai 上）
 */
export function loadYicaiScripts(globals = {}, files = scriptSources().filter((f) => !/app\.js$/.test(f))) {
  const sandbox = { console };
  Object.assign(sandbox, globals);
  vm.createContext(sandbox);
  // 浏览器里各脚本都挂在 window 上；沙箱里让 window 指回沙箱自身，
  // 这样注入的 document / localStorage / innerHeight 等宿主全局也能被当成 window 的属性访问。
  if (sandbox.window === undefined || sandbox.window === null) sandbox.window = sandbox;
  for (const file of files) {
    const code = readFileSync(join(projectRoot, file), 'utf8');
    vm.runInContext(code, sandbox, { filename: file });
  }
  return sandbox;
}

/** 便捷：直接拿到 Yicai 命名空间 */
export function loadYicai(globals = {}) {
  return loadYicaiScripts(globals).Yicai;
}

/** 简易断言辅助：模拟一局，检查是否通关 */
export function simulateSolved(Yicai, board, moves, target) {
  const result = Yicai.Core.simulate(board, moves, target);
  return { solved: result.solved, applied: result.applied, board: result.board };
}
