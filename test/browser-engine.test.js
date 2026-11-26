/**
 * The static demo (GitHub Pages) runs the same engine in the browser, over the
 * vendored SQLite Wasm build instead of `node:sqlite`. These tests build that
 * runtime here in Node and assert it answers identically to the server one, so a
 * change to the engine, the dialect or the adapter cannot silently break the
 * published demo.
 *
 * `viewer/vendor/sqlite-wasm/sqlite3.js` is the browser build: it would normally
 * `fetch()` its `.wasm` next to itself, so the bytes are handed over directly via
 * Emscripten's `wasmBinary` option. Everything above that — the adapter, the
 * dialect's user-defined functions, the engine, the REST router — is exactly what
 * the browser loads.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../server/config.js';
import { SERVICE_DEFAULTS } from '../server/serviceConfig.js';
import { FeatureService } from '../server/featureService.js';
import { createFeatureService } from '../server/nodeRuntime.js';
import { createRestRouter } from '../server/restRouter.js';
import { openDatabase } from '../viewer/js/engine/sqliteWasmRuntime.js';
import { queryLibrary } from '../sql-library/queryLibrary.js';
import { runEntry } from '../sql-library/runner.js';

const vendor = path.join(config.root, 'viewer', 'vendor', 'sqlite-wasm');

// Console noise from the OPFS probe: there is no `location` in Node, and no
// SharedArrayBuffer on a plain static host either. SQLite ignores it and carries on.
const quiet = console.error;
console.error = () => {};
const sqlite3InitModule = (await import(`file://${path.join(vendor, 'sqlite3.js').replace(/\\/g, '/')}`)).default;
const sqlite3 = await sqlite3InitModule({
  wasmBinary: fs.readFileSync(path.join(vendor, 'sqlite3.wasm')),
  print: () => {},
  printErr: () => {},
});
console.error = quiet;

const cfg = { ...SERVICE_DEFAULTS };
const wasmSvc = new FeatureService(cfg, {
  geojson: JSON.parse(fs.readFileSync(config.geojsonPath, 'utf8')),
  openDatabase: () => openDatabase(sqlite3),
});
const nodeSvc = createFeatureService(config);

const onWasm = async (params) => ({ url: '(sqlite-wasm)', json: wasmSvc.query(params) });
const onNode = async (params) => ({ url: '(node:sqlite)', json: nodeSvc.query(params) });

test('the Wasm runtime loads the same dataset', () => {
  assert.equal(wasmSvc.count, nodeSvc.count);
  assert.equal(wasmSvc.metadata.asOf, nodeSvc.metadata.asOf);
});

test('the catalog table loads on the Wasm runtime too, so the static demo has one', () => {
  assert.equal(wasmSvc.catalogCount, nodeSvc.catalogCount);
  assert.deepEqual(wasmSvc.layerIds(), nodeSvc.layerIds());
  assert.equal(wasmSvc.layerInfo(1).type, 'Table');
  const q = { where: '1=1', outFields: 'QueryNumber,Portability,RestParams', orderByFields: 'QueryNumber' };
  assert.deepEqual(
    wasmSvc.query(q, 1).features.map((f) => ({ ...f.attributes })),
    nodeSvc.query(q, 1).features.map((f) => ({ ...f.attributes })),
  );
});

test('user-defined T-SQL functions are registered', () => {
  const r = wasmSvc.sql("SELECT DATEDIFF(day, '2024-01-01', '2024-03-01') AS d, FORMAT(CAST('2024-03-05' AS DATETIME), 'yyyy-MM') AS ym, LEN('abc  ') AS n, DATALENGTH('abc') AS b");
  assert.ok(!r.error, r.error && r.error.message);
  // Rows come back as null-prototype objects from both runtimes; spread to compare values.
  assert.deepEqual({ ...r.rows[0] }, { d: 60, ym: '2024-03', n: 3, b: 6 });
});

test('percentile aggregates work as window functions', () => {
  const r = wasmSvc.sql('SELECT TOP 1 PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY DATEDIFF(day, DtLogged, DtCompleted)) OVER () AS med FROM ServiceRequest WHERE DtCompleted IS NOT NULL');
  assert.ok(!r.error, r.error && r.error.message);
  assert.equal(typeof r.rows[0].med, 'number');
});

test('the engine stays read-only', () => {
  const r = wasmSvc.sql("UPDATE ServiceRequest SET Status = 'Closed'");
  assert.ok(r.error, 'a write should be rejected');
});

// Every library entry, both transports, compared row for row.
for (const entry of queryLibrary) {
  test(`Q${entry.id} REST matches node:sqlite: ${entry.question}`, async () => {
    const [wasm, node] = await Promise.all([runEntry(entry, onWasm), runEntry(entry, onNode)]);
    assert.deepEqual(wasm.columns, node.columns);
    assert.deepEqual(wasm.rows, node.rows);
  });
}

for (const entry of queryLibrary) {
  test(`Q${entry.id} T-SQL matches node:sqlite`, () => {
    const wasm = wasmSvc.sql(entry.tsql);
    const node = nodeSvc.sql(entry.tsql);
    assert.ok(!wasm.error, wasm.error && `${wasm.error.message} ${wasm.error.details}`);
    assert.equal(wasm.sqlite, node.sqlite);
    assert.deepEqual(wasm.rows, node.rows);
  });
}

// The REST surface the service worker serves is the one the Node host serves.
test('the REST router answers identically on both runtimes', () => {
  const wasmRoute = createRestRouter(wasmSvc, cfg);
  const nodeRoute = createRestRouter(nodeSvc, config);
  const paths = [
    '/arcgis/rest/info',
    '/arcgis/rest/services',
    '/arcgis/rest/services/ServiceRequests/FeatureServer',
    '/arcgis/rest/services/ServiceRequests/FeatureServer/0',
  ];
  for (const path of paths) {
    const params = new URLSearchParams({ f: 'json' });
    assert.deepEqual(wasmRoute({ path, params }), nodeRoute({ path, params }), path);
  }
  const queryParams = new URLSearchParams({ f: 'json', where: "Status <> 'Closed'", returnCountOnly: 'true' });
  const path = '/arcgis/rest/services/ServiceRequests/FeatureServer/0/query';
  assert.deepEqual(wasmRoute({ path, params: queryParams }), nodeRoute({ path, params: queryParams }));
});

// The execute route is the one non-generic thing the service worker serves, and the
// published demo is where it is most likely to be tried, so prove it there too.
test('executing a question by identifier works on the browser runtime', () => {
  const wasmRoute = createRestRouter(wasmSvc, cfg);
  const nodeRoute = createRestRouter(nodeSvc, config);
  const path = '/arcgis/rest/services/ServiceRequests/FeatureServer/1/execute';
  for (const qs of [{ q: '12' }, { q: '12', top: '9' }, { q: '27', top: '2', days: '120' }, { q: '13' }, { q: '12', top: '900' }, { q: '12', where: '1=1' }]) {
    const params = new URLSearchParams({ f: 'json', ...qs });
    assert.deepEqual(wasmRoute({ path, params }), nodeRoute({ path, params }), JSON.stringify(qs));
  }
  const ran = JSON.parse(wasmRoute({ path, params: new URLSearchParams({ f: 'json', q: '12', top: '9' }) }).body);
  assert.equal(ran.rowCount, 9);
  assert.deepEqual(ran.parameters, { top: 9 });
});

test('a mount prefix only changes the links, not the data', () => {
  const route = createRestRouter(wasmSvc, cfg);
  const params = new URLSearchParams({ f: 'json' });
  const hit = route({ path: '/service-request-gis/arcgis/rest/services', params, prefix: '/service-request-gis' });
  assert.match(hit.body, /\/service-request-gis\/arcgis\/rest\/services\/ServiceRequests\/FeatureServer/);
  const plain = route({ path: '/arcgis/rest/services', params });
  assert.equal(JSON.parse(hit.body).services[0].name, JSON.parse(plain.body).services[0].name);
});
