/**
 * The query library published as a FeatureServer *table* (layer 1).
 *
 * This is the catalog half of the architecture: instead of one HTTP endpoint per
 * analytical question, the questions themselves are data, served over the same
 * ArcGIS REST `query` operation as the features. A client does
 *
 *   GET .../FeatureServer/1/query?where=Portability='standard'&outFields=*
 *
 * to discover what can be asked, then takes the `RestParams` of a row and replays
 * it against
 *
 *   GET .../FeatureServer/0/query?<those parameters>
 *
 * where the service's own SQL engine transforms and executes it. Two generic
 * requests, both of them standard ArcGIS, and no analytics-specific API surface.
 *
 * `RestParams` holds the decomposed query (where / groupByFieldsForStatistics /
 * outStatistics / orderByFields / having) rather than a SELECT statement, because
 * that is what a real FeatureServer accepts — see docs/query-catalog.md. `SqlText`
 * carries the equivalent T-SQL alongside it for audit and for the SQL Server path.
 *
 * The `Chart*` columns carry the presentation contract in the same row, so one request
 * tells a client both what the question is and how its answer is drawn. There is no
 * per-question response type anywhere in this pipeline, so these columns are where the
 * shape of an answer is declared — docs/catalog-pattern.md section 2. A renderer that
 * guesses from the shape of the rows instead is making an inference, and an inference
 * cannot be wrong loudly. `HasChart = 0` is the author saying this result is a figure
 * or a list of features, not a chart.
 */
import { queryLibrary } from '../sql-library/queryLibrary.js';

export const CATALOG_FIELDS = [
  { name: 'ObjectID', type: 'esriFieldTypeOID', alias: 'ObjectID', sql: 'INTEGER PRIMARY KEY' },
  { name: 'QueryNumber', type: 'esriFieldTypeInteger', alias: 'Query Number' },
  { name: 'Category', type: 'esriFieldTypeString', alias: 'Category', length: 60 },
  { name: 'Question', type: 'esriFieldTypeString', alias: 'Question', length: 200 },
  { name: 'Dimension', type: 'esriFieldTypeString', alias: 'Dimension (5W+H)', length: 10 },
  { name: 'AnalyticLayer', type: 'esriFieldTypeString', alias: 'Analytical Layer', length: 4 },
  { name: 'Portability', type: 'esriFieldTypeString', alias: 'Portability', length: 20 },
  { name: 'RequestCount', type: 'esriFieldTypeSmallInteger', alias: 'REST Requests' },
  { name: 'Transforms', type: 'esriFieldTypeString', alias: 'Client Transforms', length: 100 },
  { name: 'HasChart', type: 'esriFieldTypeSmallInteger', alias: 'Has Chart' },
  { name: 'ChartType', type: 'esriFieldTypeString', alias: 'Chart Type', length: 20 },
  { name: 'ChartLabelColumn', type: 'esriFieldTypeString', alias: 'Chart Label Column', length: 100 },
  { name: 'ChartValueColumns', type: 'esriFieldTypeString', alias: 'Chart Value Columns', length: 200 },
  { name: 'ChartSeriesColumn', type: 'esriFieldTypeString', alias: 'Chart Series Column', length: 100 },
  { name: 'ChartAnnotationColumn', type: 'esriFieldTypeString', alias: 'Chart Annotation Column', length: 100 },
  { name: 'RestParams', type: 'esriFieldTypeString', alias: 'REST Parameters (JSON)', length: 4000 },
  { name: 'TransformSpec', type: 'esriFieldTypeString', alias: 'Transform Spec (JSON)', length: 1000 },
  { name: 'SqlText', type: 'esriFieldTypeString', alias: 'T-SQL', length: 4000 },
  { name: 'Notes', type: 'esriFieldTypeString', alias: 'Notes', length: 600 },
];

export const CATALOG_OID_FIELD = 'ObjectID';
export const CATALOG_DISPLAY_FIELD = 'Question';

/** The library as plain table rows, in query-number order. */
export const catalogRows = () =>
  queryLibrary
    .slice()
    .sort((a, b) => a.id - b.id)
    .map((e) => {
      const transforms = [e.transform ?? []].flat();
      const requests = Array.isArray(e.rest) ? e.rest : [{ name: 'main', params: e.rest }];
      return {
        ObjectID: e.id,
        QueryNumber: e.id,
        Category: e.category,
        Question: e.question,
        Dimension: e.dimension,
        AnalyticLayer: e.layer,
        Portability: e.portability,
        RequestCount: requests.length,
        Transforms: transforms.map((t) => t.type).join(', '),
        HasChart: e.chart ? 1 : 0,
        ChartType: e.chart?.type ?? null,
        ChartLabelColumn: e.chart?.labels ?? null,
        ChartValueColumns: e.chart?.values ?? null,
        ChartSeriesColumn: e.chart?.series ?? null,
        ChartAnnotationColumn: e.chart?.annotation ?? null,
        RestParams: JSON.stringify(Array.isArray(e.rest) ? e.rest : e.rest),
        TransformSpec: transforms.length ? JSON.stringify(transforms) : null,
        SqlText: e.tsql,
        Notes: e.notes ?? null,
      };
    });
