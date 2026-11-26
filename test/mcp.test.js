/**
 * The MCP tool contract (`mcp/tools.js`) and the stdio transport over it
 * (`mcp/server.js`).
 *
 * The same contract is driven in the browser — by the run panels' workflow trace
 * and by `viewer/js/mcp-contract.js` — so these tests also cover what the viewer
 * shows. The last test spawns the real server over a pipe, because that is the only
 * thing that proves Claude Code can still talk to it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createFeatureService } from '../server/nodeRuntime.js';
import { config } from '../server/config.js';
import { createTools, createDispatcher, MAX_ROWS, SERVER_INFO, libraryQueryPayload, tsqlPayload, toolContent } from '../mcp/tools.js';
import { queryLibrary, getQuery } from '../sql-library/queryLibrary.js';
import { runEntry, toQueryUrl, bindEntry, paramsOf } from '../sql-library/runner.js';

const svc = createFeatureService(config);
const layerUrl = `http://127.0.0.1:${config.port}/arcgis/rest/services/${config.serviceName}/FeatureServer/0`;
const service = {
  query: (params) => svc.query(params),
  sql: (statement) => svc.sql(statement),
  stats: () => ({ featureCount: svc.count, asOf: svc.metadata.asOf, clock: config.clock }),
};
const tools = createTools({ service, layerUrl });
const dispatch = createDispatcher({ tools });

const call = async (name, args = {}) => {
  const res = await dispatch({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  assert.ok(res.result, `tools/call ${name} returned no result: ${JSON.stringify(res)}`);
  return res.result;
};
/** The tool payload, parsed back out of the MCP text content block. */
const payload = async (name, args) => {
  const r = await call(name, args);
  assert.ok(!r.isError, `${name} failed: ${r.content[0].text}`);
  return JSON.parse(r.content[0].text);
};

// ------------------------------------------------------------------ protocol
test('initialize reports the protocol version, capabilities and server info', async () => {
  const res = await dispatch({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.equal(res.result.protocolVersion, '2025-06-18');
  assert.deepEqual(res.result.serverInfo, SERVER_INFO);
  assert.deepEqual(res.result.capabilities, { tools: { listChanged: false } });
  assert.match(res.result.instructions, /describe_layer first/);
});

test('tools/list advertises the five tools with schemas but no handlers', async () => {
  const { result } = await dispatch({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(result.tools.map((t) => t.name), ['describe_layer', 'query_layer', 'list_library', 'run_library_query', 'run_tsql']);
  for (const t of result.tools) {
    assert.equal(typeof t.description, 'string');
    assert.equal(t.inputSchema.type, 'object');
    assert.equal(t.handler, undefined, `${t.name} leaked its handler over the wire`);
  }
});

test('a notification gets no reply, and ping gets an empty one', async () => {
  assert.equal(await dispatch({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.deepEqual((await dispatch({ jsonrpc: '2.0', id: 3, method: 'ping' })).result, {});
});

test('an unknown method and an unknown tool both fail cleanly', async () => {
  const bad = await dispatch({ jsonrpc: '2.0', id: 4, method: 'resources/list' });
  assert.equal(bad.error.code, -32601);
  const noTool = await dispatch({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'drop_everything' } });
  assert.equal(noTool.error.code, -32602);
});

test('a tool error comes back as an isError result, not a transport error', async () => {
  const r = await call('run_tsql', { sql: 'SELECT * FROM NoSuchTable' });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /^Error: /);
});

// ------------------------------------------------------------------ the tools
test('describe_layer returns the schema and the value domains', async () => {
  const d = await payload('describe_layer');
  assert.equal(d.featureCount, svc.count);
  assert.equal(d.layerUrl, layerUrl);
  assert.deepEqual(d.fields.map((f) => f.name), ['ObjectID', 'RequestID', 'Category', 'CategorySub', 'Status', 'Channel', 'Suburb', 'Description', 'DtLogged', 'DtCompleted']);
  assert.equal(d.values.Status.reduce((a, r) => a + r.n, 0), svc.count);
  assert.deepEqual(d.values.Channel.map((r) => r.v).sort(), ['App', 'Email', 'In person', 'Online form', 'Phone']);
});

test('query_layer returns rows plus the equivalent GET URL', async () => {
  const q = await payload('query_layer', { where: "Status <> 'Closed'", outFields: 'RequestID,Category,DtLogged', resultRecordCount: 5 });
  assert.equal(q.rows.length, 5);
  assert.ok(q.url.startsWith(`${layerUrl}/query?`));
  // Dates are rendered for a reader, not left as epoch ms.
  assert.match(q.rows[0].DtLogged, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} SAST$/);
});

test('query_layer caps its rows so a tool reply cannot flood a context', async () => {
  const q = await payload('query_layer', { where: '1=1', outFields: 'RequestID' });
  assert.equal(q.rows.length, MAX_ROWS);
  assert.equal(q.truncated, true);
  assert.equal(q.rowCount, svc.count);
});

test('list_library lists everything, and filters', async () => {
  assert.equal((await payload('list_library')).length, queryLibrary.length);
  const std = await payload('list_library', { portability: 'standard' });
  assert.equal(std.length, 10);
  assert.ok(std.every((q) => q.portability === 'standard'));
  const found = await payload('list_library', { search: 'percentile' });
  assert.ok(found.length >= 1);
});

test('run_library_query runs an entry, and compare adds the T-SQL result', async () => {
  const plain = await payload('run_library_query', { id: 2 });
  assert.equal(plain.question, 'Count by Category');
  assert.equal(plain.result.rows.length, 13);
  assert.equal(plain.tsqlResult, undefined);

  const compared = await payload('run_library_query', { id: 2, compare: true });
  assert.match(compared.tsql, /^SELECT Category/);
  assert.deepEqual(
    compared.result.rows.map((r) => r.Count),
    compared.tsqlResult.rows.map((r) => r.Count),
  );
});

test('list_library publishes what may be varied, so the list is also the extension contract', async () => {
  const all = await payload('list_library', {});
  const declared = all.filter((q) => q.params);
  assert.deepEqual(declared.map((q) => q.id), queryLibrary.filter((q) => paramsOf(q).length).map((q) => q.id));
  assert.deepEqual(all.find((q) => q.id === 41).params, [{ name: 'top', type: 'int', min: 1, max: 25, default: 5 }]);
  assert.equal(all.find((q) => q.id === 2).params, undefined);
});

test('run_library_query varies a question within its declared bounds', async () => {
  const published = await payload('run_library_query', { id: 41 });
  assert.deepEqual(published.parameters, { top: 5 });
  assert.equal(published.result.rows.length, 5);

  const varied = await payload('run_library_query', { id: 41, params: { top: 12 } });
  assert.deepEqual(varied.parameters, { top: 12 });
  assert.equal(varied.result.rows.length, 12);
  assert.equal(varied.rest.resultRecordCount, 12, 'the payload reports the definition that ran');

  // compare runs the T-SQL side of the *bound* entry, not the published one.
  const both = await payload('run_library_query', { id: 41, params: { top: 3 }, compare: true });
  assert.match(both.tsql, /SELECT TOP 3 /);
  assert.deepEqual(both.result.rows.map((r) => r.Count), both.tsqlResult.rows.map((r) => r.Count));
});

test('run_library_query refuses a value the author did not ratify', async () => {
  for (const params of [{ top: 99 }, { top: 0 }, { top: 'lots' }, { nope: 1 }]) {
    const r = await call('run_library_query', { id: 41, params });
    assert.ok(r.isError, `${JSON.stringify(params)} was accepted`);
    assert.match(r.content[0].text, /Query 41 not run/);
    assert.match(r.content[0].text, /Declared: top \(int 1\.\.25, default 5\)/);
  }
  const none = await call('run_library_query', { id: 2, params: { top: 5 } });
  assert.ok(none.isError);
  assert.match(none.content[0].text, /declares no parameters/);
});

/**
 * The viewer runs library entries itself — its grid needs every row and raw epoch
 * dates — and then shows the JSON-RPC response an agent would have received, built
 * from that same result by `libraryQueryPayload` / `tsqlPayload`. Nothing in the page
 * dispatches any more, so these two tests are the only thing keeping the envelopes the
 * viewer renders identical to the ones the server actually sends. If a handler and its
 * builder drift apart, the viewer starts showing an envelope that does not exist.
 */
test('libraryQueryPayload is what run_library_query returns, so the viewer cannot drift', async () => {
  const local = async (params) => ({ url: toQueryUrl(layerUrl, params), json: await service.query(params) });
  // The panel binds every entry before running it, so the comparison binds too: for a
  // question with no parameters that is the entry itself, and for one with parameters it
  // is the variant actually on screen.
  for (const [id, params] of [[2, {}], [44, {}], [62, {}], [41, {}], [41, { top: 9 }], [65, { top: 2, days: 45 }]]) {
    const { entry, errors } = bindEntry(getQuery(id), params);
    assert.deepEqual(errors, [], `entry ${id}`);
    const runResult = await runEntry(entry, local);
    // Compared through the envelope, because that is what the viewer renders — and it
    // is `toolContent` that decides how a payload becomes text.
    assert.deepEqual(
      toolContent(libraryQueryPayload({ q: entry, runResult })),
      await call('run_library_query', { id, ...(Object.keys(params).length ? { params } : {}) }),
      `entry ${id} ${JSON.stringify(params)}`,
    );
  }
});

test('tsqlPayload is what run_tsql returns, so the Run SQL lane cannot drift', async () => {
  // Including an entry over the row cap, since clipping is the one thing that differs
  // between what the grid shows and what the agent receives.
  for (const statement of [
    'SELECT Category, COUNT(*) AS n FROM ServiceRequest GROUP BY Category',
    getQuery(11).tsql,
  ]) {
    const r = await service.sql(statement);
    assert.deepEqual(toolContent(tsqlPayload(r)), await call('run_tsql', { sql: statement }));
  }
});

test('the tools/call envelope is shaped in exactly one place', async () => {
  const r = await call('list_library', { portability: 'extension' });
  assert.deepEqual(r, toolContent(JSON.parse(r.content[0].text)));
});

test('run_library_query reports a bad id as a tool error', async () => {
  const r = await call('run_library_query', { id: 999 });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /No library query 999/);
});

test('run_tsql is read-only', async () => {
  const good = await payload('run_tsql', { sql: 'SELECT COUNT(*) AS n FROM ServiceRequest' });
  assert.equal(good.rows[0].n, svc.count);
  const write = await call('run_tsql', { sql: "UPDATE ServiceRequest SET Status = 'Closed'" });
  assert.equal(write.isError, true);
});

// ------------------------------------------------------------------ the real transport
test('the stdio server answers a real initialize / tools/list exchange', async () => {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(config.root, 'mcp', 'server.js')], { stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    const lines = [];
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) { lines.push(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
    });

    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'query_layer', arguments: { where: '1=1', returnCountOnly: true } } })}\n`);

    const deadline = Date.now() + 20000;
    while (lines.length < 3 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));

    const msgs = lines.map((l) => JSON.parse(l));
    assert.equal(msgs.length, 3, `expected 3 replies (the notification must not get one), got ${lines.length}`);
    assert.deepEqual(msgs[0].result.serverInfo, SERVER_INFO);
    assert.equal(msgs[1].result.tools.length, 5);
    assert.equal(JSON.parse(msgs[2].result.content[0].text).rows[0].count, svc.count);
    assert.deepEqual(msgs.map((m) => m.id), [1, 2, 3]);
  } finally {
    child.kill();
  }
});
