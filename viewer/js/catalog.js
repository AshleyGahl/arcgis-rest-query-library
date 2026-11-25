/**
 * Reads the query library from the FeatureServer instead of importing it.
 *
 * The catalog is table 1 of the same service (server/catalogSchema.js), so the
 * viewer discovers the analytical questions with one ordinary ArcGIS REST query:
 *
 *   POST .../FeatureServer/1/query   where=1=1&outFields=*
 *
 * Nothing about any individual question is compiled into the viewer. Add a query
 * to the library, restart the service, and it appears in the panel — the point of
 * publishing the catalog as data rather than as code.
 */
import { CONFIG } from './config.js';
import { toRows, entryFromRow } from '../../sql-library/runner.js';

// The row -> entry mapping lives in runner.js, because the service's own execute route
// does the same thing with the same rows (server/restRouter.js) and the two must not
// drift. The Chart* columns become `chart` and ParamSpec becomes `params`, so how a
// question is drawn and what may be varied both arrive with the question itself.

/**
 * Fetch the whole catalog.
 * @returns `{ entries, categories, url }` — categories in catalog order.
 */
export async function fetchCatalog() {
  const body = new URLSearchParams({ f: 'json', where: '1=1', outFields: '*', orderByFields: 'QueryNumber', resultRecordCount: '2000' });
  const res = await fetch(`${CONFIG.catalogUrl}/query`, { method: 'POST', body });
  const json = await res.json();
  if (json.error) throw new Error(`Query catalog unavailable: ${json.error.message}`);
  const entries = toRows(json).map(entryFromRow);
  if (!entries.length) throw new Error('The query catalog (FeatureServer table 1) returned no rows.');
  return { entries, categories: [...new Set(entries.map((e) => e.category))], url: `${CONFIG.catalogUrl}/query` };
}

/**
 * Counts per portability tag, asked of the catalog itself with outStatistics —
 * the catalog is a normal table, so it can be aggregated like one.
 */
export async function catalogStats() {
  const body = new URLSearchParams({
    f: 'json',
    where: '1=1',
    groupByFieldsForStatistics: 'Portability',
    outStatistics: JSON.stringify([{ statisticType: 'count', onStatisticField: 'ObjectID', outStatisticFieldName: 'Count' }]),
    orderByFields: 'Count DESC',
  });
  const res = await fetch(`${CONFIG.catalogUrl}/query`, { method: 'POST', body });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  return toRows(json);
}
