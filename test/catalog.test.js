/**
 * The query library published as a FeatureServer table (layer 1).
 *
 * The point of these tests is the loop at the bottom: a client that knows nothing
 * about this repository discovers the analytical questions with one standard
 * ArcGIS REST request against table 1, then executes any of them with a second
 * standard request against layer 0, using the parameters the catalog handed it.
 * Nothing but the catalog row travels between the two calls.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFeatureService } from '../server/nodeRuntime.js';
import { createRestRouter } from '../server/restRouter.js';
import { config } from '../server/config.js';
import { queryLibrary } from '../sql-library/queryLibrary.js';
import { runEntry, toRows, TRANSFORMS } from '../sql-library/runner.js';
import { CATALOG_FIELDS } from '../server/catalogSchema.js';

const svc = createFeatureService(config);
const route = createRestRouter(svc, config);

/** Go through the actual REST surface, exactly as an HTTP client would. */
const rest = (layerId, params) => {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries({ f: 'json', ...params })) {
    if (v === undefined || v === null) continue;
    qs.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  const res = route({ path: `/arcgis/rest/services/${config.serviceName}/FeatureServer/${layerId}/query`, params: qs });
  assert.ok(res, `no route for layer ${layerId}`);
  return JSON.parse(res.body);
};
const attrs = (json) => toRows(json);

// ------------------------------------------------------------------ the table exists and is advertised
test('the service advertises the catalog as a table, not a layer', () => {
  const info = svc.serviceInfo();
  assert.deepEqual(info.layers.map((l) => l.id), [0]);
  assert.deepEqual(info.tables.map((l) => l.id), [1]);
  assert.equal(info.tables[0].name, 'QueryLibrary');
  assert.equal(info.tables[0].geometryType, null);
});

test('table 1 reports type Table with no geometry, extent or timeInfo', () => {
  const info = svc.layerInfo(1);
  assert.equal(info.type, 'Table');
  assert.equal(info.geometryType, null);
  assert.equal(info.extent, null);
  assert.equal(info.timeInfo, null);
  assert.equal(info.objectIdField, 'ObjectID');
  assert.deepEqual(info.fields.map((f) => f.name), CATALOG_FIELDS.map((f) => f.name));
});

test('layer 0 is unchanged and still spatial', () => {
  const info = svc.layerInfo(0);
  assert.equal(info.type, 'Feature Layer');
  assert.equal(info.geometryType, 'esriGeometryPoint');
  assert.ok(info.extent.xmin < info.extent.xmax);
  assert.equal(info.timeInfo.startTimeField, 'DtLogged');
});

test('/layers lists the layer and the table separately', () => {
  const res = route({ path: `/arcgis/rest/services/${config.serviceName}/FeatureServer/layers`, params: new URLSearchParams({ f: 'json' }) });
  const body = JSON.parse(res.body);
  assert.deepEqual(body.layers.map((l) => l.id), [0]);
  assert.deepEqual(body.tables.map((l) => l.id), [1]);
});

test('an unknown layer id is a 400-style REST error, not a route miss', () => {
  assert.equal(route({ path: `/arcgis/rest/services/${config.serviceName}/FeatureServer/9/query`, params: new URLSearchParams() }), null);
  assert.match(svc.query({ where: '1=1' }, 9).error.message, /Invalid layer id/);
});

// ------------------------------------------------------------------ the catalog is a normal queryable table
test('the catalog holds one row per library entry', () => {
  assert.equal(rest(1, { where: '1=1', returnCountOnly: true }).count, queryLibrary.length);
});

test('the catalog supports a standard where clause', () => {
  const rows = attrs(rest(1, { where: "Portability = 'standard'", outFields: 'QueryNumber,Portability' }));
  assert.equal(rows.length, 32);
  assert.ok(rows.every((r) => r.Portability === 'standard'));
});

test('the catalog supports outStatistics, so the catalog can describe itself', () => {
  const rows = attrs(rest(1, {
    where: '1=1',
    groupByFieldsForStatistics: 'Portability',
    outStatistics: [{ statisticType: 'count', onStatisticField: 'ObjectID', outStatisticFieldName: 'Count' }],
    orderByFields: 'Count DESC',
  }));
  assert.deepEqual(rows, [
    { Portability: 'standard', Count: 32 },
    { Portability: 'native', Count: 23 },
    { Portability: 'sql-expression', Count: 14 },
    { Portability: 'extension', Count: 1 },
  ]);
  assert.equal(rows.reduce((a, r) => a + r.Count, 0), queryLibrary.length);
});

test('returnDistinctValues gives a client its category dropdown', () => {
  const rows = attrs(rest(1, { where: '1=1', outFields: 'Category', returnDistinctValues: true, orderByFields: 'Category' }));
  assert.equal(rows.length, 12);
});

test('a table query rejects returnExtentOnly instead of inventing an extent', () => {
  assert.match(rest(1, { where: '1=1', returnExtentOnly: true }).error.message, /no geometry/);
});

test('the catalog is read-only like the rest of the engine', () => {
  assert.ok(svc.sql("UPDATE QueryLibrary SET Question = 'x'").error);
});

test('the QueryLibrary view is visible to the raw-SQL extension too', () => {
  const r = svc.sql('SELECT COUNT(*) AS n FROM QueryLibrary');
  assert.ok(!r.error, r.error?.message);
  assert.equal(r.rows[0].n, queryLibrary.length);
});

// ------------------------------------------------------------------ the whole point
/**
 * Catalog-driven execution: read the row over REST, replay its RestParams over
 * REST, and assert the answer is identical to running the library entry directly.
 * If this passes for all 70, the catalog is a sufficient description of the
 * analytics — the client needs no compiled-in knowledge of any question.
 */
const catalog = attrs(rest(1, { where: '1=1', outFields: '*', orderByFields: 'QueryNumber', resultRecordCount: 2000 }));

test('the catalog came back whole', () => {
  assert.equal(catalog.length, 70);
  assert.ok(catalog.every((r) => r.RestParams && r.SqlText));
});

for (const row of catalog) {
  test(`Q${row.QueryNumber} executes from its catalog row alone: ${row.Question}`, async () => {
    // Everything below uses only what the catalog returned.
    const params = JSON.parse(row.RestParams);
    const requests = Array.isArray(params) ? params : [{ name: 'main', params }];
    assert.equal(requests.length, row.RequestCount);

    const sets = {};
    for (const r of requests) sets[r.name] = attrs(rest(0, r.params));

    let rows = sets.main ?? sets[Object.keys(sets)[0]];
    for (const t of JSON.parse(row.TransformSpec ?? '[]')) rows = TRANSFORMS[t.type](rows, t, sets);

    const entry = queryLibrary.find((q) => q.id === row.QueryNumber);
    const direct = await runEntry(entry, async (p) => ({ url: '(in-process)', json: svc.query(p) }));
    assert.deepEqual(rows, direct.rows);
    assert.ok(rows.length > 0, 'a catalogued question should return rows');
  });
}

test('the catalog advertises exactly the transforms the library needs', () => {
  const needsTransform = catalog.filter((r) => r.Transforms);
  assert.equal(needsTransform.length, 9);
  assert.ok(needsTransform.every((r) => JSON.parse(r.TransformSpec).every((t) => TRANSFORMS[t.type])));
  // Everything else is answered by the REST request alone.
  assert.ok(catalog.filter((r) => !r.Transforms).every((r) => r.TransformSpec === null));
});

test('a client can select a portable subset and run only that', async () => {
  const portable = attrs(rest(1, { where: "Portability = 'standard'", outFields: 'QueryNumber,RestParams,Transforms', orderByFields: 'QueryNumber' }));
  assert.equal(portable.length, 32);
  for (const row of portable) {
    const params = JSON.parse(row.RestParams);
    const json = rest(0, Array.isArray(params) ? params[0].params : params);
    assert.ok(!json.error, `Q${row.QueryNumber}: ${json.error?.message}`);
    // A 'standard' request must not need sqlFormat=native to run.
    assert.ok(!JSON.stringify(params).includes('sqlFormat'), `Q${row.QueryNumber} is tagged standard but asks for sqlFormat`);
  }
});
