import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFeatureService } from '../server/nodeRuntime.js';
import { config } from '../server/config.js';
import { queryLibrary } from '../sql-library/queryLibrary.js';
import { runEntry } from '../sql-library/runner.js';

const svc = createFeatureService(config);
const local = async (params) => ({ url: '(in-process)', json: svc.query(params) });

test('library has 31 unique entries', () => {
  assert.equal(queryLibrary.length, 31);
  assert.equal(new Set(queryLibrary.map((q) => q.id)).size, 31);
});

for (const entry of queryLibrary) {
  test(`Q${entry.id} REST: ${entry.question}`, async () => {
    const r = await runEntry(entry, local);
    assert.ok(Array.isArray(r.rows));
  });
  test(`Q${entry.id} T-SQL runs on the mock`, () => {
    const r = svc.sql(entry.tsql);
    assert.ok(!r.error, r.error && `${r.error.message} ${r.error.details}`);
  });
}

// REST and T-SQL should agree where both are exact equivalents
const scalar = (rows) => Object.values(rows[0])[0];
for (const [id, restKey] of [[1, 'count'], [18, 'count'], [30, 'count'], [57, 'count']]) {
  test(`Q${id} REST count == T-SQL count`, async () => {
    const entry = queryLibrary.find((q) => q.id === id);
    const rest = await runEntry(entry, local);
    assert.equal(rest.rows[0][restKey], scalar(svc.sql(entry.tsql).rows));
  });
}
test('Q41 top-5 categories match', async () => {
  const e = queryLibrary.find((q) => q.id === 41);
  const rest = await runEntry(e, local);
  assert.deepEqual(rest.rows.map((r) => r.Count), svc.sql(e.tsql).rows.map((r) => r.Count));
});
test('Q44 MoM percentages match T-SQL LAG', async () => {
  const e = queryLibrary.find((q) => q.id === 44);
  const rest = await runEntry(e, local);
  const t = svc.sql(e.tsql).rows;
  rest.rows.forEach((r, i) => assert.equal(r.PctChange, t[i].PctChange == null ? null : +t[i].PctChange.toFixed(2)));
});
test('Q26 median matches', async () => {
  const e = queryLibrary.find((q) => q.id === 26);
  assert.equal((await runEntry(e, local)).rows[0].MedianDays, svc.sql(e.tsql).rows[0].MedianDays);
});
test('rejects writes and multiple statements', () => {
  assert.ok(svc.query({ where: '1=1; DROP TABLE x' }).error);
  assert.ok(svc.sql('DELETE FROM ServiceRequest').error);
  assert.ok(svc.query({ where: "1=1 AND (SELECT 1)=1" }).error);
});
test('spatial envelope filter (4326)', () => {
  const all = svc.query({ returnCountOnly: true }).count;
  const sub = svc.query({ geometry: '18.40,-33.94,18.45,-33.90', inSR: 4326, returnCountOnly: true }).count;
  assert.ok(sub > 0 && sub < all);
});
test('point + distance buffer', () => {
  const r = svc.query({ geometry: '18.4241,-33.9249', geometryType: 'esriGeometryPoint', inSR: 4326, distance: 1500, units: 'esriSRUnit_Meter', returnCountOnly: true });
  assert.ok(r.count > 0);
});
