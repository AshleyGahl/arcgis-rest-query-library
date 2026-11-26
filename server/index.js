/**
 * HTTP host for the mock ArcGIS REST service + static viewer.
 *
 *   http://127.0.0.1:3001/                                                   -> landing page
 *   http://127.0.0.1:3001/arcgis/rest/services                               -> services directory
 *   http://127.0.0.1:3001/arcgis/rest/services/ServiceRequests/FeatureServer/0/query
 *   http://127.0.0.1:3001/arcgis/rest/services/ServiceRequests/FeatureServer/0/sql   (mock extension)
 *
 * The REST surface itself lives in `server/restRouter.js`, which the static
 * browser demo serves through a service worker instead of a socket.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { createFeatureService } from './nodeRuntime.js';
import { createRestRouter, isRestPath } from './restRouter.js';

const svc = createFeatureService(config);

const route = createRestRouter(svc, config, {
  onQuery({ ms, params, result }) {
    if (!config.logQueries) return;
    const summary = ['where', 'outStatistics', 'groupByFieldsForStatistics', 'returnCountOnly', 'geometry', 'orderByFields']
      .filter((k) => params.get(k)).map((k) => `${k}=${String(params.get(k)).slice(0, 80)}`).join(' ');
    console.log(`[query] ${ms}ms ${result.error ? 'ERROR ' + result.error.message : ''} ${summary}`);
  },
});

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.geojson': 'application/geo+json; charset=utf-8', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.md': 'text/markdown; charset=utf-8' };
// `/mcp/` is here because the viewer's MCP tab imports the tool contract
// (`mcp/tools.js`) directly; `mcp/server.js` is never fetched by the browser.
const STATIC = { '/viewer/': 'viewer', '/sql-library/': 'sql-library', '/data/': 'data', '/server/': 'server', '/docs/': 'docs', '/mcp/': 'mcp' };
// Files served from the repository root, so a local run matches the published static site:
// the landing page, and the service worker the static demo registers (?mode=static).
const ROOT_FILES = new Set(['/', '/index.html', '/sw.js']);

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
  res.end(body);
}

function serveStatic(res, prefix, dir, urlPath) {
  const rel = decodeURIComponent(urlPath.slice(prefix.length)) || 'index.html';
  const base = path.join(config.root, dir);
  const file = path.normalize(path.join(base, rel));
  if (!file.startsWith(base)) return send(res, 403, 'Forbidden', 'text/plain');
  fs.stat(file, (err, st) => {
    if (err) return send(res, 404, 'Not found', 'text/plain');
    const target = st.isDirectory() ? path.join(file, 'index.html') : file;
    fs.readFile(target, (e, buf) => (e ? send(res, 404, 'Not found', 'text/plain') : send(res, 200, buf, MIME[path.extname(target)] ?? 'application/octet-stream')));
  });
}

async function readBody(req) {
  if (req.method !== 'POST') return new URLSearchParams();
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks).toString('utf8');
  if ((req.headers['content-type'] ?? '').includes('application/json')) return new URLSearchParams(Object.entries(JSON.parse(body || '{}')).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)]));
  return new URLSearchParams(body);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': '*' });
      return res.end();
    }
    const url = new URL(req.url, `http://${req.headers.host}`);
    const params = url.searchParams;
    for (const [k, v] of await readBody(req)) params.set(k, v);
    const p = url.pathname.replace(/\/+$/, '') || '/';

    if (url.pathname === '/viewer') { res.writeHead(302, { Location: '/viewer/' }); return res.end(); }
    if (ROOT_FILES.has(p)) return serveStatic(res, '/', '.', p === '/' ? '/index.html' : p);
    for (const [prefix, dir] of Object.entries(STATIC)) {
      if ((p + '/').startsWith(prefix)) return serveStatic(res, prefix, dir, url.pathname);
    }

    if (isRestPath(p)) {
      const hit = route({ path: p, params });
      if (hit) return send(res, hit.status, hit.body, hit.contentType);
    }

    send(res, 404, JSON.stringify({ error: { code: 404, message: 'Not found', details: [p] } }));
  } catch (e) {
    send(res, 500, JSON.stringify({ error: { code: 500, message: e.message, details: [] } }));
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n  Port ${config.port} is already in use. Stop the other server (Debug toolbar ■, or close its terminal),`);
    console.error('  or set a different port in .vscode/launch.json ("env": { "PORT": "3001" }).\n');
    process.exit(1);
  }
  throw e;
});

server.listen(config.port, config.host, () => {
  const origin = `http://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}:${config.port}`;
  console.log(`Mock FeatureServer: ${origin}/arcgis/rest/services/${config.serviceName}/FeatureServer/0`);
  console.log(`GIS viewer:         ${origin}/viewer/`);
  console.log(`Loaded ${svc.count} features (clock: ${config.clock}${config.clock === 'snapshot' ? ' @ ' + (svc.metadata.asOf ?? '?') : ''})`);
});
