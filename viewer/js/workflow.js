/**
 * The workflow trace behind a library question: what clicking the run button actually
 * did, and the MCP tool call that wraps the very same work.
 *
 * Two sections, one execution. **Workflow** is the real pipeline, timed live as it happens.
 * **Agent view** below it is the `tools/call` an AI client would have sent for the same
 * question, with the real JSON-RPC envelopes. Each is a collapsible `<details>`, stacked
 * above the request itself (which `query-panel.js` renders in the same shape), so the
 * three read top to bottom: what ran, what an agent would have sent, what was sent.
 *
 * One execution because the grid needs it to be: the panel runs the entry itself so the
 * results drawer keeps every row and raw epoch dates (date sorting, the chart's time
 * axis, CSV export). The agent lane's response is then built by the tools' own payload
 * builders over that same result, so it is the real payload rather than a second
 * implementation of it.
 *
 * Two modes, because each tab has its own verb and its own tool:
 *
 *   rest  catalog row -> one POST /0/query per request -> transforms -> render
 *         agent view: run_library_query
 *   sql   catalog row -> POST /0/sql -> the SQLite rewrite -> render
 *         agent view: run_tsql
 *
 * The one thing neither mode can show live is the transform steps individually: they run
 * inside `runEntry` after the last response, so they share a single elapsed figure rather
 * than invented per-step times.
 */
import { requestsOf, toRows } from '../../sql-library/runner.js';
import { libraryQueryPayload, tsqlPayload, comparable, dateColsOf, MAX_ROWS } from '../../mcp/tools.js';
import { toolCallRequest, toolCallResponse } from './mcp-envelope.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const ms = (n) => `${Math.round(n)}ms`;

const catalogStep = () => ({
  key: 'catalog', label: 'catalog row',
  detail: 'FeatureServer/1 · read once at start-up', state: 'done', note: 'cached',
});
const renderStep = () => ({ key: 'render', kind: 'render', label: 'render', detail: '', state: 'pending' });

/**
 * Build the step list before the work starts, so its shape is visible while still pending.
 * The run steps begin at index 1, after the catalog row — that is where the wrapper
 * starts reporting, since `runEntry` calls its fetcher once per request in order.
 */
export function planSteps(q, mode) {
  if (mode === 'sql') {
    return {
      steps: [
        catalogStep(),
        { key: 'sql', kind: 'run', label: 'POST /0/sql', detail: 'read-only mock extension', state: 'pending' },
        { key: 'rewrite', kind: 'rewrite', label: 'T-SQL → SQLite', detail: 'rewritten by the engine', state: 'pending' },
        renderStep(),
      ],
      runFrom: 1, runCount: 1, transformCount: 0,
    };
  }
  const reqs = requestsOf(q);
  const transforms = q.transform ? [q.transform].flat() : [];
  return {
    steps: [
      catalogStep(),
      ...reqs.map((r, i) => ({
        key: `rest${i}`, kind: 'run',
        label: 'POST /0/query', detail: reqs.length > 1 ? r.name : summarise(r.params), state: 'pending',
      })),
      ...transforms.map((t, i) => ({
        key: `tf${i}`, kind: 'transform',
        label: `transform · ${t.type}`, detail: 'client-side', state: 'pending',
      })),
      renderStep(),
    ],
    runFrom: 1, runCount: reqs.length, transformCount: transforms.length,
  };
}

/** A one-line gist of a request's parameters, for the step's detail column. */
function summarise(p) {
  const bits = [];
  if (p.where && p.where !== '1=1') bits.push(`where=${p.where}`);
  if (p.groupByFieldsForStatistics) bits.push(`groupBy=${p.groupByFieldsForStatistics}`);
  if (p.outStatistics) bits.push(`${[p.outStatistics].flat().length} statistic(s)`);
  if (p.returnCountOnly) bits.push('returnCountOnly');
  if (p.resultRecordCount) bits.push(`top ${p.resultRecordCount}`);
  return bits.join(' · ') || 'where=1=1';
}

/**
 * Only claim a difference where there is one, and name only the ones that apply.
 *
 * `datesApply` is false for `run_tsql`, which clips rows but never reformats dates — so
 * in SQL mode the note must not imply that date columns would have been rewritten.
 */
function noteFor({ truncated, rowCount, hasDates, datesApply = true }) {
  const diffs = [
    truncated ? `${MAX_ROWS} of ${rowCount} rows` : null,
    hasDates ? 'dates as SAST text' : null,
  ].filter(Boolean);
  const keeps = [
    truncated ? 'every row' : null,
    hasDates ? 'raw epoch dates, which sorting, the chart and CSV need' : null,
  ].filter(Boolean);
  if (diffs.length) return `The agent receives ${diffs.join(' and ')}; the grid below keeps ${keeps.join(' and ')}.`;
  const tail = datesApply ? ', no date columns to reformat' : '';
  return `Identical to the grid below — ${rowCount} row${rowCount === 1 ? '' : 's'}, under the ${MAX_ROWS}-row cap${tail}.`;
}

/**
 * A live workflow trace rendered into `host`.
 *
 * The caller drives it: `wrapFetcher` reports each request as it goes (REST mode), or
 * `step()` marks the single `/sql` request (SQL mode), then `finish` closes out the
 * remaining steps and attaches the agent view's envelopes.
 */
export function createTrace(host, q, { mode = 'rest' } = {}) {
  const plan = planSteps(q, mode);
  const { steps } = plan;
  let rpc = null;          // { request, response } once known
  let agentNote = '';
  let rewrite = null;      // the SQLite the engine actually ran, when it differs (sql mode)
  let at = plan.runFrom;   // index of the next run step to report

  const stepRow = (s) => `
    <div class="wf-step ${s.state}">
      <span class="wf-dot">${s.state === 'running' ? '<span class="spin"></span>' : ''}</span>
      <span class="wf-label">${esc(s.label)}</span>
      <span class="wf-detail">${esc(s.detail)}</span>
      <span class="wf-time">${s.note ?? (s.elapsed != null ? ms(s.elapsed) : '')}</span>
    </div>`;

  const tool = mode === 'sql' ? 'run_tsql' : 'run_library_query';

  const agentLane = () => {
    const args = mode === 'sql' ? '{"sql": "…"}' : `{"id": ${q.id}}`;
    const wraps = mode === 'sql'
      ? 'the same statement, the same engine'
      : `wraps ${plan.runCount} request${plan.runCount === 1 ? '' : 's'}${plan.transformCount ? ' + the transform' : ''}`;
    return `
      <div class="wf-agent-row">${mode === 'sql' ? 'describe_layer' : 'list_library'}</div>
      <div class="wf-agent-row call">tools/call <code>${tool}</code>
        <span class="wf-args">${esc(args)}</span>
        <span class="wf-detail">${esc(wraps)}</span>
      </div>
      ${rpc ? '<div class="wf-agent-row">response</div><pre class="wf-wire code small"></pre>' : ''}
      ${agentNote ? `<p class="wf-note">${agentNote}</p>` : ''}`;
  };

  // Which sections are expanded. Held here because `render()` runs again on every step,
  // and rebuilding the markup would otherwise throw away whatever the reader opened.
  const open = { workflow: true, agent: false };

  /** Collapsed sections still have to say something useful. */
  const workflowSummary = () => {
    if (steps.some((s) => s.state === 'error')) return 'failed';
    const running = steps.find((s) => s.state === 'running');
    if (running) return `${running.label}…`;
    const last = steps[steps.length - 1];
    const n = `${steps.length} steps`;
    return last.state === 'done' && last.elapsed != null ? `${n} · ${ms(last.elapsed)}` : n;
  };

  const agentSummary = () => {
    if (!rpc) return `tools/call ${tool}`;
    const payload = JSON.parse(rpc.response.result.content[0].text);
    const rows = payload.result?.rowCount ?? payload.rowCount;
    return `${tool} · ${rows} row${rows === 1 ? '' : 's'}`;
  };

  const section = (key, title, summary, body) => `
    <details class="wf-sec" data-sec="${key}"${open[key] ? ' open' : ''}>
      <summary><span class="wf-sec-title">${title}</span><span class="wf-sec-sum">${esc(summary)}</span></summary>
      <div class="wf-sec-body">${body}</div>
    </details>`;

  const render = () => {
    host.classList.remove('hidden');
    host.innerHTML = section('workflow', 'Workflow', workflowSummary(), `
        ${steps.map(stepRow).join('')}
        ${rewrite ? `<pre class="code small wf-rewrite">${esc(rewrite)}</pre>` : ''}
        ${plan.transformCount ? '<p class="wf-note">Transforms run inside the same pass as the last response, so they share the total rather than carry invented per-step times.</p>' : ''}`)
      + section('agent', 'Agent view', agentSummary(), agentLane());

    for (const el of host.querySelectorAll('.wf-sec')) {
      el.ontoggle = () => { open[el.dataset.sec] = el.open; };
    }
    const pre = host.querySelector('.wf-wire');
    if (pre && rpc) pre.textContent = `→ ${JSON.stringify(rpc.request)}\n\n← ${JSON.stringify(rpc.response, null, 1)}`;
  };

  render();

  /** Mark the next pending run step as running, and return it with a closer. */
  const beginStep = () => {
    const step = steps[at++];
    if (step) { step.state = 'running'; render(); }
    const t0 = performance.now();
    return {
      step,
      done(detail) {
        if (!step) return;
        step.state = 'done';
        step.elapsed = performance.now() - t0;
        if (detail) step.detail = detail;
        render();
      },
      failed(message) {
        if (!step) return;
        step.state = 'error';
        step.detail = message;
        render();
      },
    };
  };

  return {
    /**
     * REST mode: wrap the runner's fetcher so each request marks its own step. `runEntry`
     * calls the fetcher once per request, in order, which is the whole seam needed —
     * `sql-library/runner.js` is untouched.
     */
    wrapFetcher(fetcher) {
      return async (params) => {
        const pending = beginStep();
        const was = pending.step?.detail ?? '';
        try {
          const out = await fetcher(params);
          const n = toRows(out.json).length;
          pending.done(`${was} → ${n} row${n === 1 ? '' : 's'}`);
          return out;
        } catch (e) {
          pending.failed(e.message);
          throw e;
        }
      };
    },

    /** SQL mode: run the statement through `fn`, reporting the one `/sql` request. */
    async runSql(statement, fn) {
      const pending = beginStep();
      try {
        const r = await fn(statement);
        pending.done(`${r.rows.length} row${r.rows.length === 1 ? '' : 's'} returned`);
        const step = steps.find((s) => s.kind === 'rewrite');
        if (step) {
          step.state = 'done';
          step.note = '';
          // The statement itself goes below the steps, not in the step's one ellipsised
          // line — it is the thing worth reading, as the old SQLite line was.
          const changed = r.sqlite && r.sqlite.trim() !== statement.trim();
          step.detail = changed ? 'rewritten for SQLite' : 'no rewrite needed';
          rewrite = changed ? r.sqlite : null;
        }
        render();
        return r;
      } catch (e) {
        pending.failed(e.message);
        for (const s of steps) if (s.state === 'pending') s.state = 'skipped';
        render();
        throw e;
      }
    },

    /**
     * Close out the remaining steps and attach the agent view's envelopes.
     * `rows`/`columns` describe what the grid got; `payload` is the tool's own.
     */
    finish({ rows, columns, elapsed, payload, tool, args }) {
      for (const s of steps) {
        if (s.kind === 'transform') { s.state = 'done'; s.note = 'in the run'; }
      }
      const last = steps[steps.length - 1];
      last.state = 'done';
      last.detail = `${rows.length} row${rows.length === 1 ? '' : 's'} · ${columns.length} columns`;
      last.elapsed = elapsed;

      const request = toolCallRequest(tool, args);
      rpc = { request, response: toolCallResponse(request.id, payload) };
      render();
      return rpc;
    },

    /** REST mode convenience: build the payload and note from a `runEntry` result. */
    finishRest({ runResult, elapsed }) {
      const payload = libraryQueryPayload({ q, runResult });
      const hasDates = dateColsOf({ fields: runResult.requests.flatMap((x) => x.response.fields ?? []) }).length > 0;
      agentNote = noteFor({ ...payload.result, hasDates });
      if (comparable(q)) agentNote += ' Add <code>compare: true</code> for the T-SQL side.';
      this.finish({
        rows: runResult.rows, columns: runResult.columns, elapsed, payload,
        // The values ride on the bound entry, so the envelope shows the call that
        // reproduces this exact run rather than the unparameterised one.
        tool: 'run_library_query', args: { id: q.id, ...(q.paramValues ? { params: q.paramValues } : {}) },
      });
    },

    /** SQL mode convenience: `run_tsql` clips rows but never reformats dates. */
    finishSql({ result, statement, elapsed }) {
      const payload = tsqlPayload(result);
      agentNote = noteFor({
        truncated: payload.truncated, rowCount: payload.rowCount,
        hasDates: false, datesApply: false,
      });
      this.finish({
        rows: result.rows, columns: result.columns, elapsed, payload,
        tool: 'run_tsql', args: { sql: statement },
      });
    },

    /** Mark the trace failed at whichever step was in flight. */
    fail(message) {
      const s = steps.find((x) => x.state === 'running') ?? steps.find((x) => x.state === 'pending');
      if (s) { s.state = 'error'; s.detail = message; }
      for (const x of steps) if (x.state === 'pending') x.state = 'skipped';
      render();
    },
  };
}
