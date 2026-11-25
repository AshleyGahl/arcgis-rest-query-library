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
import { toRows } from '../../sql-library/runner.js';

/**
 * A catalog row, reshaped into the entry object runner.js and the panels expect.
 * The Chart* columns become `chart`, the presentation contract the result drawer
 * obeys — so how a question is drawn arrives in the same request as the question.
 */
const toEntry = (r) => ({
  id: r.QueryNumber,
  category: r.Category,
  question: r.Question,
  dimension: r.Dimension,
  layer: r.AnalyticLayer,
  portability: r.Portability,
  rest: JSON.parse(r.RestParams),
  transform: r.TransformSpec ? JSON.parse(r.TransformSpec) : undefined,
  chart: r.HasChart
    ? { type: r.ChartType, labels: r.ChartLabelColumn, values: r.ChartValueColumns, series: r.ChartSeriesColumn ?? undefined, annotation: r.ChartAnnotationColumn ?? undefined }
    : undefined,
  tsql: r.SqlText,
  notes: r.Notes ?? undefined,
});

/**
 * Fetch the whole catalog.
 * @returns `{ entries, categories, url }` — categories in catalog order.
 */
export async function fetchCatalog() {
  const body = new URLSearchParams({ f: 'json', where: '1=1', outFields: '*', orderByFields: 'QueryNumber', resultRecordCount: '2000' });
  const res = await fetch(`${CONFIG.catalogUrl}/query`, { method: 'POST', body });
  const json = await res.json();
  if (json.error) throw new Error(`Query catalog unavailable: ${json.error.message}`);
  const entries = toRows(json).map(toEntry);
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
