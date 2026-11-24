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
const workflowSource = fs.readFileSync(path.join(root, '.github', 'workflows', 'pages.yml'), 'utf8');

/**
 * The workflow with its comment lines removed. A path named only in a comment is
 * documentation, not a copy, so every check below reasons about the commands.
 */
const workflow = workflowSource.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

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

/** True when the workflow copies this exact repo-relative path, one way or another. */
const staged = (f) => WHOLESALE.some((d) => f.startsWith(d)) || BY_NAME.includes(f) || workflow.includes(f);

test('the browser import closure is non-trivial (the walker actually found things)', () => {
  assert.ok(closure.length > 20, `only found ${closure.length} modules`);
  assert.ok(closure.includes('viewer/js/main.js'));
  assert.ok(closure.includes('server/featureService.js'));
});

test('every module the browser imports is staged for GitHub Pages', () => {
  const missing = closure.filter((f) => !staged(f));
  assert.deepEqual(missing, [], `not staged in .github/workflows/pages.yml: ${missing.join(', ')}`);
});

test('the staged engine modules stay platform-free', () => {
  for (const f of closure.filter((x) => x.startsWith('server/') || x.startsWith('mcp/'))) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    assert.doesNotMatch(src, /from\s+['"]node:/, `${f} imports a node: built-in but is loaded by the browser`);
    assert.doesNotMatch(src, /\bprocess\.(env|argv|cwd)\b/, `${f} uses process but is loaded by the browser`);
  }
});

test('the workflow does not stage a Node-only module by accident', () => {
  for (const f of ['nodeRuntime.js', 'index.js', 'start.js', 'config.js']) {
    assert.ok(!workflow.includes(`server/${f}`), `pages.yml stages Node-only server/${f}`);
  }
  // mcp/server.js is the stdio transport: Node-only, and nothing in the page imports it.
  assert.ok(!workflow.includes('mcp/server.js'), 'pages.yml stages Node-only mcp/server.js');
  assert.ok(!closure.includes('mcp/server.js'), 'the browser imports mcp/server.js, which is Node-only');
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
