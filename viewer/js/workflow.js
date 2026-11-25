/**
 * The workflow trace behind a library question: what clicking **Run REST** actually
 * does, and the MCP tool call that wraps the very same requests.
 *
 * Two lanes, one execution. The spine is the real pipeline — the catalog row, each
 * `POST /0/query`, each client-side transform, the render — timed live as it happens.
 * The agent lane beside it is the `tools/call run_library_query` an AI client would
 * have sent for the same question, with the real JSON-RPC envelopes.
 *
 * It is one execution because the grid needs it to be: the Library panel runs the entry
 * itself so the results drawer keeps every row and raw epoch dates (date sorting, the
 * chart's time axis, CSV export). The agent lane's response is then built by
 * `libraryQueryPayload` — the tool's own code — over that same result, so it is the real
 * payload rather than a second implementation of it. The one thing it cannot show live
 * is the transform steps individually: they run inside `runEntry` after the last
 * response, so they share a single elapsed figure rather than invented per-step times.
 */
import { requestsOf, toRows } from '../../sql-library/runner.js';
import { libraryQueryPayload, comparable, dateColsOf, MAX_ROWS } from '../../mcp/tools.js';
import { toolCallRequest, toolCallResponse } from './mcp-service.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const ms = (n) => `${Math.round(n)}ms`;

/**
 * Build the step list for an entry before it runs, so the shape of the work is visible
 * while it is still pending.
 *
 * @returns steps, plus the index range of the REST steps the tool call spans.
 */
export function planSteps(q, catalogUrl) {
  const reqs = requestsOf(q);
  const transforms = q.transform ? [q.transform].flat() : [];
  const steps = [
    { key: 'catalog', label: 'catalog row', detail: catalogUrl ? 'FeatureServer/1 · read once at start-up' : 'FeatureServer/1', state: 'done', note: 'cached' },
    ...reqs.map((r, i) => ({
      key: `rest${i}`, kind: 'rest',
      label: 'POST /0/query', detail: reqs.length > 1 ? r.name : summarise(r.params), state: 'pending',
    })),
    ...transforms.map((t, i) => ({
      key: `tf${i}`, kind: 'transform',
      label: `transform · ${t.type}`, detail: 'client-side', state: 'pending',
    })),
    { key: 'render', kind: 'render', label: 'render', detail: '', state: 'pending' },
  ];
  // The REST steps start at 1, after the catalog row — that is where the fetcher wrapper
  // begins reporting, since `runEntry` calls it once per request in order.
  return { steps, restFrom: 1, restCount: reqs.length, transformCount: transforms.length };
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
 * A live workflow trace rendered into `host`.
 *
 * The caller drives it: `wrapFetcher` around the runner's fetcher reports each REST
 * request as it goes, then `finish` closes out the transform and render steps and
 * attaches the agent lane's envelopes.
 */
export function createTrace(host, q, catalogUrl) {
  const plan = planSteps(q, catalogUrl);
  const { steps } = plan;
  let rpc = null;          // { request, response } once known
  let agentNote = '';
  let at = plan.restFrom;  // index of the next REST step to report

  const render = () => {
    host.classList.remove('hidden');
    host.innerHTML = `
      <div class="wf">
        <div class="wf-head">Workflow</div>
        <div class="wf-head">Agent view</div>
        <div class="wf-steps">${steps.map(stepRow).join('')}
          ${plan.transformCount ? '<p class="wf-note">Transforms run inside the same pass as the last response, so they share the total rather than carry invented per-step times.</p>' : ''}
        </div>
        <div class="wf-agent">${agentLane()}</div>
      </div>`;
    const pre = host.querySelector('.wf-wire');
    if (pre && rpc) pre.textContent = `→ ${JSON.stringify(rpc.request)}\n\n← ${JSON.stringify(rpc.response, null, 1)}`;
  };

  const stepRow = (s) => `
    <div class="wf-step ${s.state}">
      <span class="wf-dot">${s.state === 'running' ? '<span class="spin"></span>' : ''}</span>
      <span class="wf-label">${esc(s.label)}</span>
      <span class="wf-detail">${esc(s.detail)}</span>
      <span class="wf-time">${s.note ?? (s.elapsed != null ? ms(s.elapsed) : '')}</span>
    </div>`;

  const agentLane = () => `
      <div class="wf-agent-row">list_library</div>
      <div class="wf-agent-row call">tools/call <code>run_library_query</code>
        <span class="wf-args">{"id": ${q.id}}</span>
        <span class="wf-detail">wraps ${plan.restCount} request${plan.restCount === 1 ? '' : 's'}${plan.transformCount ? ' + the transform' : ''}</span>
      </div>
      ${rpc ? '<div class="wf-agent-row">response</div>' : ''}
      ${rpc ? '<details class="wf-rpc"><summary>JSON-RPC</summary><pre class="wf-wire code small"></pre></details>' : ''}
      ${agentNote ? `<p class="wf-note">${agentNote}</p>` : ''}`;

  render();

  return {
    /**
     * Wrap the runner's fetcher so each REST request marks its own step. `runEntry`
     * calls the fetcher once per request, in order, which is the whole seam needed —
     * `sql-library/runner.js` is untouched.
     */
    wrapFetcher(fetcher) {
      return async (params) => {
        const s = steps[at++];
        if (s) { s.state = 'running'; render(); }
        const t0 = performance.now();
        try {
          const out = await fetcher(params);
          if (s) {
            const n = toRows(out.json).length;
            s.state = 'done';
            s.elapsed = performance.now() - t0;
            s.detail = `${s.detail} → ${n} row${n === 1 ? '' : 's'}`;
            render();
          }
          return out;
        } catch (e) {
          if (s) { s.state = 'error'; s.detail = e.message; render(); }
          throw e;
        }
      };
    },

    /** Close out the transform and render steps, and attach the agent lane's envelopes. */
    finish({ runResult, elapsed }) {
      for (const s of steps) {
        if (s.kind === 'transform') { s.state = 'done'; s.note = 'in the run'; }
      }
      const last = steps[steps.length - 1];
      last.state = 'done';
      last.detail = `${runResult.rows.length} row${runResult.rows.length === 1 ? '' : 's'} · ${runResult.columns.length} columns`;
      last.elapsed = elapsed;

      const payload = libraryQueryPayload({ q, runResult });
      const request = toolCallRequest('run_library_query', { id: q.id });
      rpc = { request, response: toolCallResponse(request.id, payload) };
      // Only claim a difference where there is one: most entries aggregate, so they are
      // neither truncated nor date-bearing and the two sides are identical.
      const { truncated, rowCount } = payload.result;
      const hasDates = dateColsOf({ fields: runResult.requests.flatMap((x) => x.response.fields ?? []) }).length > 0;
      const diffs = [
        truncated ? `${MAX_ROWS} of ${rowCount} rows` : null,
        hasDates ? 'dates as SAST text' : null,
      ].filter(Boolean);
      const keeps = [
        truncated ? 'every row' : null,
        hasDates ? 'raw epoch dates, which sorting, the chart and CSV need' : null,
      ].filter(Boolean);
      agentNote = diffs.length
        ? `The agent receives ${diffs.join(' and ')}; the grid below keeps ${keeps.join(' and ')}.`
        : `Identical to the grid below — ${rowCount} row${rowCount === 1 ? '' : 's'}, under the ${MAX_ROWS}-row cap, no date columns to reformat.`;
      if (comparable(q)) agentNote += ' Add <code>compare: true</code> for the T-SQL side.';
      render();
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
