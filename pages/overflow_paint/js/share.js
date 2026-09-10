/**
 * share.js —— 题目分享码：把一道题压成一串短字符，且完全可逆。
 *
 * 编码格式（位流，最后整体按 base64url 输出，前缀 "YC"）：
 *   版本 3 位 | 行数-1 4 位 | 列数-1 5 位 | 目标色 2 位 | 限制步数 4 位
 *   | 有空洞 1 位 [ | 每格 1 位的空洞位图 rows*cols 位 ]
 *   | 每个有效格 2 位的颜色
 *   | 解法步数 6 位 | 每步：落子格下标 log2(格数) 位 + 颜色 2 位
 *   | 校验和 8 位（FNV-1a 的截断，防止手抄出错）
 *
 * 例：10×8 的题目大约 40~50 个字符；20×15 的大约 120~140 个字符。
 *
 * 传统脚本（非 ES Module），接口挂在全局 Yicai.Share 上。
 */

(function (global) {
  'use strict';

  const Yicai = (global.Yicai = global.Yicai || {});
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const PREFIX = 'YC';
  const VERSION = 1;

  /** 位数组 → 字节数组（高位在前） */
  function packBits(bits) {
    const bytes = new Uint8Array(Math.ceil(bits.length / 8));
    for (let i = 0; i < bits.length; i++) {
      if (bits[i]) bytes[i >> 3] |= 0x80 >> (i & 7);
    }
    return bytes;
  }

  /** 字节数组 → 位数组（取前 count 位） */
  function unpackBits(bytes, count) {
    const bits = new Array(count);
    for (let i = 0; i < count; i++) {
      bits[i] = (bytes[i >> 3] >> (7 - (i & 7))) & 1;
    }
    return bits;
  }

  function checksum(bytes) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i++) {
      hash = Math.imul(hash ^ bytes[i], 16777619);
    }
    return (hash >>> 0) & 0xff;
  }

  function toBase64Url(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
      const b0 = bytes[i];
      const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
      const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
      const chunk = (b0 << 16) | (b1 << 8) | b2;
      out += ALPHABET[(chunk >> 18) & 63];
      out += ALPHABET[(chunk >> 12) & 63];
      if (i + 1 < bytes.length) out += ALPHABET[(chunk >> 6) & 63];
      if (i + 2 < bytes.length) out += ALPHABET[chunk & 63];
    }
    return out;
  }

  function fromBase64Url(text) {
    const bytes = [];
    let buffer = 0;
    let bits = 0;
    for (const ch of text) {
      const value = ALPHABET.indexOf(ch);
      if (value < 0) return null;
      buffer = (buffer << 6) | value;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        bytes.push((buffer >> bits) & 0xff);
      }
    }
    return new Uint8Array(bytes);
  }

  function bitLength(value) {
    let bits = 1;
    while (1 << bits <= value) bits++;
    return bits;
  }

  /**
   * 题目 → 分享码
   * @param {{rows:number, cols:number, target:number, limit:number, board:object, solution:Array}} puzzle
   * @returns {string}
   */
  function encode(puzzle) {
    const Core = Yicai.Core;
    const rows = Math.max(1, Math.round(puzzle.rows));
    const cols = Math.max(1, Math.round(puzzle.cols));
    const cells = puzzle.board.cells;
    if (rows > 16 || cols > 32) throw new Error('盘面太大，无法编码');

    const bits = [];
    const push = (value, count) => {
      for (let i = count - 1; i >= 0; i--) bits.push((value >> i) & 1);
    };

    let hasHoles = false;
    const active = [];
    for (let i = 0; i < cells.length; i++) {
      if (cells[i] === Core.HOLE) hasHoles = true;
      else active.push(i);
    }

    push(VERSION, 3);
    push(rows - 1, 4);
    push(cols - 1, 5);
    push(puzzle.target & 3, 2);
    push(Math.min(15, Math.max(0, puzzle.limit)) & 15, 4);
    push(hasHoles ? 1 : 0, 1);
    if (hasHoles) {
      for (let i = 0; i < cells.length; i++) push(cells[i] === Core.HOLE ? 0 : 1, 1);
    }
    for (const i of active) push(cells[i] & 3, 2);

    const solution = Array.isArray(puzzle.solution) ? puzzle.solution.slice(0, 63) : [];
    push(solution.length, 6);
    const indexBits = bitLength(rows * cols - 1);
    for (const move of solution) {
      push(move.index, indexBits);
      push(move.color & 3, 2);
    }

    const body = packBits(bits);
    const sum = checksum(body);
    const bytes = new Uint8Array(body.length + 1);
    bytes.set(body, 0);
    bytes[body.length] = sum;
    return PREFIX + toBase64Url(bytes);
  }

  /**
   * 分享码 → 题目数据
   * @returns {{rows:number, cols:number, target:number, limit:number, board:object, solution:Array, mask:object}|null}
   */
  function decode(code) {
    const Core = Yicai.Core;
    if (typeof code !== 'string') return null;
    const text = code.trim().replace(/\s+/g, '');
    if (!text.startsWith(PREFIX)) return null;
    const bytes = fromBase64Url(text.slice(PREFIX.length));
    if (!bytes || bytes.length < 2) return null;

    // 最后一个字节是校验和，前面是正文（正文按字节对齐，末尾补 0）
    const sum = bytes[bytes.length - 1];
    const body = bytes.slice(0, bytes.length - 1);
    if (checksum(body) !== sum) return null;

    const bodyBits = body.length * 8;
    const bits = unpackBits(body, bodyBits);

    try {
      let pos = 0;
      const read = (count) => {
        let value = 0;
        for (let i = 0; i < count; i++) {
          if (pos >= bodyBits) throw new Error('数据不完整');
          value = (value << 1) | bits[pos++];
        }
        return value;
      };

      const version = read(3);
      if (version !== VERSION) return null;
      const rows = read(4) + 1;
      const cols = read(5) + 1;
      const target = read(2);
      const limit = read(4);
      const hasHoles = read(1) === 1;
      if (rows < 1 || cols < 1 || rows > 16 || cols > 32) return null;
      if (!Core.isValidColor(target)) return null;
      if (limit < 1 || limit > 15) return null;

      const total = rows * cols;
      const mask = new Int8Array(total);
      mask.fill(1);
      if (hasHoles) {
        for (let i = 0; i < total; i++) mask[i] = read(1);
      }

      const board = Core.createBoard(rows, cols, Core.HOLE);
      for (let i = 0; i < total; i++) {
        if (!mask[i]) continue;
        board.cells[i] = read(2);
      }

      const steps = read(6);
      const indexBits = bitLength(total - 1);
      const solution = [];
      for (let i = 0; i < steps; i++) {
        const index = read(indexBits);
        const color = read(2);
        if (index >= total || !Core.isValidColor(color)) return null;
        solution.push({ index, color });
      }

      // 带的解法必须真的能通关；对不上（例如手工构造的「只有题目」的码）就当没带解法
      const check = Core.simulate(board, solution, target);
      const valid = solution.length > 0 && check.solved;

      return {
        rows,
        cols,
        target,
        limit: valid ? solution.length : limit,
        board,
        solution: valid ? solution : [],
        mask: { rows, cols, mask },
      };
    } catch (error) {
      return null;
    }
  }

  Yicai.Share = { encode, decode, PREFIX, ALPHABET };
})(typeof window !== 'undefined' ? window : globalThis);
