/**
 * Decides where the viewer's FeatureServer comes from, and in the static case
 * stands one up inside the page.
 *
 *   live   - a Node mock server (npm start) is answering at this origin. Nothing to do.
 *   static - no server: build the engine here, register `sw.js`, and answer the
 *            service worker's forwarded requests. This is the GitHub Pages path.
 *
 * In static mode the page runs the very same modules the Node host runs —
 * `server/featureService.js`, `server/sqlDialect.js`, `server/restRouter.js` — over
 * SQLite Wasm instead of `node:sqlite`. So the viewer, the REST console, the 70
 * library queries and the T-SQL panel all behave as they do locally, and the
 * requests are genuine HTTP requests that a service worker happens to answer.
 *
 * `?mode=live` or `?mode=static` in the viewer URL overrides the detection.
 */
import { SITE_BASE } from '../config.js';
import { SERVICE_DEFAULTS } from '../../../server/serviceConfig.js';
import { FeatureService } from '../../../server/featureService.js';
import { createRestRouter } from '../../../server/restRouter.js';
import { browserRuntime } from './sqliteWasmRuntime.js';

const SW_URL = `${SITE_BASE}/sw.js`;
const SW_SCOPE = `${SITE_BASE}/`;
const GEOJSON_URL = `${SITE_BASE}/data/service_requests.geojson`;
const RELOADED_FLAG = 'service-request-gis:sw-reloaded';

const requestedMode = new URLSearchParams(location.search).get('mode');

/** Is a real server answering, or is our own service worker already in charge? */
async function detectMode() {
  if (requestedMode === 'live' || requestedMode === 'static') return requestedMode;
  if (location.protocol === 'file:') return 'unavailable';
  if (navigator.serviceWorker?.controller) return 'static'; // our worker is already serving
  try {
    const res = await fetch(`${SITE_BASE}/arcgis/rest/info?f=json`, { cache: 'no-store' });
    if (res.ok && (await res.json()).currentVersion) return 'live';
  } catch { /* no server here */ }
  return 'static';
}

/** Turn one forwarded request into the router's `{ path, params }`. */
async function paramsFor({ url, method, contentType, body }) {
  const parsed = new URL(url);
  const params = parsed.searchParams;
  if (method === 'POST' && body) {
    const entries = contentType.includes('application/json')
      ? Object.entries(JSON.parse(body || '{}')).map(([k, v]) => [k, typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v)])
      : [...new URLSearchParams(body)];
    for (const [k, v] of entries) params.set(k, v);
  }
  return { path: parsed.pathname.replace(/\/+$/, '') || '/', params };
}

async function startStaticService() {
  if (!('serviceWorker' in navigator)) {
    throw new Error('This browser has no service worker support, which the static demo needs. Run the Node server instead (npm start).');
  }

  const cfg = { ...SERVICE_DEFAULTS };
  const runtime = await browserRuntime(GEOJSON_URL);
  const svc = new FeatureService(cfg, runtime);
  const route = createRestRouter(svc, cfg);

  // Answer the worker before waiting for it to take control: a worker that is
  // already active may start forwarding as soon as it has a client.
  navigator.serviceWorker.addEventListener('message', async (event) => {
    const port = event.ports[0];
    if (!port) return;
    if (event.data?.type === 'engine-ping') return port.postMessage({ ok: true });
    if (event.data?.type !== 'rest-request') return;
    try {
      const hit = route({ ...(await paramsFor(event.data.payload)), prefix: SITE_BASE });
      port.postMessage(hit ?? { status: 404, contentType: 'application/json; charset=utf-8', body: JSON.stringify({ error: { code: 404, message: 'Not found', details: [] } }) });
    } catch (e) {
      port.postMessage({ error: e?.message ?? String(e) });
    }
  });

  const registration = await navigator.serviceWorker.register(SW_URL, { scope: SW_SCOPE });
  await navigator.serviceWorker.ready;

  // Tell the worker this page can answer, so it never has to guess between tabs.
  const announce = () => (navigator.serviceWorker.controller ?? registration.active)?.postMessage({ type: 'engine-ready' });
  announce();
  navigator.serviceWorker.addEventListener('controllerchange', announce);

  if (!navigator.serviceWorker.controller) {
    // `clients.claim()` in the worker normally takes control of this page straight
    // away. If it has not within a few seconds, one reload is the reliable fix.
    const claimed = await new Promise((resolve) => {
      const done = () => resolve(true);
      navigator.serviceWorker.addEventListener('controllerchange', done, { once: true });
      setTimeout(() => resolve(Boolean(navigator.serviceWorker.controller)), 4000);
    });
    if (!claimed) {
      if (sessionStorage.getItem(RELOADED_FLAG)) {
        throw new Error('The service worker never took control of the page, so the mock FeatureServer cannot answer requests.');
      }
      sessionStorage.setItem(RELOADED_FLAG, '1');
      location.reload();
      await new Promise(() => {}); // hold here; the reload is on its way
    }
  }
  sessionStorage.removeItem(RELOADED_FLAG);

  return { svc, count: svc.count, asOf: svc.metadata?.asOf ?? null };
}

/**
 * Live mode with our service worker still in charge would be the worst of both:
 * the worker would relay requests to a page that is not running an engine. This
 * happens on 127.0.0.1 after trying `?mode=static`, so `?mode=live` undoes it.
 * An active worker keeps serving the pages it already controls, hence the reload.
 */
async function releaseServiceWorker() {
  const registration = await navigator.serviceWorker?.getRegistration(SW_SCOPE);
  if (!registration) return;
  await registration.unregister();
  if (navigator.serviceWorker.controller && !sessionStorage.getItem(RELOADED_FLAG)) {
    sessionStorage.setItem(RELOADED_FLAG, '1');
    location.reload();
    await new Promise(() => {});
  }
}

/**
 * Must be awaited before the map or any panel issues a query.
 * @returns `{ mode, count, asOf, error }`
 */
export async function bootMockService() {
  const mode = await detectMode();
  if (mode === 'live') {
    await releaseServiceWorker();
    sessionStorage.removeItem(RELOADED_FLAG);
    return { mode };
  }
  if (mode === 'unavailable') {
    return { mode, error: new Error('Opened from the filesystem. Serve the folder over http:// (npm start) or use the published demo.') };
  }
  try {
    const { count, asOf } = await startStaticService();
    return { mode: 'static', count, asOf };
  } catch (e) {
    return { mode: 'static', error: e };
  }
}
