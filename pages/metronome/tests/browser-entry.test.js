import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);

test('the HTML entry runs as a classic local script without an ES module fetch', () => {
  const html = readFileSync(new URL('index.html', root), 'utf8');
  const scripts = [...html.matchAll(/<script\b([^>]*)\bsrc="([^"]+)"[^>]*><\/script>/g)];
  assert.equal(scripts.length, 1);
  assert.doesNotMatch(scripts[0][1], /\btype\s*=\s*["']module["']/);
  assert.match(scripts[0][1], /\bdefer\b/);
  const script = readFileSync(new URL(scripts[0][2], root), 'utf8');
  assert.doesNotMatch(script, /^\s*(?:import|export)\s/m);
  assert.doesNotThrow(() => new vm.Script(script, { filename: fileURLToPath(new URL(scripts[0][2], root)) }));
});
