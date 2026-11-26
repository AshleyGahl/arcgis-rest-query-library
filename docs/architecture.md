# Architecture

*How the parts fit together, and where the query library lives in each of the two databases.*

The repository is one pipeline with two front doors. A single query engine answers ArcGIS REST
requests; everything else is either a producer of its data, a renderer of its answers, or a
generator kept in step with it. The library of 30 analytical questions is not a module the UI
imports — it is **a table of the service**, discovered over REST like any other table.

## 1. The whole picture

Three bands. **Top:** one source file, three derivations — none of them a second copy to
maintain. **Middle:** the engine, with a runtime injected underneath it so the same code runs on
Node and in the browser. **Bottom:** the consumers, all of them speaking REST.

### Top: one source, three derivations

```mermaid
flowchart TB
  LIB["sql-library/queryLibrary.js
  30 entries: id, question, rest,
  transform, tsql, chart, portability"]
  CAT["server/catalogSchema.js
  CATALOG_FIELDS + catalogRows()"]
  BSQL["scripts/build-sql.js
  sql/03_vw_QueryLibrary.sql"]
  BHTTP["scripts/build-http.js
  rest/library.http"]
  USE["sql-library/runner.js
  mcp/*, scripts/run-query.js"]
  LIB -->|derived at load| CAT
  LIB -->|generated| BSQL
  LIB -->|generated| BHTTP
  LIB -->|imported| USE
```

### Middle: one engine, two runtimes

```mermaid
flowchart TB
  GEO[("data/service_requests.geojson")]
  CATROWS["catalogRows()"]
  ENG["server/featureService.js
  query(params, layerId)"]
  DIA["server/sqlDialect.js
  T-SQL and ArcGIS SQL to SQLite"]
  SCH["server/schema.js
  server/serviceConfig.js"]
  NODE["server/nodeRuntime.js
  fs + node:sqlite"]
  WASM["viewer/js/engine/sqliteWasmRuntime.js
  SQLite Wasm, in the page"]
  ROUTER["server/restRouter.js
  (path, params) to response"]
  HTTP["server/index.js
  HTTP + static files"]
  SW["sw.js
  service worker, static mode"]
  GEO -->|layer 0| ENG
  CATROWS -->|table 1| ENG
  ENG --- DIA
  ENG --- SCH
  NODE -->|runtime injected| ENG
  WASM -->|runtime injected| ENG
  ENG --> ROUTER
  ROUTER --> HTTP
  ROUTER --> SW
```

The same `restRouter.js` answers in both modes, which is why the GitHub Pages demo needs no
server: `sw.js` intercepts the REST URLs and hands them to an engine running in the tab.

### Bottom: the viewer

```mermaid
flowchart TB
  BOOT["viewer/js/engine/boot.js
  live or ?mode=static"]
  MAP["FeatureLayer on layer 0
  the map"]
  CATJS["js/catalog.js
  one GET on table 1"]
  DASH["js/dashboard.js
  REST statistics"]
  STORE["js/query-store.js
  one fetch, one selection"]
  PANEL["js/query-panel.js x2
  Run REST | Run SQL"]
  RUNNER["sql-library/runner.js
  client-side transforms"]
  WF["js/workflow.js
  Workflow + Agent view"]
  ENV["js/mcp-envelope.js
  tools/call, from mcp/tools.js"]
  CHARTS["js/charts.js"]
  RC["js/result-chart.js
  table or chart"]
  BOOT --> MAP
  BOOT --> CATJS
  BOOT --> DASH
  CATJS --> STORE
  STORE --> PANEL
  PANEL --> RUNNER
  PANEL --> WF
  WF --> ENV
  RUNNER --> RC
  DASH --> CHARTS
  RC --> CHARTS
```


## 2. Who references whom

| Component | Depends on | Must never import |
|---|---|---|
| `sql-library/queryLibrary.js` | nothing | — |
| `server/catalogSchema.js` | `queryLibrary.js` | anything platform-specific |
| `server/featureService.js` | `schema.js`, `catalogSchema.js`, `sqlDialect.js`, `serviceConfig.js`, an injected runtime | `node:*`, `process`, `Buffer` |
| `server/restRouter.js` | a `FeatureService` instance | HTTP objects |
| `server/index.js` | `restRouter.js`, `nodeRuntime.js` | — |
| `viewer/js/catalog.js` | the REST endpoint `…/FeatureServer/1/query` | `queryLibrary.js` |
| `viewer/js/query-store.js` | `js/catalog.js` | a second catalog fetch — there is one, shared |
| `viewer/js/query-panel.js` | `js/query-store.js`, `runner.js`, `js/workflow.js` | knowledge of which questions exist |
| `viewer/js/mcp-envelope.js` | `toolContent` from `mcp/tools.js` | a dispatcher — nothing in the page dispatches |
| `viewer/js/workflow.js` | `js/mcp-envelope.js`, the payload builders in `mcp/tools.js` | hand-built JSON-RPC |
| `mcp/server.js` | `mcp/tools.js`, `nodeRuntime.js` | — |
| `scripts/build-*.js`, `scripts/run-query.js` | `queryLibrary.js` directly | — |

Two of those rules are enforced by tests rather than by convention: `test/deploy.test.js`
resolves the browser's import closure and fails if a Node-only module enters it, and
`test/browser-engine.test.js` runs all 30 entries on both runtimes and fails if they diverge.

## 3. The library as a table (layer 1)

The service publishes two layers over one REST surface:

| Id | Name | Type | Rows | Source |
|---|---|---|---|---|
| 0 | `ServiceRequests` | Feature Layer | ~850 points | `data/service_requests.geojson` |
| 1 | `QueryLibrary` | Table (no geometry) | 30 questions | `catalogRows()` over `queryLibrary.js` |

`server/catalogSchema.js` declares the table's schema as `CATALOG_FIELDS`, in Esri field terms,
so `…/FeatureServer/1?f=json` describes it exactly as a real published table would:

| Field | Esri type | Length | What it holds |
|---|---|---|---|
| `ObjectID` | `esriFieldTypeOID` | — | the query number, reused as the OID |
| `QueryNumber` | `esriFieldTypeInteger` | — | 0–29, the stable public identifier a client stores and an executor takes |
| `Category` | `esriFieldTypeString` | 60 | one of the eight library sections |
| `Question` | `esriFieldTypeString` | 200 | the business question, and the display field |
| `Dimension` | `esriFieldTypeString` | 10 | `WHO` … `HOW` (see [framework](framework.md)) |
| `AnalyticLayer` | `esriFieldTypeString` | 4 | `L1`–`L5`, descriptive to advanced |
| `Portability` | `esriFieldTypeString` | 20 | `standard` · `sql-expression` · `native` (ten each); `extension` is defined but unused |
| `RequestCount` | `esriFieldTypeSmallInteger` | — | REST requests needed (1, or 2 for Q24) |
| `Transforms` | `esriFieldTypeString` | 100 | names of the client-side steps, comma-separated |
| `HasChart` | `esriFieldTypeSmallInteger` | — | 1 when the author says this answer is a chart (22 of 30) |
| `ChartType` | `esriFieldTypeString` | 20 | `bar` or `line` |
| `ChartLabelColumn` | `esriFieldTypeString` | 100 | the category axis; two columns joined when a label needs both (`Year,Month`) |
| `ChartValueColumns` | `esriFieldTypeString` | 200 | the measure(s) to plot — several only when they share a unit |
| `ChartSeriesColumn` | `esriFieldTypeString` | 100 | splits into one dataset per value, or null |
| `ChartAnnotationColumn` | `esriFieldTypeString` | 100 | carried into the tooltip without being plotted, or null |
| `RestParams` | `esriFieldTypeString` | 4000 | **the executable payload**: the decomposed query as JSON |
| `TransformSpec` | `esriFieldTypeString` | 1000 | the transform parameters as JSON, or null |
| `ParamSpec` | `esriFieldTypeString` | 1000 | the parameters this question may be varied by, as JSON, or null (3 of 30) |
| `SqlText` | `esriFieldTypeString` | 4000 | the reference T-SQL statement |
| `Notes` | `esriFieldTypeString` | 600 | caveats (for example a `DATEFIRST` assumption), or null |

`RestParams` holds `where` / `groupByFieldsForStatistics` / `outStatistics` / `having` /
`orderByFields`, never a `SELECT` — see the [query catalog](query-catalog.md) for why that
distinction is the whole point of the pattern.

The `Chart*` columns are the presentation contract. No response type is declared for any
question anywhere in this pipeline, so these columns are the only place the shape of an answer
is written down: which column is the category axis, which are the measures, what splits into
series. `viewer/js/result-chart.js` obeys them and falls back to inferring from the shape of
the rows only for results that have no contract, such as anything run from the SQL console.
`HasChart = 0` is a statement in its own right — a single figure or a list of features is not
a chart — and the [catalog pattern](catalog-pattern.md) explains why a declared contract and an
inferred one are not the same kind of thing.

`ParamSpec` is the extension contract: the parameters a question may be varied by, each with the
type, the range its author ratified, and where the value lands in the definition. Six questions
declare one — *"top 5 categories"* is the obvious case, and Q26's *"stuck for more than 30 days"*
is the interesting one, because 30 is a policy, not a fact:

```
[{ "name": "days", "label": "Open longer than (days)", "type": "int",
   "min": 1, "max": 365, "default": 30,
   "binds": [{ "in": "rest", "key": "where", "template": "Status <> 'Closed' AND … > {v}" },
             { "in": "tsql", "find": "… GETDATE()) > 30", "template": "… GETDATE()) > {v}" }] }]
```

The binding is data, and it never hands the client a fragment of query text to compose. The entry
stores the *default rendering* — `resultRecordCount: 5` and `TOP 5` stay literal — so a client
that ignores `ParamSpec` still replays the question exactly as ratified, and binding the declared
default has to reproduce the published definition byte for byte. `test/params.test.js` asserts
that for every parameter, which is what makes a default the ratified question rather than merely
a sensible number.

### How it is set up in the mock database

There is no DDL file for layer 1, because the table is built from the field list at start-up.
`featureService.load()` creates both layers the same way, in the same in-memory SQLite database:

```js
db.exec(`CREATE TABLE _QueryLibrary (${CATALOG_FIELDS.map((f) => `"${f.name}" ${sqlTypeOf(f)}`).join(', ')})`);
```

It then inserts `catalogRows()` and registers a **layer descriptor** — `{ id: 1, name:
'QueryLibrary', table: '_QueryLibrary', fields: CATALOG_FIELDS, oid: 'ObjectID', displayField:
'Question', timeField: null, geometry: false }` — alongside layer 0's. From that point the query
methods are layer-agnostic: `svc.query(params, 1)` takes the same `where`, `outFields`,
`outStatistics` and `orderByFields` path as a query against the points, which is why the catalog
can report on itself (`…/1/query?groupByFieldsForStatistics=Portability`). The database is
read-only (`PRAGMA query_only` plus a statement filter), both layers alike.

So **adding a question changes one array**. The table's rows, the `.http` file and the T-SQL
catalogue all follow from `npm run build`, and nothing in the viewer changes at all.

### How it is set up in the relational database

The relational side exists for comparison — proving the reference SQL and the REST request give the
same answer on identical data — so it carries the library in the simplest form that supports that.
The pattern does not depend on a particular engine; the scripts here are written for one example
database, SQL Server, and a PostgreSQL or Oracle port would change the dialect, not the shape:

| Script | Object | Form |
|---|---|---|
| `sql/01_ServiceRequest_table.sql` | `dbo.ServiceRequest`, `dbo.GeoJsonDocument` | tables plus three indexes; `Shape` is a computed `GEOGRAPHY::Point` |
| `sql/02_import_geojson.sql` | `dbo.vw_ServiceRequest_GeoJson`, `dbo.usp_ImportServiceRequestGeoJson` | view and stored proc over `OPENJSON`, epoch ms to SAST |
| `sql/03_vw_QueryLibrary.sql` | `dbo.vw_QueryLibrary`, `dbo.usp_RunLibraryQuery` | **generated** view of 30 `SELECT … UNION ALL` literals, plus the proc that runs one by number |

`vw_QueryLibrary` is a view of constants rather than a physical table, with five descriptive
columns and the statement itself:

| Column | Type | Note |
|---|---|---|
| `QueryNumber` | `INT` | matches `QueryNumber` on layer 1 |
| `Category` | `NVARCHAR` | same value |
| `Dimension` | `NVARCHAR` | same value |
| `AnalyticalLayer` | `NVARCHAR` | layer 1 calls this `AnalyticLayer` |
| `Question` | `NVARCHAR` | same value |
| `SQLText` | `NVARCHAR` | layer 1 calls this `SqlText` |
| `HasChart` | `INT` | same value |
| `ChartType`, `ChartLabelColumn`, `ChartValueColumns` | `NVARCHAR(200)` | same values |
| `ChartSeriesColumn`, `ChartAnnotationColumn` | `NVARCHAR(200)` | same values |
| `ParamSpec` | `NVARCHAR(1000)` | same value |

An entry is executed by number, through the proc form in the same script — the T-SQL counterpart
of replaying a row's `RestParams` against layer 0:

```sql
EXEC dbo.usp_RunLibraryQuery @QueryNumber = 14;                 -- run it
EXEC dbo.usp_RunLibraryQuery @QueryNumber = 14, @Execute = 0;    -- return the statement only
```

It resolves `SQLText` from the view and hands it to `sys.sp_executesql`, throwing 50010 for a
number that is not in the catalogue. The underlying two lines work as well, if a caller would
rather hold the statement itself:

```sql
DECLARE @sql NVARCHAR(MAX) = (SELECT SQLText FROM dbo.vw_QueryLibrary WHERE QueryNumber = 14);
EXEC sp_executesql @sql;
```

Note what this deliberately is **not**. It is not a physical table, so there is no load step and
no stored row that can drift from the library — regenerate the file, re-run it, and the view is
current. And it is not the same schema as layer 1: it has no `Portability`, `RequestCount`,
`Transforms`, `RestParams` or `TransformSpec`, because those describe the *REST* half of an entry
and mean nothing to a client that already holds a T-SQL statement. The two catalogues are two
projections of one source, each carrying the columns its own execution path can act on.

The `Chart*` columns and `ParamSpec` are the exceptions that show the rule: they appear in both,
because they describe the *question and its answer* rather than the route taken to it. Whichever
way a client resolves query 14 — replaying `RestParams` against layer 0, or
`EXEC dbo.usp_RunLibraryQuery @QueryNumber = 14` — it gets the same rows, the same instruction for
drawing them, and the same statement of what a user is allowed to change. The proc runs `SQLText`
as published; binding a parameter means rendering the declared template over the declared text,
which the REST side does on the trusted side at `/FeatureServer/1/execute`.

## 4. The two REST hops, end to end

```mermaid
sequenceDiagram
  autonumber
  participant V as viewer
  participant R as restRouter.js
  participant E as featureService.js
  V->>R: GET /FeatureServer/1/query (where=1=1, outFields=*)
  R->>E: svc.query(params, 1)
  E-->>V: 30 catalog rows
  Note over V: the run panels list them, grouped by Category
  V->>R: POST /FeatureServer/0/query, the RestParams of that row
  R->>E: svc.query(params, 0)
  E-->>V: rows
  Note over V: runner.js applies the TransformSpec,<br/>result-chart.js draws it per the Chart* columns
```

Both hops are the standard ArcGIS `query` operation, and nothing about Q14 exists in the client.

### And one hop that is deliberately not generic

```mermaid
sequenceDiagram
  autonumber
  participant C as client
  participant X as /1/execute
  participant E as featureService.js
  C->>X: GET ?q=26&top=3&days=90
  X->>E: svc.query(where QueryNumber = 27, layer 1)
  E-->>X: the catalog row
  Note over X: bindEntry validates 3 and 90<br/>against the row's ParamSpec
  X->>E: svc.query(the bound RestParams, layer 0)
  E-->>X: rows
  Note over X: runner.js applies the TransformSpec here,<br/>not in the client
  X-->>C: question, parameters, rows, chart contract
```

`/FeatureServer/1/execute` is a mock extension, like `/0/sql`, and it exists to make a point the
two generic hops cannot. Its input type is a question number plus the parameters that question
declares — a `where` or an `outStatistics` sent to it is refused, not ignored. It resolves the row
through its own layer 1, binds on the trusted side, executes, and applies the client-side
transform before answering. That is the forwarding tier of the
[catalog pattern](catalog-pattern.md): it restores the narrow input type the pattern rests on, and
it knows nothing about any individual question. The viewer still replays rows against layer 0,
because that is the honest demonstration of what a FeatureServer alone can do; the tier is what
you add when the bounds have to be enforced rather than published.

See also: [query catalog](query-catalog.md) for the design argument and its four real limits,
[data model](data-model.md) for layer 0's fields, [analytics framework](framework.md) for the
dimensions the catalog columns expose.
