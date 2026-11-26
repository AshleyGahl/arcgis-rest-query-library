/**
 * Bounded parameters: the extension path.
 *
 * A catalogued question is authored, tested and ratified before it is published, which
 * is what makes it authoritative — so the only sanctioned way for a client to vary one
 * is a parameter its author declared, inside a range its author ratified. The
 * declaration is published as the catalog's `ParamSpec` column and applied by
 * `bindEntry` (sql-library/runner.js).
 *
 * Two properties carry the weight here, and the rest of the file is detail:
 *
 *   1. **The default is the ratified question.** Binding a parameter at its declared
 *      default must reproduce the published definition byte for byte — in the REST
 *      parameters *and* in the T-SQL. If it does not, the row no longer describes what
 *      a client that ignores parameters actually runs.
 *   2. **The bounds are enforced where the input type is narrow.** A client holds the
 *      definition and can send anything, so validating in the page proves nothing; the
 *      `/1/execute` route takes an identifier and declared parameters only, and refuses
 *      everything else. That is the trust boundary, and it is tested as one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFeatureService } from '../server/nodeRuntime.js';
import { createRestRouter } from '../server/restRouter.js';
import { config } from '../server/config.js';
import { queryLibrary, getQuery } from '../sql-library/queryLibrary.js';
import { runEntry, toRows, toQueryUrl, bindEntry, validateParams, paramsOf, entryFromRow, requestsOf } from '../sql-library/runner.js';

const svc = createFeatureService(config);
const route = createRestRouter(svc, config);
const base = `/arcgis/rest/services/${config.serviceName}/FeatureServer`;
const local = async (params) => ({ url: toQueryUrl('local', params), json: svc.query(params, 0) });

/** The execute route, through the real REST surface. */
const execute = (qs) => {
  const res = route({ path: `${base}/1/execute`, params: new URLSearchParams({ f: 'json', ...qs }) });
  assert.ok(res, 'no route for /1/execute');
  return JSON.parse(res.body);
};
/** A catalog row, as a client gets it. */
const catalogRow = (id) => toRows(JSON.parse(route({
  path: `${base}/1/query`,
  params: new URLSearchParams({ f: 'json', where: `QueryNumber = ${id}`, outFields: '*' }),
}).body))[0];

const parameterised = queryLibrary.filter((e) => paramsOf(e).length);

// ------------------------------------------------------------------ the declaration itself
test('the library declares bounded parameters on the questions that invite them', () => {
  assert.ok(parameterised.length >= 4, `only ${parameterised.length} parameterised entries`);
  for (const e of parameterised) {
    for (const p of paramsOf(e)) {
      assert.ok(p.name && /^[a-zA-Z][a-zA-Z0-9]*$/.test(p.name), `Q${e.id} parameter name ${p.name}`);
      assert.equal(p.type, 'int', `Q${e.id} ${p.name}: the only declared type so far is int`);
      assert.ok(Number.isInteger(p.min) && Number.isInteger(p.max) && p.min < p.max, `Q${e.id} ${p.name} range`);
      assert.ok(Number.isInteger(p.default), `Q${e.id} ${p.name} default`);
      assert.ok(p.default >= p.min && p.default <= p.max, `Q${e.id} ${p.name}: default outside its own range`);
      assert.ok(p.label, `Q${e.id} ${p.name}: no label for a client to render`);
      assert.ok(p.binds?.length, `Q${e.id} ${p.name}: declares no binding, so it cannot do anything`);
    }
  }
});

test('every bind names something the definition actually contains', () => {
  for (const e of parameterised) {
    for (const p of paramsOf(e)) {
      for (const b of p.binds) {
        if (b.in === 'rest') {
          assert.ok(requestsOf(e).some((r) => b.key in r.params),
            `Q${e.id} ${p.name} binds rest '${b.key}', which the entry does not set`);
        } else if (b.in === 'tsql') {
          const hits = e.tsql.split(b.find).length - 1;
          // Exactly once: `replace` swaps the first occurrence, so two would silently
          // leave the second one at the old value.
          assert.equal(hits, 1, `Q${e.id} ${p.name} binds T-SQL '${b.find}', found ${hits} times`);
        } else {
          assert.fail(`Q${e.id} ${p.name}: unknown bind target '${b.in}'`);
        }
      }
    }
  }
});

// ------------------------------------------------------------------ property 1: the default is the question
test('binding the declared defaults reproduces the published question exactly', () => {
  for (const e of parameterised) {
    const { entry, values, errors } = bindEntry(e);
    assert.deepEqual(errors, [], `Q${e.id}`);
    assert.deepEqual(entry.rest, e.rest, `Q${e.id}: default binding changed the REST parameters`);
    assert.equal(entry.tsql, e.tsql, `Q${e.id}: default binding changed the T-SQL`);
    for (const p of paramsOf(e)) assert.equal(values[p.name], p.default, `Q${e.id} ${p.name}`);
  }
});

test('an entry that declares no parameters is returned untouched', () => {
  const e = getQuery(1);
  const { entry, errors } = bindEntry(e);
  assert.equal(entry, e, 'the same object, so no consumer can see a difference');
  assert.deepEqual(errors, []);
  assert.deepEqual(bindEntry(e, { top: 5 }).errors, ['this question declares no parameters']);
});

// ------------------------------------------------------------------ binding does what it says
test('a bound value lands in both the REST request and the T-SQL', () => {
  const { entry } = bindEntry(getQuery(12), { top: 3 });
  assert.equal(entry.rest.resultRecordCount, 3);
  assert.match(entry.tsql, /SELECT TOP 3 Category/);

  const q27 = bindEntry(getQuery(27), { top: 2, days: 90 }).entry;
  assert.equal(q27.rest.resultRecordCount, 2);
  assert.match(q27.rest.where, /GETDATE\(\)\) > 90$/);
  assert.match(q27.tsql, /SELECT TOP 2 Category/);
  assert.match(q27.tsql, /GETDATE\(\)\) > 90 GROUP BY/);
  // The template rebuilt the clause rather than appending to it.
  assert.equal((q27.rest.where.match(/GETDATE/g) ?? []).length, 1);
});

test('the bound entry carries the values it was run with', () => {
  assert.deepEqual(bindEntry(getQuery(8), { top: 4 }).entry.paramValues, { top: 4, minClosed: 10 });
  assert.equal(getQuery(8).paramValues, undefined, 'the library entry itself is not mutated');
});

test('a bound question returns the number of rows it was asked for', async () => {
  for (const [id, top] of [[12, 3], [21, 4], [27, 2]]) {
    const { entry } = bindEntry(getQuery(id), { top });
    const r = await runEntry(entry, local);
    assert.equal(r.rows.length, top, `Q${id} with top=${top}`);
  }
});

test('REST and T-SQL still agree after binding, which is the point of binding both', async () => {
  for (const [id, values] of [[12, { top: 3 }], [27, { top: 3, days: 60 }], [8, { top: 4, minClosed: 20 }]]) {
    const { entry } = bindEntry(getQuery(id), values);
    const rest = await runEntry(entry, local);
    const sql = svc.sql(entry.tsql);
    assert.ok(!sql.error, `Q${id} T-SQL: ${sql.error?.message}`);
    const label = rest.columns[0];
    assert.deepEqual(
      rest.rows.map((r) => r[label]),
      sql.rows.map((r) => r[label]),
      `Q${id} ${JSON.stringify(values)}: the two verbs disagree after binding`,
    );
  }
});

test('a wider bound includes the narrower one: the parameter means what it says', async () => {
  const rows = async (values) => (await runEntry(bindEntry(getQuery(27), values).entry, local)).rows;
  const strict = await rows({ top: 25, days: 180 });
  const loose = await rows({ top: 25, days: 30 });
  const total = (rs) => rs.reduce((a, r) => a + r.StuckCount, 0);
  assert.ok(total(loose) > total(strict), `30 days (${total(loose)}) should find more than 180 (${total(strict)})`);
});

// ------------------------------------------------------------------ refusals
test('a value outside the ratified range is refused, not clamped', () => {
  for (const bad of [{ top: 0 }, { top: 26 }, { top: -1 }, { top: 1000 }]) {
    const { entry, errors } = bindEntry(getQuery(12), bad);
    assert.equal(errors.length, 1, JSON.stringify(bad));
    assert.match(errors[0], /'top' must be/);
    assert.deepEqual(entry.rest, getQuery(12).rest, 'the unbound question comes back, never a half-applied one');
  }
});

test('a value of the wrong type, or a name nobody declared, is refused', () => {
  assert.match(bindEntry(getQuery(12), { top: 'five' }).errors[0], /whole number/);
  assert.match(bindEntry(getQuery(12), { top: 2.5 }).errors[0], /whole number/);
  assert.match(bindEntry(getQuery(12), { limit: 5 }).errors[0], /not a parameter/);
});

test('validateParams fills defaults for everything left out', () => {
  const spec = paramsOf(getQuery(27));
  assert.deepEqual(validateParams(spec, {}).values, { top: 5, days: 30 });
  assert.deepEqual(validateParams(spec, { days: 7 }).values, { top: 5, days: 7 });
  assert.deepEqual(validateParams(spec, { days: '' }).values, { top: 5, days: 30 }, 'an empty input is not a value');
});

// ------------------------------------------------------------------ the catalog publishes the declaration
test('ParamSpec is published for exactly the questions that declare parameters', () => {
  const rows = toRows(JSON.parse(route({
    path: `${base}/1/query`,
    params: new URLSearchParams({ f: 'json', where: '1=1', outFields: 'QueryNumber,ParamSpec', orderByFields: 'QueryNumber', resultRecordCount: '2000' }),
  }).body));
  const declared = rows.filter((r) => r.ParamSpec).map((r) => r.QueryNumber);
  assert.deepEqual(declared, parameterised.map((e) => e.id));
  for (const r of rows.filter((x) => x.ParamSpec)) {
    assert.deepEqual(JSON.parse(r.ParamSpec), paramsOf(getQuery(r.QueryNumber)), `Q${r.QueryNumber} round-trip`);
  }
});

test('a client can ask the catalog what may be varied', () => {
  const body = JSON.parse(route({
    path: `${base}/1/query`,
    params: new URLSearchParams({ f: 'json', where: 'ParamSpec IS NOT NULL', outFields: 'QueryNumber,Question,ParamSpec' }),
  }).body);
  assert.equal(toRows(body).length, parameterised.length);
});

test('a catalog row alone is enough to run a variant: no library import anywhere', async () => {
  const entry = entryFromRow(catalogRow(12));
  assert.deepEqual(entry.params, paramsOf(getQuery(12)));
  const { entry: bound, errors } = bindEntry(entry, { top: 8 });
  assert.deepEqual(errors, []);
  const r = await runEntry(bound, local);
  assert.equal(r.rows.length, 8);
  // And the same row refuses the same bad value the library entry would.
  assert.match(bindEntry(entry, { top: 99 }).errors[0], /at most 25/);
});

// ------------------------------------------------------------------ property 2: the enforcing tier
test('the execute route runs a question from its identifier alone', () => {
  const r = execute({ q: '12' });
  assert.equal(r.queryNumber, 12);
  assert.equal(r.question, 'Top 5 categories with most requests');
  assert.deepEqual(r.parameters, { top: 5 }, 'the ratified default, applied by the service');
  assert.equal(r.rowCount, 5);
  assert.deepEqual(r.columns, ['Category', 'Count']);
  assert.equal(r.chart.type, 'bar');
});

test('the execute route honours a declared parameter', () => {
  assert.equal(execute({ q: '12', top: '10' }).rowCount, 10);
  const r = execute({ q: '27', top: '3', days: '90' });
  assert.deepEqual(r.parameters, { top: 3, days: 90 });
  assert.equal(r.rowCount, 3);
  assert.match(r.requests[0].params.where, /> 90$/);
});

test('the execute route enforces the bounds the client could ignore', () => {
  const r = execute({ q: '12', top: '500' });
  assert.equal(r.error.code, 400);
  assert.match(r.error.details.join(' '), /'top' must be at most 25/);
  assert.match(r.error.details.join(' '), /Declared: top \(int 1\.\.25, default 5\)/);
  assert.equal(r.rows, undefined, 'nothing ran');
});

test('the execute route refuses a definition rather than ignoring it', () => {
  for (const sent of [{ where: '1=1' }, { outStatistics: '[]' }, { resultRecordCount: '500' }, { groupByFieldsForStatistics: 'Suburb' }]) {
    const r = execute({ q: '12', ...sent });
    assert.equal(r.error?.code, 400, `${Object.keys(sent)[0]} was not refused`);
    assert.match(r.error.details.join(' '), new RegExp(`'${Object.keys(sent)[0]}' is not a parameter`));
  }
});

test('the execute route reports an unknown or missing identifier', () => {
  assert.equal(execute({ q: '999' }).error.code, 404);
  assert.match(execute({ q: 'everything' }).error.message, /must be a query number/);
  assert.match(execute({}).error.message, /Missing 'q'/);
});

test('the execute route applies the client-side transform on the service side', () => {
  const r = execute({ q: '13' });
  assert.deepEqual(r.transforms, ['runningTotal']);
  assert.ok(r.columns.includes('RunningTotal'), 'the transform ran, so the client gets a finished answer');
  assert.ok(r.rows.at(-1).RunningTotal > r.rows[0].RunningTotal);
});

test('every catalogued question runs by identifier, as a tier would forward it', () => {
  for (const e of queryLibrary) {
    const r = execute({ q: String(e.id) });
    assert.ok(!r.error, `Q${e.id}: ${r.error?.message} ${r.error?.details?.join(' ')}`);
    assert.equal(r.queryNumber, e.id);
    assert.equal(r.rowCount, r.rows.length);
  }
});

test('executing by identifier and replaying the row give the same answer', async () => {
  for (const [id, values] of [[12, { top: 9 }], [8, { top: 3, minClosed: 15 }], [13, {}], [25, {}]]) {
    const { entry } = bindEntry(entryFromRow(catalogRow(id)), values);
    const replayed = await runEntry(entry, local);
    const tiered = execute({ q: String(id), ...values });
    assert.deepEqual(tiered.rows, replayed.rows, `Q${id}`);
    assert.deepEqual(tiered.columns, replayed.columns, `Q${id}`);
  }
});

test('the HTML form offers an input per declared parameter', () => {
  const res = route({ path: `${base}/1/execute`, params: new URLSearchParams({ q: '27' }) });
  assert.match(res.contentType, /text\/html/);
  assert.match(res.body, /name="top"[^>]*min="1"[^>]*max="25"/);
  assert.match(res.body, /name="days"[^>]*min="1"[^>]*max="365"/);
  // And it says what it will not accept.
  assert.match(res.body, /is refused/);
});

test('the layer page advertises the operation, so it is discoverable', () => {
  const res = route({ path: `${base}/1`, params: new URLSearchParams({ f: 'html' }) });
  assert.match(res.body, /1\/execute">Execute \(mock extension\)/);
});
