/**
 * 测试辅助：按浏览器的方式加载 js/*.js。
 *
 * 这些脚本是「传统脚本」而不是 ES Module（为了能直接 file:// 双击打开），
 * 所以不能用 import 引入，只能在 vm 沙箱里按 <script> 顺序求值，
 * 再从全局命名空间 Piano 上取接口——顺便也就验证了 file:// 场景下的加载方式。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import vm from 'node:vm';

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function readHtml() {
  return readFileSync(join(projectRoot, 'piano.html'), 'utf8');
}

/** 从 piano.html 中按出现顺序取出脚本路径 */
export function scriptSources(html = readHtml()) {
  return [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map(match => match[1]);
}

/**
 * 在沙箱里按顺序执行脚本。
 *
 * @param {object} [globals] 额外注入的宿主全局（document / window / 定时器等）
 * @param {string[]} [files] 要加载的脚本，默认取 piano.html 里声明的全部
 * @returns {object} 沙箱全局对象（命名空间挂在 Piano 上）
 */
export function loadPianoScripts(globals = {}, files = scriptSources()) {
  const sandbox = { console };
  Object.assign(sandbox, globals);

  vm.createContext(sandbox);
  for (const file of files) {
    const code = readFileSync(join(projectRoot, file), 'utf8');
    vm.runInContext(code, sandbox, { filename: file });
  }
  return sandbox;
}
