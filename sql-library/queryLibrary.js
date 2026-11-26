/**
 * Service Request Query Library — 70 analytical questions, each as an ArcGIS REST
 * FeatureServer `query` request with the equivalent T-SQL alongside.
 *
 * Schema (generic council "report a problem" model — docs/data-model.md):
 *   ObjectID, RequestID, Category, CategorySub, Status (Open | In Progress | Closed),
 *   Channel (App | Online form | Phone | Email | In person), Suburb, Description,
 *   DtLogged, DtCompleted
 *
 *   rest        : query parameters (object), or an array of { name, params } for multi-request entries
 *   transform   : optional client-side step(s) for things REST cannot do (window functions, joins) — runner.js
 *   params      : optional bounded parameters — the only sanctioned way for a client to vary
 *                 this question (see `param()` below). Published as the catalog's ParamSpec column.
 *   chart       : optional presentation contract — how the author says the result is drawn (see `chart()` below).
 *                 Absent means this result is not a chart: a single figure, or a list of features.
 *   portability : how far the REST request travels beyond this mock
 *       standard        plain fields, standard where clause — any ArcGIS FeatureServer
 *       sql-expression  standardized SQL functions (EXTRACT, CAST, CASE, CHAR_LENGTH, FLOOR) inside
 *                       groupBy / onStatisticField. Needs supportsSqlExpression (ArcGIS Online hosted, Enterprise 10.9+)
 *       native          T-SQL functions (DATEDIFF, DATEPART, FORMAT, LEN...). Needs sqlFormat=native on a
 *                       SQL Server-backed Enterprise service with useStandardizedQueries=false
 *       extension       mock-only feature (statisticType "countdistinct")
 *   dimension   : WHO | WHAT | WHEN | WHERE | WHY | HOW      (docs/framework.md §1)
 *   layer       : L1 Descriptive … L5 Advanced               (docs/framework.md §2)
 *
 * "expr AS Alias" in groupByFieldsForStatistics / outFields is a convenience this mock honours.
 * On a real service drop the alias; the expression becomes the output column name.
 */

const RES = 'DATEDIFF(day, DtLogged, DtCompleted)';
const AGE = 'DATEDIFF(day, DtLogged, GETDATE())';
const OPEN = "Status <> 'Closed'";
const AGE_CASE = `CASE WHEN ${AGE} <= 2 THEN '0-2 Days' WHEN ${AGE} <= 7 THEN '3-7 Days' WHEN ${AGE} <= 30 THEN '8-30 Days' ELSE '30+ Days' END`;
export const THEME_CASE = "CASE WHEN Category IN ('Water Supply', 'Wastewater & Stormwater', 'Flooding') THEN 'Three Waters' WHEN Category IN ('Roads & Footpaths', 'Streetlights', 'Abandoned Vehicles') THEN 'Transport' WHEN Category IN ('Rubbish & Recycling', 'Illegal Dumping') THEN 'Waste' WHEN Category IN ('Parks & Reserves', 'Trees') THEN 'Parks & Open Space' WHEN Category IN ('Noise', 'Animals', 'Graffiti') THEN 'Community & Regulatory' ELSE 'Other' END";

/**
 * Chart metadata: how the *author* says a result should be drawn, rather than leaving a
 * renderer to infer it from the shape of the rows. It is published as columns of the
 * catalog (server/catalogSchema.js), so a client is told the presentation contract in the
 * same request that tells it the question.
 *   labels      column naming the category axis; may name two (joined, e.g. Year + Month),
 *               or be null when the measures themselves are the categories
 *   values      the measure(s) to plot. Several are allowed only when they share a unit,
 *               because a chart gets one y-axis
 *   series      optional column to split into one dataset per distinct value
 *   annotation  optional column carried into the tooltip without being plotted — the place
 *               for a supporting count beside an average, or a second unit
 */
const chart = (type, labels, values, extra = {}) => ({ type, labels, values, ...extra });

/**
 * A bounded parameter: the one way a client may vary a catalogued question without
 * authoring one. The author declares the name, the type, the range they have ratified
 * and where the value lands — in the REST request, in the T-SQL statement, or both.
 *
 * The declared default must reproduce the question exactly as written here, because the
 * entry stores the *default rendering*, not a template: `resultRecordCount: 5` and
 * `TOP 5` stay literal, so every client that ignores the parameter still replays the
 * ratified question. `test/params.test.js` asserts that for every parameter.
 *
 * Binding is data, never a fragment of query text the client composes:
 *   { in: 'rest', key: 'resultRecordCount' }                 set that request parameter
 *   { in: 'rest', key: 'where', template: '… > {v}' }        rebuild it from a template
 *   { in: 'tsql', find: 'TOP 5', template: 'TOP {v}' }       swap that substring
 */
const param = (name, { label, type = 'int', min, max, default: def, binds, help }) =>
  ({ name, label, type, min, max, default: def, binds, ...(help ? { help } : {}) });

/** The commonest parameter by far: how many rows of a ranked question to return. */
const topN = (n, max = 25) => param('top', {
  label: 'Rows', min: 1, max, default: n,
  binds: [{ in: 'rest', key: 'resultRecordCount' }, { in: 'tsql', find: `TOP ${n}`, template: 'TOP {v}' }],
});

const count = (out = 'Count', field = 'ObjectID') => ({ statisticType: 'count', onStatisticField: field, outStatisticFieldName: out });
const stat = (statisticType, onStatisticField, outStatisticFieldName, extra = {}) => ({ statisticType, onStatisticField, outStatisticFieldName, ...extra });
const groupCount = (groupBy, orderByFields = 'Count DESC', extra = {}) => ({ where: '1=1', groupByFieldsForStatistics: groupBy, outStatistics: [count()], orderByFields, ...extra });

export const CATEGORIES = [
  'Basic Counts & Distribution', 'Time-Based Aggregations', 'Duration & Performance Metrics',
  'Filtered Queries (Specific Criteria)', 'Advanced Analytics (Ranking, Windows, etc.)', 'Service Levels & Thresholds',
  'Thematic / Hierarchical Groupings', 'Hotspots & Channel Performance', 'Data Quality & Integrity Checks',
  'Operational & Workload Insights', 'Text Mining & Description Analysis', 'Trend & Forecasting Prep',
];
const [BASIC, TIME, DURATION, FILTERED, ADVANCED, SLA, THEMATIC, HOTSPOT, DQ, OPS, TEXT, TREND] = CATEGORIES;

export const queryLibrary = [
  // ======================================================================= 1. BASIC COUNTS (0, 1, 2)
  { id: 0, category: BASIC, dimension: 'WHAT', layer: 'L1', portability: 'standard',
    question: 'Total number of service requests',
    rest: { where: '1=1', returnCountOnly: true },
    tsql: `SELECT COUNT(*) AS TotalRequests FROM ServiceRequest;` },
  { id: 1, category: BASIC, dimension: 'WHAT', layer: 'L1', portability: 'standard',
    question: 'Count by Category',
    chart: chart('bar', 'Category', 'Count'),
    rest: groupCount('Category'),
    tsql: `SELECT Category, COUNT(*) AS Count FROM ServiceRequest GROUP BY Category ORDER BY Count DESC;` },
  { id: 2, category: BASIC, dimension: 'WHAT', layer: 'L1', portability: 'standard',
    question: 'Count by Category and Status (cross-tab)',
    chart: chart('bar', 'Category', 'Count', { series: 'Status' }),
    rest: groupCount('Category,Status', 'Category, Status'),
    tsql: `SELECT Category, Status, COUNT(*) AS Count FROM ServiceRequest GROUP BY Category, Status ORDER BY Category, Status;` },
  // ======================================================================= 2. TIME-BASED (3, 4, 5, 6, 7)
  { id: 3, category: TIME, dimension: 'WHEN', layer: 'L2', portability: 'sql-expression',
    question: 'Requests by logged date (day)',
    chart: chart('line', 'LogDate', 'Count'),
    rest: groupCount('CAST(DtLogged AS DATE) AS LogDate', 'LogDate'),
    tsql: `SELECT CAST(DtLogged AS DATE) AS LogDate, COUNT(*) AS Count FROM ServiceRequest GROUP BY CAST(DtLogged AS DATE) ORDER BY LogDate;` },
  { id: 4, category: TIME, dimension: 'WHEN', layer: 'L2', portability: 'sql-expression',
    question: 'Requests by logged month and year',
    chart: chart('line', 'LogYear,LogMonth', 'Count'),
    rest: groupCount('EXTRACT(YEAR FROM DtLogged) AS LogYear, EXTRACT(MONTH FROM DtLogged) AS LogMonth', 'LogYear, LogMonth'),
    tsql: `SELECT YEAR(DtLogged) AS LogYear, MONTH(DtLogged) AS LogMonth, COUNT(*) AS Count FROM ServiceRequest GROUP BY YEAR(DtLogged), MONTH(DtLogged) ORDER BY LogYear, LogMonth;` },
  { id: 5, category: TIME, dimension: 'WHEN', layer: 'L2', portability: 'sql-expression',
    question: 'Requests by hour of day',
    chart: chart('bar', 'LogHour', 'Count'),
    rest: groupCount('EXTRACT(HOUR FROM DtLogged) AS LogHour', 'LogHour'),
    tsql: `SELECT DATEPART(hour, DtLogged) AS LogHour, COUNT(*) AS Count FROM ServiceRequest GROUP BY DATEPART(hour, DtLogged) ORDER BY LogHour;` },
  { id: 6, category: TIME, dimension: 'WHEN', layer: 'L2', portability: 'native',
    question: 'Weekly trend (ISO week, ISO year)',
    chart: chart('line', 'ISOYear,ISOWeek', 'Count'),
    notes: 'Groups by ISO year (not calendar YEAR) so weeks spanning New Year are not split.',
    rest: groupCount('DATEPART(iso_week, DtLogged) AS ISOWeek, YEAR(DATEADD(day, 26 - DATEPART(iso_week, DtLogged), DtLogged)) AS ISOYear', 'ISOYear, ISOWeek', { sqlFormat: 'native' }),
    tsql: `SELECT YEAR(DATEADD(day, 26 - DATEPART(iso_week, DtLogged), DtLogged)) AS ISOYear, DATEPART(iso_week, DtLogged) AS ISOWeek, COUNT(*) AS Count FROM ServiceRequest GROUP BY YEAR(DATEADD(day, 26 - DATEPART(iso_week, DtLogged), DtLogged)), DATEPART(iso_week, DtLogged) ORDER BY ISOYear, ISOWeek;` },
  { id: 7, category: TIME, dimension: 'WHEN', layer: 'L2', portability: 'standard',
    question: 'Count requests logged in the last 7 days',
    rest: { where: "DtLogged >= CURRENT_TIMESTAMP - INTERVAL '7' DAY", returnCountOnly: true },
    tsql: `SELECT COUNT(*) AS Last7Days FROM ServiceRequest WHERE DtLogged >= DATEADD(day, -7, GETDATE());` },
  // ======================================================================= 3. DURATION (8, 9, 10)
  { id: 8, category: DURATION, dimension: 'HOW', layer: 'L3', portability: 'native',
    question: 'Ten slowest sub-categories (average days to close, min 10 closed)',
    chart: chart('bar', 'CategorySub', 'AvgDays', { annotation: 'Closed' }),
    params: [topN(10), param('minClosed', { label: 'Minimum closed', min: 1, max: 200, default: 10,
      help: 'How many closed requests a sub-category needs before its average is reported',
      binds: [{ in: 'rest', key: 'having', template: 'COUNT(ObjectID) >= {v}' },
        { in: 'tsql', find: 'HAVING COUNT(*) >= 10', template: 'HAVING COUNT(*) >= {v}' }] })],
    rest: { where: "Status = 'Closed' AND DtCompleted IS NOT NULL", sqlFormat: 'native', groupByFieldsForStatistics: 'CategorySub',
      outStatistics: [stat('avg', RES, 'AvgDays'), count('Closed')], having: 'COUNT(ObjectID) >= 10', orderByFields: 'AvgDays DESC', resultRecordCount: 10 },
    tsql: `SELECT TOP 10 CategorySub, AVG(CAST(DATEDIFF(day, DtLogged, DtCompleted) AS FLOAT)) AS AvgDays, COUNT(*) AS Closed FROM ServiceRequest WHERE Status = 'Closed' AND DtCompleted IS NOT NULL GROUP BY CategorySub HAVING COUNT(*) >= 10 ORDER BY AvgDays DESC;` },
  { id: 9, category: DURATION, dimension: 'HOW', layer: 'L3', portability: 'native',
    question: 'Median resolution time (using PERCENTILE_CONT)',
    rest: { where: 'DtCompleted IS NOT NULL', sqlFormat: 'native', outStatistics: [stat('percentile_cont', RES, 'MedianDays', { statisticParameters: { value: 0.5 } })] },
    tsql: `SELECT DISTINCT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY DATEDIFF(day, DtLogged, DtCompleted)) OVER () AS MedianDays FROM ServiceRequest WHERE DtCompleted IS NOT NULL;` },
  { id: 10, category: DURATION, dimension: 'HOW', layer: 'L3', portability: 'standard',
    question: 'Requests completed on the same day they were logged',
    rest: { where: 'DtCompleted IS NOT NULL AND CAST(DtLogged AS DATE) = CAST(DtCompleted AS DATE)', returnCountOnly: true },
    tsql: `SELECT COUNT(*) AS SameDayCompleted FROM ServiceRequest WHERE DtCompleted IS NOT NULL AND CAST(DtLogged AS DATE) = CAST(DtCompleted AS DATE);` },

  // ======================================================================= 4. FILTERED (11)
  { id: 11, category: FILTERED, dimension: 'WHERE', layer: 'L4', portability: 'standard',
    question: "Open requests in Khayelitsha",
    rest: { where: `Suburb = 'Khayelitsha' AND ${OPEN}`, outFields: '*', orderByFields: 'ObjectID DESC' },
    tsql: `SELECT * FROM ServiceRequest WHERE Suburb = 'Khayelitsha' AND Status <> 'Closed';` },
  // ======================================================================= 5. ADVANCED (12, 13, 14, 15, 16, 17)
  { id: 12, category: ADVANCED, dimension: 'WHAT', layer: 'L5', portability: 'standard',
    question: 'Top 5 categories with most requests',
    chart: chart('bar', 'Category', 'Count'),
    params: [topN(5)],
    rest: groupCount('Category', 'Count DESC', { resultRecordCount: 5 }),
    tsql: `SELECT TOP 5 Category, COUNT(*) AS Count FROM ServiceRequest GROUP BY Category ORDER BY Count DESC;` },
  { id: 13, category: ADVANCED, dimension: 'WHEN', layer: 'L5', portability: 'sql-expression',
    question: 'Running total of requests per day (cumulative)',
    chart: chart('line', 'LogDate', 'RunningTotal', { annotation: 'DailyCount' }),
    rest: { where: '1=1', groupByFieldsForStatistics: 'CAST(DtLogged AS DATE) AS LogDate', outStatistics: [count('DailyCount')], orderByFields: 'LogDate' },
    transform: { type: 'runningTotal', field: 'DailyCount', as: 'RunningTotal' },
    tsql: `WITH Daily AS (SELECT CAST(DtLogged AS DATE) AS LogDate, COUNT(*) AS DailyCount FROM ServiceRequest GROUP BY CAST(DtLogged AS DATE)) SELECT LogDate, DailyCount, SUM(DailyCount) OVER (ORDER BY LogDate) AS RunningTotal FROM Daily ORDER BY LogDate;` },
  { id: 14, category: ADVANCED, dimension: 'WHEN', layer: 'L5', portability: 'sql-expression',
    question: 'Month-over-month percentage change in request volume',
    chart: chart('line', 'Yr,Mo', 'PctChange', { annotation: 'Cnt' }),
    rest: { where: '1=1', groupByFieldsForStatistics: 'EXTRACT(YEAR FROM DtLogged) AS Yr, EXTRACT(MONTH FROM DtLogged) AS Mo', outStatistics: [count('Cnt')], orderByFields: 'Yr, Mo' },
    transform: { type: 'lag', field: 'Cnt', offset: 1, as: 'PrevMonthCnt', pctAs: 'PctChange' },
    tsql: `WITH Monthly AS (SELECT YEAR(DtLogged) AS Yr, MONTH(DtLogged) AS Mo, COUNT(*) AS Cnt FROM ServiceRequest GROUP BY YEAR(DtLogged), MONTH(DtLogged)) SELECT Yr, Mo, Cnt, LAG(Cnt) OVER (ORDER BY Yr, Mo) AS PrevMonthCnt, CASE WHEN LAG(Cnt) OVER (ORDER BY Yr, Mo) IS NOT NULL THEN (Cnt - LAG(Cnt) OVER (ORDER BY Yr, Mo)) * 1.0 / LAG(Cnt) OVER (ORDER BY Yr, Mo) * 100 ELSE NULL END AS PctChange FROM Monthly ORDER BY Yr, Mo;` },
  { id: 15, category: ADVANCED, dimension: 'HOW', layer: 'L5', portability: 'native',
    question: 'Rank categories by average completion time (fastest first)',
    chart: chart('bar', 'Category', 'AvgDays', { annotation: 'SpeedRank' }),
    rest: { where: 'DtCompleted IS NOT NULL', sqlFormat: 'native', groupByFieldsForStatistics: 'Category', outStatistics: [stat('avg', RES, 'AvgDays')], orderByFields: 'AvgDays' },
    transform: { type: 'rank', field: 'AvgDays', as: 'SpeedRank' },
    tsql: `SELECT Category, AVG(CAST(DATEDIFF(day, DtLogged, DtCompleted) AS FLOAT)) AS AvgDays, RANK() OVER (ORDER BY AVG(CAST(DATEDIFF(day, DtLogged, DtCompleted) AS FLOAT))) AS SpeedRank FROM ServiceRequest WHERE DtCompleted IS NOT NULL GROUP BY Category ORDER BY SpeedRank;` },
  { id: 16, category: ADVANCED, dimension: 'WHO', layer: 'L5', portability: 'standard',
    question: 'For each Channel, count of distinct categories reported',
    chart: chart('bar', 'Channel', 'DistinctCategories'),
    rest: groupCount('Channel,Category', 'Channel, Category'),
    transform: { type: 'groupCount', by: 'Channel', as: 'DistinctCategories' },
    tsql: `SELECT Channel, COUNT(DISTINCT Category) AS DistinctCategories FROM ServiceRequest GROUP BY Channel ORDER BY Channel;` },
  { id: 17, category: ADVANCED, dimension: 'HOW', layer: 'L5', portability: 'native',
    question: 'Distribution of resolution days (buckets of 5)',
    chart: chart('bar', 'BucketStart', 'Count', { annotation: 'BucketEnd' }),
    rest: { where: 'DtCompleted IS NOT NULL AND DtCompleted >= DtLogged', sqlFormat: 'native', groupByFieldsForStatistics: `FLOOR(${RES} / 5) * 5 AS BucketStart, FLOOR(${RES} / 5) * 5 + 4 AS BucketEnd`, outStatistics: [count()], orderByFields: 'BucketStart' },
    tsql: `SELECT FLOOR(DATEDIFF(day, DtLogged, DtCompleted) / 5) * 5 AS BucketStart, FLOOR(DATEDIFF(day, DtLogged, DtCompleted) / 5) * 5 + 4 AS BucketEnd, COUNT(*) AS Count FROM ServiceRequest WHERE DtCompleted IS NOT NULL AND DtCompleted >= DtLogged GROUP BY FLOOR(DATEDIFF(day, DtLogged, DtCompleted) / 5) ORDER BY BucketStart;` },
  // ======================================================================= 6. SERVICE LEVELS (18, 19)
  { id: 18, category: SLA, dimension: 'HOW', layer: 'L3', portability: 'native',
    question: 'Share of completed requests that took longer than 5 days',
    rest: { where: 'DtCompleted IS NOT NULL', sqlFormat: 'native',
      outStatistics: [count('TotalCompleted'), stat('sum', `CASE WHEN ${RES} > 5 THEN 1 ELSE 0 END`, 'Over5Days')] },
    transform: { type: 'ratio', numerator: 'Over5Days', denominator: 'TotalCompleted', as: 'Over5DaysPct' },
    tsql: `SELECT COUNT(*) AS TotalCompleted, SUM(CASE WHEN DATEDIFF(day, DtLogged, DtCompleted) > 5 THEN 1 ELSE 0 END) AS Over5Days, CAST(SUM(CASE WHEN DATEDIFF(day, DtLogged, DtCompleted) > 5 THEN 1 ELSE 0 END) * 100.0 / COUNT(*) AS DECIMAL(5,2)) AS Over5DaysPct FROM ServiceRequest WHERE DtCompleted IS NOT NULL;` },
  { id: 19, category: SLA, dimension: 'HOW', layer: 'L3', portability: 'native',
    question: '90th percentile resolution time',
    rest: { where: 'DtCompleted IS NOT NULL', sqlFormat: 'native', outStatistics: [stat('percentile_cont', RES, 'P90_Days', { statisticParameters: { value: 0.9 } })] },
    tsql: `SELECT DISTINCT PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY DATEDIFF(day, DtLogged, DtCompleted)) OVER () AS P90_Days FROM ServiceRequest WHERE DtCompleted IS NOT NULL;` },

  // ======================================================================= 7. THEMATIC (20)
  { id: 20, category: THEMATIC, dimension: 'WHAT', layer: 'L5', portability: 'native',
    question: 'Thematic grouping of categories (Three Waters, Transport, Waste, …)',
    chart: chart('bar', 'Theme', 'Count', { annotation: 'AvgResolutionDays' }),
    rest: { where: '1=1', sqlFormat: 'native', groupByFieldsForStatistics: `${THEME_CASE} AS Theme`,
      outStatistics: [count(), stat('avg', RES, 'AvgResolutionDays')], orderByFields: 'Count DESC' },
    tsql: `SELECT ${THEME_CASE} AS Theme, COUNT(*) AS Count, AVG(CAST(DATEDIFF(day, DtLogged, DtCompleted) AS FLOAT)) AS AvgResolutionDays FROM ServiceRequest GROUP BY ${THEME_CASE} ORDER BY Count DESC;` },

  // ======================================================================= 8. HOTSPOTS & CHANNELS (21, 22)
  { id: 21, category: HOTSPOT, dimension: 'WHERE', layer: 'L5', portability: 'extension',
    question: 'Top 10 suburb hotspots (volume, variety, first and last report)',
    chart: chart('bar', 'Suburb', 'RequestCount', { annotation: 'DistinctTypes' }),
    params: [topN(10)],
    notes: "statisticType 'countdistinct' is a mock extension. On a real service drop DistinctTypes or run a second groupBy Suburb,CategorySub query.",
    rest: { where: 'Suburb IS NOT NULL', groupByFieldsForStatistics: 'Suburb',
      outStatistics: [count('RequestCount'), stat('countdistinct', 'CategorySub', 'DistinctTypes'), stat('min', 'DtLogged', 'FirstRequest'), stat('max', 'DtLogged', 'LastRequest')],
      orderByFields: 'RequestCount DESC', resultRecordCount: 10 },
    tsql: `SELECT TOP 10 Suburb, COUNT(*) AS RequestCount, COUNT(DISTINCT CategorySub) AS DistinctTypes, MIN(DtLogged) AS FirstRequest, MAX(DtLogged) AS LastRequest FROM ServiceRequest WHERE Suburb IS NOT NULL GROUP BY Suburb ORDER BY RequestCount DESC;` },
  { id: 22, category: HOTSPOT, dimension: 'HOW', layer: 'L3', portability: 'native',
    question: 'Channel efficiency (which channel gets closed fastest?)',
    chart: chart('bar', 'Channel', 'Total,StillOpen', { annotation: 'AvgCloseDays' }),
    rest: { where: '1=1', sqlFormat: 'native', groupByFieldsForStatistics: 'Channel',
      outStatistics: [count('Total'), stat('avg', RES, 'AvgCloseDays'), stat('sum', "CASE WHEN Status <> 'Closed' THEN 1 ELSE 0 END", 'StillOpen')], orderByFields: 'AvgCloseDays' },
    tsql: `SELECT Channel, COUNT(*) AS Total, AVG(CAST(DATEDIFF(day, DtLogged, DtCompleted) AS FLOAT)) AS AvgCloseDays, SUM(CASE WHEN Status <> 'Closed' THEN 1 ELSE 0 END) AS StillOpen FROM ServiceRequest GROUP BY Channel ORDER BY AvgCloseDays;` },

  // ======================================================================= 9. DATA QUALITY (23, 24)
  { id: 23, category: DQ, dimension: 'WHY', layer: 'L4', portability: 'standard',
    question: 'Invalid dates (completed before logged)',
    rest: { where: 'DtCompleted IS NOT NULL AND DtCompleted < DtLogged', returnCountOnly: true },
    tsql: `SELECT COUNT(*) AS DataErrors FROM ServiceRequest WHERE DtCompleted IS NOT NULL AND DtCompleted < DtLogged;` },
  { id: 24, category: DQ, dimension: 'WHERE', layer: 'L4', portability: 'sql-expression',
    question: 'Requests with missing fields (Suburb, CategorySub, Description)',
    chart: chart('bar', null, 'MissingSuburb,MissingCategorySub,MissingDescription'),
    rest: { where: '1=1', outStatistics: [
      stat('sum', 'CASE WHEN Suburb IS NULL THEN 1 ELSE 0 END', 'MissingSuburb'),
      stat('sum', "CASE WHEN CategorySub IS NULL OR CategorySub = '' THEN 1 ELSE 0 END", 'MissingCategorySub'),
      stat('sum', "CASE WHEN Description IS NULL OR Description = '' THEN 1 ELSE 0 END", 'MissingDescription')] },
    tsql: `SELECT SUM(CASE WHEN Suburb IS NULL THEN 1 ELSE 0 END) AS MissingSuburb, SUM(CASE WHEN CategorySub IS NULL OR CategorySub = '' THEN 1 ELSE 0 END) AS MissingCategorySub, SUM(CASE WHEN Description IS NULL OR Description = '' THEN 1 ELSE 0 END) AS MissingDescription FROM ServiceRequest;` },
  // ======================================================================= 10. OPERATIONAL (25, 26, 27, 28)
  { id: 25, category: OPS, dimension: 'HOW', layer: 'L5', portability: 'sql-expression',
    question: 'Monthly throughput (logged vs completed side by side)',
    chart: chart('bar', 'Year,Month', 'Logged,Completed', { annotation: 'NetBacklogChange' }),
    rest: [
      { name: 'logged', params: { where: '1=1', groupByFieldsForStatistics: 'EXTRACT(YEAR FROM DtLogged) AS Year, EXTRACT(MONTH FROM DtLogged) AS Month', outStatistics: [count('Logged')], orderByFields: 'Year, Month' } },
      { name: 'completed', params: { where: 'DtCompleted IS NOT NULL', groupByFieldsForStatistics: 'EXTRACT(YEAR FROM DtCompleted) AS Year, EXTRACT(MONTH FROM DtCompleted) AS Month', outStatistics: [count('Completed')], orderByFields: 'Year, Month' } },
    ],
    transform: { type: 'fullOuterJoin', left: 'logged', right: 'completed', on: ['Year', 'Month'], fill0: ['Logged', 'Completed'], diff: { as: 'NetBacklogChange', a: 'Logged', b: 'Completed' } },
    tsql: `WITH MonthlyLogs AS (SELECT YEAR(DtLogged) AS Yr, MONTH(DtLogged) AS Mo, COUNT(*) AS Logged FROM ServiceRequest GROUP BY YEAR(DtLogged), MONTH(DtLogged)), MonthlyCompletes AS (SELECT YEAR(DtCompleted) AS Yr, MONTH(DtCompleted) AS Mo, COUNT(*) AS Completed FROM ServiceRequest WHERE DtCompleted IS NOT NULL GROUP BY YEAR(DtCompleted), MONTH(DtCompleted)) SELECT ISNULL(L.Yr, C.Yr) AS [Year], ISNULL(L.Mo, C.Mo) AS [Month], ISNULL(L.Logged, 0) AS Logged, ISNULL(C.Completed, 0) AS Completed, ISNULL(L.Logged, 0) - ISNULL(C.Completed, 0) AS NetBacklogChange FROM MonthlyLogs L FULL OUTER JOIN MonthlyCompletes C ON L.Yr = C.Yr AND L.Mo = C.Mo ORDER BY [Year], [Month];` },
  { id: 26, category: OPS, dimension: 'WHO', layer: 'L1', portability: 'sql-expression',
    question: 'Pivot: Channel vs Status (conditional aggregation)',
    chart: chart('bar', 'Channel', 'OpenCount,InProgress,Closed', { annotation: 'Total' }),
    rest: { where: '1=1', groupByFieldsForStatistics: 'Channel', outStatistics: [
      count('Total'),
      stat('sum', "CASE WHEN Status = 'Open' THEN 1 ELSE 0 END", 'OpenCount'),
      stat('sum', "CASE WHEN Status = 'In Progress' THEN 1 ELSE 0 END", 'InProgress'),
      stat('sum', "CASE WHEN Status = 'Closed' THEN 1 ELSE 0 END", 'Closed')], orderByFields: 'Channel' },
    tsql: `SELECT Channel, COUNT(*) AS Total, SUM(CASE WHEN Status = 'Open' THEN 1 ELSE 0 END) AS OpenCount, SUM(CASE WHEN Status = 'In Progress' THEN 1 ELSE 0 END) AS InProgress, SUM(CASE WHEN Status = 'Closed' THEN 1 ELSE 0 END) AS Closed FROM ServiceRequest GROUP BY Channel ORDER BY Channel;` },
  { id: 27, category: OPS, dimension: 'WHY', layer: 'L4', portability: 'native',
    question: 'Which categories have the most requests stuck open for more than 30 days?',
    chart: chart('bar', 'Category', 'StuckCount'),
    params: [topN(5), param('days', { label: 'Open longer than (days)', min: 1, max: 365, default: 30,
      help: 'The age at which an open request counts as stuck',
      binds: [{ in: 'rest', key: 'where', template: `${OPEN} AND ${AGE} > {v}` },
        { in: 'tsql', find: 'DATEDIFF(day, DtLogged, GETDATE()) > 30', template: 'DATEDIFF(day, DtLogged, GETDATE()) > {v}' }] })],
    rest: { where: `${OPEN} AND ${AGE} > 30`, sqlFormat: 'native', groupByFieldsForStatistics: 'Category', outStatistics: [count('StuckCount')], orderByFields: 'StuckCount DESC', resultRecordCount: 5 },
    tsql: `SELECT TOP 5 Category, COUNT(*) AS StuckCount FROM ServiceRequest WHERE Status <> 'Closed' AND DATEDIFF(day, DtLogged, GETDATE()) > 30 GROUP BY Category ORDER BY StuckCount DESC;` },
  { id: 28, category: OPS, dimension: 'WHERE', layer: 'L5', portability: 'standard',
    question: 'Which category dominates each suburb?',
    chart: chart('bar', 'Suburb', 'Requests', { series: 'Category' }),
    rest: { where: 'Suburb IS NOT NULL', groupByFieldsForStatistics: 'Suburb,Category', outStatistics: [count('Requests')], orderByFields: 'Suburb, Requests DESC, Category' },
    transform: { type: 'topPerGroup', partition: 'Suburb', orderBy: 'Requests' },
    tsql: `WITH SuburbCategoryCounts AS (SELECT Suburb, Category, COUNT(*) AS Cnt, ROW_NUMBER() OVER (PARTITION BY Suburb ORDER BY COUNT(*) DESC, Category) AS rn FROM ServiceRequest WHERE Suburb IS NOT NULL GROUP BY Suburb, Category) SELECT Suburb, Category AS TopCategory, Cnt AS Requests FROM SuburbCategoryCounts WHERE rn = 1 ORDER BY Suburb;` },

  // ======================================================================= 11. TEXT MINING (29)
  { id: 29, category: TEXT, dimension: 'WHAT', layer: 'L4', portability: 'sql-expression',
    question: 'Average description length per Category',
    chart: chart('bar', 'Category', 'AvgDescLength', { annotation: 'Count' }),
    rest: { where: 'Description IS NOT NULL', groupByFieldsForStatistics: 'Category', outStatistics: [stat('avg', 'CHAR_LENGTH(Description)', 'AvgDescLength'), count()], having: 'COUNT(ObjectID) > 10', orderByFields: 'AvgDescLength DESC' },
    tsql: `SELECT Category, AVG(CAST(LEN(Description) AS FLOAT)) AS AvgDescLength, COUNT(*) AS Count FROM ServiceRequest WHERE Description IS NOT NULL GROUP BY Category HAVING COUNT(*) > 10 ORDER BY AvgDescLength DESC;` },

  // ======================================================================= 12. TREND (30)
  { id: 30, category: TREND, dimension: 'WHEN', layer: 'L5', portability: 'sql-expression',
    question: 'Moving 7-day average of new requests (to smooth daily noise)',
    chart: chart('line', 'LogDate', 'DailyTotal,MovingAvg7Days'),
    notes: 'The window is 7 rows (days with requests), not 7 calendar days.',
    rest: { where: '1=1', groupByFieldsForStatistics: 'CAST(DtLogged AS DATE) AS LogDate', outStatistics: [count('DailyTotal')], orderByFields: 'LogDate' },
    transform: [{ type: 'movingAverage', field: 'DailyTotal', window: 7, as: 'MovingAvg7Days' }, { type: 'sort', field: 'LogDate', desc: true }],
    tsql: `WITH DailyCounts AS (SELECT CAST(DtLogged AS DATE) AS LogDate, COUNT(*) AS DailyTotal FROM ServiceRequest GROUP BY CAST(DtLogged AS DATE)) SELECT LogDate, DailyTotal, AVG(CAST(DailyTotal AS FLOAT)) OVER (ORDER BY LogDate ROWS BETWEEN 6 PRECEDING AND CURRENT ROW) AS MovingAvg7Days FROM DailyCounts ORDER BY LogDate DESC;` },
];

export const getQuery = (id) => queryLibrary.find((q) => q.id === Number(id));
export default queryLibrary;
