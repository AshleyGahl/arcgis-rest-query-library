#!/usr/bin/env node
/**
 * MCP server (stdio) exposing the mock FeatureServer to Claude Code.
 * Zero dependencies: newline-delimited JSON-RPC 2.0 over stdin/stdout.
 * Registered in .mcp.json as "servicerequests".
 *
 * Tools: describe_layer, query_layer, list_library, run_library_query, run_tsql
 */
import readline from 'node:readline';
import { createFeatureService } from '../server/nodeRuntime.js';
import { config } from '../server/config.js';
import { FIELDS } from '../server/schema.js';
import { queryLibrary, getQuery } from '../sql-library/queryLibrary.js';
import { runEntry, toQueryUrl, toRows } from '../sql-library/runner.js';

const svc = createFeatureService(config);
const LAYER = `http://127.0.0.1:${config.port}/arcgis/rest/services/${config.serviceName}/FeatureServer/0`;
const local = async (params) => ({ url: toQueryUrl(LAYER, params), json: svc.query(params) });
const MAX_ROWS = 200;
const log = (...a) => process.stderr.write(a.join(' ') + '\n');

const fmtDates = (rows, dateCols) => rows.map((r) => {
  const o = { ...r };
  for (const c of dateCols) if (typeof o[c] === 'number') o[c] = new Date(o[c] + 2 * 3600000).toISOString().slice(0, 19).replace('T', ' ') + ' SAST';
  return o;
});
const dateColsOf = (json) => (json.fields ?? []).filter((f) => f.type === 'esriFieldTypeDate').map((f) => f.name);
const clip = (rows) => ({ rowCount: rows.length, truncated: rows.length > MAX_ROWS, rows: rows.slice(0, MAX_ROWS) });

const TOOLS = [
  {
    name: 'describe_layer',
    description: 'Schema and value domains of the ServiceRequests mock FeatureServer layer (generic public service requests, Cape Town coordinates). Call this before writing where clauses.',
    inputSchema: { type: 'object', properties: {} },
    handler: () => {
      const distinct = (f) => svc.sql(`SELECT ${f} AS v, COUNT(*) AS n FROM ServiceRequests GROUP BY ${f} ORDER BY n DESC`).rows;
      return {
        layerUrl: LAYER,
        featureCount: svc.count,
        asOf: svc.metadata.asOf,
        clock: config.clock,
        spatialReference: 'layer 102100 (Web Mercator); pass outSR=4326 for lon/lat',
        dateHandling: 'Dates are epoch ms (UTC) in responses; where-clause date literals are SAST local time, e.g. DateLogged >= DATE \'2026-01-01\'',
        fields: FIELDS.map((f) => ({ name: f.name, type: f.type, alias: f.alias })),
        values: { Category: distinct('Category'), RequestType: distinct('RequestType'), Status: distinct('Status'), Channel: distinct('Channel') },
        dataModel: 'docs/data-model.md — generic council report-a-problem model; core facts are DateLogged, DateCompleted, Category',
        sql: 'where/groupBy/outStatistics accept ArcGIS standard SQL (EXTRACT, CAST, CASE, CURRENT_TIMESTAMP - INTERVAL \'7\' DAY) and T-SQL functions (DATEDIFF, DATEPART, DATEADD, FORMAT, LEN, GETDATE).',
      };
    },
  },
  {
    name: 'query_layer',
    description: 'Run an ArcGIS REST FeatureServer layer query (same parameters as /FeatureServer/0/query). Returns flattened rows (max 200) and the equivalent GET URL.',
    inputSchema: {
      type: 'object',
      properties: {
        where: { type: 'string', default: '1=1' },
        outFields: { type: 'string', description: 'Comma list or "*". Supports "expr AS Alias".' },
        orderByFields: { type: 'string' },
        groupByFieldsForStatistics: { type: 'string' },
        outStatistics: { type: 'array', items: { type: 'object' }, description: '[{statisticType, onStatisticField, outStatisticFieldName, statisticParameters?}]' },
        having: { type: 'string' },
        resultRecordCount: { type: 'integer' },
        resultOffset: { type: 'integer' },
        returnCountOnly: { type: 'boolean' },
        returnDistinctValues: { type: 'boolean' },
        returnGeometry: { type: 'boolean', default: false },
        outSR: { type: 'integer', default: 4326 },
        geometry: { type: 'string', description: 'Envelope "xmin,ymin,xmax,ymax", point "x,y", or Esri geometry JSON' },
        geometryType: { type: 'string' },
        inSR: { type: 'integer' },
        distance: { type: 'number' },
        units: { type: 'string' },
      },
    },
    handler: (args) => {
      const params = { returnGeometry: false, outSR: 4326, ...args };
      const json = svc.query(params);
      if (json.error) throw new Error(`${json.error.message} ${json.error.details?.join(' | ') ?? ''}`);
      return { url: toQueryUrl(LAYER, params), ...(json.exceededTransferLimit ? { exceededTransferLimit: true } : {}), ...clip(fmtDates(toRows(json), dateColsOf(json))) };
    },
  },
  {
    name: 'list_library',
    description: 'List the 70-query Service Request Query Library (id, category, portability, question). Optional filters.',
    inputSchema: { type: 'object', properties: { search: { type: 'string' }, portability: { type: 'string', enum: ['standard', 'sql-expression', 'native', 'extension'] }, category: { type: 'string' } } },
    handler: ({ search, portability, category } = {}) => queryLibrary
      .filter((q) => (!portability || q.portability === portability) && (!category || q.category.toLowerCase().includes(category.toLowerCase())) && (!search || `${q.question} ${q.tsql}`.toLowerCase().includes(search.toLowerCase())))
      .map(({ id, category: c, dimension, layer, portability: p, question }) => ({ id, category: c, dimension, layer, portability: p, question })),
  },
  {
    name: 'run_library_query',
    description: 'Run a library entry by id via REST (with its client-side transform). compare=true also runs the original T-SQL for side-by-side checking.',
    inputSchema: { type: 'object', properties: { id: { type: 'integer' }, compare: { type: 'boolean', default: false } }, required: ['id'] },
    handler: async ({ id, compare }) => {
      const q = getQuery(id);
      if (!q) throw new Error(`No library query ${id}`);
      const r = await runEntry(q, local);
      const dateCols = r.requests.flatMap((x) => dateColsOf(x.response));
      const out = { id, question: q.question, portability: q.portability, notes: q.notes, rest: q.rest, transform: q.transform, urls: r.requests.map((x) => x.url), result: clip(fmtDates(r.rows, dateCols)) };
      if (compare && q.id !== 50) { const t = svc.sql(q.tsql); out.tsql = q.tsql; out.tsqlResult = t.error ? t.error : clip(t.rows); }
      return out;
    },
  },
  {
    name: 'run_tsql',
    description: 'Mock extension (not ArcGIS REST): run a read-only T-SQL SELECT/WITH against the ServiceRequests table to validate REST ports.',
    inputSchema: { type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'] },
    handler: ({ sql }) => { const r = svc.sql(sql); if (r.error) throw new Error(`${r.error.message} ${r.error.details.join(' ')}`); return { sqlite: r.sqlite, ...clip(r.rows) }; },
  },
];

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return fail(null, -32700, 'Parse error'); }
  const { id, method, params } = msg;
  try {
    switch (method) {
      case 'initialize':
        return reply(id, {
          protocolVersion: params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'servicerequests', version: '1.0.0' },
          instructions: 'Mock ArcGIS FeatureServer for generic public service requests (Cape Town coordinates). Use describe_layer first, then query_layer with ArcGIS REST parameters.',
        });
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return;
      case 'ping':
        return reply(id, {});
      case 'tools/list':
        return reply(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
      case 'tools/call': {
        const tool = TOOLS.find((t) => t.name === params?.name);
        if (!tool) return fail(id, -32602, `Unknown tool ${params?.name}`);
        try {
          const result = await tool.handler(params.arguments ?? {});
          return reply(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 1) }] });
        } catch (e) {
          return reply(id, { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });
        }
      }
      default:
        if (id !== undefined) fail(id, -32601, `Method not found: ${method}`);
    }
  } catch (e) {
    log('mcp error', e.stack);
    if (id !== undefined) fail(id, -32603, e.message);
  }
});
log(`servicerequests MCP ready (${svc.count} features)`);
