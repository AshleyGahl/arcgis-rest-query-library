#!/usr/bin/env node
/**
 * MCP server (stdio) exposing the mock FeatureServer to Claude Code.
 * Zero dependencies: newline-delimited JSON-RPC 2.0 over stdin/stdout.
 * Registered in .mcp.json as "servicerequests".
 *
 * This file is only the transport and the Node wiring. The tools themselves and
 * the JSON-RPC dispatch live in `mcp/tools.js`, which takes no platform
 * dependency, so the viewer's MCP tab drives exactly the same contract in the
 * browser (see `viewer/js/mcp-panel.js`).
 *
 * Tools: describe_layer, query_layer, list_library, run_library_query, run_tsql
 */
import readline from 'node:readline';
import { createFeatureService } from '../server/nodeRuntime.js';
import { config } from '../server/config.js';
import { createTools, createDispatcher } from './tools.js';

const svc = createFeatureService(config);
const layerUrl = `http://127.0.0.1:${config.port}/arcgis/rest/services/${config.serviceName}/FeatureServer/0`;

/** The in-process service adapter: the engine is right here, so nothing is awaited. */
const service = {
  query: (params) => svc.query(params),
  sql: (statement) => svc.sql(statement),
  stats: () => ({ featureCount: svc.count, asOf: svc.metadata.asOf, clock: config.clock }),
};

const dispatch = createDispatcher({ tools: createTools({ service, layerUrl }) });

const log = (...a) => process.stderr.write(a.join(' ') + '\n');
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  try {
    const response = await dispatch(msg);
    if (response) send(response);
  } catch (e) {
    log('mcp error', e.stack);
    if (msg.id !== undefined && msg.id !== null) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: e.message } });
  }
});

log(`servicerequests MCP ready (${svc.count} features)`);
