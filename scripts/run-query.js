#!/usr/bin/env node
/**
 * Run Query Library entries from the terminal.
 *
 *   npm run query -- list                       list all 70 queries
 *   npm run query -- 41                         run Q41's REST request in-process
 *   npm run query -- 41 --compare               run REST and T-SQL side by side
 *   npm run query -- 41 --url <layerUrl>        run against any FeatureServer layer over HTTP
 *   npm run query -- --where "Suburb = 'Sea Point'" --outFields "RequestID,Category,Status" --resultRecordCount 5
 *   npm run query -- --sql "SELECT TOP 5 Suburb, COUNT(*) AS n FROM ServiceRequest GROUP BY Suburb ORDER BY n DESC"
 */
import { createFeatureService } from '../server/nodeRuntime.js';
import { config } from '../server/config.js';
import { queryLibrary, getQuery } from '../sql-library/queryLibrary.js';
import { runEntry, httpFetcher, toQueryUrl, toRows } from '../sql-library/runner.js';

const argv = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) {
    const k = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) flags[k] = true; else { flags[k] = next; i++; }
  } else positional.push(argv[i]);
}

const LAYER = `http://127.0.0.1:${config.port}/arcgis/rest/services/${config.serviceName}/FeatureServer/0`;
const svc = createFeatureService(config);
const local = async (params) => ({ url: toQueryUrl(LAYER, params), json: svc.query(params) });
const fetcher = flags.url ? httpFetcher(flags.url) : local;
const max = parseInt(flags.rows ?? '25', 10);

// Esri dates are epoch ms; render them in SAST for the terminal
const fmt = (v) => (typeof v === 'number' && v > 9e11 && v < 4.1e12 ? new Date(v + 2 * 3600000).toISOString().slice(0, 19).replace('T', ' ') : v);
const show = (rows, title) => {
  rows = rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, fmt(v)])));
  console.log(`\n${title} — ${rows.length} row(s)${rows.length > max ? `, showing ${max}` : ''}`);
  console.table(rows.slice(0, max));
};

if (positional[0] === 'list') {
  for (const q of queryLibrary) console.log(`${String(q.id).padStart(2)}  [${q.portability.padEnd(14)}] ${q.layer} ${q.dimension.padEnd(5)} ${q.question}`);
} else if (flags.sql) {
  const r = svc.sql(flags.sql);
  if (r.error) { console.error(r.error.message, r.error.details.join('\n')); process.exit(1); }
  console.log(`SQLite: ${r.sqlite}`);
  show(r.rows, 'T-SQL (mock extension)');
} else if (positional[0]) {
  const entry = getQuery(positional[0]);
  if (!entry) { console.error(`No query ${positional[0]}`); process.exit(1); }
  console.log(`Q${entry.id}: ${entry.question}  [${entry.portability}]`);
  if (entry.notes) console.log(`Note: ${entry.notes}`);
  try {
    const r = await runEntry(entry, fetcher);
    for (const req of r.requests) console.log(`GET ${decodeURIComponent(req.url)}`);
    if (entry.transform) console.log(`Client transform: ${[entry.transform].flat().map((t) => t.type).join(' -> ')}`);
    show(r.rows, 'REST');
  } catch (e) { console.error('REST error:', e.message); process.exitCode = 1; }
  if (flags.compare && entry.id !== 50) {
    const t = svc.sql(entry.tsql);
    if (t.error) console.error('T-SQL error:', t.error.message);
    else show(t.rows, 'T-SQL');
  }
} else if (Object.keys(flags).length) {
  const { url, rows, ...params } = flags;
  const { url: u, json } = await fetcher(params);
  console.log(`GET ${decodeURIComponent(u)}`);
  try { show(toRows(json), 'REST'); } catch (e) { console.error(e.message); process.exit(1); }
} else {
  console.log('Usage: npm run query -- list | <id> [--compare] [--url <layerUrl>] | --where ... | --sql "..."');
}
