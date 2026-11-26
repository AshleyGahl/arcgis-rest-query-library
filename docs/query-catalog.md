# The query catalog as a FeatureServer table

*For developers evaluating this pattern, and for anyone maintaining the library.*

The service publishes two things over one REST surface:

| Id | Name | Type | What it is |
|---|---|---|---|
| 0 | `ServiceRequests` | Feature Layer | the ~850 service request points |
| 1 | `QueryLibrary` | Table | the 31 analytical questions, as data |

A client needs exactly two requests, and both are the standard ArcGIS `query` operation:

```
1. discover   GET  …/FeatureServer/1/query?where=1=1&outFields=*
2. execute    POST …/FeatureServer/0/query   <the RestParams from a row of step 1>
```

Nothing about any individual question is compiled into the client. `viewer/js/catalog.js`
does step 1 at start-up and the run panels render whatever comes back; add a query to
`sql-library/queryLibrary.js`, restart the service, and it appears in the UI with no change
to the viewer. `test/catalog.test.js` asserts this for all 31: it reads each row over REST,
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

## What else the row carries

A client that has the parameters still has to decide what to do with the rows that come back,
and that decision is in the row too. Six `Chart*` columns say how the author intends the answer
to be drawn:

```
HasChart = 1, ChartType = 'bar', ChartLabelColumn = 'CategorySub',
ChartValueColumns = 'AvgDays', ChartAnnotationColumn = 'Closed'
```

Twenty-three of the thirty-one questions carry a contract; the rest declare `HasChart = 0`, because a
single figure or a list of features is not a chart. Being data, the contract is queryable like
anything else — `where=HasChart=1` returns the questions a client can draw, and grouping by
`ChartType` counts them by kind, with no reporting code on either side.

The alternative is for the client to infer the chart from the shape of the result, which this
viewer still does for anything with no contract (the SQL console, an edited statement). The
difference is not cosmetic: a declared contract can be checked, and `test/catalog.test.js`
checks every one of the forty-four against the columns its question actually returns. An
inference cannot be checked, because it has not claimed anything.

One more column says what a *user* may change. Six questions carry a `ParamSpec`: a typed,
bounded parameter with the range its author ratified and a declaration of where the value lands
in the definition.

```
ParamSpec of Q27 = [{ name: 'top',  type: 'int', min: 1, max:  25, default:  5, binds: […] },
                    { name: 'days', type: 'int', min: 1, max: 365, default: 30, binds: […] }]
```

This is the answer to *"can I see ten instead of five?"* — the question every catalogue of
canned reports eventually gets, and the one that usually ends with someone adding a free-text
SQL box. A declared parameter answers it without anyone composing a statement: the row stores
the default rendering (`resultRecordCount: 5`, `TOP 5`), so a client that ignores `ParamSpec`
replays the ratified question, and one that honours it can only move inside the declared range.
Either the REST request or the T-SQL can be bound, so the variant is the same question under
both verbs.

`SqlText` carries the equivalent T-SQL in the same row. It is not dead weight: it is the
reference definition the REST request must reproduce, the audit record of what a metric
means, and what you execute if you point the same catalog at a relational database instead —
SQL Server here, as the example database (`sql/03_vw_QueryLibrary.sql` is generated from the same
source).

## What this buys, and what it does not

Measured against the library as it stands — run `npm test` to re-check every number here.

**Holds.** Adding a metric is a data change, not a deployment. One generic pipeline serves
31 questions or 300. The catalog is self-documenting by construction: every row carries its
category, its business question and its portability. And because the catalog is a normal
table, it answers questions about itself with the same `query` operation — *"how portable is
this library?"* is one `outStatistics` call, no reporting code:

| `Portability` | Count | Runs on |
|---|---|---|
| `standard` | 10 | any FeatureServer |
| `sql-expression` | 10 | ArcGIS Online hosted, Enterprise 10.9+ |
| `native` | 10 | RDBMS-backed Enterprise, `sqlFormat=native` |
| `extension` | 1 | this mock only |

**Does not hold.** Four limits are real and worth stating before anyone builds on this:

1. **The `query` operation has no window functions.** Eight entries come back as raw groups
   and are finished on the client by `sql-library/runner.js` — `lag`, `runningTotal`,
   `movingAverage` and `rank` stand in for the SQL window functions of the same name, and
   `topPerGroup`, `fullOuterJoin`, `groupCount`, `ratio` and `sort` for the rest. The catalog is
   honest about it — the `Transforms` and `TransformSpec` columns name the step, so a client
   knows what it must apply — but the compute has moved to the client, which is the very
   failure mode this architecture is meant to avoid. There is no `ROLLUP` either, so subtotals
   cost a second request. One entry (Q25) needs two requests and a client-side full outer join.

2. **Date arithmetic is not portable.** 10 of 31 are tagged `native` almost entirely because
   standardized SQL has no date-difference function, so every duration and SLA metric needs
   `sqlFormat=native` against an RDBMS-backed service. The descriptive half of the library
   travels anywhere; the performance half — the half management asks for — does not.

3. **The catalog is a convention, not an access control.** `FeatureServer/0/query` still
   accepts an arbitrary `where` from anyone who can reach it. Publishing the catalog does not
   stop a client sending its own predicate and scanning an unindexed column. If you want the
   whitelist property — clients may pass only a query number — you need a tier in front that
   refuses to forward a client-supplied `where`, because the FeatureServer will not refuse it
   for you. What the catalog gives you here is governance of *definitions*, not of *access*.

   The mock now ships that tier, as a mock extension rather than as ArcGIS REST, so the cost can
   be read rather than guessed at: `…/FeatureServer/1/execute?q=27&top=3&days=90` accepts a
   question number and declared parameters only, resolves the row through layer 1, enforces the
   `ParamSpec` bounds and executes. It is about sixty lines and it knows no individual question —
   see [the catalog pattern](catalog-pattern.md) for why that one component is what the whole
   invariant hangs on. Layer 0 is unchanged and still accepts anything, which is the point: the
   tier is something you put *in front*, not a setting you switch on.

4. **Publishing the definition is a disclosure decision, and this repo makes the easy version
   of it.** `RestParams` and `SqlText` are columns of a table any reader of the service can
   query, so every metric formula in the library is public. Three claims about that need to be
   kept apart, because they have different answers.

   *It does not cost enforcement.* Withholding the definitions recovers nothing while layer 0
   accepts a predicate: a reader who cannot see `SqlText` can still send the equivalent `where`
   by hand. Authority comes from the input type of the executor, not from the definition being
   secret — [the catalog pattern](catalog-pattern.md) argues that at length. Hiding the menu
   does not close the kitchen door.

   *The disclosure is near-zero here, and that does not generalise.* Every statement in this
   library reads `FROM ServiceRequest` and its own CTEs — no lookup table, no second fact table,
   nothing the service does not already publish, since `…/FeatureServer/0?f=json` lists every
   field and type anyway. A production library is not like that. One entry that joins a lookup,
   a staff table, or a view whose `WHERE` encodes an access rule, and `SqlText` discloses schema
   the service deliberately does not expose. The formulas can be the sensitive part on their own
   terms, too: how an SLA breach is defined is sometimes a position, not a fact.

   *The fix is a column split, not concealment.* The definition columns are readable by clients
   only because a FeatureServer cannot execute by identifier, so the client has to replay them.
   Give it the `/1/execute` tier from limit 3 and the split falls along the trust boundary:
   `Question`, `Category`, `Portability`, `ParamSpec` and the `Chart*` contract are what a client
   needs to build its UI and draw an answer, while `RestParams` and `SqlText` exist for the
   author, the auditor and the relational-database path. On a real platform that is two published views of
   the same table — definition columns withheld from the general audience, the full row to an
   authoring role — rather than anything this pattern has to invent. The costs are honest ones:
   it does not make the definitions unguessable while layer 0 still takes a `where`, and the
   audit role loses the "one request discovers everything, no second copy" property that
   publishing the catalog as one table is for. This repo publishes the full row to everyone,
   which is the right default for a demo whose whole point is that you can read it.

## Adding a question

Add the entry to `sql-library/queryLibrary.js` with an honest `portability` tag, then
`npm run build` (regenerates `rest/library.http` and `sql/03_vw_QueryLibrary.sql`) and
`npm test`. `server/catalogSchema.js` derives the table from the library at load time, so
there is no separate catalog to keep in step.

See also: `rest/catalog.http` (the two-hop flow as runnable requests), `docs/framework.md`
(the 5W+H dimensions and analytical layers the catalog columns expose).
