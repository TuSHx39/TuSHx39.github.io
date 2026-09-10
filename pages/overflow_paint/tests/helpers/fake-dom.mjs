/**
 * 测试用的极简 DOM。
 *
 * 浏览器在本机沙箱里起不来，所以这里只实现 app.js 真正用到的那一小部分 API
 * （getElementById / createElement / classList / style / dataset / 事件派发……），
 * 让交互层也能在 Node 里完整跑一遍：初始化、落子、提示、答案、演示、选项、存档恢复。
 *
 * 元素结构由页面 HTML 里带 id 的标签「搭」出来，保证测试与真实页面用的是同一份 id 清单。
 */

export class FakeClassList {
  constructor() {
    this.set = new Set();
  }

  add(...names) {
    for (const name of names) if (name) this.set.add(name);
  }

  remove(...names) {
    for (const name of names) this.set.delete(name);
  }

  toggle(name, force) {
    const on = force === undefined ? !this.set.has(name) : !!force;
    if (on) this.set.add(name);
    else this.set.delete(name);
    return on;
  }

  contains(name) {
    return this.set.has(name);
  }

  toString() {
    return [...this.set].join(' ');
  }
}

export class FakeElement {
  constructor(tagName, document) {
    this.tagName = String(tagName).toUpperCase();
    this.ownerDocument = document || null;
    this.children = [];
    this.parentNode = null;
    this.classList = new FakeClassList();
    this.dataset = {};
    this.attributes = {};
    this.listeners = new Map();
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.value = '';
    this.textContent = '';
    this.clientWidth = 640;
    this.clientHeight = 480;
    this._html = '';
    this.style = {
      setProperty(name, value) {
        this[name] = value;
      },
      removeProperty(name) {
        delete this[name];
      },
    };
  }

  get className() {
    return this.classList.toString();
  }

  set className(value) {
    this.classList = new FakeClassList();
    this.classList.add(...String(value).split(/\s+/).filter(Boolean));
  }

  get innerHTML() {
    return this._html;
  }

  set innerHTML(value) {
    this._html = String(value);
    if (this._html === '') this.children = [];
  }

  get offsetWidth() {
    return 40;
  }

  focus() {
    if (this.ownerDocument) this.ownerDocument.activeElement = this;
  }

  blur() {
    if (this.ownerDocument && this.ownerDocument.activeElement === this) {
      this.ownerDocument.activeElement = null;
    }
  }

  select() {
    this.selected = true;
  }

  appendChild(node) {
    if (!node) return node;
    if (node.tagName === 'FRAGMENT') {
      for (const child of node.children.slice()) this.appendChild(child);
      node.children = [];
      return node;
    }
    this.children.push(node);
    node.parentNode = this;
    return node;
  }

  removeChild(node) {
    const index = this.children.indexOf(node);
    if (index >= 0) {
      this.children.splice(index, 1);
      node.parentNode = null;
    }
    return node;
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  removeEventListener(type, handler) {
    const list = this.listeners.get(type);
    if (!list) return;
    const index = list.indexOf(handler);
    if (index >= 0) list.splice(index, 1);
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
  }

  closest(selector) {
    if (selector.startsWith('.')) {
      const cls = selector.slice(1);
      let node = this;
      while (node) {
        if (node.classList && node.classList.contains(cls)) return node;
        node = node.parentNode;
      }
    }
    return null;
  }

  querySelectorAll(selector) {
    const doc = this.ownerDocument;
    if (doc && selector.startsWith('.')) return doc.queryByClass(selector.slice(1));
    return [];
  }

  /** 触发已注册的事件处理器（返回是否有处理器被调用） */
  dispatch(type, event) {
    const list = this.listeners.get(type) || [];
    const payload = Object.assign({ type, target: this, preventDefault() {} }, event || {});
    for (const handler of list.slice()) handler(payload);
    return list.length > 0;
  }
}

export function createDom(html) {
  const ids = new Map();
  const byClass = new Map();
  const document = {
    readyState: 'complete',
    body: null,
    documentElement: null,
    listeners: new Map(),
    getElementById(id) {
      return ids.get(id) || null;
    },
    createElement(tag) {
      return new FakeElement(tag, document);
    },
    createDocumentFragment() {
      return new FakeElement('fragment', document);
    },
    addEventListener(type, handler) {
      if (!document.listeners.has(type)) document.listeners.set(type, []);
      document.listeners.get(type).push(handler);
    },
    queryByClass(cls) {
      return (byClass.get(cls) || []).slice();
    },
  };

  document.body = new FakeElement('body', document);
  document.documentElement = new FakeElement('html', document);
  const title = /<title>([^<]*)<\/title>/.exec(html);
  document.title = title ? title[1] : '';

  // 极简解析：把 HTML 里带 id / class / data-mode 的标签变成元素
  const tagPattern = /<([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>])*)>/g;
  let match;
  while ((match = tagPattern.exec(html))) {
    const tagName = match[1];
    const attrs = match[2] || '';
    const idMatch = /\sid="([^"]+)"/.exec(attrs);
    const classMatch = /\sclass="([^"]+)"/.exec(attrs);
    const modeMatch = /\sdata-mode="([^"]+)"/.exec(attrs);
    const hidden = /(^|\s)hidden(\s|$|=)/.test(attrs);
    if (!idMatch && !classMatch && !modeMatch) continue;

    const element = new FakeElement(tagName, document);
    if (classMatch) element.className = classMatch[1];
    if (modeMatch) element.dataset.mode = modeMatch[1];
    if (hidden) element.hidden = true;
    if (idMatch) {
      element.id = idMatch[1];
      ids.set(idMatch[1], element);
    }
    const classNames = classMatch ? classMatch[1].split(/\s+/).filter(Boolean) : [];
    if (modeMatch && !classNames.includes('tab')) classNames.push('tab');
    for (const cls of classNames) {
      if (!byClass.has(cls)) byClass.set(cls, []);
      byClass.get(cls).push(element);
    }
    if (modeMatch) {
      // 选项卡必须挂在弹窗里，app.js 会用 optionsModal.querySelectorAll('.tab')
      const modal = ids.get('options-modal');
      if (modal) modal.appendChild(element);
    }
  }

  return { document, ids, byClass };
}
