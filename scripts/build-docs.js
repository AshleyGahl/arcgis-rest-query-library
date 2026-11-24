/**
 * Renders docs/*.md into docs/*.html so the documentation is readable on the
 * published site and not just on GitHub.
 *
 * The Markdown files stay the single source of truth: this script is run by
 * `npm run build` (Ctrl+Shift+B) and `test/docs.test.js` fails if the committed
 * HTML no longer matches the Markdown, which is what stops the two drifting.
 *
 * The converter handles only what these docs actually use — headings, tables,
 * fenced code, bullet and numbered lists, blockquotes, and inline code, bold,
 * italic and links. That is deliberate: this repository has no dependencies, and
 * a general Markdown implementation is not the point. If a doc needs something
 * richer, add it here rather than reaching for a package.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const docsDir = path.join(root, 'docs');

/** Order on the nav bar and the docs index. `blurb` is shown on the index only. */
const PAGES = [
  { file: 'data-model.md', nav: 'Data model', blurb: 'The fields, the categories and sub-categories, how the generated data behaves, and the defects planted for the data-quality queries.' },
  { file: 'framework.md', nav: 'Analytics framework', blurb: 'How the 70 questions are organised: the 5W+H dimensions, the five analytical layers, the coverage checklist and what comes next.' },
  { file: 'query-catalog.md', nav: 'Query catalog', blurb: 'The architecture: the query library published as a FeatureServer table, why it stores parameters rather than statements, and the three places the pattern does not hold.' },
];

// ---------------------------------------------------------------- inline
const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Inline Markdown -> HTML. Code spans are pulled out first so their contents are
 * never treated as emphasis or links.
 */
function inline(src) {
  const spans = [];
  let s = src.replace(/`([^`]+)`/g, (_, code) => {
    spans.push(`<code>${escapeHtml(code)}</code>`);
    return `\u0000${spans.length - 1}\u0000`;
  });
  s = escapeHtml(s);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, href) => `<a href="${href.replace(/\.md(#|$)/, '.html$1')}">${text}</a>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[\s(])\*([^*]+)\*(?=[\s).,;:]|$)/g, '$1<em>$2</em>');
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => spans[Number(i)]);
  return s;
}

const slug = (text) =>
  text.toLowerCase().replace(/<[^>]+>/g, '').replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-');

// ---------------------------------------------------------------- blocks
/**
 * @returns `{ html, title, toc }` — toc is the list of h2 headings.
 */
function render(md) {
  const lines = md.split(/\r?\n/);
  const out = [];
  const toc = [];
  let title = null;
  let i = 0;

  const para = (buf) => { if (buf.length) out.push(`<p>${inline(buf.join(' '))}</p>`); };

  while (i < lines.length) {
    const line = lines[i];

    // fenced code
    if (/^```/.test(line)) {
      const lang = line.slice(3).trim();
      const body = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++]);
      i++;
      out.push(`<pre${lang ? ` data-lang="${lang}"` : ''}><code>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }

    // headings
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      const text = inline(h[2]);
      if (level === 1 && !title) { title = h[2].replace(/[*`]/g, ''); out.push(`<h1>${text}</h1>`); }
      else {
        const id = slug(h[2]);
        if (level === 2) toc.push({ id, text });
        out.push(`<h${level} id="${id}">${text}</h${level}>`);
      }
      i++;
      continue;
    }

    // table: a header row followed by a |---|---| separator
    if (/^\|/.test(line) && /^\|[\s:|-]+\|$/.test(lines[i + 1] ?? '')) {
      const cells = (row) => row.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
      const head = cells(line);
      const align = cells(lines[i + 1]).map((a) => (a.startsWith(':') && a.endsWith(':') ? ' class="c"' : a.endsWith(':') ? ' class="r"' : ''));
      i += 2;
      const body = [];
      while (i < lines.length && /^\|/.test(lines[i])) body.push(cells(lines[i++]));
      out.push([
        '<div class="table-wrap"><table>',
        `<thead><tr>${head.map((c, n) => `<th${align[n] ?? ''}>${inline(c)}</th>`).join('')}</tr></thead>`,
        `<tbody>${body.map((r) => `<tr>${r.map((c, n) => `<td${align[n] ?? ''}>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody>`,
        '</table></div>',
      ].join(''));
      continue;
    }

    // lists — a item continues onto following indented lines
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    const number = /^(\d+)\.\s+(.*)$/.exec(line);
    if (bullet || number) {
      const ordered = Boolean(number);
      const marker = (n) => (ordered ? /^(\d+)\.\s+(.*)$/.exec(lines[n] ?? '') : /^[-*]\s+(.*)$/.exec(lines[n] ?? ''));
      const items = [];
      while (i < lines.length) {
        const m = marker(i);
        if (m) items.push([ordered ? m[2] : m[1]]);
        else if (/^\s+\S/.test(lines[i]) && items.length) items[items.length - 1].push(lines[i].trim());
        // A blank line between items is still one list: look past it for the next
        // marker, so a loosely written ordered list does not restart at 1.
        else if (!lines[i].trim() && marker(i + 1)) { /* skip */ }
        else break;
        i++;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.map((p) => `<li>${inline(p.join(' '))}</li>`).join('')}</${tag}>`);
      continue;
    }

    // blockquote
    if (/^>\s?/.test(line)) {
      const body = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) body.push(lines[i++].replace(/^>\s?/, ''));
      out.push(`<blockquote>${inline(body.join(' '))}</blockquote>`);
      continue;
    }

    if (!line.trim()) { i++; continue; }

    // paragraph: consume until a blank line or the start of another block
    const buf = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|[-*]\s|\d+\.\s|>|```|\|)/.test(lines[i])) buf.push(lines[i++].trim());
    if (buf.length) para(buf);
    else i++;
  }

  return { html: out.join('\n'), title: title ?? 'Documentation', toc };
}

// ---------------------------------------------------------------- page shell
const navFor = (current) =>
  [
    `<a href="../index.html">Overview</a>`,
    `<a href="index.html"${current === 'index' ? ' aria-current="page"' : ''}>Docs</a>`,
    ...PAGES.map((p) => {
      const href = p.file.replace(/\.md$/, '.html');
      return `<a href="${href}"${current === href ? ' aria-current="page"' : ''}>${p.nav}</a>`;
    }),
    `<a href="../viewer/">Viewer</a>`,
  ].join('\n      ');

function page({ title, description, body, toc = [], current }) {
  const tocHtml = toc.length
    ? `<nav class="toc" aria-label="On this page"><h2>On this page</h2><ol>${toc.map((t) => `<li><a href="#${t.id}">${t.text}</a></li>`).join('')}</ol></nav>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · Service Request GIS</title>
<meta name="description" content="${escapeHtml(description)}">
<link rel="icon" href="data:,">
<link rel="stylesheet" href="docs.css">
</head>
<body>
<header class="site">
  <a class="brand" href="../index.html">Service Request GIS</a>
  <nav aria-label="Documentation">
      ${navFor(current)}
  </nav>
</header>
<main>
${tocHtml}
<article>
${body}
</article>
</main>
<footer>
  <p>Synthetic data, a mock service, and a proof of concept &mdash; not a deployable product.
  Generated from the Markdown in <code>docs/</code> by <code>npm run build</code>.</p>
</footer>
</body>
</html>
`;
}

// ---------------------------------------------------------------- write
const written = [];

for (const p of PAGES) {
  const md = fs.readFileSync(path.join(docsDir, p.file), 'utf8');
  const { html, title, toc } = render(md);
  const outName = p.file.replace(/\.md$/, '.html');
  fs.writeFileSync(path.join(docsDir, outName), page({ title, description: p.blurb, body: html, toc, current: outName }));
  written.push(outName);
}

// The docs index.
const cards = PAGES.map((p) => {
  const href = p.file.replace(/\.md$/, '.html');
  return `<li><a href="${href}"><strong>${p.nav}</strong></a><p>${p.blurb}</p></li>`;
}).join('\n');

fs.writeFileSync(
  path.join(docsDir, 'index.html'),
  page({
    title: 'Documentation',
    description: 'Documentation for the Service Request GIS proof of concept: the data model, the analytics framework and the query-catalog architecture.',
    current: 'index',
    body: `<h1>Documentation</h1>
<p class="lede">Three documents, written as Markdown in <code>docs/</code> and rendered here. The
first describes the data, the second how the questions asked of it are organised, and the third the
architecture the proof of concept is actually testing.</p>
<ul class="cards">
${cards}
</ul>
<h2 id="elsewhere">Elsewhere in the repository</h2>
<div class="table-wrap"><table>
<thead><tr><th>Path</th><th></th></tr></thead>
<tbody>
<tr><td><code>sql-library/queryLibrary.js</code></td><td>The 70 entries themselves: REST parameters, client transform, T-SQL and portability tag.</td></tr>
<tr><td><code>rest/catalog.http</code></td><td>The discover-then-execute flow as runnable requests.</td></tr>
<tr><td><code>rest/library.http</code></td><td>All 70 library requests, generated.</td></tr>
<tr><td><code>sql/</code></td><td>SQL Server scripts that load the same GeoJSON, so the T-SQL can be run where it was written for.</td></tr>
<tr><td><code>CLAUDE.md</code></td><td>Conventions and layout, for working on the repository.</td></tr>
</tbody>
</table></div>`,
  }),
);
written.push('index.html');

console.log(`Wrote ${written.map((w) => path.join('docs', w)).join(', ')}`);
