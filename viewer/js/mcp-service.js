/**
 * The MCP tool surface, wired up for the page.
 *
 * This is not a description of `mcp/server.js` — it builds the tools from the same
 * `mcp/tools.js` and the same JSON-RPC dispatcher the stdio server uses, so what the
 * page calls here is literally the contract Claude Code sees. The only difference is
 * the transport: stdin/stdout there, a function call here.
 *
 * There is no language model involved and no API key. Two things import this: the
 * Library panel's workflow lane (the tool call behind a question you ran) and
 * `mcp-contract.js` (the tool list and free-form `tools/call`). One dispatcher serves
 * both, which is the point.
 */
import { CONFIG } from './config.js';
import { createTools, createDispatcher, toolContent } from '../../mcp/tools.js';

const post = async (path, body) => {
  const res = await fetch(`${CONFIG.layerUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  return res.json();
};

/**
 * The service adapter `mcp/tools.js` expects, backed by REST rather than by an
 * in-process engine. Every call is a real request to the FeatureServer — answered by
 * the Node server, or by the service worker in the static demo.
 *
 * `sql` deliberately does not reuse `rest.js`'s `tsql()`: that one throws, while the
 * adapter contract is to return `{ error }`.
 */
export const service = {
  query: (params) => {
    const flat = { f: 'json' };
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      flat[k] = typeof v === 'object' ? JSON.stringify(v) : String(v);
    }
    return post('/query', flat);
  },
  sql: (statement) => post('/sql', { q: statement, f: 'json' }),
  stats: async () => {
    const [count, info] = await Promise.all([
      post('/query', { f: 'json', where: '1=1', returnCountOnly: 'true' }),
      fetch(`${CONFIG.layerUrl}?f=json`).then((r) => r.json()),
    ]);
    return {
      featureCount: count.count,
      asOf: info.editingInfo?.lastEditDate ? new Date(info.editingInfo.lastEditDate).toISOString() : undefined,
      clock: 'reported by the service',
    };
  },
};

export const tools = createTools({ service, layerUrl: CONFIG.layerUrl });
export const dispatch = createDispatcher({ tools });

/** One monotonic JSON-RPC id sequence for the whole page, as a single client would have. */
let nextId = 1;
export const nextRpcId = () => nextId++;

/** The `tools/call` request envelope for a tool, exactly as it would cross a transport. */
export const toolCallRequest = (name, args) => ({
  jsonrpc: '2.0',
  id: nextRpcId(),
  method: 'tools/call',
  params: { name, arguments: args },
});

/**
 * The response envelope a successful `tools/call` produces, around a payload the caller
 * already holds. `toolContent` is the dispatcher's own wrapper, so this is the same
 * envelope the stdio server would have written — not a lookalike.
 */
export const toolCallResponse = (id, payload) => ({ jsonrpc: '2.0', id, result: toolContent(payload) });
