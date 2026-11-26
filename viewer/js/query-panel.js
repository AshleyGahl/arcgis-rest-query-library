/**
 * The Run REST and Run SQL panels — one implementation, two instances.
 *
 * Both list the same 70 questions, and the tab is the verb: pick a question under
 * Run REST and it goes to `…/FeatureServer/0/query`; pick it under Run SQL and its
 * statement goes to `…/FeatureServer/0/sql`. There is no Compare button, because with
 * each verb on its own tab a control that quietly does both is the odd one out.
 *
 * The questions are not imported: they are read from table 1 of the FeatureServer at
 * start-up (see `catalog.js`), once, into the shared store (`query-store.js`). This
 * panel therefore knows how to *run* a catalogued query but nothing about which queries
 * exist — that is the service's business.
 *
 * A question that declares bounded parameters (the catalog's ParamSpec column) gets an
 * input per parameter, built from the declaration — the panel has no idea that any
 * particular question takes a row count. Changing one re-binds the entry through
 * `bindEntry`, so what the panel shows is always the definition it would send. The
 * bounds are checked here because the inputs should refuse a value before a request is
 * made, not because checking here enforces anything: a client holds the definition and
 * can send what it likes. The service's `/1/execute` route is the enforcing counterpart,
 * and the link beside the inputs runs the same binding through it.
 */
import { runEntry, httpFetcher, requestsOf, toQueryUrl, bindEntry, paramsOf } from '../../sql-library/runner.js';
import { comparable } from '../../mcp/tools.js';
import { CONFIG } from './config.js';
import { layerUrl, dateColumnsOf, tsql } from './rest.js';
import { showResults, showError } from './results.js';
import { createTrace } from './workflow.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const fetcher = httpFetcher(layerUrl);

/**
 * @param prefix  element-id prefix for this instance's markup (`rest` or `sql`)
 * @param mode    'rest' | 'sql' — which verb this panel performs
 * @param store   the shared catalog + selection store
 */
export function createQueryPanel({ prefix, mode, map, filters, store }) {
  const id = (suffix) => `${prefix}${suffix}`;
  const el = (suffix) => $(id(suffix));
  const isRest = mode === 'rest';

  // Bumped on every run and re-selection, so a slow run cannot draw over a newer one.
  let seq = 0;

  // The parameter values currently in the inputs, cleared when the selection changes.
  let values = {};
  const executeUrl = (q, v) => `${CONFIG.catalogUrl}/execute?${new URLSearchParams({ q: q.id, ...v, f: 'pjson' })}`;

  function renderList() {
    const list = el('List');
    if (store.state.error) {
      list.innerHTML = `<div class="lib-group">Query catalog unavailable</div><div class="note" style="padding:8px 10px">${esc(store.state.error.message)}</div>`;
      return;
    }
    const items = store.matching();
    list.replaceChildren();
    for (const cat of store.state.categories) {
      const inCat = items.filter((q) => q.category === cat);
      if (!inCat.length) continue;
      list.insertAdjacentHTML('beforeend', `<div class="lib-group">${esc(cat)}</div>`);
      for (const q of inCat) {
        const row = document.createElement('div');
        row.className = `lib-item${q.id === store.state.activeId ? ' active' : ''}`;
        row.innerHTML = `<span class="id">${q.id}</span><span class="q">${esc(q.question)}</span><span class="badge ${q.portability}">${q.portability}</span>`;
        row.onclick = () => store.select(q.id);
        list.appendChild(row);
      }
    }
  }

  /**
   * The inputs for a question's declared parameters, or nothing at all. Built from the
   * declaration the catalog published, never from knowledge of the question.
   */
  function paramsBlock(q) {
    const spec = paramsOf(q);
    if (!spec.length) return '';
    const input = (p) => `<label>${esc(p.label ?? p.name)}
      <input type="number" data-param="${esc(p.name)}" value="${esc(values[p.name] ?? p.default)}" min="${p.min}" max="${p.max}" title="${esc(p.help ?? '')}">
    </label>`;
    return `<div class="params" id="${id('Params')}">
      <div class="param-inputs">${spec.map(input).join('')}
        <a href="${esc(executeUrl(q, values))}" target="_blank" data-execute>execute by id ↗</a>
      </div>
      <div class="note">${spec.length > 1 ? 'Parameters' : 'Parameter'} declared by the catalog:
        ${esc(spec.map((p) => `${p.name} ${p.min}–${p.max} (default ${p.default})`).join(', '))}.
        The default is the question as its author ratified it.</div>
      <div class="note param-errors" id="${id('ParamErr')}"></div>
    </div>`;
  }

  /**
   * Re-bind after a parameter changes: the request preview, the open link, the editable
   * statement and the Run button all follow the values in the inputs.
   */
  function syncParams(q) {
    const host = el('Params');
    if (!host) return;
    for (const input of host.querySelectorAll('input[data-param]')) values[input.dataset.param] = input.value;
    const { entry: bound, errors } = bindEntry(q, values);
    el('ParamErr').textContent = errors.join(' · ');
    const run = el('Run');
    if (run) run.disabled = errors.length > 0 || (!isRest && !comparable(q));
    host.querySelector('[data-execute]').href = executeUrl(q, values);
    if (isRest) {
      const blocks = [...el('Detail').querySelectorAll('[data-request]')];
      requestsOf(bound).forEach((r, i) => {
        if (!blocks[i]) return;
        blocks[i].querySelector('pre').textContent = JSON.stringify(r.params, null, 2);
        blocks[i].querySelector('a[data-open]').href = toQueryUrl(layerUrl, { ...r.params, f: 'pjson' });
      });
    } else if (el('Text')) {
      el('Text').value = bound.tsql;
    }
  }

  function renderDetail(q) {
    const detail = el('Detail');
    if (!q) { detail.classList.add('hidden'); detail.innerHTML = ''; return; }
    detail.classList.remove('hidden');
    const transform = q.transform ? [q.transform].flat().map((t) => t.type).join(' → ') : null;
    const head = `
      <h4>Q${q.id}. ${esc(q.question)}</h4>
      <div class="meta">
        <span class="badge ${q.portability}">${q.portability}</span>
        <span class="badge plain">${q.dimension}</span>
        <span class="badge plain">${q.layer}</span>
        ${transform ? `<span class="badge plain">client: ${esc(transform)}</span>` : ''}
      </div>
      ${q.notes ? `<div class="note">${esc(q.notes)}</div>` : ''}`;

    detail.innerHTML = isRest ? `${head}
      ${paramsBlock(q)}
      <div class="buttons">
        <button class="primary" id="${id('Run')}">Run REST</button>
        ${!Array.isArray(q.rest) && q.rest.where && q.rest.where !== '1=1' ? `<button id="${id('Apply')}">Apply where to map</button>` : ''}
      </div>
      <div id="${id('Workflow')}" class="hidden"></div>
      ${requestsOf(q).map((r, i, all) => `
        <details class="wf-sec" open data-request="${i}">
          <summary>
            <span class="wf-sec-title">REST request${all.length > 1 ? ` · ${esc(r.name)}` : ''}</span>
            <span class="wf-sec-sum"><a href="${esc(toQueryUrl(layerUrl, { ...r.params, f: 'pjson' }))}" target="_blank" data-open>open ↗</a></span>
          </summary>
          <div class="wf-sec-body"><pre class="code">${esc(JSON.stringify(r.params, null, 2))}</pre></div>
        </details>`).join('')}`
      : `${head}
      ${paramsBlock(q)}
      <div class="buttons">
        <button class="primary" id="${id('Run')}"${comparable(q) ? '' : ' disabled'}>Run SQL</button>
      </div>
      ${comparable(q) ? '' : `<div class="note">This entry's reference statement is not a query, and the engine is read-only, so there is nothing to run here. Its REST form still works under <strong>Run REST</strong>.</div>`}
      <div id="${id('Workflow')}" class="hidden"></div>
      <details class="wf-sec" open>
        <summary>
          <span class="wf-sec-title">T-SQL statement</span>
          <span class="wf-sec-sum">editable</span>
        </summary>
        <div class="wf-sec-body">
          <textarea id="${id('Text')}" rows="8" spellcheck="false">${esc(q.tsql)}</textarea>
          <p class="hint"><strong>Run SQL</strong> sends whatever is in the box to
          <code>…/FeatureServer/0/sql</code> — a read-only mock extension, not part of ArcGIS REST.
          Re-select the question to get the original statement back.</p>
        </div>
      </details>`;

    wire(q);
  }

  /** Run REST: the catalogued entry, through the trace's wrapped fetcher. */
  async function runRest(q) {
    const my = ++seq;
    const trace = createTrace(el('Workflow'), q, { mode });
    el('Run').disabled = true;
    const t0 = performance.now();
    try {
      const r = await runEntry(q, trace.wrapFetcher(fetcher));
      if (my !== seq) return;
      trace.finishRest({ runResult: r, elapsed: performance.now() - t0 });
      const dateColumns = r.requests.flatMap((x) => dateColumnsOf(x.response));
      showResults({
        title: `Q${q.id}. ${q.question}`,
        meta: q.transform ? 'with client-side transform' : '',
        urls: r.requests.map((x) => x.url),
        rows: r.rows, columns: r.columns, dateColumns, chart: q.chart ?? null,
        onRowClick: (row) => map.highlightIds([row.ObjectID]),
      });
      const ids = r.rows.map((x) => x.ObjectID).filter((x) => x != null);
      if (ids.length && r.columns.includes('ObjectID')) map.highlightIds(ids);
    } catch (e) {
      if (my === seq) trace.fail(e.message);
      showError(`Q${q.id} failed`, e);
    } finally {
      if (my === seq && el('Run')) el('Run').disabled = false;
    }
  }

  /** Run SQL: whatever is in the box, so this is the free-form SQL console too. */
  async function runSql(q) {
    const my = ++seq;
    const statement = el('Text').value;
    const trace = createTrace(el('Workflow'), q, { mode });
    el('Run').disabled = true;
    const t0 = performance.now();
    try {
      const r = await trace.runSql(statement, tsql);
      if (my !== seq) return;
      trace.finishSql({ result: r, statement, elapsed: performance.now() - t0 });
      showResults({ title: `Q${q.id} · T-SQL`, rows: r.rows, columns: r.columns });
    } catch (e) {
      showError(`Q${q.id} T-SQL failed`, e);
    } finally {
      if (my === seq && el('Run')) el('Run').disabled = false;
    }
  }

  function wire(q) {
    const host = el('Params');
    if (host) for (const input of host.querySelectorAll('input[data-param]')) input.oninput = () => syncParams(q);
    const run = el('Run');
    // Re-bound at click time, so a run always uses the values on screen.
    if (run) run.onclick = () => {
      const { entry: bound, errors } = bindEntry(q, values);
      if (errors.length) { el('ParamErr').textContent = errors.join(' · '); return; }
      return isRest ? runRest(bound) : runSql(bound);
    };
    const apply = el('Apply');
    if (apply) apply.onclick = () => {
      const { where } = bindEntry(q, values).entry.rest;
      map.setDefinitionExpression(where);
      filters.setWhere(where);
    };
  }

  // The filters write to the shared store, so typing in one tab filters the other too.
  el('Search').oninput = () => store.setFilters({ search: el('Search').value });
  el('Portability').onchange = () => store.setFilters({ portability: el('Portability').value });

  // Which question's detail is currently drawn. The detail is rebuilt only when the
  // selection actually changes — not on every keystroke in the search box, which would
  // otherwise reseed the editable statement and discard a run still in flight.
  let drawn;

  const refresh = () => {
    const { search, portability, entries, activeId } = store.state;
    if (el('Search').value !== search) el('Search').value = search;
    if (el('Portability').value !== portability) el('Portability').value = portability;
    el('Search').placeholder = entries.length ? `Search ${entries.length} queries…` : 'Search queries…';
    renderList();
    if (activeId !== drawn) {
      drawn = activeId;
      seq++;                     // a re-selection invalidates any run still in flight
      values = {};               // and starts the new question at its ratified defaults
      renderDetail(store.active);
    }
  };

  store.subscribe(refresh);
  refresh();
  return { refresh };
}
