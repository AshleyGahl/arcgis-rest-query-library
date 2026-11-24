/**
 * GitHub Pages serves the repository branch as it is, so there is no staged file
 * list to keep in step: whatever the browser imports is published because it is
 * committed. Two things still have to hold, and both fail silently.
 *
 * This test resolves what the browser actually imports, then asserts that none of
 * it reaches for a Node-only API, and that `npm start` serves all of it too.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../server/config.js';

const root = config.root;

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

test('the browser import closure is non-trivial (the walker actually found things)', () => {
  assert.ok(closure.length > 20, `only found ${closure.length} modules`);
  assert.ok(closure.includes('viewer/js/main.js'));
  assert.ok(closure.includes('server/featureService.js'));
});

test('every module the browser imports is committed, so Pages serves it', () => {
  const missing = closure.filter((f) => !fs.existsSync(path.join(root, f)));
  assert.deepEqual(missing, [], `imported but not present in the repository: ${missing.join(', ')}`);
});

test('the engine modules the browser loads stay platform-free', () => {
  for (const f of closure.filter((x) => x.startsWith('server/') || x.startsWith('mcp/'))) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    assert.doesNotMatch(src, /from\s+['"]node:/, `${f} imports a node: built-in but is loaded by the browser`);
    assert.doesNotMatch(src, /\bprocess\.(env|argv|cwd)\b/, `${f} uses process but is loaded by the browser`);
  }
});

/**
 * Publishing the branch means the Node-only modules are served as well. Harmless in
 * itself — they are public source either way — but the browser must never *import*
 * one, because in the static demo there is no Node to run it.
 */
test('the browser imports no Node-only module', () => {
  const nodeOnly = ['server/nodeRuntime.js', 'server/index.js', 'server/start.js', 'server/config.js', 'mcp/server.js'];
  const imported = nodeOnly.filter((f) => closure.includes(f));
  assert.deepEqual(imported, [], `the browser imports Node-only module(s): ${imported.join(', ')}`);
});

/**
 * The same completeness question for the *local* server: `server/index.js` maps
 * URL prefixes to directories, and a module the viewer imports from a directory
 * that is not mapped 404s under `npm start` even though the published site serves
 * it. (Read as source rather than imported, because importing it starts a server.)
 */
test('the local server serves every directory the browser imports from', () => {
  const src = fs.readFileSync(path.join(root, 'server', 'index.js'), 'utf8');
  const map = /const STATIC = \{([^}]*)\}/.exec(src);
  assert.ok(map, 'could not find the STATIC prefix map in server/index.js');
  const prefixes = [...map[1].matchAll(/'\/([^']+)\/'/g)].map((m) => `${m[1]}/`);
  const rootFiles = /const ROOT_FILES = new Set\(\[([^\]]*)\]/.exec(src);
  const served = [...(rootFiles ? rootFiles[1].matchAll(/'\/?([^']*)'/g) : [])].map((m) => m[1]);

  const missing = closure.filter((f) => !prefixes.some((p) => f.startsWith(p)) && !served.includes(f));
  assert.deepEqual(missing, [], `not served by server/index.js (add a STATIC prefix): ${missing.join(', ')}`);
});
