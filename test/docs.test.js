/**
 * `docs/*.html` is generated from `docs/*.md` by `npm run build`. These tests fail
 * if the committed HTML is stale, which is the only thing keeping a documentation
 * edit from being published as the previous version.
 *
 * They also check the converter itself, since it is hand-rolled (no dependencies)
 * and the published site is the only place its output is read.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { config } from '../server/config.js';

const docsDir = path.join(config.root, 'docs');
const generated = ['overview.html', 'architecture.html', 'data-model.html', 'framework.html', 'query-catalog.html', 'catalog-pattern.html', 'index.html'];

test('every Markdown doc has a generated page', () => {
  const md = fs.readdirSync(docsDir).filter((f) => f.endsWith('.md'));
  for (const f of md) {
    const html = f.replace(/\.md$/, '.html');
    assert.ok(fs.existsSync(path.join(docsDir, html)), `docs/${html} is missing — add ${f} to PAGES in scripts/build-docs.js and run npm run build`);
  }
});

test('the committed HTML matches the Markdown (run `npm run build`)', () => {
  const before = Object.fromEntries(generated.map((f) => [f, fs.readFileSync(path.join(docsDir, f), 'utf8')]));
  execFileSync(process.execPath, ['scripts/build-docs.js'], { cwd: config.root, stdio: 'pipe' });
  for (const f of generated) {
    const after = fs.readFileSync(path.join(docsDir, f), 'utf8');
    assert.equal(after, before[f], `docs/${f} is out of date with its Markdown source. Run: npm run build`);
  }
});

test('each page is a complete document that loads the shared stylesheet', () => {
  assert.ok(fs.existsSync(path.join(docsDir, 'docs.css')));
  for (const f of generated) {
    const html = fs.readFileSync(path.join(docsDir, f), 'utf8');
    assert.match(html, /^<!doctype html>/i, `${f} has no doctype`);
    assert.match(html, /<link rel="stylesheet" href="docs\.css">/, `${f} does not load docs.css`);
    assert.match(html, /<title>[^<]+· Service Request GIS<\/title>/, `${f} has no page title`);
    assert.match(html, /<h1>/, `${f} has no h1`);
    assert.ok(!html.includes('</html>\n</html>'), `${f} looks doubled up`);
  }
});

test('Markdown tables become real tables, not escaped pipes', () => {
  const html = fs.readFileSync(path.join(docsDir, 'data-model.html'), 'utf8');
  assert.match(html, /<thead><tr><th>Field<\/th>/);
  assert.ok(!/^\s*\|/m.test(html.replace(/<pre>[\s\S]*?<\/pre>/g, '')), 'a table row survived as literal pipes');
  // The field table should have one row per field in the schema.
  const rows = [...html.matchAll(/<tbody>([\s\S]*?)<\/tbody>/g)][0][1];
  assert.ok((rows.match(/<tr>/g) ?? []).length >= 10);
});

test('inline code, bold and links survive, and .md links are rewritten to .html', () => {
  const html = fs.readFileSync(path.join(docsDir, 'query-catalog.html'), 'utf8');
  assert.match(html, /<code>RestParams<\/code>/);
  assert.match(html, /<strong>/);
  assert.ok(!html.includes('.md"'), 'a link still points at a .md file');
  assert.ok(!html.includes('`'), 'an unconverted backtick is left in the output');
});

test('a loosely written ordered list stays one list', () => {
  const html = fs.readFileSync(path.join(docsDir, 'query-catalog.html'), 'utf8');
  // The three limits are written with blank lines between them; they must not
  // render as three separate lists each restarting at 1.
  const lists = [...html.matchAll(/<ol>([\s\S]*?)<\/ol>/g)].map((m) => (m[1].match(/<li>/g) ?? []).length);
  assert.ok(lists.includes(3), `expected a 3-item ordered list, got lists of ${lists.join(', ')}`);
});

test('no HTML injection from the Markdown', () => {
  for (const f of generated) {
    const html = fs.readFileSync(path.join(docsDir, f), 'utf8');
    const body = html.slice(html.indexOf('<article>'));
    assert.ok(!/<script/i.test(body), `${f} contains a script tag in its body`);
  }
});
