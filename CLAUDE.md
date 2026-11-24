# CLAUDE.md: Service Request GIS (mock FeatureServer, viewer, REST query library)

## What this project is
`data/service_requests.geojson` holds about 850 synthetic **generic public service requests**: the kind a
council "report a problem" app collects. The points sit in and around Cape Town. The file is served as an
**ArcGIS REST FeatureServer layer**, and the project adds:
- an ArcGIS Maps SDK for JavaScript viewer (`FeatureLayer` on the mock URL), with a Chart.js dashboard
- a **static deployment** of the same thing: with no server, the engine runs in the page on SQLite Wasm
  and a service worker answers the REST requests (this is what GitHub Pages serves)
- a **query library**: 70 analytical questions written as ArcGIS REST `query` requests, with T-SQL alongside
- SQL Server scripts that load the same GeoJSON so the T-SQL can be compared against identical data

The data model is deliberately generic (`docs/data-model.md`). **Core facts: `DateLogged`, `DateCompleted`, `Category`.**
Keep it that way: no internal system names, staff/contractor fields, ward/administrative codes or complainant contact data.

## Run (VS Code first)
- **F5** runs "▶ Run Service Request GIS". It starts `server/start.js` and opens http://127.0.0.1:3000/viewer/.
- Ctrl+Shift+D lists the other configurations: server only, Edge or Chrome viewer debugging (compounds), run a library query, run tests, regenerate data.
- **Terminal › Run Task** (Ctrl+Shift+B rebuilds the `.http` file and `vw_QueryLibrary.sql`).

| Task | Command |
|---|---|
| Start server | `npm start` |
| Tests (70 REST + 69 T-SQL + parity + both runtimes) | `npm test` |
| List / run a library query | `npm run query -- list` · `npm run query -- 44 --compare` |
| Ad-hoc REST | `npm run query -- --where "Suburb = 'Sea Point'" --outFields "RequestID,Category,Status" --resultRecordCount 5` |
| Ad-hoc T-SQL (mock) | `npm run query -- --sql "SELECT TOP 5 Suburb, COUNT(*) n FROM ServiceRequests GROUP BY Suburb ORDER BY n DESC"` |
| Same against a real layer | `npm run query -- 41 --url https://<host>/server/rest/services/<svc>/FeatureServer/0` |
| Regenerate data | `npm run generate -- --count 900 --seed 42` |
| Rebuild generated artifacts | `npm run build` (after editing the library) |

Requires Node ≥ 22.16 and has **no npm dependencies** (it uses built-in `node:sqlite`). `server/start.js` checks the version.
Don't add packages without asking. The only vendored third-party code is `viewer/vendor/` (Chart.js, SQLite Wasm). Use `127.0.0.1`, not `localhost`: on Windows, Node can resolve `localhost` to IPv6, and the server only binds IPv4.

## MCP tools (server `servicerequests`, see `.mcp.json`)
- `describe_layer`: schema and value lists. Call it first.
- `query_layer`: REST parameters.
- `list_library`
- `run_library_query`: `compare: true` adds the T-SQL result.
- `run_tsql`: read-only.

## Layout
```
data/service_requests.geojson   the "service" (epoch-ms dates, WGS84 points, metadata.asOf)
docs/data-model.md              fields, categories, how the generated data behaves
docs/framework.md               5W+H dimensions, analytical layers, roadmap
scripts/generate-data.js        seeded generator (categories → request types, seasonality, data defects)
index.html                      landing page (the GitHub Pages front door)
sw.js                           service worker for the static demo; MUST stay at the repo root
server/start.js                 entry point (Node version check) → server/index.js
server/index.js                 HTTP host + static files only; the REST surface is restRouter.js
server/restRouter.js            the REST surface as (path, params) → response; no HTTP, no platform
server/featureService.js        query engine: GeoJSON → in-memory SQLite, ArcGIS query semantics
server/nodeRuntime.js           Node runtime for the engine (fs + node:sqlite) + createFeatureService()
server/serviceConfig.js         platform-free service defaults, shared with the browser demo
server/sqlDialect.js            T-SQL / ArcGIS SQL → SQLite rewrites + registered T-SQL functions
server/schema.js                field list (single source of truth for the layer schema)
sql-library/queryLibrary.js     THE library (70 entries: rest params, transform, tsql, portability)
sql-library/runner.js           runs entries anywhere + client-side transforms (LAG, running totals…)
viewer/                         ArcGIS JS 4.x viewer, ES modules, no build step
  js/config.js                  layer URL, themes, palette (THEME_COLORS etc.)
  js/charts.js                  ALL Chart.js create/destroy logic
  js/dashboard.js               Dashboard tab (KPIs + charts from REST statistics, cross-filtering)
  js/result-chart.js            table | chart toggle for any result
  js/engine/boot.js             picks live vs static mode; in static mode starts the in-page service
  js/engine/sqliteWasmRuntime.js  node:sqlite-shaped adapter over SQLite Wasm
  vendor/chart.umd.min.js       Chart.js 4.6.1 (must load BEFORE the ArcGIS script tag)
  vendor/sqlite-wasm/           SQLite Wasm; sqlite3.js and sqlite3.wasm must stay side by side
sql/                            01 table · 02 OPENJSON import (view + proc) · 03 vw_QueryLibrary (GENERATED)
rest/                           .http files for the VS Code REST Client (library.http is GENERATED)
mcp/server.js                   zero-dependency MCP stdio server
```

## Conventions
- **Library entries:** `tsql` is the reference statement and `rest` must reproduce its result. Use `transform` only
  for what REST can't do. Add parity assertions in `test/` when the two are exact equivalents. Run `npm run build` afterwards.
- **The portability tag is mandatory and must be honest:**
  - `standard`: works on any FeatureServer.
  - `sql-expression`: uses EXTRACT/CAST/CASE/CHAR_LENGTH/FLOOR in groupBy or stats.
  - `native`: uses T-SQL functions; needs `sqlFormat=native` on a SQL Server-backed Enterprise service.
  - `extension`: works on this mock only.
  - Prefer the most portable form that gives the same answer.
- `"expr AS Alias"` in `groupByFieldsForStatistics` and `outFields` is a mock convenience.
- T-SQL averages of `DATEDIFF` cast to FLOAT so SQL Server doesn't truncate to an integer.
- **Dates:** responses use epoch ms in UTC (the Esri convention). Values are stored and compared internally as SAST (UTC+2), so where-clause literals are SAST.
- `GETDATE()` returns the dataset's `asOf` snapshot by default (`CLOCK=system` uses wall time).
- `Status` is `Open` | `In Progress` | `Closed`. "Unresolved" means `Status <> 'Closed'`.
- Grids default to `ObjectID DESC` (then `Created`, `Received`) when those columns exist.
- SQL Server data-access objects: always provide **both** a view form and a stored-proc form.
- **Charts:** colours come from `viewer/js/config.js`. It is a validated palette in fixed order, and a colour follows its entity. One y-axis only, more than 8 series fold into "Other", and there is a legend only when there are 2 or more series.
- The engine is read-only (`PRAGMA query_only` plus a statement filter). Keep it that way.
- **The engine must stay platform-free.** `featureService.js`, `sqlDialect.js`, `schema.js`, `restRouter.js`
  and `serviceConfig.js` are loaded by the browser too: no `node:` imports, no `Buffer`, no `process`.
  Node-only code belongs in `nodeRuntime.js` or `index.js`. `test/browser-engine.test.js` runs the whole
  library on both runtimes and fails if they diverge — run `npm test` after touching the engine.
- The viewer's `layerUrl` is derived from where the viewer is served (`SITE_BASE` in `js/config.js`), so the
  demo works unchanged at a GitHub Pages project path. Use `?mode=static` to exercise that path locally.
