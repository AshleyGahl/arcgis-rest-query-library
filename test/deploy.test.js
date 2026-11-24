/**
 * The static deployment stages a hand-written list of platform-free engine modules
 * (`.github/workflows/pages.yml`), because the Node-only parts of `server/` must
 * not ship. A new engine import is therefore easy to add and easy to forget, and
 * the failure is silent until the published demo 404s on the module.
 *
 * This test resolves what the browser actually imports and requires every file to
 * be staged.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../server/config.js';

const root = config.root;
const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'pages.yml'), 'utf8');

/** Every local module reachable from the browser's entry points. */
function importClosure(entries) {
  const seen = new Set();
  const visit = (file) => {
    const rel = path.relative(root, file).replace(/\\/g, '/');
    if (seen.has(rel) || !fs.existsSync(file)) return;
    seen.add(rel);
    const src = fs.readFileSync(file, 'utf8');
    const specs = [
      ...[...src.matchAll(/(?:^|\n)\s*(?:import|export)[\s\S]{0,200}?from\s+['"](\.[^'"]+)['"]/g)].map((m) => m[1]),
      ...[...src.matchAll(/import\(\s*['"](\.[^'"]+)['"]\s*\)/g)].map((m) => m[1]),
    ];
    for (const spec of specs) visit(path.resolve(path.dirname(file), spec));
  };
  for (const e of entries) visit(path.join(root, e));
  return [...seen].sort();
}

const closure = importClosure(['viewer/js/main.js', 'viewer/js/engine/boot.js', 'sw.js']);

// Directories the workflow copies wholesale, plus the files it copies by name.
const WHOLESALE = ['viewer/', 'sql-library/', 'data/', 'docs/'];
const BY_NAME = ['index.html', 'sw.js', '.nojekyll'];

test('the browser import closure is non-trivial (the walker actually found things)', () => {
  assert.ok(closure.length > 20, `only found ${closure.length} modules`);
  assert.ok(closure.includes('viewer/js/main.js'));
  assert.ok(closure.includes('server/featureService.js'));
});

test('every module the browser imports is staged for GitHub Pages', () => {
  const staged = (f) =>
    WHOLESALE.some((d) => f.startsWith(d)) ||
    BY_NAME.includes(f) ||
    (f.startsWith('server/') && workflow.includes(path.basename(f)));
  const missing = closure.filter((f) => !staged(f));
  assert.deepEqual(missing, [], `not staged in .github/workflows/pages.yml: ${missing.join(', ')}`);
});

test('the staged engine modules stay platform-free', () => {
  for (const f of closure.filter((x) => x.startsWith('server/'))) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    assert.doesNotMatch(src, /from\s+['"]node:/, `${f} imports a node: built-in but is loaded by the browser`);
    assert.doesNotMatch(src, /\bprocess\.(env|argv|cwd)\b/, `${f} uses process but is loaded by the browser`);
  }
});

test('the workflow does not stage a Node-only module by accident', () => {
  for (const f of ['nodeRuntime.js', 'index.js', 'start.js', 'config.js']) {
    assert.ok(!workflow.includes(`server/${f}`), `pages.yml stages Node-only server/${f}`);
  }
});
