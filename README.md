# Service Request GIS: a metadata-driven analytics architecture on ArcGIS REST

> **A proof of concept.** The service is a mock and the data is synthetic. It exists to test an
> architecture, not to be deployed or depended on: no authentication, no rate limiting, no
> persistence, by design.

**Live demo: <https://ashleygahl.github.io/arcgis-rest-query-library/>** — no install, no server.

## What this proves

Reporting is usually welded to the application tier. Every new metric that operations or
management asks for — a 90th-percentile resolution time, a backlog breakdown by suburb, a
month-over-month anomaly check — turns into the same engineering ritual: a new DTO, a new
repository method, a new controller action, a Swagger update, a release. Analytical definitions
end up scattered across C# services, JavaScript helpers and ad-hoc SQL, and nobody can say with
confidence what metrics exist or whether two departments compute the same KPI the same way.

The alternative is to stop treating analytical questions as code and start treating them as
**data**: author each one once, store it in a catalog next to the data it queries, and give
clients one generic way to list the catalog and one generic way to execute an entry from it.

This repository tests whether **an ArcGIS REST FeatureServer can be that architecture** without a
custom API tier in the middle — because a GIS shop usually already has a FeatureServer, and if the
pattern fits it, the thin execution pipe is something you already operate.

It can. The service publishes two things:

| Id | Name | Type | What it is |
|---|---|---|---|
| `0` | `ServiceRequests` | Feature Layer | ~850 synthetic public service requests, as points |
| `1` | `QueryLibrary` | Table | the 70 analytical questions, as rows |

and a client needs exactly two requests — both of them the **standard ArcGIS `query`
operation**, neither of them specific to any question:

```
1. discover   GET  …/FeatureServer/1/query?where=1=1&outFields=*
                   → 70 rows: Question, Category, Portability, RestParams, SqlText …

2. execute    POST …/FeatureServer/0/query
                   ← the RestParams of the row you chose, replayed verbatim
                   → the answer, computed in the service's own SQL engine
```

There is no `/api/analytics/revenue-by-month`. There is no analytics controller at all. Adding a
metric is a row in `sql-library/queryLibrary.js`, and it appears in the UI without a line of
client code changing — the viewer's Library tab fetches its list from table 1 at start-up
(`viewer/js/catalog.js`), so it knows how to *run* a catalogued query but nothing about *which*
queries exist.

### The evidence

`npm test` runs **396 assertions**. The ones that carry the argument:

| What is asserted | Where |
|---|---|
| All **70** questions execute from their catalog row alone, and return results identical to running the library directly | `test/catalog.test.js` |
| REST and T-SQL agree wherever they are exact equivalents (counts, top-N, median, MoM percentages) | `test/library.test.js` |
| All 69 reference T-SQL statements run against the same data | `test/library.test.js` |
| The catalog and the whole library behave identically on `node:sqlite` and on SQLite Wasm, so the published demo cannot drift from the server | `test/browser-engine.test.js` |
| The catalog is read-only and rejects writes and multi-statement input | `test/catalog.test.js` |

The catalog-driven test is the load-bearing one: it reads each row over the REST surface, parses
the `RestParams` the service handed back, replays it against layer 0, applies any declared
client-side transform, and requires the result to equal the library run exactly. A client with
zero compiled-in knowledge of any question gets the same answers as one with all of it.

### What it does *not* prove

Three limits are real, and the catalog is built to state them per row rather than hide them.
`docs/query-catalog.md` has the detail.

1. **The `query` operation has no window functions.** `LAG`, running totals, `RANK`, moving
   averages and `ROLLUP` have no representation in `outStatistics`. Nine of the seventy come back
   as raw groups and are finished on the client by `sql-library/runner.js`. The catalog declares
   this honestly in its `Transforms` column — but the compute has moved to the client, which is
   the very failure mode this architecture is supposed to avoid. One entry needs two requests and
   a client-side full outer join.

2. **Date arithmetic is not portable.** 23 of 70 need `sqlFormat=native` against a SQL
   Server-backed service, almost entirely because standardized SQL has no date-difference
   function. The descriptive half of the library runs on any FeatureServer; the performance half —
   the half management asks for — does not.

   | `Portability` | Count | Runs on |
   |---|---|---|
   | `standard` | 32 | any FeatureServer |
   | `sql-expression` | 14 | ArcGIS Online hosted, Enterprise 10.9+ |
   | `native` | 23 | SQL Server-backed Enterprise, `sqlFormat=native` |
   | `extension` | 1 | this mock only |

3. **The catalog is a convention, not an access control.** `FeatureServer/0/query` still accepts
   an arbitrary `where` from anyone who can reach it, so publishing a catalog does not stop a
   client sending its own predicate and scanning an unindexed column. If you want the whitelist
   property — clients may pass only a query number — you need a tier in front that refuses to
   forward a client-supplied `where`. What you get here is governance of **definitions**, not of
   **access**.

### Why a mock, and why T-SQL alongside

The point is to compare, so both halves have to be real. `server/featureService.js` loads the
GeoJSON into in-memory SQLite and implements ArcGIS query semantics over it — `where`,
`outStatistics`, `groupByFieldsForStatistics`, `having`, spatial filters, paging — with a T-SQL
dialect layer (`server/sqlDialect.js`) that mirrors how a SQL Server-backed Enterprise service
behaves when called with `sqlFormat=native`. Every library entry carries the reference T-SQL
statement its REST request must reproduce, and `sql/` loads the identical data into SQL Server so
the statements can be run where they were written for. That is what makes "REST can express this"
a claim you can check rather than assert.

## Documentation

| | |
|---|---|
| [`docs/query-catalog.md`](docs/query-catalog.md) | The architecture: the catalog table, why it stores parameters rather than statements, the three limits |
| [`docs/data-model.md`](docs/data-model.md) | Fields, categories and sub-categories, how the generated data behaves, the planted defects |
| [`docs/framework.md`](docs/framework.md) | How the 70 questions are organised: 5W+H dimensions, layers L1–L5, coverage, roadmap |
| [`rest/catalog.http`](rest/catalog.http) | The discover-then-execute flow as runnable requests |
| `CLAUDE.md` | Conventions and layout, for working on the repository |

All three documents are also rendered as HTML for the published site
([browse them there](https://ashleygahl.github.io/arcgis-rest-query-library/docs/)); `npm run build`
regenerates them.

## Run it from VS Code

1. Install **Node.js 22.16 or newer** and restart VS Code.
2. **File › Open Folder…** and choose this folder (or open `service-request-gis.code-workspace`). Accept the recommended extensions: Claude Code, REST Client and SQL Server.
3. Press **F5**. *▶ Run Service Request GIS* starts the server and opens **http://127.0.0.1:3000/viewer/**.
4. Stop it with the red ■ on the debug toolbar.

You don't need `npm install`: there are no dependencies.

| In VS Code | What it does |
|---|---|
| F5 · *▶ Run Service Request GIS* | Server and browser |
| Run and Debug › *Server + debug viewer (Edge / Chrome)* | Breakpoints in the viewer's JS and the server together |
| Run and Debug › *Run library query…* | Prompts for an id (1–70), runs REST and T-SQL side by side |
| Run and Debug › *Run tests* · *Regenerate data* | |
| Ctrl+Shift+B | Rebuild `rest/library.http`, `sql/03_vw_QueryLibrary.sql` and `docs/*.html` |
| `rest/*.http` › **Send Request** | Fire any REST query from the editor (REST Client) |
| Claude Code panel | Uses `CLAUDE.md`, the MCP tools and the `/ask-data`, `/port-tsql`, `/new-query`, `/regen-data` commands |

Without VS Code, `npm start` does the same thing.

| Task | Command |
|---|---|
| Start the server | `npm start` |
| Tests | `npm test` |
| List / run a library query | `npm run query -- list` · `npm run query -- 44 --compare` |
| Ad-hoc REST | `npm run query -- --where "Suburb = 'Sea Point'" --outFields "RequestID,Category" --resultRecordCount 5` |
| Ad-hoc T-SQL | `npm run query -- --sql "SELECT TOP 5 Suburb, COUNT(*) n FROM ServiceRequest GROUP BY Suburb ORDER BY n DESC"` |
| Against a real layer | `npm run query -- 41 --url https://<host>/server/rest/services/<svc>/FeatureServer/0` |
| Regenerate the data | `npm run generate -- --count 900 --seed 42` |
| Rebuild generated artifacts | `npm run build` |

## Running without a server

The published demo is a static site, but it is not a cut-down version: the mock FeatureServer runs
**inside the viewer page** on [SQLite Wasm](https://sqlite.org/wasm), and a service worker answers
the `/arcgis/rest/…` requests the ArcGIS Maps SDK makes. Open DevTools and you will see real
`FeatureServer/0/query` and `FeatureServer/1/query` requests returning real Esri JSON. The
dashboard, all 70 library queries and the T-SQL tab work exactly as they do locally.

It is the same engine either way. `server/featureService.js`, `server/sqlDialect.js`,
`server/catalogSchema.js`, `server/schema.js` and `server/restRouter.js` take no platform
dependency; a *runtime* supplies the GeoJSON and an open SQLite handle:

| | Runtime | SQLite |
|---|---|---|
| Node (`npm start`, tests, MCP, CLI) | `server/nodeRuntime.js` | `node:sqlite` |
| Browser (the published demo) | `viewer/js/engine/sqliteWasmRuntime.js` | vendored SQLite Wasm |

The viewer picks its mode at startup: if a mock server is answering at the origin it uses it,
otherwise it starts the in-page one. Force either with `?mode=live` or `?mode=static` on the viewer
URL — `?mode=static` is how you try the published path locally.

`test/browser-engine.test.js` runs every library entry on both runtimes and asserts the results are
identical; `test/deploy.test.js` resolves what the browser imports and fails if the Pages workflow
does not stage it.

### Publishing it

GitHub Actions (`.github/workflows/pages.yml`) stages the site into `_site` and deploys it. It
needs Settings › Pages › Source = **GitHub Actions**, set once by hand. The site works from any
path, so a project page at `…/<repo>/` needs no configuration: the viewer derives its own base URL
from the module it is loaded as.

## The data

| Field | Notes |
|---|---|
| **DtLogged** | When the request was received (core fact) |
| **DtCompleted** | When it was closed off. NULL while open (core fact) |
| **Category** | Top-level group, e.g. *Water Supply*, *Roads & Footpaths* (core fact) |
| CategorySub | Sub-type, e.g. *Water leak*, *Pothole* |
| Status | `Open` · `In Progress` · `Closed` |
| Channel | `App` · `Online form` · `Phone` · `Email` · `In person` |
| Suburb | Cape Town suburb, or NULL when only a map pin was given |
| RequestID, Description | Public reference number and free text |

Thirteen categories (Roads & Footpaths, Streetlights, Water Supply, Wastewater & Stormwater,
Flooding, Rubbish & Recycling, Illegal Dumping, Graffiti, Parks & Reserves, Trees, Noise, Animals,
Abandoned Vehicles) with sub-categories under each. The model is deliberately generic: no internal
system names, no staff or contractor fields, no ward codes, no complainant contact data.
[`docs/data-model.md`](docs/data-model.md) describes it in full.

The data is seeded, so the same seed always produces the same file. It carries southern-hemisphere
seasonality, a realistic open backlog, resolution times that vary by sub-category, and deliberate
defects for the data-quality queries.

```bash
npm run generate -- --count 1000 --seed 7 --asof "2026-11-30 17:00"
```

## The service

```
GET  /arcgis/rest/services?f=pjson
GET  …/FeatureServer?f=pjson                  ← one layer, one table
GET  …/FeatureServer/0?f=pjson                ← the feature layer
GET  …/FeatureServer/1?f=pjson                ← the query catalog (type "Table")
GET|POST …/FeatureServer/{0,1}/query          ← the ArcGIS query operation
GET|POST …/FeatureServer/0/sql?q=…            ← mock extension: read-only T-SQL (not ArcGIS)
```

Open any of these without `f=` and you get an HTML services directory with a query form.

**Supported query parameters:**
- **Filtering and output:** `where`, `objectIds`, `time`, `outFields` (also `expr AS Alias`), `returnGeometry`, `outSR` (4326 / 102100)
- **Spatial:** envelope, point + distance, multipoint and polygon `geometry`, plus `inSR` and `spatialRel`
- **Return modes:** `returnCountOnly`, `returnIdsOnly`, `returnExtentOnly`, `returnDistinctValues`
- **Statistics:** `outStatistics` (count, sum, min, max, avg, stddev, var, percentile_cont, percentile_disc), `groupByFieldsForStatistics`, `having`
- **Ordering and paging:** `orderByFields`, `resultOffset`, `resultRecordCount`

**SQL dialect.** The engine runs on in-memory SQLite and accepts two kinds of SQL in where clauses
and expressions:
- ArcGIS standard SQL: `EXTRACT`, `CAST`, `CURRENT_TIMESTAMP - INTERVAL '7' DAY`, `DATE '…'`
- T-SQL: `DATEDIFF`, `DATEPART`, `FORMAT`, `LEN`, `TOP`, `PERCENTILE_CONT … WITHIN GROUP`

**Dates.** Responses return epoch ms in UTC (the Esri convention). Internally values are stored and
compared as SAST, and `GETDATE()` returns the dataset's `asOf` snapshot so results stay stable. Run
with `CLOCK=system` to use the real clock.

The database is read-only (`PRAGMA query_only` plus a statement filter) and the server only listens
on 127.0.0.1.

## Viewer

Five tabs:
- **Filter:** builds a where clause and applies it to the map. Colour by theme, status or channel, or switch to a heatmap; clustering and a time slider.
- **Dashboard:** KPI tiles and six charts, all driven by REST statistics queries. Click a bar or a month to add that value to the map filter.
- **Library:** the 70 questions, **fetched from table 1 rather than built into the page**. Run any as REST, or compare its REST result with its T-SQL result side by side.
- **REST:** a query console, including drawn-polygon queries.
- **T-SQL:** run T-SQL against the same data.
- **MCP:** the service's MCP tool contract, driven in the page — the JSON-RPC traffic an AI client normally hides. No model, no key.

Every result switches between **Table** and **Chart**; a single-value result shows as a large
figure, with the REST and T-SQL values side by side when comparing.

## The query library

`sql-library/queryLibrary.js` holds the 70 entries, organised by
[`docs/framework.md`](docs/framework.md) into 5W+H dimensions, layers L1–L5 and 12 categories. Each
entry has `rest` parameters, an optional client-side `transform`, the reference `tsql`, and a
portability tag. `server/catalogSchema.js` derives table 1 from this file at load time, so there is
no second copy to keep in step, and `scripts/build-*.js` generate `rest/library.http` and
`sql/03_vw_QueryLibrary.sql` from it too.

`runEntry(entry, httpFetcher(url))` runs an entry against any layer URL.

### MCP tools

`.mcp.json` registers a zero-dependency MCP server: `describe_layer`, `query_layer`,
`list_library`, `run_library_query` (with `compare: true` for the T-SQL result) and `run_tsql`.

The tools and the JSON-RPC dispatch live in `mcp/tools.js`, which has no transport and no platform
dependency. Two things drive it:

| | |
|---|---|
| `mcp/server.js` | newline-delimited JSON-RPC over stdin/stdout, for Claude Code |
| `viewer/js/mcp-panel.js` | the viewer's **MCP tab**, which runs the same dispatcher in the page |

So the tool surface the viewer shows is not a description of the MCP server — it is the same
contract, with a function call where the pipe would be. The tab sends `initialize`, `tools/list`
and `tools/call`, shows both JSON-RPC envelopes, and renders the result like any other query.

**It involves no language model and no API key**, so it costs nothing to run and works on the
published static demo. Worth being explicit about the billing question it raises: an MCP server
contains no model and no account. Tokens are billed to whoever runs the *conversation*, so if
someone points their own AI client at their own copy of this server, that is their subscription,
not yours. `mcp/server.js` has no network listener at all — it is spawned as a local child
process — so publishing this repository exposes the source, not a running endpoint.

## SQL Server

Run in order:
1. `sql/01_ServiceRequest_table.sql` — the table.
2. `sql/02_import_geojson.sql` — the view `vw_ServiceRequest_GeoJson` and the procedure `usp_ImportServiceRequestGeoJson @GeoJson`.
3. `sql/03_vw_QueryLibrary.sql` — the generated catalog of all 70 T-SQL statements. This is the
   same catalog as table 1, in its SQL Server form.

## Pointing it at a real service

- **Viewer:** set `layerUrl` and `catalogUrl` in `viewer/js/config.js` (they default to this project's own mock service, derived from wherever the viewer is served from).
- **CLI:** `npm run query -- <id> --url <layer>`.
- **REST Client:** change `@layer` in the `.http` files.

The target needs the same field names. Check each query's portability tag against what the service
supports — and note that a real FeatureServer will not have table 1 unless you publish the catalog
there as well.
