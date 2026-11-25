/**
 * The MCP tool contract, explorable inside the Library panel.
 *
 * The Library panel's workflow lane shows the one tool call behind a question you just
 * ran. This is the rest of the surface: every tool, its `inputSchema`, a free-form
 * `tools/call`, and the `initialize` handshake — the parts of MCP a client normally
 * hides. It drives the shared dispatcher in `mcp-service.js`, which is built from the
 * same `mcp/tools.js` the stdio server uses, so what you call here is literally the
 * contract Claude Code sees. The only difference is the transport: stdin/stdout there,
 * a function call here.
 *
 * No language model and no API key. It therefore costs nothing to run and works on the
 * static demo, where the service it queries is the engine in this same page.
 */
import { tools, dispatch, nextRpcId, toolCallRequest } from './mcp-service.js';
import { showResults, showError } from './results.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** Arguments worth starting from, per tool. */
const EXAMPLES = {
  describe_layer: {},
  query_layer: {
    where: "Status <> 'Closed'",
    groupByFieldsForStatistics: 'Category',
    outStatistics: [{ statisticType: 'count', onStatisticField: 'ObjectID', outStatisticFieldName: 'Open' }],
    orderByFields: 'Open DESC',
  },
  list_library: { portability: 'standard' },
  run_library_query: { id: 22, compare: true },
  run_tsql: { sql: 'SELECT TOP 10 Suburb, COUNT(*) AS n FROM ServiceRequest GROUP BY Suburb ORDER BY n DESC' },
};

let active = null;

/** Pull something table-shaped out of a tool payload, if there is one. */
function rowsOf(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.rows)) return payload.rows;
  if (Array.isArray(payload?.result?.rows)) return payload.result.rows;
  return null;
}

function renderToolList() {
  const list = $('mcpList');
  list.replaceChildren();
  list.insertAdjacentHTML('beforeend', `<div class="lib-group">tools/list · ${tools.length} tools</div>`);
  for (const t of tools) {
    const el = document.createElement('div');
    el.className = `lib-item${t.name === active ? ' active' : ''}`;
    const args = Object.keys(t.inputSchema.properties ?? {}).length;
    el.innerHTML = `<span class="q"><code>${esc(t.name)}</code></span><span class="badge plain">${args} arg${args === 1 ? '' : 's'}</span>`;
    el.onclick = () => select(t.name);
    list.appendChild(el);
  }
}

function select(name) {
  active = name;
  const tool = tools.find((t) => t.name === name);
  renderToolList();
  $('mcpDetail').classList.remove('hidden');
  $('mcpDetail').innerHTML = `
    <h4><code>${esc(tool.name)}</code></h4>
    <div class="note">${esc(tool.description)}</div>
    <label>Arguments (JSON)
      <textarea id="mcpArgs" rows="7" spellcheck="false">${esc(JSON.stringify(EXAMPLES[name] ?? {}, null, 2))}</textarea>
    </label>
    <div class="buttons">
      <button class="primary" id="mcpCall">Send tools/call</button>
      <button id="mcpSchema">Show inputSchema</button>
    </div>`;
  $('mcpCall').onclick = () => callTool(tool);
  $('mcpSchema').onclick = () => {
    $('mcpWire').textContent = JSON.stringify(tool.inputSchema, null, 2);
    $('mcpWireLabel').textContent = `inputSchema · ${tool.name}`;
  };
}

/** Show a request/response pair exactly as it would cross a transport. */
function showWire(label, request, response) {
  $('mcpWireLabel').textContent = label;
  $('mcpWire').textContent = `→ ${JSON.stringify(request)}\n\n← ${JSON.stringify(response, null, 2)}`;
}

async function listTools() {
  const request = { jsonrpc: '2.0', id: nextRpcId(), method: 'tools/list' };
  const response = await dispatch(request);
  showWire('tools/list', request, response);
  showResults({
    title: 'MCP tools/list',
    meta: 'the tool catalog, as an MCP client receives it',
    rows: response.result.tools.map((t) => ({
      name: t.name,
      args: Object.keys(t.inputSchema.properties ?? {}).join(', ') || '—',
      description: t.description,
    })),
    columns: ['name', 'args', 'description'],
  });
}

async function initialize() {
  const request = { jsonrpc: '2.0', id: nextRpcId(), method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'service-request-gis-viewer', version: '1.0.0' } } };
  showWire('initialize · the handshake every MCP client makes first', request, await dispatch(request));
}

async function callTool(tool) {
  let args;
  try {
    args = JSON.parse($('mcpArgs').value || '{}');
  } catch (e) {
    showError(`${tool.name}: the arguments are not valid JSON`, e);
    return;
  }

  const request = toolCallRequest(tool.name, args);
  $('mcpCall').disabled = true;
  try {
    const response = await dispatch(request);
    showWire(`tools/call · ${tool.name}`, request, response);

    if (response.error) {
      showError(`${tool.name} — JSON-RPC ${response.error.code}`, new Error(response.error.message));
      return;
    }
    const text = response.result.content[0].text;
    if (response.result.isError) {
      showError(`${tool.name} returned isError`, new Error(text));
      return;
    }

    const payload = JSON.parse(text);
    const rows = rowsOf(payload);
    if (rows?.length) {
      const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
      showResults({
        title: `MCP ${tool.name}`,
        meta: payload.truncated || payload.result?.truncated ? `truncated to 200 of ${payload.rowCount ?? payload.result?.rowCount} rows` : 'via tools/call',
        urls: payload.url ? [payload.url] : payload.urls,
        rows, columns,
      });
    } else {
      // Not tabular (describe_layer): the envelope pane is the result.
      showResults({
        title: `MCP ${tool.name}`,
        meta: 'not a table — see the JSON-RPC pane',
        rows: [{ keys: Object.keys(payload).join(', ') }],
        columns: ['keys'],
      });
    }
  } finally {
    $('mcpCall').disabled = false;
  }
}

export function initMcpContract() {
  $('mcpInit').onclick = initialize;
  $('mcpListBtn').onclick = listTools;
  renderToolList();
  select('query_layer');
}
