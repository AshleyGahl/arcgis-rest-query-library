/**
 * The mock ArcGIS REST surface, as a pure function of (path, params).
 *
 *   {prefix}/arcgis/rest/info
 *   {prefix}/arcgis/rest/services                                        services directory
 *   {prefix}/arcgis/rest/services/{service}/FeatureServer
 *   {prefix}/arcgis/rest/services/{service}/FeatureServer/0
 *   {prefix}/arcgis/rest/services/{service}/FeatureServer/0/query
 *   {prefix}/arcgis/rest/services/{service}/FeatureServer/0/sql           (mock extension)
 *
 * No HTTP and no platform built-ins, so the same routing, the same services
 * directory pages and the same `f=html` query form serve both the Node host
 * (`server/index.js`) and the static browser demo, where a service worker calls
 * `route()` instead of a socket.
 *
 * `prefix` is where the service is mounted: '' for the Node server at the origin
 * root, '/<repo>' when the demo is published under a GitHub Pages project path.
 */

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const JSON_TYPE = 'application/json; charset=utf-8';
const GEOJSON_TYPE = 'application/geo+json; charset=utf-8';
const HTML_TYPE = 'text/html; charset=utf-8';

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

function queryForm(params) {
  const v = (k, d = '') => esc(params.get(k) ?? d);
  const txt = (k, label, d = '', note = '') => `<tr><td>${label}:</td><td><input type="text" name="${k}" value="${v(k, d)}"> <span class="note">${note}</span></td></tr>`;
  const area = (k, label, note = '') => `<tr><td>${label}:</td><td><textarea name="${k}">${v(k)}</textarea><br><span class="note">${note}</span></td></tr>`;
  const tf = (k, label, d = 'false') => `<tr><td>${label}:</td><td>${['true', 'false'].map((o) => `<label><input type="radio" name="${k}" value="${o}" ${(params.get(k) ?? d) === o ? 'checked' : ''}> ${o}</label>`).join(' ')}</td></tr>`;
  return `<form method="get"><table class="form">
${txt('where', 'Where', '1=1', 'SQL; T-SQL functions allowed (sqlFormat=native)')}
${txt('objectIds', 'Object IDs')}
${txt('time', 'Time', '', 'epoch ms: start,end')}
${area('geometry', 'Input Geometry', 'Envelope "xmin,ymin,xmax,ymax", point "x,y", or Esri geometry JSON')}
<tr><td>Geometry Type:</td><td><select name="geometryType">${['esriGeometryEnvelope', 'esriGeometryPoint', 'esriGeometryMultipoint', 'esriGeometryPolygon'].map((o) => `<option ${params.get('geometryType') === o ? 'selected' : ''}>${o}</option>`).join('')}</select></td></tr>
${txt('inSR', 'Input Spatial Reference', '', '4326 or 102100')}
${txt('distance', 'Distance')}
<tr><td>Units:</td><td><select name="units">${Object.keys({ esriSRUnit_Meter: 1, esriSRUnit_Kilometer: 1, esriSRUnit_Foot: 1, esriSRUnit_StatuteMile: 1 }).map((o) => `<option ${params.get('units') === o ? 'selected' : ''}>${o}</option>`).join('')}</select></td></tr>
${txt('outFields', 'Out Fields', '*', 'fields or "expr AS Alias"')}
${tf('returnGeometry', 'Return Geometry', 'true')}
${txt('outSR', 'Output Spatial Reference', '', '4326 or 102100 (default)')}
${tf('returnIdsOnly', 'Return IDs Only')}
${tf('returnCountOnly', 'Return Count Only')}
${tf('returnExtentOnly', 'Return Extent Only')}
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
          `<h2>${esc(cfg.serviceName)} (FeatureServer)</h2><p>Layers:</p><ul><li><a href="${at('/0')}">${esc(cfg.layerName)}</a> (0)</li></ul><p>Supported Operations: <a href="${at('/0/query')}">Query</a></p><pre>${esc(JSON.stringify(svc.serviceInfo(), null, 2))}</pre>`));
      }
      return json(svc.serviceInfo(), f);
    }

    if (lp === `${lbase}/layers`) return json({ layers: [svc.layerInfo()], tables: [] }, f);

    if (lp === `${lbase}/0`) {
      if (f === 'html') {
        return html(htmlPage(cfg.layerName, crumbs([['Home', `${prefix}/arcgis/rest/services`], [cfg.serviceName, at('')], [cfg.layerName, null]]),
          `<h2>Layer: ${esc(cfg.layerName)} (ID: 0)</h2><p>Supported Operations: <a href="${at('/0/query')}">Query</a> | <a href="${at('/0/sql')}">SQL (mock extension)</a></p><pre>${esc(JSON.stringify(svc.layerInfo(), null, 2))}</pre>`));
      }
      return json(svc.layerInfo(), f);
    }

    if (lp === `${lbase}/0/query`) {
      if (f === 'html') {
        const hasQuery = [...params.keys()].some((k) => k !== 'f');
        const result = hasQuery ? svc.query(params) : null;
        return html(htmlPage('Query', crumbs([['Home', `${prefix}/arcgis/rest/services`], [cfg.serviceName, at('')], [cfg.layerName, at('/0')], ['query', null]]),
          `<h2>Query: ${esc(cfg.layerName)} (ID: 0)</h2>${queryForm(params)}${result ? `<h3>Result</h3><pre>${esc(JSON.stringify(result, null, 2))}</pre>` : ''}`));
      }
      const t0 = Date.now();
      const result = svc.query(params);
      hooks.onQuery?.({ ms: Date.now() - t0, params, result });
      return json(result, f);
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
