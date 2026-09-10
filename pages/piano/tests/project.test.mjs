/**
 * 工程自检：保证「HTML 结构」和「脚本引用的东西」互相对得上。
 *
 * 这类错误（改了 id、改了脚本路径、加了新元素忘了同步）在浏览器里
 * 只会静默失败，因此放在测试里挡住。
 *
 * 运行：cd pages/piano && npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { loadPianoScripts, scriptSources } from './helpers/load-piano.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const read = relative => readFileSync(join(root, relative), 'utf8');

const html = read('piano.html');
const css = read('piano.css');
const jsDir = join(root, 'js');
const jsFiles = readdirSync(jsDir).filter(name => name.endsWith('.js'));

function matchAll(source, pattern, group = 1) {
  const out = [];
  for (const match of source.matchAll(pattern)) out.push(match[group]);
  return out;
}

test('piano.html 引用的脚本与样式都存在', () => {
  const scripts = matchAll(html, /<script[^>]*\ssrc="([^"]+)"/g);
  const styles = matchAll(html, /<link[^>]*\shref="([^"]+)"/g);

  assert.ok(scripts.length > 0, '没有找到脚本引用');
  for (const src of [...scripts, ...styles]) {
    assert.ok(existsSync(join(root, src)), `piano.html 引用的 ${src} 不存在`);
  }
  assert.ok(scripts.includes('js/main.js'), '入口脚本应为 js/main.js');
});

test('脚本用传统 <script> 引入（file:// 直接打开也能跑）', () => {
  assert.ok(
    !/type=["']module["']/.test(html),
    'type="module" 在 file:// 下会被 CORS 拦掉，必须用传统脚本',
  );
  assert.deepEqual(scriptSources(html), [
    'js/chords.js',
    'js/synth.js',
    'js/keyboard.js',
    'js/panel.js',
    'js/store.js',
    'js/main.js',
  ], '脚本顺序必须满足依赖：chords 最先，main 最后');
});

test('js/*.js 不含 ESM 语法，且各自注册到 Piano 命名空间', () => {
  const expected = {
    'chords.js': 'Piano.Chords',
    'synth.js': 'Piano.Synth',
    'keyboard.js': 'Piano.Keyboard',
    'panel.js': 'Piano.Panel',
    'store.js': 'Piano.Store',
  };

  for (const file of jsFiles) {
    const source = readFileSync(join(jsDir, file), 'utf8');
    assert.ok(
      !/^\s*(import|export)[\s{*]/m.test(source),
      `${file} 里还有 import/export：file:// 下会整体加载失败`,
    );
    assert.ok(
      !/\bfetch\s*\(|XMLHttpRequest|import\s*\(/.test(source),
      `${file} 用了网络请求：file:// 下会被拦截，本页应保持零请求`,
    );
    if (expected[file]) {
      assert.ok(source.includes(expected[file]), `${file} 应暴露 ${expected[file]}`);
    }
  }
});

test('按 piano.html 的顺序加载全部脚本后命名空间完整（file:// 冒烟测试）', () => {
  // 只给一个「文档仍在解析」的最小 document：main.js 会把初始化推迟到 DOMContentLoaded，
  // 于是这一步验证的正是「六个脚本能否按序加载、依赖是否齐全」。
  const sandbox = loadPianoScripts({
    document: { readyState: 'loading', addEventListener() {} },
  });

  for (const name of ['Chords', 'Synth', 'Keyboard', 'Panel', 'Store']) {
    assert.ok(sandbox.Piano && sandbox.Piano[name], `Piano.${name} 没有注册`);
  }
  assert.equal(typeof sandbox.Piano.Chords.analyzeChord, 'function');
  assert.equal(typeof sandbox.Piano.Synth.createSynth, 'function');
});

test('页面里没有重复 id', () => {
  const ids = matchAll(html, /\sid="([^"]+)"/g);
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  assert.deepEqual([...new Set(duplicates)], [], `重复 id：${duplicates.join(', ')}`);
});

test('main.js 查询的每个 id 都存在于 piano.html', () => {
  const mainJs = readFileSync(join(jsDir, 'main.js'), 'utf8');
  const ids = [
    ...matchAll(mainJs, /getElementById\('([^']+)'\)/g),
    ...matchAll(mainJs, /getElementById\("([^"]+)"\)/g),
  ];
  assert.ok(ids.length >= 15, `只找到 ${ids.length} 个 id 查询，似乎解析失败`);

  const htmlIds = new Set(matchAll(html, /\sid="([^"]+)"/g));
  for (const id of ids) {
    assert.ok(htmlIds.has(id), `main.js 需要 #${id}，但 piano.html 里没有`);
  }
});

test('main.js 用到的类选择器都存在于 piano.html', () => {
  const mainJs = readFileSync(join(jsDir, 'main.js'), 'utf8');
  const selectors = matchAll(mainJs, /querySelector\('\.([\w-]+)'\)/g);
  for (const className of selectors) {
    assert.ok(
      html.includes(`class="${className}`) || html.includes(` ${className}"`) || html.includes(className),
      `main.js 需要 .${className}，但 piano.html 里没有`,
    );
  }
});

test('脚本切换的界面类都在 CSS 里有定义', () => {
  const toggled = [
    'is-hidden',        // 读数隐藏
    'hide-note-label',  // 隐藏琴键音名
    'hide-key-hints',   // 隐藏键位标注
    'key-hint',         // 键位标注本体
    'is-down',          // 琴键按下
    'show',             // 次级设置展开
    'open',             // 设置面板展开
    'show-sub',         // 子页滑动
    'active',           // 齿轮旋转
    'sustain-on',       // 延音状态
    'pedal-hidden',     // 隐藏踏板
  ];
  for (const className of toggled) {
    assert.ok(css.includes(`.${className}`) || css.includes(`body.${className}`), `CSS 缺少 .${className}`);
  }
});

test('次级设置收起时不留空白（外边距一起收掉）', () => {
  const block = css.match(/\.sub-setting\s*\{[^}]*\}/);
  assert.ok(block, '找不到 .sub-setting 规则');
  assert.match(block[0], /margin:\s*0\s*;/, '.sub-setting 收起时外边距必须为 0');
  assert.match(css, /\.sub-setting\.show\s*\{[^}]*margin:/, '.sub-setting.show 才恢复外边距');
});

test('CSS 与 JS 共用的尺寸变量还在（黑键定位依赖实测像素，不依赖数值）', () => {
  for (const variable of ['--white-w', '--keys-h', '--felt-h', '--pedal-h']) {
    assert.ok(css.includes(`${variable}:`), `CSS 缺少变量 ${variable}`);
  }
});

test('琴键容器与踏板条结构没有被改坏', () => {
  assert.ok(/id="piano-wrapper"/.test(html), '缺少 #piano-wrapper');
  assert.ok(/id="piano"\s*>/.test(html), '缺少 #piano');
  assert.ok(/class="keybed"/.test(html), '缺少 .keybed');
  assert.ok(/class="felt"/.test(html), '缺少 .felt');
  assert.ok(/id="pedal"/.test(html), '缺少 #pedal');
});

test('保留了原来的设置项，并新增键位标注开关与 piano 波形', () => {
  const required = [
    'volume-slider',
    'base-freq-input',
    'waveform-select',
    'note-name-toggle',
    'key-hint-toggle',
    'chord-toggle',
    'inversion-toggle',
    'pedal-toggle',
    'invert-pedal-toggle',
    'toggle-pedal-toggle',
  ];
  for (const id of required) {
    assert.ok(html.includes(`id="${id}"`), `设置项 #${id} 丢失`);
  }

  const waveforms = matchAll(html, /<option value="([a-z]+)"( selected)?>/g);
  assert.ok(waveforms.includes('piano'), '波形列表里应有 piano');
  assert.match(html, /<option value="piano" selected>/, 'piano 应是默认波形');

  // 默认值也要和脚本里的一致（用户没存过设置时用这套）
  const mainJs = readFileSync(join(jsDir, 'main.js'), 'utf8');
  assert.match(mainJs, /waveform:\s*'piano'/, 'main.js 的默认波形应为 piano');
  assert.match(mainJs, /showKeyHints:\s*true/, '键位标注默认开启');
});

test('复合和弦逻辑与设置项已经删干净', () => {
  const mainJs = readFileSync(join(jsDir, 'main.js'), 'utf8');
  const chordsJs = readFileSync(join(jsDir, 'chords.js'), 'utf8');

  for (const [name, source] of [['piano.html', html], ['main.js', mainJs], ['chords.js', chordsJs]]) {
    assert.ok(!/compound/i.test(source), `${name} 里仍有 compound`);
    assert.ok(!/polychord|findPolychords/i.test(source), `${name} 里仍有复合和弦实现`);
    assert.ok(!/chord-mode|chordMode|CHORD_MODES/.test(source), `${name} 里仍有和弦模式残留`);
  }

  // 识别入口只接收转位 / 候选数 / 拼写偏好
  assert.ok(!/options\.mode/.test(chordsJs), 'analyzeChord 不应再读 mode');
  assert.match(chordsJs, /allowInversion/, '转位开关必须保留');
});

test('页面带有 viewport 声明（旧版三个页面都缺）', () => {
  assert.ok(/name="viewport"/.test(html));
});

test('CSS 花括号配对，HTML 主要标签成对', () => {
  const open = (css.match(/\{/g) || []).length;
  const close = (css.match(/\}/g) || []).length;
  assert.equal(open, close, `CSS 花括号不配对：{ ${open} 个，} ${close} 个`);
  assert.ok(open > 60, `CSS 规则太少（${open}），可能没读到文件`);

  for (const tag of ['div', 'p', 'button', 'select']) {
    const opens = (html.match(new RegExp(`<${tag}[\\s>]`, 'g')) || []).length;
    const closes = (html.match(new RegExp(`</${tag}>`, 'g')) || []).length;
    assert.equal(opens, closes, `<${tag}> 开合数量不一致：${opens} / ${closes}`);
  }
});

test('不再引用旧的单文件版本 piano.js', () => {
  assert.ok(!/["']piano\.js["']/.test(html), 'piano.html 仍在引用旧的 piano.js');
  assert.ok(!existsSync(join(root, 'piano.js')), '旧的 piano.js 应该已经删除');
});

test('模块目录结构与文档描述一致', () => {
  const expected = ['chords.js', 'keyboard.js', 'main.js', 'panel.js', 'store.js', 'synth.js'];
  assert.deepEqual([...jsFiles].sort(), expected);
  assert.ok(existsSync(join(root, 'README.md')), '缺少 README.md');
  assert.ok(existsSync(join(root, 'package.json')), '缺少 package.json');
});
