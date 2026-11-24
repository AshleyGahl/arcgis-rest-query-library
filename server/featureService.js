/**
 * Mock ArcGIS FeatureServer layer backed by a GeoJSON feature collection.
 *
 * The GeoJSON is loaded into an in-memory SQLite database so that `where`,
 * `outStatistics`, `groupByFieldsForStatistics`, `having` and `orderByFields`
 * behave like a real SQL-backed feature service.
 *
 * This module has no HTTP dependency and no platform dependency: it is given a
 * parsed feature collection and an open SQLite handle by a *runtime*. Node uses
 * `server/nodeRuntime.js` (node:sqlite + fs); the browser demo uses
 * `viewer/js/engine/sqliteWasmRuntime.js` (SQLite Wasm + fetch). The HTTP server,
 * the MCP server, the CLI, the tests and the static demo all share this one engine.
 *
 * A runtime is `{ geojson, openDatabase() }`, where `openDatabase()` returns a
 * handle with the small subset of the node:sqlite `DatabaseSync` API used below:
 * `exec(sql)`, `prepare(sql).all()`, `prepare(sql).run(...values)`,
 * `function(name, opts, impl)` and `aggregate(name, spec)`.
 */
import { FIELDS, OID_FIELD, TIME_FIELD, DISPLAY_FIELD, DATE_FIELDS, FIELD_BY_LOWER, sqlTypeOf, esriField } from './schema.js';
import { makeDateTools, registerFunctions, translate, splitTopLevel } from './sqlDialect.js';

const R = 6378137;
const toMerc = (lon, lat) => [(lon * Math.PI / 180) * R, Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) * R];
const fromMerc = (x, y) => [(x / R) * 180 / Math.PI, (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * 180 / Math.PI];
const MERC = new Set([102100, 3857, 102113, 900913]);
const LAYER_SR = { wkid: 102100, latestWkid: 3857 };
const UNIT_M = { esriSRUnit_Meter: 1, esriSRUnit_Kilometer: 1000, esriSRUnit_Foot: 0.3048, esriSRUnit_StatuteMile: 1609.344, esriSRUnit_NauticalMile: 1852, esriSRUnit_USNauticalMile: 1852 };

export class QueryError extends Error {
  constructor(message, details = []) { super(message); this.code = 400; this.details = details; }
}

const bool = (v) => v === true || String(v).toLowerCase() === 'true';
const parseSR = (v) => {
  if (v == null || v === '') return null;
  if (typeof v === 'object') return v.latestWkid ?? v.wkid ?? null;
  const s = String(v).trim();
  if (s.startsWith('{')) { const o = JSON.parse(s); return o.latestWkid ?? o.wkid ?? null; }
  return parseInt(s, 10);
};
const srJson = (wkid) => (MERC.has(wkid) ? LAYER_SR : { wkid, latestWkid: wkid });
const haversine = (lon1, lat1, lon2, lat2) => {
  const r = Math.PI / 180, dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.sqrt(a));
};
const inRing = (x, y, ring) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};
const inferType = (values) => {
  const v = values.find((x) => x != null);
  if (typeof v === 'number') return values.every((x) => x == null || Number.isInteger(x)) ? 'esriFieldTypeInteger' : 'esriFieldTypeDouble';
  return 'esriFieldTypeString';
};

export class FeatureService {
  constructor(cfg, runtime) {
    if (!runtime?.geojson || typeof runtime.openDatabase !== 'function') {
      throw new Error('FeatureService needs a runtime: { geojson, openDatabase() }. Use createFeatureService() from server/nodeRuntime.js in Node.');
    }
    this.cfg = cfg;
    this.runtime = runtime;
    this.dates = makeDateTools(cfg.timeZoneOffsetHours);
    this.load();
  }

  // ------------------------------------------------------------------ load
  load() {
    const fc = this.runtime.geojson;
    this.metadata = fc.metadata ?? {};
    const snapshot = this.metadata.asOfEpoch;
    this.nowLocal = () => (this.cfg.clock === 'snapshot' && snapshot ? snapshot : Date.now()) + this.dates.OFFSET;

    const db = this.runtime.openDatabase();
    registerFunctions(db, this.dates, this.nowLocal);
    db.exec(`CREATE TABLE _ServiceRequest (${FIELDS.map((f) => `"${f.name}" ${sqlTypeOf(f)}`).join(', ')}, _lon REAL, _lat REAL, _x REAL, _y REAL)`);
    // Public view for the raw-SQL extension: same columns as the T-SQL ServiceRequest table.
    db.exec(`CREATE VIEW ServiceRequest AS SELECT ${FIELDS.map((f) => `"${f.name}"`).join(', ')} FROM _ServiceRequest`);
    const ins = db.prepare(`INSERT INTO _ServiceRequest VALUES (${Array(FIELDS.length + 4).fill('?').join(', ')})`);

    this.points = [];
    let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity, tmin = Infinity, tmax = -Infinity;
    db.exec('BEGIN');
    fc.features.forEach((ft, i) => {
      const p = ft.properties ?? {};
      const [lon, lat] = ft.geometry.coordinates;
      const oid = p[OID_FIELD] ?? ft.id ?? i + 1;
      const values = FIELDS.map((f) => {
        if (f.name === OID_FIELD) return oid;
        const v = p[f.name] ?? null;
        return DATE_FIELDS.includes(f.name) && v != null ? this.dates.fromEpoch(v) : v;
      });
      const [x, y] = toMerc(lon, lat);
      ins.run(...values, lon, lat, x, y);
      this.points.push({ oid, lon, lat });
      xmin = Math.min(xmin, lon); ymin = Math.min(ymin, lat); xmax = Math.max(xmax, lon); ymax = Math.max(ymax, lat);
      if (p[TIME_FIELD] != null) { tmin = Math.min(tmin, p[TIME_FIELD]); tmax = Math.max(tmax, p[TIME_FIELD]); }
    });
    db.exec('COMMIT');
    db.exec('PRAGMA query_only = ON'); // belt and braces: nothing can write after load
    this.db = db;
    this.count = fc.features.length;
    this.extent4326 = { xmin, ymin, xmax, ymax };
    this.timeExtent = [tmin, tmax];
  }

  // ------------------------------------------------------------------ helpers
  resolveField(name) {
    return FIELD_BY_LOWER[String(name).trim().replace(/^"(.*)"$/, '$1').toLowerCase()] ?? null;
  }

  /** "Field" | "expr AS Alias" -> { expr, alias, field } */
  parseSelectItem(item) {
    const field = this.resolveField(item);
    if (field) return { expr: `"${field.name}"`, alias: field.name, field };
    const asMatch = /^(.*\S)\s+AS\s+"?([A-Za-z_][\w ]*?)"?\s*$/is.exec(item);
    const raw = asMatch ? asMatch[1] : item;
    const alias = asMatch ? asMatch[2] : item;
    const f2 = this.resolveField(raw);
    if (f2) return { expr: `"${f2.name}"`, alias, field: f2 };
    return { expr: translate(raw), alias, field: null };
  }

  projectOut(lon, lat, sr) {
    if (MERC.has(sr)) return toMerc(lon, lat);
    if (sr === 4326) return [lon, lat];
    throw new QueryError(`Unsupported outSR ${sr}. Use 4326 or 102100/3857.`);
  }

  spatialFilter(p) {
    if (!p.geometry) return null;
    let g = p.geometry;
    let type = p.geometryType || 'esriGeometryEnvelope';
    if (typeof g === 'string') {
      g = g.trim();
      if (g.startsWith('{')) g = JSON.parse(g);
      else {
        const n = g.split(',').map(Number);
        if (n.length === 4) g = { xmin: n[0], ymin: n[1], xmax: n[2], ymax: n[3] };
        else if (n.length === 2) { g = { x: n[0], y: n[1] }; type = 'esriGeometryPoint'; }
        else throw new QueryError('Invalid geometry parameter');
      }
    }
    const sr = parseSR(p.inSR) ?? parseSR(g.spatialReference) ?? LAYER_SR.wkid;
    const toGeo = (x, y) => {
      if (MERC.has(sr)) return fromMerc(x, y);
      if (sr === 4326) return [x, y];
      throw new QueryError(`Unsupported inSR ${sr}. Use 4326 or 102100/3857.`);
    };
    const dist = (parseFloat(p.distance) || 0) * (UNIT_M[p.units] ?? 1);
    let test;
    switch (type) {
      case 'esriGeometryEnvelope': {
        const [x1, y1] = toGeo(g.xmin, g.ymin), [x2, y2] = toGeo(g.xmax, g.ymax);
        test = (pt) => pt.lon >= Math.min(x1, x2) && pt.lon <= Math.max(x1, x2) && pt.lat >= Math.min(y1, y2) && pt.lat <= Math.max(y1, y2);
        break;
      }
      case 'esriGeometryPoint': {
        const [x, y] = toGeo(g.x, g.y);
        test = (pt) => haversine(x, y, pt.lon, pt.lat) <= (dist || 1);
        break;
      }
      case 'esriGeometryMultipoint': {
        const pts = g.points.map(([x, y]) => toGeo(x, y));
        test = (pt) => pts.some(([x, y]) => haversine(x, y, pt.lon, pt.lat) <= (dist || 1));
        break;
      }
      case 'esriGeometryPolygon': {
        const rings = g.rings.map((r) => r.map(([x, y]) => toGeo(x, y)));
        test = (pt) => rings.reduce((inside, ring) => (inRing(pt.lon, pt.lat, ring) ? !inside : inside), false);
        break;
      }
      default: throw new QueryError(`Unsupported geometryType ${type}`);
    }
    const negate = p.spatialRel === 'esriSpatialRelDisjoint';
    return this.points.filter((pt) => test(pt) !== negate).map((pt) => pt.oid);
  }

  buildWhere(p) {
    const conds = [`(${translate(String(p.where ?? '').trim() || '1=1')})`];
    if (p.objectIds) {
      const ids = String(p.objectIds).split(',').map((s) => parseInt(s, 10)).filter(Number.isFinite);
      conds.push(ids.length ? `"ObjectID" IN (${ids.join(',')})` : '1=0');
    }
    if (p.time) {
      const [a, b = a] = String(p.time).split(',');
      if (a && a !== 'null') conds.push(`"${TIME_FIELD}" >= '${this.dates.fromEpoch(+a)}'`);
      if (b && b !== 'null') conds.push(`"${TIME_FIELD}" <= '${this.dates.fromEpoch(+b)}'`);
    }
    const ids = this.spatialFilter(p);
    if (ids) conds.push(ids.length ? `"ObjectID" IN (${ids.join(',')})` : '1=0');
    return conds.join(' AND ');
  }

  run(sql) {
    try { return this.db.prepare(sql).all(); }
    catch (e) { throw new QueryError('Unable to complete operation.', [e.message, `SQL: ${sql}`]); }
  }

  limits(p) {
    const max = this.cfg.maxRecordCount;
    const rc = p.resultRecordCount ? Math.min(parseInt(p.resultRecordCount, 10), max) : max;
    const off = parseInt(p.resultOffset ?? '0', 10) || 0;
    return { rc, off };
  }

  // ------------------------------------------------------------------ query
  /** Execute a FeatureServer layer query. `raw` = URLSearchParams or plain object. */
  query(raw) {
    const p = raw instanceof URLSearchParams ? Object.fromEntries(raw) : { ...raw };
    for (const k of Object.keys(p)) if (p[k] !== null && typeof p[k] === 'object' && k !== 'outStatistics' && k !== 'geometry') p[k] = JSON.stringify(p[k]);
    const f = String(p.f ?? 'json').toLowerCase();
    try {
      const outSR = f === 'geojson' ? 4326 : parseSR(p.outSR) ?? LAYER_SR.wkid;
      const where = this.buildWhere(p);
      let result;
      if (p.outStatistics) result = this.queryStatistics(p, where);
      else if (bool(p.returnIdsOnly)) result = this.queryIds(p, where);
      else if (bool(p.returnDistinctValues)) result = this.queryDistinct(p, where);
      else if (bool(p.returnCountOnly) || bool(p.returnExtentOnly)) result = this.queryCountExtent(p, where, outSR);
      else result = this.queryFeatures(p, where, outSR);
      return f === 'geojson' ? this.toGeoJSON(result) : result;
    } catch (e) {
      if (e instanceof QueryError) return { error: { code: 400, message: e.message, details: e.details } };
      return { error: { code: 400, message: e.message, details: [] } };
    }
  }

  queryIds(p, where) {
    const order = p.orderByFields ? translate(p.orderByFields) : '"ObjectID"';
    const rows = this.run(`SELECT "ObjectID" FROM _ServiceRequest WHERE ${where} ORDER BY ${order}`);
    return { objectIdFieldName: OID_FIELD, objectIds: rows.map((r) => r.ObjectID) };
  }

  queryCountExtent(p, where, outSR) {
    const out = {};
    if (bool(p.returnCountOnly)) out.count = this.run(`SELECT COUNT(*) AS n FROM _ServiceRequest WHERE ${where}`)[0].n;
    if (bool(p.returnExtentOnly)) {
      const e = this.run(`SELECT MIN(_lon) a, MIN(_lat) b, MAX(_lon) c, MAX(_lat) d, COUNT(*) n FROM _ServiceRequest WHERE ${where}`)[0];
      if (e.n === 0) out.extent = { xmin: 'NaN', ymin: 'NaN', xmax: 'NaN', ymax: 'NaN', spatialReference: srJson(outSR) };
      else {
        const [xmin, ymin] = this.projectOut(e.a, e.b, outSR), [xmax, ymax] = this.projectOut(e.c, e.d, outSR);
        out.extent = { xmin, ymin, xmax, ymax, spatialReference: srJson(outSR) };
      }
    }
    return out;
  }

  queryDistinct(p, where) {
    const items = this.outItems(p, false);
    const cols = items.map((i) => `${i.expr} AS "${i.alias}"`).join(', ');
    if (bool(p.returnCountOnly)) {
      return { count: this.run(`SELECT COUNT(*) AS n FROM (SELECT DISTINCT ${cols} FROM _ServiceRequest WHERE ${where})`)[0].n };
    }
    const order = p.orderByFields ? ` ORDER BY ${translate(p.orderByFields)}` : '';
    const { rc, off } = this.limits(p);
    const rows = this.run(`SELECT DISTINCT ${cols} FROM _ServiceRequest WHERE ${where}${order} LIMIT ${rc + 1} OFFSET ${off}`);
    return this.featureSet(items, rows, rc, null);
  }

  outItems(p, ensureOid = true) {
    const of = String(p.outFields ?? '').trim();
    let items = !of || of === '*' ? FIELDS.map((f) => this.parseSelectItem(f.name)) : splitTopLevel(of).map((s) => (s === '*' ? null : this.parseSelectItem(s))).filter(Boolean);
    if (of.split(',').map((s) => s.trim()).includes('*') && of !== '*') items = [...FIELDS.map((f) => this.parseSelectItem(f.name)), ...items.filter((i) => !i.field)];
    if (ensureOid && !items.some((i) => i.field?.name === OID_FIELD)) items.unshift(this.parseSelectItem(OID_FIELD));
    return items;
  }

  queryFeatures(p, where, outSR) {
    const items = this.outItems(p);
    const withGeom = p.returnGeometry === undefined || bool(p.returnGeometry);
    const cols = items.map((i) => `${i.expr} AS "${i.alias}"`).join(', ');
    const order = p.orderByFields ? translate(p.orderByFields) : '"ObjectID"';
    const { rc, off } = this.limits(p);
    const rows = this.run(`SELECT ${cols}, _lon AS __lon, _lat AS __lat FROM _ServiceRequest WHERE ${where} ORDER BY ${order} LIMIT ${rc + 1} OFFSET ${off}`);
    return this.featureSet(items, rows, rc, withGeom ? outSR : null);
  }

  featureSet(items, rows, rc, outSR) {
    const exceeded = rows.length > rc;
    if (exceeded) rows = rows.slice(0, rc);
    const fields = items.map((i) => (i.field ? esriField(i.field) : { name: i.alias, type: inferType(rows.map((r) => r[i.alias])), alias: i.alias }));
    const features = rows.map((r) => {
      const attributes = {};
      for (const i of items) {
        const v = r[i.alias];
        attributes[i.alias] = i.field && DATE_FIELDS.includes(i.field.name) ? this.dates.toEpoch(v) : v;
      }
      const ft = { attributes };
      if (outSR) { const [x, y] = this.projectOut(r.__lon, r.__lat, outSR); ft.geometry = { x, y }; }
      return ft;
    });
    const res = {
      objectIdFieldName: OID_FIELD,
      uniqueIdField: { name: OID_FIELD, isSystemMaintained: true },
      globalIdFieldName: '',
      geometryType: 'esriGeometryPoint',
      spatialReference: srJson(outSR ?? LAYER_SR.wkid),
      fields,
      features,
    };
    if (exceeded) res.exceededTransferLimit = true;
    return res;
  }

  queryStatistics(p, where) {
    let stats = p.outStatistics;
    if (typeof stats === 'string') {
      try { stats = JSON.parse(stats); } catch { throw new QueryError("'outStatistics' parameter is invalid"); }
    }
    if (!Array.isArray(stats) || !stats.length) throw new QueryError("'outStatistics' must be a non-empty array");

    const groups = p.groupByFieldsForStatistics ? splitTopLevel(String(p.groupByFieldsForStatistics)).map((g) => this.parseSelectItem(g)) : [];
    const statCols = stats.map((s) => {
      const type = String(s.statisticType ?? '').toLowerCase().replace(/[\s_]/g, '');
      const raw = String(s.onStatisticField ?? '').trim();
      const field = this.resolveField(raw);
      const e = field ? `"${field.name}"` : raw && raw !== '*' ? translate(raw) : null;
      const pv = Number(s.statisticParameters?.value ?? 0.5);
      const pp = /desc/i.test(s.statisticParameters?.orderBy ?? '') ? 1 - pv : pv;
      const alias = s.outStatisticFieldName || `${type}_${field?.name ?? 'expr'}`;
      const need = () => { if (!e) throw new QueryError(`statisticType '${s.statisticType}' requires onStatisticField`); return e; };
      let sql, esriType = 'esriFieldTypeDouble', isDate = false, infer = false;
      switch (type) {
        case 'count': sql = e ? `COUNT(${e})` : 'COUNT(*)'; esriType = 'esriFieldTypeInteger'; break;
        case 'countdistinct': sql = `COUNT(DISTINCT ${need()})`; esriType = 'esriFieldTypeInteger'; break; // mock extension
        case 'sum': sql = `SUM(${need()})`; break;
        case 'avg': sql = `AVG(${need()})`; break;
        case 'min': case 'max':
          sql = `${type.toUpperCase()}(${need()})`;
          if (field && DATE_FIELDS.includes(field.name)) { isDate = true; esriType = 'esriFieldTypeDate'; } else infer = true;
          break;
        case 'stddev': sql = `STDEV(${need()})`; break;
        case 'var': sql = `VAR(${need()})`; break;
        case 'percentilecont': sql = `PCT_CONT(${need()}, ${pp})`; break;
        case 'percentiledisc': sql = `PCT_DISC(${need()}, ${pp})`; infer = true; break;
        default: throw new QueryError(`Unsupported statisticType '${s.statisticType}'`);
      }
      return { sql, alias, esriType, isDate, infer };
    });

    let sql = `SELECT ${[...groups.map((g) => `${g.expr} AS "${g.alias}"`), ...statCols.map((c) => `${c.sql} AS "${c.alias}"`)].join(', ')} FROM _ServiceRequest WHERE ${where}`;
    if (groups.length) sql += ` GROUP BY ${groups.map((g) => g.expr).join(', ')}`;
    if (p.having) sql += ` HAVING ${translate(p.having)}`;
    if (p.orderByFields) sql += ` ORDER BY ${translate(p.orderByFields)}`;
    if (p.resultRecordCount || p.resultOffset) { const { rc, off } = this.limits(p); sql += ` LIMIT ${rc} OFFSET ${off}`; }
    const rows = this.run(sql);

    const fields = [
      ...groups.map((g) => (g.field ? { ...esriField(g.field), name: g.alias, alias: g.alias } : { name: g.alias, type: inferType(rows.map((r) => r[g.alias])), alias: g.alias })),
      ...statCols.map((c) => ({ name: c.alias, type: c.infer ? inferType(rows.map((r) => r[c.alias])) : c.esriType, alias: c.alias, sqlType: 'sqlTypeOther', domain: null, defaultValue: null })),
    ];
    const dateAliases = new Set([...groups.filter((g) => g.field && DATE_FIELDS.includes(g.field.name)).map((g) => g.alias), ...statCols.filter((c) => c.isDate).map((c) => c.alias)]);
    const features = rows.map((r) => {
      const attributes = {};
      for (const k of Object.keys(r)) attributes[k] = dateAliases.has(k) ? this.dates.toEpoch(r[k]) : r[k];
      return { attributes };
    });
    return { displayFieldName: '', fieldAliases: Object.fromEntries(fields.map((f) => [f.name, f.alias])), fields, features };
  }

  toGeoJSON(res) {
    if (res.error || !res.features) return res;
    const fc = {
      type: 'FeatureCollection',
      features: res.features.map((ft) => ({
        type: 'Feature',
        id: ft.attributes[OID_FIELD],
        geometry: ft.geometry ? { type: 'Point', coordinates: [ft.geometry.x, ft.geometry.y] } : null,
        properties: ft.attributes,
      })),
    };
    if (res.exceededTransferLimit) fc.properties = { exceededTransferLimit: true };
    return fc;
  }

  // ------------------------------------------------------------------ raw SQL (mock extension)
  /**
   * NOT part of the ArcGIS REST API. Runs a read-only T-SQL SELECT against the
   * `ServiceRequest` view so the original vw_QueryLibrary statements can be compared
   * with their REST equivalents.
   */
  sql(statement, maxRows = 5000) {
    let sqlite;
    try {
      sqlite = translate(statement, { fullStatement: true });
      const rows = this.db.prepare(sqlite).all();
      return { sqlite, columns: rows.length ? Object.keys(rows[0]) : [], rowCount: rows.length, rows: rows.slice(0, maxRows) };
    } catch (e) {
      return { error: { code: 400, message: e.message, details: sqlite ? [`SQLite: ${sqlite}`] : [] } };
    }
  }

  // ------------------------------------------------------------------ metadata
  extent102100() {
    const e = this.extent4326;
    const [xmin, ymin] = toMerc(e.xmin, e.ymin), [xmax, ymax] = toMerc(e.xmax, e.ymax);
    return { xmin, ymin, xmax, ymax, spatialReference: LAYER_SR };
  }

  layerInfo() {
    const { maxRecordCount } = this.cfg;
    return {
      currentVersion: 11.3,
      id: 0,
      name: this.cfg.layerName,
      type: 'Feature Layer',
      description: 'Synthetic public service requests located in and around Cape Town (mock FeatureServer backed by GeoJSON).',
      copyrightText: 'Synthetic data for development and testing',
      defaultVisibility: true,
      editingInfo: { lastEditDate: this.metadata.asOfEpoch ?? Date.now() },
      relationships: [],
      isDataVersioned: false,
      supportsAppend: false,
      supportsCalculate: false,
      supportsTruncate: false,
      supportsAttachmentsByUploadId: false,
      supportsRollbackOnFailureParameter: false,
      supportsStatistics: true,
      supportsExceedsLimitStatistics: false,
      supportsAdvancedQueries: true,
      supportsValidateSql: false,
      supportsCoordinatesQuantization: false,
      supportsQuantizationEditMode: false,
      supportsApplyEditsWithGlobalIds: false,
      supportsReturningQueryGeometry: false,
      advancedQueryCapabilities: {
        useStandardizedQueries: false,
        supportsStatistics: true,
        supportsPercentileStatistics: true,
        supportsHavingClause: true,
        supportsOrderBy: true,
        supportsDistinct: true,
        supportsCountDistinct: true,
        supportsPagination: true,
        supportsPaginationOnAggregatedQueries: true,
        supportsQueryWithDistance: true,
        supportsSqlExpression: true,
        supportsOutFieldSQLExpression: true,
        supportsDisjointSpatialRel: true,
        supportsQueryWithResultType: false,
        supportsReturningGeometryCentroid: false,
        supportsTopFeaturesQuery: false,
        supportsQueryWithCacheHint: false,
        supportsLod: false,
        supportsQueryAttachments: false,
        supportsQueryAnalytic: false,
        supportsQueryBins: false,
      },
      useStandardizedQueries: false,
      geometryType: 'esriGeometryPoint',
      minScale: 0,
      maxScale: 0,
      extent: this.extent102100(),
      drawingInfo: {
        renderer: {
          type: 'simple',
          symbol: { type: 'esriSMS', style: 'esriSMSCircle', color: [0, 112, 255, 200], size: 6, angle: 0, xoffset: 0, yoffset: 0, outline: { color: [255, 255, 255, 255], width: 0.75 } },
          label: '', description: '',
        },
        transparency: 0,
        labelingInfo: null,
      },
      allowGeometryUpdates: false,
      hasAttachments: false,
      htmlPopupType: 'esriServerHTMLPopupTypeNone',
      hasM: false,
      hasZ: false,
      objectIdField: OID_FIELD,
      uniqueIdField: { name: OID_FIELD, isSystemMaintained: true },
      globalIdField: '',
      typeIdField: '',
      displayField: DISPLAY_FIELD,
      dateFieldsTimeReference: { timeZone: 'UTC', respectsDaylightSaving: false },
      timeInfo: {
        startTimeField: TIME_FIELD,
        endTimeField: null,
        trackIdField: null,
        timeExtent: this.timeExtent,
        timeReference: null,
        timeInterval: 1,
        timeIntervalUnits: 'esriTimeUnitsMonths',
        hasLiveData: false,
      },
      fields: FIELDS.map(esriField),
      geometryField: { name: 'Shape', type: 'esriFieldTypeGeometry', alias: 'Shape' },
      indexes: [],
      types: [],
      templates: [],
      supportedQueryFormats: 'JSON, geoJSON',
      supportedSpatialRelationships: ['esriSpatialRelIntersects', 'esriSpatialRelContains', 'esriSpatialRelWithin', 'esriSpatialRelEnvelopeIntersects', 'esriSpatialRelDisjoint'],
      hasStaticData: true,
      maxRecordCount,
      standardMaxRecordCount: maxRecordCount,
      tileMaxRecordCount: maxRecordCount,
      maxRecordCountFactor: 1,
      capabilities: 'Query',
    };
  }

  serviceInfo() {
    const extent = this.extent102100();
    return {
      currentVersion: 11.3,
      serviceDescription: 'Mock ArcGIS FeatureServer for public service requests (GeoJSON-backed).',
      hasVersionedData: false,
      supportsDisconnectedEditing: false,
      hasStaticData: true,
      maxRecordCount: this.cfg.maxRecordCount,
      supportedQueryFormats: 'JSON, geoJSON',
      capabilities: 'Query',
      description: '',
      copyrightText: 'Synthetic data for development and testing',
      spatialReference: LAYER_SR,
      initialExtent: extent,
      fullExtent: extent,
      allowGeometryUpdates: false,
      units: 'esriMeters',
      syncEnabled: false,
      layers: [{ id: 0, name: this.cfg.layerName, parentLayerId: -1, defaultVisibility: true, subLayerIds: null, minScale: 0, maxScale: 0, geometryType: 'esriGeometryPoint' }],
      tables: [],
    };
  }
}
