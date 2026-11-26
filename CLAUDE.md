# CLAUDE.md: Service Request GIS (mock FeatureServer, viewer, REST query library)

## What this project is
`data/service_requests.geojson` holds about 850 synthetic **generic public service requests**: the kind a
council "report a problem" app collects. The points sit in and around Cape Town. The file is served as an
**ArcGIS REST FeatureServer layer**, and the project adds:
- an ArcGIS Maps SDK for JavaScript viewer (`FeatureLayer` on the mock URL), with a Chart.js dashboard
- a **static deployment** of the same thing: with no server, the engine runs in the page on SQLite Wasm
  and a service worker answers the REST requests (this is what GitHub Pages serves)
- a **query library**: 31 analytical questions written as ArcGIS REST `query` requests, with T-SQL alongside
- the library **published as table 1 of the same FeatureServer**, so a client discovers the questions with
  one standard REST request and executes any of them with a second (`docs/query-catalog.md`)
- SQL Server scripts that load the same GeoJSON so the T-SQL can be compared against identical data

The data model is deliberately generic (`docs/data-model.md`). **Core facts: `DtLogged`, `DtCompleted`, `Category`.**
Keep it that way: no internal system names, staff/contractor fields, ward/administrative codes or complainant contact data.

## Run (VS Code first)
- **F5** runs "▶ Run Service Request GIS". It starts `server/start.js` and opens http://127.0.0.1:3001/viewer/.
- Ctrl+Shift+D lists the other configurations: server only, Edge or Chrome viewer debugging (compounds), run a library query, run tests, regenerate data.
- **Terminal › Run Task** (Ctrl+Shift+B rebuilds the `.http` file, `vw_QueryLibrary.sql` and `docs/*.html`).

| Task | Command |
|---|---|
| Start server | `npm start` |
| Tests (31 REST + 31 T-SQL + catalog round-trip + parity + parameters + both runtimes) | `npm test` |
| List / run a library query | `npm run query -- list` · `npm run query -- 14 --compare` |
| Ad-hoc REST | `npm run query -- --where "Suburb = 'Sea Point'" --outFields "RequestID,Category,Status" --resultRecordCount 5` |
| Ad-hoc T-SQL (mock) | `npm run query -- --sql "SELECT TOP 5 Suburb, COUNT(*) n FROM ServiceRequest GROUP BY Suburb ORDER BY n DESC"` |
| Same against a real layer | `npm run query -- 12 --url https://<host>/server/rest/services/<svc>/FeatureServer/0` |
| Regenerate data | `npm run generate -- --count 900 --seed 42` |
| Rebuild generated artifacts | `npm run build` (after editing the library or any `docs/*.md`) |

Requires Node ≥ 22.16 and has **no npm dependencies** (it uses built-in `node:sqlite`). `server/start.js` checks the version.
Don't add packages without asking. The only vendored third-party code is `viewer/vendor/` (Chart.js, SQLite Wasm). Use `127.0.0.1`, not `localhost`: on Windows, Node can resolve `localhost` to IPv6, and the server only binds IPv4.

## MCP tools (server `servicerequests`, see `.mcp.json`)
- `describe_layer`: schema and value lists. Call it first.
- `query_layer`: REST parameters.
- `list_library`
- `run_library_query`: `compare: true` adds the T-SQL result; `params: { top: 10 }` varies an entry
  that declares bounded parameters (`list_library` shows which, and their ranges).
- `run_tsql`: read-only.

## Layout
```
data/service_requests.geojson   the "service" (epoch-ms dates, WGS84 points, metadata.asOf)
docs/architecture.md            component map, layer 1's table schema, the library in both databases
docs/data-model.md              fields, categories, how the generated data behaves
docs/framework.md               5W+H dimensions, analytical layers, roadmap
docs/query-catalog.md           the catalog-as-a-table architecture, and its four real limits
docs/catalog-pattern.md         the pattern argued platform-free, its costs, this repo scored against it
docs/overview.md                the front door: what the PoC tests, the architecture, what it shows
docs/*.html + docs/docs.css     GENERATED from the .md by scripts/build-docs.js (the site’s doc pages)
docs/mermaid-init.js            theme + startup for the mermaid diagrams (hand-written, not generated)
docs/vendor/mermaid.min.js      Mermaid 11, vendored like viewer/vendor — no CDN, no npm dependency
scripts/build-docs.js           zero-dependency Markdown -> HTML for docs/; add a page to its PAGES list
scripts/generate-data.js        seeded generator (categories → sub-categories, seasonality, data defects)
index.html                      redirect to docs/overview.html (the root URL is the doc site)
sw.js                           service worker for the static demo; MUST stay at the repo root
server/start.js                 entry point (Node version check) → server/index.js
server/index.js                 HTTP host + static files only; the REST surface is restRouter.js
server/restRouter.js            the REST surface as (path, params) → response; no HTTP, no platform
                                plus /1/execute: run a catalogued question by id (mock extension)
server/featureService.js        query engine: GeoJSON → in-memory SQLite, ArcGIS query semantics
server/nodeRuntime.js           Node runtime for the engine (fs + node:sqlite) + createFeatureService()
server/serviceConfig.js         platform-free service defaults, shared with the browser demo
server/sqlDialect.js            T-SQL / ArcGIS SQL → SQLite rewrites + registered T-SQL functions
server/schema.js                field list (single source of truth for layer 0's schema)
server/catalogSchema.js         layer 1: the query library as a non-spatial table (fields + rows,
                                incl. the Chart* presentation contract)
sql-library/queryLibrary.js     THE library (31 entries: rest params, transform, tsql, portability)
                                also the source of layer 1, via server/catalogSchema.js
sql-library/runner.js           runs entries anywhere + client-side transforms (LAG, running totals…)
                                also bindEntry/validateParams (bounded parameters) and entryFromRow
viewer/                         ArcGIS JS 4.x viewer, ES modules, no build step
  js/config.js                  layer URL, catalog URL, themes, palette (THEME_COLORS etc.)
  js/catalog.js                 reads the query library from FeatureServer table 1 at runtime
  js/query-store.js             ONE catalog fetch + the selection the two run panels share
  js/query-panel.js             the Run REST and Run SQL panels: one impl, two instances
  js/mcp-envelope.js            builds the tools/call envelopes the run panels display
  js/workflow.js                the stacked Workflow + Agent view trace (rest | sql mode)
  js/charts.js                  ALL Chart.js create/destroy logic
  js/dashboard.js               Dashboard tab (KPIs + charts from REST statistics, cross-filtering)
  js/result-chart.js            table | chart toggle for any result
  js/engine/boot.js             picks live vs static mode; in static mode starts the in-page service
  js/engine/sqliteWasmRuntime.js  node:sqlite-shaped adapter over SQLite Wasm
  vendor/chart.umd.min.js       Chart.js 4.6.1 (must load BEFORE the ArcGIS script tag)
  vendor/sqlite-wasm/           SQLite Wasm; sqlite3.js and sqlite3.wasm must stay side by side
sql/                            01 table · 02 OPENJSON import (view + proc) · 03 vw_QueryLibrary (GENERATED)
rest/                           .http files for the VS Code REST Client (library.http is GENERATED)
                                catalog.http is the discover-then-execute flow, hand-written
mcp/tools.js                    THE MCP tool contract + JSON-RPC dispatch (platform-free, no transport)
mcp/server.js                   stdio transport over it, for Claude Code (Node only)
```

## Conventions
- **The site's front door is `docs/overview.html`.** The repository root `index.html` only
  redirects there; the overview is a normal generated page, so it shares the nav, stylesheet and
  TOC. The nav tabs (including Viewer, REST services and GitHub) come from `navFor()` in
  `scripts/build-docs.js`.
- **Diagrams are mermaid fences in the Markdown.** `scripts/build-docs.js` turns one into a
  `<div class="mermaid">` and loads `docs/vendor/mermaid.min.js` + `docs/mermaid-init.js` from the
  page `<head>` — the body must stay script-free, which `test/docs.test.js` checks. Keep the theme
  in `mermaid-init.js` in step with the palette in `docs/docs.css` by hand: Mermaid cannot read CSS
  variables. Prefer a diagram to ASCII art, and keep node labels short.
- **Tables rule their columns, not just their rows.** Every HTML table — the generated doc
  pages (`docs/docs.css`) and the viewer's result grid (`table.grid` in `viewer/css/app.css`) —
  draws a vertical rule between columns, with the outer edges left open so the table sits flush
  with the text around it rather than reading as a boxed figure. Style tables there, never per
  page or inline.
- **Docs are Markdown-first.** Edit `docs/*.md`, never the generated `docs/*.html`; run `npm run build`.
  `test/docs.test.js` fails if the committed HTML is stale. A new `docs/*.md` must be added to `PAGES`
  in `scripts/build-docs.js`, or that test fails too.
- **Pages publishes the branch root.** There is no build step and no staged file list: a module the
  browser imports is published because it is committed. So the whole repository is served, including
  the Node-only parts — which is harmless, but the browser must never *import* one.
  `test/deploy.test.js` resolves the browser's import closure and enforces that, plus that
  `server/index.js` serves the same files locally. Run `npm test` after adding an import.
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
- **The chart is declared, not guessed.** Layer 1 carries the presentation contract (`HasChart`,
  `ChartType`, `ChartLabelColumn`, `ChartValueColumns`, `ChartSeriesColumn`, `ChartAnnotationColumn`),
  set by the `chart` field of a library entry. `viewer/js/result-chart.js` obeys it and only infers
  from the result's shape when there is no contract (the SQL console, an edited statement). A new
  charted entry must name columns its result really has: `test/catalog.test.js` runs all 23 and fails
  otherwise. Several `ChartValueColumns` are allowed only when they share a unit — one y-axis.
- **A question is varied only by a parameter its author declared.** `params` on a library entry
  declares a typed, bounded parameter and where its value lands; `bindEntry` in
  `sql-library/runner.js` applies it, and layer 1 publishes the declaration as `ParamSpec`. The
  entry stores the **default rendering**, not a template — `resultRecordCount: 5` and `TOP 5` stay
  literal — so binding the declared default must reproduce the published definition exactly, and
  `test/params.test.js` fails if it does not. Bind both the `rest` and the `tsql` side, so the
  variant is the same question under either verb. Never widen a range to make a value fit: the
  range *is* the ratification. An out-of-range value is refused, never clamped.
- **`…/FeatureServer/1/execute` is the enforcing counterpart** (a mock extension, like `/0/sql`).
  Its input is a question number plus declared parameters and nothing else: a `where` or an
  `outStatistics` sent there is refused, not ignored. It resolves the row through the service's own
  layer 1 — never by importing the library — binds on the trusted side, and applies the entry's
  client-side transform before answering. The viewer deliberately does **not** run through it; it
  replays rows against layer 0, because what a bare FeatureServer can carry is the thing this repo
  is testing. Keep both paths: `test/params.test.js` asserts they give identical answers.
- **Charts:** colours come from `viewer/js/config.js`. It is a validated palette in fixed order, and a colour follows its entity. One y-axis only, more than 8 series fold into "Other", and there is a legend only when there are 2 or more series.
- The engine is read-only (`PRAGMA query_only` plus a statement filter). Keep it that way.
- **Two layers, one pipeline.** `svc.query(params, layerId)` serves layer 0 (features) and table 1
  (the query catalog). Everything table-specific lives in a layer descriptor, so add a layer by
  registering a descriptor in `load()`, never by special-casing the query methods. A non-spatial
  table must report `type: 'Table'` with null `geometryType`, `extent` and `timeInfo`.
- **MCP tools are defined once, in `mcp/tools.js`.** `mcp/server.js` is the only transport (stdio).
  Add or change a tool there and the server gets it. `tools.js` is loaded by the browser, so it must
  stay platform-free, and it talks to a small injected adapter (`query`/`sql`/`stats`, each may be
  async) rather than to a FeatureService, which is what lets it run in-process on the server.
  **MCP in the viewer involves no language model and no API key — keep it that way.**
- **There is no MCP tab.** MCP shows up under the question it belongs to: `js/workflow.js` traces
  each run as two stacked, collapsible sections — **Workflow**, the real pipeline timed live, then
  **Agent view**, the `tools/call` that wraps the same work (`run_library_query` in `rest` mode, `run_tsql` in `sql` mode). The payload an agent would
  get is built by `libraryQueryPayload` / `tsqlPayload` and wrapped by `toolContent`, all exported
  from `mcp/tools.js`. **Never hand-build that JSON in the viewer** — nothing in the page dispatches,
  so the two no-drift tests in `test/mcp.test.js` are the only thing keeping the rendered envelopes
  identical to the real ones. Each panel still runs its entry itself: the tools clip to `MAX_ROWS`
  and `run_library_query` formats dates as SAST text, which the grid's sorting, charts and CSV need raw.
- **The tab is the verb.** Run REST and Run SQL are two instances of `js/query-panel.js`, listing the
  same questions and sharing one selection and one catalog fetch via `js/query-store.js`. Keep it one
  fetch: "one REST request discovers every question" is the point of publishing the catalog as table 1.
  There is no Compare button in the viewer — the MCP `compare: true` argument and the CLI
  `--compare` flag still do that. Run SQL gates on `comparable(q)` in `mcp/tools.js`, which tests
  the statement rather than listing identifiers, so an entry whose `tsql` is not a query disables
  the button instead of being rejected by the read-only engine; keep it a test, not a list.
- **The viewer must not import `queryLibrary.js` for its UI.** The run panels read the catalog
  over REST (`viewer/js/catalog.js`); that is the whole point of publishing it. Build scripts, the
  MCP server and the CLI may import it directly.
- The catalog is derived from the library at load time — there is no second copy to keep in step.
  `RestParams` holds the decomposed query parameters, never a `SELECT` statement, because that is
  what a real FeatureServer accepts.
- **The engine must stay platform-free.** `featureService.js`, `sqlDialect.js`, `schema.js`, `restRouter.js`
  and `serviceConfig.js` are loaded by the browser too: no `node:` imports, no `Buffer`, no `process`.
  Node-only code belongs in `nodeRuntime.js` or `index.js`. `test/browser-engine.test.js` runs the whole
  library on both runtimes and fails if they diverge — run `npm test` after touching the engine.
- The viewer's `layerUrl` is derived from where the viewer is served (`SITE_BASE` in `js/config.js`), so the
  demo works unchanged at a GitHub Pages project path. Use `?mode=static` to exercise that path locally.
