/**
 * The site is published by GitHub Pages straight from the `main` branch root
 * (Settings › Pages › Deploy from a branch › main / `/`). There is no build step
 * and no Actions workflow: **the site is the repository**.
 *
 * That removes the old failure mode entirely — a workflow staging a hand-written
 * list of files, which silently 404'd whatever it forgot. Two things still have to
 * hold, and neither is obvious while working locally:
 *
 *   1. Everything the browser imports must be committed, or Pages cannot serve it.
 *   2. Those modules must stay platform-free, because the browser loads them
 *      directly from `server/` and `mcp/` (see CLAUDE.md).
 *
 * And because the local Node server serves a *subset* of the repository by prefix,
 * a module can work on the published site yet 404 under `npm start`. The last test
 * covers that asymmetry.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
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
  assert.ok(closure.includes('mcp/tools.js'));
});

test('every module the browser imports is committed, so Pages can serve it', () => {
  // `git ls-files` lists tracked files; an untracked or ignored module is simply
  // absent from the published branch.
  const tracked = new Set(
    execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
      .split('\n').map((l) => l.trim()).filter(Boolean),
  );
  const missing = closure.filter((f) => !tracked.has(f));
  assert.deepEqual(missing, [], `not committed, so GitHub Pages will 404 on them: ${missing.join(', ')}`);
});

test('the site entry points are committed too', () => {
  for (const f of ['index.html', 'sw.js', '.nojekyll', 'viewer/index.html', 'docs/index.html', 'docs/docs.css']) {
    assert.ok(fs.existsSync(path.join(root, f)), `${f} is missing`);
  }
  // `.nojekyll` is what stops Pages running the files through Jekyll.
  assert.ok(fs.existsSync(path.join(root, '.nojekyll')));
});

test('the modules the browser loads stay platform-free', () => {
  for (const f of closure.filter((x) => x.startsWith('server/') || x.startsWith('mcp/'))) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    assert.doesNotMatch(src, /from\s+['"]node:/, `${f} imports a node: built-in but is loaded by the browser`);
    assert.doesNotMatch(src, /\bprocess\.(env|argv|cwd)\b/, `${f} uses process but is loaded by the browser`);
  }
});

test('the Node-only modules are not in the browser closure', () => {
  for (const f of ['server/nodeRuntime.js', 'server/index.js', 'server/start.js', 'server/config.js', 'mcp/server.js']) {
    assert.ok(!closure.includes(f), `the browser imports ${f}, which is Node-only`);
  }
});

/**
 * The local server maps URL prefixes to directories and serves nothing else, so a
 * module the viewer imports from an unmapped directory 404s under `npm start` even
 * though the published site serves it. (Read as source rather than imported,
 * because importing `server/index.js` starts a server.)
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

test('no GitHub Actions workflow has crept back in to publish the site', () => {
  // Deliberately branch-deployed: Pages serves main/ directly. If a workflow is
  // added again, it needs its own staging checks, which this file no longer has.
  const dir = path.join(root, '.github', 'workflows');
  const workflows = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)) : [];
  assert.deepEqual(workflows, [], `unexpected workflow(s): ${workflows.join(', ')} — see the note at the top of this file`);
});
