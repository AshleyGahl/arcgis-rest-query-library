# Service Request GIS

*Proof-of-concept demo · mock service, synthetic data.*

Can an ArcGIS REST FeatureServer carry a whole analytics layer — no analytics API, no endpoint per
metric — by publishing the questions themselves as data? This demo is the test: ~850 synthetic
public service requests around Cape Town, and 70 analytical questions served as a table on the same
service, each written twice so the answers can be checked.

[Open the GIS viewer](../viewer/) · [REST services directory](../arcgis/rest/services) ·
[Source on GitHub](https://github.com/AshleyGahl/arcgis-rest-query-library)

## The problem it is testing

In most enterprise and municipal systems, reporting is welded to the application tier. Every metric
operations asks for — a 90th-percentile resolution time, a backlog breakdown by suburb, a
month-over-month anomaly check — becomes the same ritual: a new response type, a new repository
method, a new controller action, a docs update, a release. Analytical definitions scatter across
server code, frontend helpers and ad-hoc SQL, until nobody can say what metrics exist or whether two
departments compute the same KPI the same way.

Handing clients open query flexibility instead just moves the problem: it pushes heavy
window-function work outward, and exposes the schema to filters that can scan an unindexed column in
production. The third option is to stop treating analytical questions as code and treat them as
**data** — authored once, stored next to the data they query, and reached through one generic way to
list them and one generic way to run them.

The [catalog pattern](catalog-pattern.md) makes that argument on its own terms, without a platform
in it, and then scores this repository against it.

## The architecture

The service publishes two things, and the second one is the catalog:

| Id | Name | Type | |
|---|---|---|---|
| `0` | `ServiceRequests` | Feature Layer | the ~850 service requests, as points |
| `1` | `QueryLibrary` | Table | the 70 analytical questions, as rows |

So a client needs exactly two requests, and both are the standard ArcGIS `query` operation — neither
is specific to any question:

```
GET  …/FeatureServer/1/query?where=1=1&outFields=*       70 rows: Question, Portability,
                                                         RestParams, SqlText, ChartType…
POST …/FeatureServer/0/query  <the RestParams of a row>  the answer, computed in the
                                                         service's own SQL engine
```

There is no analytics controller. Adding a metric is a row, not a deployment: it appears in the UI
with no client code changing, because the viewer's run tabs fetch their list from table 1 at
start-up. They know how to *run* a catalogued question, but nothing about *which* questions exist.

> The catalog stores the REST parameters, not a `SELECT` statement — a real FeatureServer has no
> endpoint that accepts one. What `query` does accept is SQL in pieces (`where`,
> `groupByFieldsForStatistics`, `outStatistics`, `having`), which it transforms and executes
> server-side. The equivalent T-SQL rides along in the same row as the reference definition.

The row also carries the **chart contract** — `ChartType`, `ChartLabelColumn`, `ChartValueColumns`
and the rest — so the same request that tells a client what the question is tells it how the answer
is drawn. No response type is declared for any question anywhere in the pipeline, which makes those
columns the only place the shape of an answer is written down.

Six rows carry a **`ParamSpec`** as well: a typed parameter with the range its author ratified, so
*"top 5 categories"* can be asked for ten without anyone composing SQL, and *"stuck for more than
30 days"* can be asked at 90. The mock also serves `…/FeatureServer/1/execute`, which takes a
question number and declared parameters and refuses anything else — the one non-generic route here,
and the one that shows what it costs to make a published catalog enforceable.

[The architecture page](architecture.md) traces the whole pipeline component by component.

## What the demo shows

Try it yourself: open the [viewer](../viewer/), go to the Run REST tab and watch the Network panel.
The question list arrives from `FeatureServer/1/query`; running one fires `FeatureServer/0/query`
with parameters that came out of that first response.

The repository's test suite asserts the same thing over 400 times — including that all 70 questions
execute from their catalog row alone and return results identical to running the library directly,
that every declared chart column exists in the result it describes, and that the whole library
behaves the same on the server engine and the in-browser one.

## Where it breaks down

Three limits are real, and the catalog states them per row rather than hiding them.

- **No window functions.** `LAG`, running totals, `RANK`, moving averages and `ROLLUP` have no
  representation in `outStatistics`. Nine of the seventy come back as raw groups and are finished on
  the client — which is the very failure mode this architecture is meant to avoid. The catalog
  declares it in a `Transforms` column, so at least a client knows what it must apply.
- **Date arithmetic is not portable.** Standardized SQL has no date-difference function, so every
  duration and SLA metric needs a SQL Server-backed service called with `sqlFormat=native`. The
  descriptive half of the library runs anywhere; the performance half — the half management asks
  for — does not.
- **The catalog is a convention, not an access control.** `FeatureServer/0/query` still accepts an
  arbitrary `where` from anyone who can reach it. Publishing a catalog gives you governance of
  *definitions*, not of *access*; the whitelist property needs a tier in front that refuses to
  forward a client-supplied predicate.

How far each question travels is itself a column in the catalog, so the service can answer "how
portable is this library?" with one statistics query:

| Portability | Count | Runs on |
|---|---|---|
| `standard` | 32 | any FeatureServer |
| `sql-expression` | 14 | ArcGIS Online hosted, Enterprise 10.9+ |
| `native` | 23 | SQL Server-backed Enterprise, `sqlFormat=native` |
| `extension` | 1 | this mock only |

[The query catalog](query-catalog.md) sets all of this out in full.

## What is actually running

There is no server behind this page. The mock FeatureServer — the SQL query engine, the ArcGIS query
semantics, the T-SQL dialect translation, both layers — runs inside the viewer tab on
[SQLite Wasm](https://sqlite.org/wasm), and a service worker answers the `/arcgis/rest/…` requests
the ArcGIS Maps SDK makes. Open the Network tab and you will see genuine `FeatureServer/0/query` and
`FeatureServer/1/query` requests with genuine Esri JSON responses.

> It is the same code the local Node server runs: the viewer detects whether a real server is there
> and, if not, stands the engine up in the page. The REST services directory in the nav is served
> that way too, so the viewer needs to be open in a tab for it to answer.

## What to try in the viewer

| Tab | |
|---|---|
| **Filter** | Build a `where` clause from dropdowns and watch it go to the service; switch basemaps, symbology, clustering and the time slider. |
| **Dashboard** | KPIs and charts built entirely from REST `outStatistics` requests. Click a bar to cross-filter the map. |
| **Run REST** | All 70 questions — and the list is not built into the page. It is fetched from `FeatureServer/1/query`, because the query library is published as a table on the same service. Pick one and run it as ArcGIS REST. |
| **Run SQL** | The same 70 questions, run as their original T-SQL against the same data through `…/FeatureServer/0/sql`, a read-only mock extension. The statement is editable, so the panel is the SQL console too. |
| **API** | A query console: the raw ArcGIS parameters, and the URL they produce. |

> Both run tabs share one question list, one selection and one catalog request, so picking a
> question under Run REST keeps your place when you switch to Run SQL — only the verb changes. Each
> traces what the click did, step by step and timed, then the MCP `tools/call` that wraps the very
> same work, with its JSON-RPC envelopes — stacked above the request itself, each one expandable. No
> language model and no API key are involved — it is the protocol made visible, not a chatbot.

## The data

Deliberately generic: a council "report a problem" record, holding only what a member of the public
submits plus the lifecycle dates — no internal system names, staff or contractor fields, ward codes
or contact details. The core facts are `DtLogged`, `DtCompleted` and `Category`, across thirteen
categories with sub-categories under each.

It is generated from a seed, so the same seed always produces the same file, and it is shaped so the
queries have something real to find: southern-hemisphere seasonality, a realistic open backlog,
resolution times that vary by sub-category, and deliberate defects for the data-quality queries.
[The data model](data-model.md) describes it in full, and [the analytics framework](framework.md)
how the 70 questions are organised.

## Running it locally

Node ≥ 22.16, no npm dependencies. `npm start` serves the real mock FeatureServer on
`http://127.0.0.1:3000`, and `npm test` runs the 70 REST queries, the T-SQL equivalents, their
parity assertions, the catalog round-trip, and the whole suite again against the in-browser engine.
The repository also carries SQL Server scripts that load the identical data, so the T-SQL can be run
where it was written for.
