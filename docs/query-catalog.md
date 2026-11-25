# The query catalog as a FeatureServer table

*For developers evaluating this pattern, and for anyone maintaining the library.*

The service publishes two things over one REST surface:

| Id | Name | Type | What it is |
|---|---|---|---|
| 0 | `ServiceRequests` | Feature Layer | the ~850 service request points |
| 1 | `QueryLibrary` | Table | the 70 analytical questions, as data |

A client needs exactly two requests, and both are the standard ArcGIS `query` operation:

```
1. discover   GET  …/FeatureServer/1/query?where=1=1&outFields=*
2. execute    POST …/FeatureServer/0/query   <the RestParams from a row of step 1>
```

Nothing about any individual question is compiled into the client. `viewer/js/catalog.js`
does step 1 at start-up and the run panels render whatever comes back; add a query to
`sql-library/queryLibrary.js`, restart the service, and it appears in the UI with no change
to the viewer. `test/catalog.test.js` asserts this for all 70: it reads each row over REST,
replays its `RestParams`, and requires the result to equal the library run exactly.

## Why the catalog stores parameters, not statements

The obvious design is to store the `SELECT` statement and POST it to the service. **A real
FeatureServer has no endpoint that accepts a SQL statement.** There is no `?sql=`; the
`/0/sql` route in this repo is labelled a mock extension for exactly that reason.

What the `query` operation *does* accept is SQL in pieces — `where`,
`groupByFieldsForStatistics`, `outStatistics.onStatisticField`, `having`, `orderByFields` —
and the service transforms and executes those server-side in its own engine. So the catalog's
`RestParams` column holds the decomposed query:

```json
{
  "where": "DtCompleted IS NOT NULL",
  "sqlFormat": "native",
  "groupByFieldsForStatistics": "Category",
  "outStatistics": [{ "statisticType": "avg",
                      "onStatisticField": "DATEDIFF(day, DtLogged, DtCompleted)",
                      "outStatisticFieldName": "AvgDays" }],
  "orderByFields": "AvgDays"
}
```

`SqlText` carries the equivalent T-SQL in the same row. It is not dead weight: it is the
reference definition the REST request must reproduce, the audit record of what a metric
means, and what you execute if you point the same catalog at SQL Server instead
(`sql/03_vw_QueryLibrary.sql` is generated from the same source).

## What this buys, and what it does not

Measured against the library as it stands — run `npm test` to re-check every number here.

**Holds.** Adding a metric is a data change, not a deployment. One generic pipeline serves
70 questions or 700. The catalog is self-documenting by construction: every row carries its
category, its business question and its portability. And because the catalog is a normal
table, it answers questions about itself with the same `query` operation — *"how portable is
this library?"* is one `outStatistics` call, no reporting code:

| `Portability` | Count | Runs on |
|---|---|---|
| `standard` | 32 | any FeatureServer |
| `sql-expression` | 14 | ArcGIS Online hosted, Enterprise 10.9+ |
| `native` | 23 | SQL Server-backed Enterprise, `sqlFormat=native` |
| `extension` | 1 | this mock only |

**Does not hold.** Three limits are real and worth stating before anyone builds on this:

1. **The `query` operation has no window functions.** Nine entries come back as raw groups
   and are finished on the client by `sql-library/runner.js` — `lag`, `runningTotal`,
   `movingAverage` and `rank` stand in for the SQL window functions of the same name, and
   `topPerGroup`, `fullOuterJoin`, `groupCount`, `ratio` and `sort` for the rest. The catalog is
   honest about it — the `Transforms` and `TransformSpec` columns name the step, so a client
   knows what it must apply — but the compute has moved to the client, which is the very
   failure mode this architecture is meant to avoid. There is no `ROLLUP` either, so subtotals
   cost a second request. One entry (Q62) needs two requests and a client-side full outer join.

2. **Date arithmetic is not portable.** 23 of 70 are tagged `native` almost entirely because
   standardized SQL has no date-difference function, so every duration and SLA metric needs
   `sqlFormat=native` against a SQL Server-backed service. The descriptive half of the library
   travels anywhere; the performance half — the half management asks for — does not.

3. **The catalog is a convention, not an access control.** `FeatureServer/0/query` still
   accepts an arbitrary `where` from anyone who can reach it. Publishing the catalog does not
   stop a client sending its own predicate and scanning an unindexed column. If you want the
   whitelist property — clients may pass only a query number — you need a tier in front that
   refuses to forward a client-supplied `where`, because the FeatureServer will not refuse it
   for you. What the catalog gives you here is governance of *definitions*, not of *access*.

## Adding a question

Add the entry to `sql-library/queryLibrary.js` with an honest `portability` tag, then
`npm run build` (regenerates `rest/library.http` and `sql/03_vw_QueryLibrary.sql`) and
`npm test`. `server/catalogSchema.js` derives the table from the library at load time, so
there is no separate catalog to keep in step.

See also: `rest/catalog.http` (the two-hop flow as runnable requests), `docs/framework.md`
(the 5W+H dimensions and analytical layers the catalog columns expose).
