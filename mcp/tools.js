/**
 * The MCP tool contract for the ServiceRequests service, and the JSON-RPC 2.0
 * dispatch over it — with no transport and no platform dependency.
 *
 * Two things speak this contract:
 *   - `mcp/server.js`      newline-delimited JSON-RPC over stdin/stdout, for Claude Code
 *   - `viewer/js/mcp-service.js` the same tools and dispatcher in the page, over a REST
 *                               adapter, so the Library tab can show the tool call behind a
 *                               question it just ran and let the contract be inspected
 *
 * Keeping the definitions here rather than in the stdio server is the point: the
 * tools the viewer shows are not a description of the MCP server, they *are* it.
 *
 * This module is loaded by the browser, so it must stay platform-free: no `node:`
 * imports, no `process`, no `Buffer`.
 *
 * ## The service adapter
 *
 * `createTools()` takes a small adapter rather than a FeatureService, so the same
 * tools can run in-process on the server or over HTTP from the page. Every method
 * may return a promise:
 *
 *   query(params)    -> Esri JSON, as `…/FeatureServer/0/query` returns it
 *   sql(statement)   -> { sqlite, columns, rows } | { error }   (the mock /sql extension)
 *   stats()          -> { featureCount, asOf, clock }
 */
import { FIELDS } from '../server/schema.js';
import { queryLibrary, getQuery } from '../sql-library/queryLibrary.js';
import { runEntry, toQueryUrl, toRows } from '../sql-library/runner.js';

/** Row cap on every tool result: a tool reply becomes tokens in someone's context. */
export const MAX_ROWS = 200;

export const SERVER_INFO = { name: 'servicerequests', version: '1.0.0' };
export const PROTOCOL_VERSION = '2025-06-18';
export const INSTRUCTIONS =
  'Mock ArcGIS FeatureServer for generic public service requests (Cape Town coordinates). Use describe_layer first, then query_layer with ArcGIS REST parameters.';

const SAST_OFFSET_MS = 2 * 3600000;

export const fmtDates = (rows, dateCols) => rows.map((r) => {
  const o = { ...r };
  for (const c of dateCols) {
    if (typeof o[c] === 'number') o[c] = new Date(o[c] + SAST_OFFSET_MS).toISOString().slice(0, 19).replace('T', ' ') + ' SAST';
  }
  return o;
});
export const dateColsOf = (json) => (json.fields ?? []).filter((f) => f.type === 'esriFieldTypeDate').map((f) => f.name);
export const clip = (rows) => ({ rowCount: rows.length, truncated: rows.length > MAX_ROWS, rows: rows.slice(0, MAX_ROWS) });

/** Library entries whose T-SQL has no single-statement equivalent, so `compare` skips them. */
const NO_COMPARE = new Set([50]);

/**
 * Shape a `run_library_query` payload from an already-executed `runEntry` result.
 *
 * Exported because the viewer's Library panel runs the entry itself — it needs the
 * uncapped rows and raw epoch dates for its grid — and then shows the JSON-RPC
 * response an agent would have received for the same question. Building it here means
 * that lane is the real payload from the real code, not a second implementation of it.
 *
 * @param q          the library entry
 * @param runResult  what `runEntry(q, fetcher)` resolved to
 * @param tsqlResult optional `{ sqlite, columns, rows } | { error }` from the /sql side
 */
export function libraryQueryPayload({ q, runResult, tsqlResult }) {
  const dateCols = runResult.requests.flatMap((x) => dateColsOf(x.response));
  const out = {
    id: q.id, question: q.question, portability: q.portability, notes: q.notes,
    rest: q.rest, transform: q.transform,
    urls: runResult.requests.map((x) => x.url),
    result: clip(fmtDates(runResult.rows, dateCols)),
  };
  if (tsqlResult && !NO_COMPARE.has(q.id)) {
    out.tsql = q.tsql;
    out.tsqlResult = tsqlResult.error ? tsqlResult.error : clip(tsqlResult.rows);
  }
  return out;
}

/** Whether `compare` would actually run the T-SQL for this entry. */
export const comparable = (q) => !NO_COMPARE.has(q.id);

/**
 * How a tool's return value is wrapped into an MCP `tools/call` result. The dispatcher
 * uses this, and so does the viewer when it shows the envelope for a payload it already
 * holds — so the two cannot drift apart over something as small as an indent width.
 */
export const toolContent = (payload) => ({ content: [{ type: 'text', text: JSON.stringify(payload, null, 1) }] });

/**
 * Build the tool list.
 * @param service  the adapter described above
 * @param layerUrl the layer URL to report and to build example GET URLs with
 */
export function createTools({ service, layerUrl }) {
  /** A fetcher for runner.js that goes through the adapter. */
  const local = async (params) => ({ url: toQueryUrl(layerUrl, params), json: await service.query(params) });

  return [
    {
      name: 'describe_layer',
      description: 'Schema and value domains of the ServiceRequests mock FeatureServer layer (generic public service requests, Cape Town coordinates). Call this before writing where clauses.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const distinct = async (f) => (await service.sql(`SELECT ${f} AS v, COUNT(*) AS n FROM ServiceRequest GROUP BY ${f} ORDER BY n DESC`)).rows;
        const { featureCount, asOf, clock } = await service.stats();
        return {
          layerUrl,
          featureCount,
          asOf,
          clock,
          spatialReference: 'layer 102100 (Web Mercator); pass outSR=4326 for lon/lat',
          dateHandling: 'Dates are epoch ms (UTC) in responses; where-clause date literals are SAST local time, e.g. DtLogged >= DATE \'2026-01-01\'',
          fields: FIELDS.map((f) => ({ name: f.name, type: f.type, alias: f.alias })),
          values: {
            Category: await distinct('Category'),
            CategorySub: await distinct('CategorySub'),
            Status: await distinct('Status'),
            Channel: await distinct('Channel'),
          },
          dataModel: 'docs/data-model.md — generic council report-a-problem model; core facts are DtLogged, DtCompleted, Category',
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
      handler: async (args) => {
        const params = { returnGeometry: false, outSR: 4326, ...args };
        const json = await service.query(params);
        if (json.error) throw new Error(`${json.error.message} ${json.error.details?.join(' | ') ?? ''}`);
        return {
          url: toQueryUrl(layerUrl, params),
          ...(json.exceededTransferLimit ? { exceededTransferLimit: true } : {}),
          ...clip(fmtDates(toRows(json), dateColsOf(json))),
        };
      },
    },
    {
      name: 'list_library',
      description: 'List the 70-query Service Request Query Library (id, category, portability, question). Optional filters.',
      inputSchema: {
        type: 'object',
        properties: {
          search: { type: 'string' },
          portability: { type: 'string', enum: ['standard', 'sql-expression', 'native', 'extension'] },
          category: { type: 'string' },
        },
      },
      handler: ({ search, portability, category } = {}) => queryLibrary
        .filter((q) => (!portability || q.portability === portability)
          && (!category || q.category.toLowerCase().includes(category.toLowerCase()))
          && (!search || `${q.question} ${q.tsql}`.toLowerCase().includes(search.toLowerCase())))
        .map(({ id, category: c, dimension, layer, portability: p, question }) => ({ id, category: c, dimension, layer, portability: p, question })),
    },
    {
      name: 'run_library_query',
      description: 'Run a library entry by id via REST (with its client-side transform). compare=true also runs the original T-SQL for side-by-side checking.',
      inputSchema: { type: 'object', properties: { id: { type: 'integer' }, compare: { type: 'boolean', default: false } }, required: ['id'] },
      handler: async ({ id, compare }) => {
        const q = getQuery(id);
        if (!q) throw new Error(`No library query ${id}`);
        const runResult = await runEntry(q, local);
        const tsqlResult = compare && comparable(q) ? await service.sql(q.tsql) : undefined;
        return libraryQueryPayload({ q, runResult, tsqlResult });
      },
    },
    {
      name: 'run_tsql',
      description: 'Mock extension (not ArcGIS REST): run a read-only T-SQL SELECT/WITH against the ServiceRequest table to validate REST ports.',
      inputSchema: { type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'] },
      handler: async ({ sql }) => {
        const r = await service.sql(sql);
        if (r.error) throw new Error(`${r.error.message} ${(r.error.details ?? []).join(' ')}`);
        return { sqlite: r.sqlite, ...clip(r.rows) };
      },
    },
  ];
}

/**
 * JSON-RPC 2.0 dispatch for the MCP methods this server implements.
 *
 * @returns `dispatch(message)` -> a response object, or `null` for a notification
 *          (which by the spec gets no reply). It never throws: a handler failure
 *          becomes an `isError` tool result, and anything else a JSON-RPC error.
 */
export function createDispatcher({ tools, serverInfo = SERVER_INFO, instructions = INSTRUCTIONS }) {
  const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
  const okTool = (id, payload) => ok(id, toolContent(payload));
  const err = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

  return async function dispatch(msg) {
    const { id, method, params } = msg ?? {};
    const notification = id === undefined || id === null;
    try {
      switch (method) {
        case 'initialize':
          return ok(id, {
            protocolVersion: params?.protocolVersion ?? PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo,
            instructions,
          });
        case 'notifications/initialized':
        case 'notifications/cancelled':
          return null;
        case 'ping':
          return ok(id, {});
        case 'tools/list':
          return ok(id, { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
        case 'tools/call': {
          const tool = tools.find((t) => t.name === params?.name);
          if (!tool) return err(id, -32602, `Unknown tool ${params?.name}`);
          try {
            const result = await tool.handler(params.arguments ?? {});
            return okTool(id, result);
          } catch (e) {
            return ok(id, { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });
          }
        }
        default:
          return notification ? null : err(id, -32601, `Method not found: ${method}`);
      }
    } catch (e) {
      return notification ? null : err(id, -32603, e.message);
    }
  };
}
