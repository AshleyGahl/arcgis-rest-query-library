/**
 * The mock ArcGIS REST surface, as a pure function of (path, params).
 *
 *   {prefix}/arcgis/rest/info
 *   {prefix}/arcgis/rest/services                                        services directory
 *   {prefix}/arcgis/rest/services/{service}/FeatureServer
 *   {prefix}/arcgis/rest/services/{service}/FeatureServer/layers
 *   {prefix}/arcgis/rest/services/{service}/FeatureServer/{id}            0 = features, 1 = QueryLibrary table
 *   {prefix}/arcgis/rest/services/{service}/FeatureServer/{id}/query
 *   {prefix}/arcgis/rest/services/{service}/FeatureServer/0/sql           (mock extension)
 *   {prefix}/arcgis/rest/services/{service}/FeatureServer/1/execute       (mock extension)
 *
 * Layer 1 is the query catalog (server/catalogSchema.js): the analytical questions
 * served as a non-spatial table over the same `query` operation, so a client
 * discovers what to ask with one standard request and executes it with another.
 *
 * `/1/execute` is the one route here that is not generic, and it exists to make a point
 * the two generic requests cannot: it accepts a question identifier and the parameters
 * that question declares, and nothing else. No `where`, no `outStatistics` — it refuses
 * them rather than ignoring them. It resolves the row through its own layer 1, binds the
 * parameters on the trusted side, and executes. That is the forwarding tier of
 * docs/catalog-pattern.md: narrow the executor's input type back to an identifier and
 * the catalog becomes enforceable again, at the cost of one component that knows no
 * individual question. Like `/0/sql` it is a mock extension, not part of ArcGIS REST.
 *
 * No HTTP and no platform built-ins, so the same routing, the same services
 * directory pages and the same `f=html` query form serve both the Node host
 * (`server/index.js`) and the static browser demo, where a service worker calls
 * `route()` instead of a socket.
 *
 * `prefix` is where the service is mounted: '' for the Node server at the origin
 * root, '/<repo>' when the demo is published under a GitHub Pages project path.
 */

import { toRows, entryFromRow, bindEntry, paramsOf, requestsOf, finishEntry } from '../sql-library/runner.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const JSON_TYPE = 'application/json; charset=utf-8';
const GEOJSON_TYPE = 'application/geo+json; charset=utf-8';
const HTML_TYPE = 'text/html; charset=utf-8';

/** An Esri-shaped error body. The mock answers 200 with an error object, as a real service does. */
const restError = (code, message, details = []) => ({ error: { code, message, details } });

const json = (obj, f) => ({
  status: 200,
  contentType: f === 'geojson' ? GEOJSON_TYPE : JSON_TYPE,
  body: JSON.stringify(obj, null, f === 'pjson' ? 2 : 0),
});
const html = (body) => ({ status: 200, contentType: HTML_TYPE, body });

function htmlPage(title, trail, inner) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{font:14px/1.45 Segoe UI,Arial,sans-serif;margin:0;color:#222}header{background:#2b3e50;color:#fff;padding:10px 18px}
header a{color:#cde}main{padding:16px 18px;max-width:1100px}pre{background:#f6f8fa;border:1px solid #ddd;padding:10px;overflow:auto;max-height:60vh}
table.form td{padding:3px 6px;vertical-align:top}input[type=text],textarea,select{width:560px;font:13px Consolas,monospace}textarea{height:56px}
.note{color:#666;font-size:12px}</style></head><body><header><b>ArcGIS REST Services Directory</b> <span class="note" style="color:#cde">(mock)</span><br>${trail}</header><main>${inner}</main></body></html>`;
}
const crumbs = (parts) => parts.map(([label, href]) => (href ? `<a href="${href}">${esc(label)}</a>` : esc(label))).join(' &gt; ');

function queryForm(params, isTable = false) {
  const v = (k, d = '') => esc(params.get(k) ?? d);
  const txt = (k, label, d = '', note = '') => `<tr><td>${label}:</td><td><input type="text" name="${k}" value="${v(k, d)}"> <span class="note">${note}</span></td></tr>`;
  const area = (k, label, note = '') => `<tr><td>${label}:</td><td><textarea name="${k}">${v(k)}</textarea><br><span class="note">${note}</span></td></tr>`;
  const tf = (k, label, d = 'false') => `<tr><td>${label}:</td><td>${['true', 'false'].map((o) => `<label><input type="radio" name="${k}" value="${o}" ${(params.get(k) ?? d) === o ? 'checked' : ''}> ${o}</label>`).join(' ')}</td></tr>`;
  const spatial = isTable ? '' : `${txt('time', 'Time', '', 'epoch ms: start,end')}
${area('geometry', 'Input Geometry', 'Envelope "xmin,ymin,xmax,ymax", point "x,y", or Esri geometry JSON')}
<tr><td>Geometry Type:</td><td><select name="geometryType">${['esriGeometryEnvelope', 'esriGeometryPoint', 'esriGeometryMultipoint', 'esriGeometryPolygon'].map((o) => `<option ${params.get('geometryType') === o ? 'selected' : ''}>${o}</option>`).join('')}</select></td></tr>
${txt('inSR', 'Input Spatial Reference', '', '4326 or 102100')}
${txt('distance', 'Distance')}
<tr><td>Units:</td><td><select name="units">${Object.keys({ esriSRUnit_Meter: 1, esriSRUnit_Kilometer: 1, esriSRUnit_Foot: 1, esriSRUnit_StatuteMile: 1 }).map((o) => `<option ${params.get('units') === o ? 'selected' : ''}>${o}</option>`).join('')}</select></td></tr>`;
  const geomOut = isTable ? '' : `${tf('returnGeometry', 'Return Geometry', 'true')}
${txt('outSR', 'Output Spatial Reference', '', '4326 or 102100 (default)')}
${tf('returnExtentOnly', 'Return Extent Only')}`;
  return `<form method="get"><table class="form">
${txt('where', 'Where', '1=1', 'SQL; T-SQL functions allowed (sqlFormat=native)')}
${txt('objectIds', 'Object IDs')}
${spatial}
${txt('outFields', 'Out Fields', '*', 'fields or "expr AS Alias"')}
${geomOut}
${tf('returnIdsOnly', 'Return IDs Only')}
${tf('returnCountOnly', 'Return Count Only')}
${tf('returnDistinctValues', 'Return Distinct Values')}
${txt('orderByFields', 'Order By Fields')}
${txt('groupByFieldsForStatistics', 'Group By Fields (for statistics)', '', 'fields or "expr AS Alias"')}
${area('outStatistics', 'Output Statistics', '[{"statisticType":"count","onStatisticField":"ObjectID","outStatisticFieldName":"Count"}]')}
${txt('having', 'Having Clause')}
${txt('resultOffset', 'Result Offset')}
${txt('resultRecordCount', 'Result Record Count')}
<tr><td>Format:</td><td><select name="f">${['html', 'pjson', 'json', 'geojson'].map((o) => `<option ${params.get('f') === o ? 'selected' : ''}>${o}</option>`).join('')}</select></td></tr>
<tr><td></td><td><button type="submit">Query (GET)</button></td></tr></table></form>`;
}

/** Strip the mount prefix from a pathname. */
const relativeTo = (path, prefix) =>
  (prefix && path.toLowerCase().startsWith(prefix.toLowerCase()) ? path.slice(prefix.length) : path);

/** True for any path the router handles, so a host can decide before building params. */
export const isRestPath = (path, prefix = '') =>
  /^\/arcgis\/rest(\/|$)/i.test(relativeTo(path, prefix).replace(/\/+$/, '') || '/');

/**
 * @param svc   a FeatureService
 * @param cfg   the service config (needs `serviceName` and `layerName`)
 * @param hooks optional `{ onQuery({ ms, params, result }) }`, used for the server's query log
 * @returns `route({ path, params, prefix })` -> `{ status, contentType, body }`,
 *          or `null` when the path is not part of the REST surface.
 */
export function createRestRouter(svc, cfg, hooks = {}) {
  const base = `/arcgis/rest/services/${cfg.serviceName}/FeatureServer`;
  const lbase = base.toLowerCase();

  /** Every catalog row, as entries, read through the service's own table 1. */
  const catalogEntries = () => toRows(svc.query({ where: '1=1', outFields: '*', orderByFields: 'QueryNumber', resultRecordCount: 2000 }, 1)).map(entryFromRow);
  const entryByNumber = (n) => toRows(svc.query({ where: `QueryNumber = ${n}`, outFields: '*' }, 1)).map(entryFromRow)[0];

  /** Parameters this route consumes itself, so anything else is an attempt to send a definition. */
  const RESERVED = new Set(['f', 'q', 'queryNumber']);

  /**
   * Resolve, validate, bind and run — or explain why not. Returns null when no question
   * was named at all, so the HTML form can be shown without an error on it.
   */
  function execute(params) {
    const raw = params.get('q') ?? params.get('queryNumber');
    if (raw == null || raw === '') return null;

    const n = Number(raw);
    if (!Number.isInteger(n)) return restError(400, `'q' must be a query number (got '${raw}')`);
    const entry = entryByNumber(n);
    if (!entry) return restError(404, `No question ${n} in the catalog`, ['Discover the catalogue at /FeatureServer/1/query?where=1=1&outFields=*']);

    const spec = paramsOf(entry);
    const given = {};
    for (const p of spec) {
      const v = params.get(p.name);
      if (v !== null && v !== '') given[p.name] = v;
    }
    const uninvited = [...params.keys()].filter((k) => !RESERVED.has(k) && !spec.some((p) => p.name === k));
    const { entry: bound, values, errors } = bindEntry(entry, given);
    if (uninvited.length) {
      errors.push(`${uninvited.map((k) => `'${k}'`).join(', ')} ${uninvited.length > 1 ? 'are not parameters' : 'is not a parameter'} of question ${n}`);
    }
    if (errors.length) {
      return restError(400, `Question ${n} was not run`, [...errors, spec.length
        ? `Declared: ${spec.map((p) => `${p.name} (${p.type} ${p.min}..${p.max}, default ${p.default})`).join('; ')}`
        : 'This question declares no parameters.']);
    }

    const sets = {};
    const requests = [];
    for (const r of requestsOf(bound)) {
      const response = svc.query(r.params, 0);
      if (response.error) return { error: response.error };
      sets[r.name] = toRows(response);
      requests.push({ name: r.name, params: r.params });
    }
    const { rows, columns } = finishEntry(bound, sets);
    return {
      queryNumber: entry.id,
      question: entry.question,
      portability: entry.portability,
      parameters: values,
      declared: spec,
      transforms: [bound.transform ?? []].flat().map((t) => t.type),
      requests,
      chart: entry.chart ?? null,
      columns,
      rowCount: rows.length,
      rows,
    };
  }

  /** The form, with one input per declared parameter of the question in hand. */
  function executeForm(params, result) {
    const q = params.get('q') ?? '';
    const spec = result && !result.error ? result.declared : paramsOf(entryByNumber(Number(q)) ?? {});
    const picked = (name, fallback) => esc(params.get(name) ?? fallback);
    const options = catalogEntries()
      .map((e) => `<option value="${e.id}" ${String(e.id) === String(q) ? 'selected' : ''}>${esc(`Q${e.id}. ${e.question}`)}${paramsOf(e).length ? ' *' : ''}</option>`)
      .join('');
    return `<form method="get"><table class="form">
<tr><td>Question:</td><td><select name="q" onchange="this.form.submit()"><option value="">— pick a question (* takes parameters) —</option>${options}</select></td></tr>
${spec.map((p) => `<tr><td>${esc(p.label ?? p.name)}:</td><td><input type="number" name="${esc(p.name)}" value="${picked(p.name, p.default)}" min="${p.min}" max="${p.max}" style="width:100px">
<span class="note">${esc(p.name)}: ${esc(p.type)} ${p.min}–${p.max}, default ${p.default}${p.help ? ` — ${esc(p.help)}` : ''}</span></td></tr>`).join('')}
<tr><td>Format:</td><td><select name="f">${['html', 'pjson', 'json'].map((o) => `<option ${params.get('f') === o ? 'selected' : ''}>${o}</option>`).join('')}</select></td></tr>
<tr><td></td><td><button type="submit">Execute</button></td></tr></table></form>`;
  }

  return function route({ path, params, prefix = '' }) {
    const p = relativeTo(path, prefix).replace(/\/+$/, '') || '/';
    const lp = p.toLowerCase();
    const at = (suffix) => `${prefix}${base}${suffix}`;
    const f = String(params.get('f') ?? 'html').toLowerCase();

    if (lp === '/arcgis/rest/info') {
      return json({ currentVersion: 11.3, fullVersion: '11.3.0', owningSystemUrl: null, authInfo: { isTokenBasedSecurity: false } }, f);
    }

    if (lp === '/arcgis/rest/services' || lp === '/arcgis/rest') {
      if (f === 'html') {
        return html(htmlPage('Services', crumbs([['Home', null]]),
          `<h2>Folder: /</h2><ul><li><a href="${at('')}">${esc(cfg.serviceName)}</a> (FeatureServer)</li></ul><p><a href="${prefix}/viewer/">Open GIS viewer</a></p>`));
      }
      return json({ currentVersion: 11.3, folders: [], services: [{ name: cfg.serviceName, type: 'FeatureServer', url: at('') }] }, f);
    }

    if (lp === lbase) {
      if (f === 'html') {
        return html(htmlPage(cfg.serviceName, crumbs([['Home', `${prefix}/arcgis/rest/services`], [cfg.serviceName, null]]),
          `<h2>${esc(cfg.serviceName)} (FeatureServer)</h2>${['layers', 'tables'].map((kind) => {
            const items = svc.serviceInfo()[kind];
            return items.length ? `<p>${kind === 'layers' ? 'Layers' : 'Tables'}:</p><ul>${items.map((l) => `<li><a href="${at(`/${l.id}`)}">${esc(l.name)}</a> (${l.id})</li>`).join('')}</ul>` : '';
          }).join('')}<p>Supported Operations: <a href="${at('/0/query')}">Query</a></p><pre>${esc(JSON.stringify(svc.serviceInfo(), null, 2))}</pre>`));
      }
      return json(svc.serviceInfo(), f);
    }

    if (lp === `${lbase}/layers`) {
      const infos = svc.layerIds().map((id) => svc.layerInfo(id));
      return json({ layers: infos.filter((l) => l.type === 'Feature Layer'), tables: infos.filter((l) => l.type === 'Table') }, f);
    }

    // /{id} and /{id}/query for every published layer and table.
    const idMatch = /^(\d+)(\/query)?$/.exec(lp.startsWith(`${lbase}/`) ? lp.slice(lbase.length + 1) : '');
    if (idMatch && svc.layerIds().includes(Number(idMatch[1]))) {
      const id = Number(idMatch[1]);
      const info = svc.layerInfo(id);
      const name = info.name;

      if (!idMatch[2]) {
        if (f === 'html') {
          const extra = { 0: ` | <a href="${at('/0/sql')}">SQL (mock extension)</a>`, 1: ` | <a href="${at('/1/execute')}">Execute (mock extension)</a>` }[id] ?? '';
          const ops = `<a href="${at(`/${id}/query`)}">Query</a>${extra}`;
          return html(htmlPage(name, crumbs([['Home', `${prefix}/arcgis/rest/services`], [cfg.serviceName, at('')], [name, null]]),
            `<h2>${esc(info.type)}: ${esc(name)} (ID: ${id})</h2><p>Supported Operations: ${ops}</p><pre>${esc(JSON.stringify(info, null, 2))}</pre>`));
        }
        return json(info, f);
      }

      if (f === 'html') {
        const hasQuery = [...params.keys()].some((k) => k !== 'f');
        const result = hasQuery ? svc.query(params, id) : null;
        return html(htmlPage('Query', crumbs([['Home', `${prefix}/arcgis/rest/services`], [cfg.serviceName, at('')], [name, at(`/${id}`)], ['query', null]]),
          `<h2>Query: ${esc(name)} (ID: ${id})</h2>${queryForm(params, info.type === 'Table')}${result ? `<h3>Result</h3><pre>${esc(JSON.stringify(result, null, 2))}</pre>` : ''}`));
      }
      const t0 = Date.now();
      const result = svc.query(params, id);
      hooks.onQuery?.({ ms: Date.now() - t0, layerId: id, params, result });
      return json(result, f);
    }

    if (lp === `${lbase}/1/execute`) {
      const result = execute(params);
      if (f === 'html') {
        return html(htmlPage('Execute', crumbs([['Home', `${prefix}/arcgis/rest/services`], [cfg.serviceName, at('')], ['QueryLibrary', at('/1')], ['execute', null]]),
          `<h2>Execute a catalogued question (mock extension, not part of ArcGIS REST)</h2>
<p class="note">The only inputs are a question number and the parameters that question declares.
A <code>where</code> or <code>outStatistics</code> sent here is refused: this route exists to show
the executor's input type narrowed back to an identifier.</p>
${executeForm(params, result)}${result ? `<h3>Result</h3><pre>${esc(JSON.stringify(result, null, 2))}</pre>` : ''}`));
      }
      return json(result ?? restError(400, "Missing 'q': the QueryNumber of a catalogued question", ['Discover the catalogue at /FeatureServer/1/query?where=1=1&outFields=*']), f);
    }

    if (lp === `${lbase}/0/sql`) {
      const q = params.get('q') ?? params.get('sql');
      if (f === 'html' && !q) {
        return html(htmlPage('SQL', crumbs([['Home', `${prefix}/arcgis/rest/services`], ['sql (mock extension)', null]]),
          `<h2>Raw T-SQL (mock extension, not part of ArcGIS REST)</h2><form method="get"><textarea name="q" style="width:100%;height:160px">SELECT TOP 5 Category, COUNT(*) AS Count FROM ServiceRequest GROUP BY Category ORDER BY Count DESC;</textarea><input type="hidden" name="f" value="pjson"><br><button>Run</button></form>`));
      }
      return json(q ? svc.sql(q) : { error: { code: 400, message: "Missing 'q' parameter", details: [] } }, f === 'html' ? 'pjson' : f);
    }

    return null;
  };
}
