/**
 * The Query Library panel.
 *
 * The questions are not imported: they are read from table 1 of the FeatureServer
 * at start-up (see catalog.js). This panel therefore knows how to *run* a
 * catalogued query, but nothing about which queries exist — that is the service's
 * business. Everything below works off the catalog rows alone.
 */
import { runEntry, httpFetcher, requestsOf, toQueryUrl } from '../../sql-library/runner.js';
import { layerUrl, dateColumnsOf, tsql } from './rest.js';
import { showResults, showError, showCompare } from './results.js';
import { fetchCatalog } from './catalog.js';
import { createTrace } from './workflow.js';
import { initMcpContract } from './mcp-contract.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const fetcher = httpFetcher(layerUrl);

// Filled in by initLibraryPanel() from the catalog request.
let entries = [];
let categories = [];

function renderList(onSelect, activeId) {
  const term = $('libSearch').value.trim().toLowerCase();
  const port = $('libPortability').value;
  const list = $('libList');
  list.replaceChildren();
  for (const cat of categories) {
    const items = entries.filter((q) => q.category === cat && (!port || q.portability === port) &&
      (!term || `${q.id} ${q.question} ${q.tsql}`.toLowerCase().includes(term)));
    if (!items.length) continue;
    list.insertAdjacentHTML('beforeend', `<div class="lib-group">${esc(cat)}</div>`);
    for (const q of items) {
      const el = document.createElement('div');
      el.className = `lib-item${q.id === activeId ? ' active' : ''}`;
      el.innerHTML = `<span class="id">${q.id}</span><span class="q">${esc(q.question)}</span><span class="badge ${q.portability}">${q.portability}</span>`;
      el.onclick = () => onSelect(q);
      list.appendChild(el);
    }
  }
}

function renderDetail(q) {
  const reqs = requestsOf(q);
  const transform = q.transform ? [q.transform].flat().map((t) => t.type).join(' → ') : null;
  $('libDetail').classList.remove('hidden');
  $('libDetail').innerHTML = `
    <h4>Q${q.id}. ${esc(q.question)}</h4>
    <div class="meta">
      <span class="badge ${q.portability}">${q.portability}</span>
      <span class="badge plain">${q.dimension}</span>
      <span class="badge plain">${q.layer}</span>
      ${transform ? `<span class="badge plain">client: ${esc(transform)}</span>` : ''}
    </div>
    ${q.notes ? `<div class="note">${esc(q.notes)}</div>` : ''}
    <div class="buttons">
      <button class="primary" id="libRun">Run REST</button>
      <button id="libRunSql">Run T-SQL</button>
      <button id="libCompare">Compare</button>
      ${!Array.isArray(q.rest) && q.rest.where && q.rest.where !== '1=1' ? '<button id="libApply">Apply where to map</button>' : ''}
    </div>
    <div id="libWorkflow" class="hidden"></div>
    ${reqs.map((r) => `
      <details open><summary>REST request${reqs.length > 1 ? ` · ${esc(r.name)}` : ''} · <a href="${esc(toQueryUrl(layerUrl, { ...r.params, f: 'pjson' }))}" target="_blank">open ↗</a></summary>
      <pre class="code">${esc(JSON.stringify(r.params, null, 2))}</pre></details>`).join('')}
    <label>T-SQL <textarea id="libSql" rows="8" spellcheck="false">${esc(q.tsql)}</textarea></label>
    <p class="hint">The entry's original statement, editable. <strong>Run T-SQL</strong> sends whatever is in the
    box to <code>…/FeatureServer/0/sql</code> — a read-only mock extension, not part of ArcGIS REST.
    <strong>Compare</strong> ignores your edits and always runs the catalogued statement, so it stays a parity
    check. Re-select the question to get the original back.</p>
    <pre id="libSqlTranslated" class="code small hidden"></pre>`;
}

export async function initLibraryPanel(map, filters) {
  let active = null;
  // Bumped on every run and re-selection, so a slow run cannot draw over a newer one.
  let seq = 0;
  const select = (q) => { active = q; seq++; renderList(select, q.id); renderDetail(q); wire(q); };

  async function run(q) {
    const my = ++seq;
    const trace = createTrace($('libWorkflow'), q, $('libList').dataset.catalogUrl);
    $('libRun').disabled = true;
    const t0 = performance.now();
    try {
      const r = await runEntry(q, trace.wrapFetcher(fetcher));
      if (my !== seq) return null;
      trace.finish({ runResult: r, elapsed: performance.now() - t0 });
      const dateColumns = r.requests.flatMap((x) => dateColumnsOf(x.response));
      showResults({
        title: `Q${q.id}. ${q.question}`,
        meta: q.transform ? 'with client-side transform' : '',
        urls: r.requests.map((x) => x.url),
        rows: r.rows, columns: r.columns, dateColumns,
        onRowClick: (row) => map.highlightIds([row.ObjectID]),
      });
      const ids = r.rows.map((x) => x.ObjectID).filter((x) => x != null);
      if (ids.length && r.columns.includes('ObjectID')) map.highlightIds(ids);
      return { r, dateColumns };
    } catch (e) {
      if (my === seq) trace.fail(e.message);
      showError(`Q${q.id} failed`, e);
      return null;
    } finally {
      if (my === seq && $('libRun')) $('libRun').disabled = false;
    }
  }

  // The box starts as the entry's statement but is free-form: this is also the SQL console.
  async function runSql(q) {
    try {
      const r = await tsql($('libSql').value);
      $('libSqlTranslated').textContent = `SQLite: ${r.sqlite}`;
      $('libSqlTranslated').classList.remove('hidden');
      showResults({ title: `Q${q.id} · T-SQL`, rows: r.rows, columns: r.columns });
    } catch (e) {
      $('libSqlTranslated').textContent = '';
      $('libSqlTranslated').classList.add('hidden');
      showError(`Q${q.id} T-SQL failed`, e);
    }
  }

  async function compare(q) {
    const left = { label: 'REST (+ client transform)', rows: [], columns: [] };
    const right = { label: 'Original T-SQL (mock /sql)', rows: [], columns: [] };
    try {
      const r = await runEntry(q, fetcher);
      Object.assign(left, { rows: r.rows, columns: r.columns, dateColumns: r.requests.flatMap((x) => dateColumnsOf(x.response)) });
    } catch (e) { left.error = e.message; }
    try {
      const t = await tsql(q.tsql);
      Object.assign(right, { rows: t.rows, columns: t.columns });
    } catch (e) { right.error = e.message; }
    showCompare({ title: `Q${q.id}. ${q.question}`, left, right });
  }

  function wire(q) {
    $('libRun').onclick = () => run(q);
    $('libRunSql').onclick = () => runSql(q);
    $('libCompare').onclick = () => compare(q);
    if ($('libApply')) $('libApply').onclick = () => { map.setDefinitionExpression(q.rest.where); filters.setWhere(q.rest.where); };
  }

  $('libSearch').oninput = () => renderList(select, active?.id);
  $('libPortability').onchange = () => renderList(select, active?.id);

  // The rest of the MCP surface, below the questions: every tool, its schema and a
  // free-form tools/call. It needs no catalog, so it is mounted before the fetch.
  initMcpContract();

  // One REST request discovers every question the service can answer.
  try {
    const catalog = await fetchCatalog();
    entries = catalog.entries;
    categories = catalog.categories;
    $('libSearch').placeholder = `Search ${entries.length} queries…`;
    $('libList').dataset.catalogUrl = catalog.url;
    renderList(select);
  } catch (e) {
    $('libList').innerHTML = `<div class="lib-group">Query catalog unavailable</div><div class="note" style="padding:8px 10px">${esc(e.message)}</div>`;
    showError('Could not read the query catalog (FeatureServer table 1)', e);
  }
}
