# Service Request GIS: Mock FeatureServer, Viewer, Dashboard & REST Query Library

> **A proof-of-concept demo.** The service is a mock and the data is synthetic. It exists to show
> the technique — ArcGIS REST query semantics, and the same 70 questions expressed in both REST
> and T-SQL — not to be deployed or depended on. There is no authentication, no rate limiting and
> no persistence, by design.

This project takes a GeoJSON of about 850 synthetic **public service requests** and serves it as an **ArcGIS REST FeatureServer layer**. The records follow the generic "report a problem" model that councils publish (see `docs/data-model.md`), and the points are placed in and around Cape Town. On top of the layer it provides:
- a GIS viewer
- a cross-filtering dashboard
- 70 analytical queries written as REST requests, with T-SQL alongside

**Live demo: <https://ashleygahl.github.io/arcgis-rest-query-library/>** — no install, no server. See
[Running without a server](#running-without-a-server) for how that works.

## Run it from VS Code

1. Install **Node.js 22.16 or newer** (current LTS) and restart VS Code.
2. **File › Open Folder…** and choose this folder (or open `service-request-gis.code-workspace`). Accept the recommended extensions: Claude Code, REST Client and SQL Server.
3. Press **F5**. *▶ Run Service Request GIS* starts the server in the terminal and opens **http://127.0.0.1:3000/viewer/**.
4. Stop it with the red ■ on the debug toolbar.

You don't need to run `npm install`, because there are no dependencies.

| In VS Code | What it does |
|---|---|
| F5 · *▶ Run Service Request GIS* | Server and browser |
| Run and Debug › *Server + debug viewer (Edge / Chrome)* | Breakpoints in the viewer's JS and the server together |
| Run and Debug › *Run library query…* | Prompts for an id (1–70), runs REST and T-SQL side by side |
| Run and Debug › *Run tests* · *Regenerate data* | |
| Ctrl+Shift+B | Rebuild `rest/library.http` and `sql/03_vw_QueryLibrary.sql` from the library |
| `rest/*.http` › **Send Request** | Fire any REST query from the editor (REST Client) |
| Claude Code panel | Uses `CLAUDE.md`, the MCP tools and the `/ask-data`, `/port-tsql`, `/new-query`, `/regen-data` commands |

Without VS Code, `npm start` does the same thing.

## Running without a server

The published demo is a static site, but it is not a cut-down version: the mock
FeatureServer runs **inside the viewer page** on [SQLite Wasm](https://sqlite.org/wasm), and a
service worker answers the `/arcgis/rest/…` requests the ArcGIS Maps SDK makes. Open DevTools
and you will see real `FeatureServer/0/query` requests returning real Esri JSON. The dashboard,
all 70 library queries and the T-SQL tab work exactly as they do locally.

It is the same engine either way. `server/featureService.js`, `server/sqlDialect.js` and
`server/restRouter.js` take no platform dependency; a *runtime* supplies the GeoJSON and an open
SQLite handle:

| | Runtime | SQLite |
|---|---|---|
| Node (`npm start`, tests, MCP, CLI) | `server/nodeRuntime.js` | `node:sqlite` |
| Browser (the published demo) | `viewer/js/engine/sqliteWasmRuntime.js` | vendored SQLite Wasm |

The viewer picks its mode at startup: if a mock server is answering at the origin it uses it,
otherwise it starts the in-page one. Force either with `?mode=live` or `?mode=static` on the
viewer URL — `?mode=static` is how you try the published path locally.

`test/browser-engine.test.js` runs every library entry on both runtimes and asserts the results
are identical, so the published demo cannot drift from the server.

### Publishing it

GitHub Pages, from the repository root (Settings › Pages › Deploy from a branch › `main` / `/`).
Everything it needs is already committed and no build step runs:

- `index.html` — the landing page
- `sw.js` — must stay at the repository root; a service worker can only intercept URLs inside
  its own scope, and the REST paths sit beside `viewer/`, not inside it
- `.nojekyll` — serve the files as they are

The site works from any path, so a project page at `…/<repo>/` needs no configuration: the
viewer derives its own base URL from the module it is loaded as.

## The data

| Field | Notes |
|---|---|
| **DateLogged** | When the request was received (core fact) |
| **DateCompleted** | When it was closed off. NULL while open (core fact) |
| **Category** | Top-level group, e.g. *Water Supply*, *Roads & Footpaths* (core fact) |
| RequestType | Sub-type, e.g. *Water leak*, *Pothole* |
| Status | `Open` · `In Progress` · `Closed` |
| Channel | `App` · `Online form` · `Phone` · `Email` · `In person` |
| Suburb | Cape Town suburb, or NULL when only a map pin was given |
| RequestID, Description | Public reference number and free text |

**Categories:**
- Roads & Footpaths
- Streetlights
- Water Supply
- Wastewater & Stormwater
- Flooding
- Rubbish & Recycling
- Illegal Dumping
- Graffiti
- Parks & Reserves
- Trees
- Noise
- Animals
- Abandoned Vehicles

They are modelled on what New Zealand councils expose through Snap Send Solve, Antenno, Auckland's *Report a problem* and Wellington's *FIXiT*. `docs/data-model.md` lists the sources.

The data is seeded, so the same seed always produces the same file. It includes:
- southern-hemisphere seasonality
- a backlog of open requests
- deliberate data defects for the data-quality queries

```bash
npm run generate -- --count 1000 --seed 7 --asof "2026-11-30 17:00"
```

## The service

```
GET  /arcgis/rest/services?f=pjson
GET  /arcgis/rest/services/ServiceRequests/FeatureServer/0?f=pjson
GET|POST …/FeatureServer/0/query          ← the ArcGIS query operation
GET|POST …/FeatureServer/0/sql?q=…        ← mock extension: read-only T-SQL (not part of ArcGIS)
```

If you open these URLs without `f=`, you get an HTML services directory with a query form.

**Supported query parameters:**
- **Filtering and output:** `where`, `objectIds`, `time`, `outFields` (also `expr AS Alias`), `returnGeometry`, `outSR` (4326 / 102100)
- **Spatial:** envelope, point + distance, multipoint and polygon `geometry`, plus `inSR` and `spatialRel`
- **Return modes:** `returnCountOnly`, `returnIdsOnly`, `returnExtentOnly`, `returnDistinctValues`
- **Statistics:** `outStatistics` (count, sum, min, max, avg, stddev, var, percentile_cont, percentile_disc), `groupByFieldsForStatistics`, `having`
- **Ordering and paging:** `orderByFields`, `resultOffset`, `resultRecordCount`

**SQL dialect.** The engine runs on in-memory SQLite (`node:sqlite` on the server, SQLite Wasm in
the browser demo). It accepts two kinds of SQL in where clauses and expressions:
- ArcGIS standard SQL: `EXTRACT`, `CAST`, `CURRENT_TIMESTAMP - INTERVAL '7' DAY`, `DATE '…'`
- T-SQL: `DATEDIFF`, `DATEPART`, `FORMAT`, `LEN`, `TOP`, `PERCENTILE_CONT … WITHIN GROUP`

This mirrors a SQL Server-backed service called with `sqlFormat=native`.

**Dates.** Responses return dates as epoch ms in UTC. Internally they are stored and compared as SAST, and `GETDATE()` returns the dataset's `asOf` time so results stay stable. Run with `CLOCK=system` to use the real clock instead.

The database is read-only, and the server only listens on 127.0.0.1.

## Viewer

The viewer has five tabs:
- **Filter:** builds a where clause and applies it to the map. You can colour points by theme, status, channel or a heatmap, and turn on clustering and a time slider.
- **Dashboard:** KPI tiles plus six charts, all driven by REST statistics queries. Click a bar or a month to add that value to the map filter.
- **Library:** run any of the 70 queries, or compare a query's REST result with its T-SQL result.
- **REST:** a hand-built query console, including drawn-polygon queries.
- **T-SQL:** run T-SQL against the same data.

Every result can switch between **Table** and **Chart**. A single-value result shows as a large figure, with the REST and T-SQL values side by side when comparing.

## The query library

`sql-library/queryLibrary.js` holds 70 entries, organised by `docs/framework.md` (5W+H dimensions, layers L1–L5, 12 categories). Each entry has:
- `rest` parameters
- an optional client-side `transform` for LAG, running totals, ranks and joins
- the T-SQL statement
- a **portability** tag:
  - `standard`: works on any FeatureServer
  - `sql-expression`: needs `supportsSqlExpression`
  - `native`: needs SQL Server with `sqlFormat=native`
  - `extension`: works on this mock only

`runEntry(entry, httpFetcher(url))` runs an entry against any layer URL.

## SQL Server

Run these in order:
1. `sql/01_ServiceRequests_table.sql`: creates the table.
2. `sql/02_import_geojson.sql`: creates the **view** `vw_ServiceRequests_GeoJson` and the **stored procedure** `usp_ImportServiceRequestsGeoJson @GeoJson`.
3. `sql/03_vw_QueryLibrary.sql`: creates the generated catalogue of all 70 T-SQL statements.

## Pointing it at a real service

- **Viewer:** set `layerUrl` in `viewer/js/config.js` (it defaults to this project's own mock
  service, derived from wherever the viewer is served from).
- **CLI:** `npm run query -- <id> --url <layer>`.
- **REST Client:** change `@layer` in the `.http` files.

The target needs the same field names. Check each query's portability tag against what the server supports.
