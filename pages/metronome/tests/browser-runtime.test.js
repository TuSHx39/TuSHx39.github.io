import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { DEFAULT_STATE } from '../js/rhythm.js';

const root = new URL('../', import.meta.url);

// Model the DOM operations used by the app, while deriving static IDs from the
// real page so a missing element cannot silently pass this startup test.
class ElementDouble {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.className = '';
    this.clientWidth = 640;
    this.scrollLeft = 0;
    this.classList = {
      contains: (name) => this.className.split(/\s+/).includes(name),
      add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(' '); },
      remove: (...names) => { this.className = this.className.split(/\s+/).filter((name) => name && !names.includes(name)).join(' '); },
      toggle: (name, force) => {
        const enabled = force ?? !this.classList.contains(name);
        this.classList[enabled ? 'add' : 'remove'](name);
        return enabled;
      },
    };
  }
  set value(value) { this._value = String(value); }
  get value() { return this._value ?? ''; }
  set textContent(value) { this._textContent = String(value); this.replaceChildren(); }
  get textContent() { return this._textContent ?? ''; }
  set innerHTML(value) { this._innerHTML = value; this.replaceChildren(); }
  get innerHTML() { return this._innerHTML ?? ''; }
  append(...children) {
    for (const child of children) { child.parentElement = this; this.children.push(child); }
  }
  replaceChildren(...children) {
    for (const child of this.children) child.parentElement = null;
    this.children = [];
    this.append(...children);
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  fire(type) {
    const event = { type, target: this, preventDefault() {} };
    const results = [];
    for (let node = this; node; node = node.parentElement) {
      for (const listener of node.listeners.get(type) ?? []) results.push(listener(event));
    }
    return Promise.all(results);
  }
  matches(selector) {
    const alternatives = selector.split(',').map((part) => part.trim());
    return alternatives.some((part) => {
      const attributes = [...part.matchAll(/\[data-([\w-]+)(?:="([^"]*)")?\]/g)];
      if (attributes.length) return attributes.every(([, name, value]) => {
        const key = name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
        return this.dataset[key] !== undefined && (value === undefined || String(this.dataset[key]) === value);
      });
      if (part.startsWith('.')) return this.classList.contains(part.slice(1));
      return this.tagName.toLowerCase() === part;
    });
  }
  querySelectorAll(selector) {
    const result = [];
    for (const child of this.children) {
      if (child.matches(selector)) result.push(child);
      result.push(...child.querySelectorAll(selector));
    }
    return result;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  closest(selector) {
    for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node;
    return null;
  }
  focus() { this.ownerDocument.activeElement = this; }
  blur() { this.ownerDocument.activeElement = null; return this.fire('blur'); }
}

function startPage({ storageBlocked = false, storedState } = {}) {
  const html = readFileSync(new URL('index.html', root), 'utf8');
  const elements = new Map();
  const body = new ElementDouble('body');
  const shell = new ElementDouble('div');
  shell.className = 'app-shell';
  body.append(shell);
  for (const [, tagName, attributes, id] of html.matchAll(/<([a-z][\w-]*)\b([^>]*\bid="([^"]+)"[^>]*)>/gi)) {
    const element = new ElementDouble(tagName);
    element.id = id;
    for (const name of ['type', 'min', 'max', 'value']) {
      const match = attributes.match(new RegExp(`\\b${name}="([^"]*)"`));
      if (match) element[name] = match[1];
    }
    element.hidden = /\bhidden\b/.test(attributes);
    element.checked = /\bchecked\b/.test(attributes);
    elements.set(id, element);
    shell.append(element);
  }
  const playIcon = new ElementDouble('svg');
  playIcon.append(new ElementDouble('use'));
  elements.get('play-button').append(playIcon, new ElementDouble('span'), new ElementDouble('kbd'));
  const tapIcon = new ElementDouble('svg');
  tapIcon.append(new ElementDouble('use'));
  elements.get('tap-button').append(tapIcon, new ElementDouble('span'), new ElementDouble('kbd'));
  const documentListeners = new Map();
  const document = {
    body,
    getElementById: (id) => elements.get(id) ?? null,
    createElement: (tagName) => { const element = new ElementDouble(tagName); element.ownerDocument = document; return element; },
    querySelectorAll: (selector) => body.querySelectorAll(selector),
    querySelector: (selector) => body.querySelector(selector),
    addEventListener(type, listener) { documentListeners.set(type, listener); },
  };
  for (const element of elements.values()) element.ownerDocument = document;
  const saved = new Map();
  if (storedState) saved.set('tushx39.metronome.v1', JSON.stringify(storedState));
  let audioTime = 0;
  let tapTime = 0;
  let nextId = 1;
  const intervals = new Map();
  const frames = new Map();
  const timeouts = new Map();
  const param = () => ({ value: 0, setValueAtTime() {}, setTargetAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} });
  const node = () => ({ connect() {}, disconnect() {}, start() {}, stop() {}, gain: param(), frequency: param(), Q: param() });
  class AudioContextDouble {
    state = 'running';
    sampleRate = 44100;
    destination = node();
    get currentTime() { return audioTime; }
    createGain() { return node(); }
    createOscillator() { return node(); }
    createBufferSource() { return node(); }
    createBiquadFilter() { return node(); }
    createBuffer(channels, size) { return { getChannelData: () => new Float32Array(size) }; }
    async resume() { this.state = 'running'; }
  }
  const context = {
    document,
    window: { addEventListener() {} },
    structuredClone,
    AudioContext: AudioContextDouble,
    setInterval: (callback) => { const id = nextId++; intervals.set(id, callback); return id; },
    clearInterval: (id) => intervals.delete(id),
    setTimeout: (callback) => { const id = nextId++; timeouts.set(id, callback); return id; },
    clearTimeout: (id) => timeouts.delete(id),
    requestAnimationFrame: (callback) => { const id = nextId++; frames.set(id, callback); return id; },
    cancelAnimationFrame: (id) => frames.delete(id),
    performance: { now: () => tapTime },
  };
  Object.defineProperty(context, 'localStorage', storageBlocked ? {
    get() { throw new Error('Storage is unavailable for this file origin'); },
  } : {
    value: { getItem: (key) => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) },
  });
  // Execute the shipped classic script directly: no ES-module loader or HTTP
  // server can hide a missing dependency in the double-click entry point.
  const entry = html.match(/<script\b[^>]*\bsrc="([^"]+)"/);
  assert.ok(entry, 'the page must load a browser entry script');
  const source = readFileSync(new URL(entry[1], root), 'utf8');
  new vm.Script(source, { filename: 'metronome.js' }).runInNewContext(context);
  return {
    document, element: (id) => elements.get(id), saved,
    advance(time) {
      audioTime = time;
      for (const callback of [...intervals.values()]) callback();
      const pending = [...frames.values()]; frames.clear();
      for (const callback of pending) callback();
    },
    tapAt(time, keyboard = false) {
      tapTime = time;
      if (keyboard) documentListeners.get('keydown')({ code: 'KeyT', target: body, preventDefault() {} });
      else elements.get('tap-button').fire('click');
    },
  };
}

test('the standalone browser bundle initializes controls and handles tempo changes', () => {
  const page = startPage();
  assert.equal(page.element('beats').children.length, 12);
  assert.equal(page.element('preset-list').children.length, 12);
  assert.equal(page.element('sound-list').children.length, 6);
  assert.equal(page.element('beat-editor').children.length, 4);
  assert.equal(page.element('rail-notes').children.length, 4);
  assert.equal(page.element('bpm').value, '120');
  page.element('tempo-plus').fire('click');
  assert.equal(page.element('bpm').value, '121');
  assert.equal(page.element('tempo-range').value, '121');
  assert.equal(JSON.parse([...page.saved.values()][0]).bpm, 121);
});

test('blocked file-origin storage still allows mode switching and rhythm editing', () => {
  const page = startPage({ storageBlocked: true });
  page.element('tempo-plus').fire('click');
  assert.equal(page.element('bpm').value, '121');
  assert.match(page.element('save-status').textContent, /无法保存/);
  page.element('advanced-mode').fire('click');
  assert.equal(page.element('advanced-panel').hidden, false);
  assert.equal(page.element('advanced-mode').getAttribute('aria-pressed'), 'true');
  const division = page.document.querySelector('[data-division-beat="0"]');
  division.value = '3';
  division.fire('change');
  assert.equal(page.document.querySelector('[data-preset="custom"]').getAttribute('aria-pressed'), 'true');
  assert.equal(page.document.querySelectorAll('[data-cell]').length, 6);
  page.document.querySelector('[data-beat="0"][data-cell="0"]').fire('click');
  assert.equal(page.element('note-kind').value, 'accent');
  assert.equal(page.element('note-inspector').hidden, false);
  assert.match(page.document.querySelector('[data-beat="0"][data-cell="0"]').getAttribute('aria-label'), /重音/);
  page.element('basic-mode').fire('click');
  assert.equal(page.element('advanced-panel').hidden, true);
  assert.equal(page.element('rail-notes').children.length, 4);
});

test('ramp tempo updates the main BPM and slider without compounding the saved base', async () => {
  const state = structuredClone(DEFAULT_STATE);
  state.advanced = true;
  Object.assign(state.practice, { rampEnabled: true, rampEvery: 1, rampStep: 10 });
  const page = startPage({ storedState: state });
  await page.element('play-button').fire('click');
  page.advance(.06);
  page.advance(2.06);
  assert.equal(page.element('bpm').value, '130');
  assert.equal(page.element('tempo-range').value, '130');
  page.advance(3.91);
  assert.equal(page.element('bpm').value, '140');
  assert.equal(JSON.parse([...page.saved.values()][0]).bpm, 120);
  await page.element('tempo-plus').fire('click');
  assert.equal(page.element('bpm').value, '141');
  assert.equal(page.element('tempo-range').value, '141');
});

test('practice numbers apply during input and leave incomplete values editable', () => {
  const page = startPage();
  page.element('ramp-every').value = '2';
  page.element('ramp-every').fire('input');
  assert.equal(JSON.parse([...page.saved.values()][0]).practice.rampEvery, 2);
  page.element('ramp-every').value = '';
  page.element('ramp-every').fire('input');
  assert.equal(page.element('ramp-every').value, '');
  assert.equal(JSON.parse([...page.saved.values()][0]).practice.rampEvery, 2);
});

test('focused BPM follows ramping and protects an unfinished edit until blur', async () => {
  const state = structuredClone(DEFAULT_STATE);
  state.advanced = true;
  Object.assign(state.practice, { rampEnabled: true, rampEvery: 1, rampStep: 10 });
  const page = startPage({ storedState: state });
  await page.element('play-button').fire('click');
  page.advance(.06);
  page.element('bpm').focus();
  page.advance(2.06);
  assert.equal(page.element('bpm').value, '130');
  page.element('bpm').value = '';
  page.element('bpm').fire('input');
  page.advance(3.91);
  assert.equal(page.element('bpm').value, '');
  assert.equal(page.element('tempo-range').value, '140');
  page.element('bpm').fire('change');
  page.element('bpm').blur();
  assert.equal(page.element('bpm').value, '140');
  assert.equal(JSON.parse([...page.saved.values()][0]).bpm, 120);
});

test('Tap preserves its button contents and T shortcut while measuring BPM', () => {
  const page = startPage();
  const button = page.element('tap-button');
  const children = [...button.children];
  page.tapAt(1000);
  page.tapAt(1400, true);
  assert.equal(page.element('bpm').value, '150');
  assert.deepEqual(button.children, children);
  assert.equal(button.classList.contains('tapped'), true);
});

test('only beats per bar is configurable and old settings use quarter-note beats', () => {
  const state = structuredClone(DEFAULT_STATE);
  state.denominator = 8;
  state.beats = 6;
  const page = startPage({ storedState: state });
  assert.equal(Boolean(page.element('denominator')), false);
  assert.equal(page.element('beats').value, '6');
  assert.equal(page.element('editor-meter').textContent, '6 拍');
  page.element('tempo-plus').fire('click');
  assert.equal(JSON.parse([...page.saved.values()][0]).denominator, 4);
});

test('twelve notation-only presets include a working six-note subdivision', () => {
  const page = startPage();
  const presets = page.element('preset-list').children;
  assert.equal(presets.length, 12);
  for (const button of presets) {
    assert.equal(Boolean(button.querySelector('.preset-name')), false);
    assert.ok(button.getAttribute('aria-label'));
    assert.match(button.querySelector('.notation').innerHTML, /<svg/);
  }
  assert.equal(Boolean(page.element('preset-current')), false);
  page.element('advanced-mode').fire('click');
  page.document.querySelector('[data-preset="sextuplet"]').fire('click');
  assert.equal(page.element('rail-notes').children.length, 24);
  assert.equal(page.element('rhythm-caption').hidden, true);
});

test('the first editor cell and accent checkbox stay synchronized in both directions', () => {
  const page = startPage();
  page.element('advanced-mode').fire('click');
  const first = () => page.document.querySelector('[data-beat="0"][data-cell="0"]');
  assert.equal(page.element('accent').checked, true);
  assert.equal(first().classList.contains('accent'), true);
  page.element('accent').checked = false;
  page.element('accent').fire('change');
  assert.equal(first().classList.contains('normal'), true);
  assert.equal(page.document.querySelector('[data-preset="quarter"]').getAttribute('aria-pressed'), 'true');
  first().fire('click');
  assert.equal(first().classList.contains('accent'), true);
  assert.equal(page.element('accent').checked, true);
  first().fire('click');
  assert.equal(first().classList.contains('rest'), true);
  assert.equal(page.element('accent').checked, false);
  page.element('accent').checked = true;
  page.element('accent').fire('change');
  assert.equal(first().classList.contains('accent'), true);
  assert.equal(page.element('note-kind').value, 'accent');
  page.element('note-kind').value = 'normal';
  page.element('note-kind').fire('change');
  assert.equal(first().classList.contains('normal'), true);
  assert.equal(page.element('accent').checked, false);
  const saved = JSON.parse([...page.saved.values()][0]);
  assert.equal(saved.accent, false);
  assert.equal(saved.pattern[0].cells[0].kind, 'normal');
});

test('first-cell binding survives clear, grid changes, mode switching and preset rests', () => {
  const page = startPage();
  page.element('advanced-mode').fire('click');
  page.element('clear-pattern').fire('click');
  assert.equal(page.element('accent').checked, false);
  page.element('accent').checked = true;
  page.element('accent').fire('change');
  const division = page.document.querySelector('[data-division-beat="0"]');
  division.value = '3'; division.fire('change');
  assert.equal(page.element('accent').checked, false);
  page.document.querySelector('[data-beat="0"][data-cell="0"]').fire('click');
  assert.equal(page.element('accent').checked, true);
  page.element('basic-mode').fire('click');
  page.element('accent').checked = false;
  page.element('accent').fire('change');
  page.element('advanced-mode').fire('click');
  assert.equal(page.document.querySelector('[data-beat="0"][data-cell="0"]').classList.contains('normal'), true);
  page.document.querySelector('[data-preset="syncopated"]').fire('click');
  assert.equal(page.element('accent').checked, false);
  page.element('accent').checked = true;
  page.element('accent').fire('change');
  assert.equal(page.document.querySelector('[data-beat="0"][data-cell="0"]').classList.contains('accent'), true);
  assert.equal(page.document.querySelector('[data-preset="custom"]').getAttribute('aria-pressed'), 'true');
  const notation = page.document.querySelector('[data-preset="custom"]').querySelector('.notation').innerHTML;
  assert.equal((notation.match(/<circle\b/g) || []).length, 3);
  assert.doesNotMatch(notation, /<ellipse|<path/);
});
