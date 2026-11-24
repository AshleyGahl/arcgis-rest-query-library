/**
 * Service worker for the static (GitHub Pages) demo.
 *
 * It exists so the viewer needs no static-hosting branch at all: an ArcGIS
 * `FeatureLayer` points at `<site>/arcgis/rest/services/ServiceRequests/FeatureServer/0`
 * exactly as it does against the Node server, and this worker answers those requests.
 * The query engine itself runs in the page (it needs ES modules and the SQLite Wasm
 * build), so this worker is only a relay: intercept, forward to a page over a
 * MessagePort, return what comes back. Real requests, real responses, visible in
 * DevTools' Network tab.
 *
 * It lives at the repository root on purpose. A service worker can only intercept
 * URLs inside its own scope, and the REST paths sit next to `viewer/`, not inside it.
 *
 * This file is a classic (non-module) worker so it runs in every browser that
 * supports service workers at all.
 */

const REST = /\/arcgis\/rest(\/|$)/i;
const REQUEST_TIMEOUT_MS = 30000;
const PING_TIMEOUT_MS = 2000;

// Client ids of pages that have told us they are running the engine. A service
// worker is stopped whenever it goes idle, so this is a cache, not the source of
// truth: when it is empty we ask every open page who can answer.
const hosts = new Set();

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('message', (event) => {
  if (event.data?.type === 'engine-ready' && event.source?.id) hosts.add(event.source.id);
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !REST.test(url.pathname)) return;
  event.respondWith(serve(event));
});

/** Send one message to a page and wait for its reply over a private port. */
function ask(client, message, timeoutMs) {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => reject(new Error('The in-browser mock service did not respond in time.')), timeoutMs);
    channel.port1.onmessage = (event) => {
      clearTimeout(timer);
      if (event.data && event.data.error) reject(new Error(event.data.error));
      else resolve(event.data);
    };
    client.postMessage(message, [channel.port2]);
  });
}

/**
 * Pages that can answer, best candidate first. The page that made the request is
 * preferred — it is the one whose engine already has the data loaded.
 */
async function enginePages(event) {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  let known = windows.filter((client) => hosts.has(client.id));

  if (!known.length) {
    // Either nothing is open, or this worker restarted and lost the set. Ask around.
    const replies = await Promise.all(windows.map((client) =>
      ask(client, { type: 'engine-ping' }, PING_TIMEOUT_MS).then(() => client, () => null)));
    known = replies.filter(Boolean);
    for (const client of known) hosts.add(client.id);
  }

  const requester = known.find((client) => client.id === event.clientId);
  return requester ? [requester, ...known.filter((client) => client !== requester)] : known;
}

function problem(request, status, message) {
  const wantsHtml = (request.headers.get('accept') || '').includes('text/html');
  const viewer = new URL('viewer/', self.registration.scope).pathname;
  const body = wantsHtml
    ? `<!doctype html><meta charset="utf-8"><title>Mock service not ready</title>
<body style="font:14px/1.6 Segoe UI,Arial,sans-serif;margin:2rem;max-width:40rem;color:#0b0b0b">
<h1 style="font-size:1.4rem">Mock service not ready</h1>
<p>${message}</p>
<p>This demo has no server: the mock FeatureServer runs inside the viewer page, so the viewer
has to be open in a tab for these REST URLs to answer.</p>
<p><a href="${viewer}">Open the GIS viewer</a>, then reload this page.</p>`
    : JSON.stringify({ error: { code: status, message, details: [] } });
  return new Response(body, {
    status,
    headers: { 'Content-Type': wantsHtml ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

async function serve(event) {
  const request = event.request;
  const payload = {
    url: request.url,
    method: request.method,
    contentType: request.headers.get('content-type') || '',
    body: request.method === 'POST' ? await request.clone().text() : '',
  };

  let pages;
  try {
    pages = await enginePages(event);
  } catch (e) {
    return problem(request, 503, e.message || String(e));
  }
  if (!pages.length) return problem(request, 503, 'No page is open that can answer the request.');

  let last = 'The in-browser mock service did not answer.';
  for (const client of pages) {
    try {
      const answer = await ask(client, { type: 'rest-request', payload }, REQUEST_TIMEOUT_MS);
      return new Response(answer.body, {
        status: answer.status,
        headers: {
          'Content-Type': answer.contentType,
          'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': '*',
        },
      });
    } catch (e) {
      hosts.delete(client.id); // that page is gone or never had an engine
      last = e.message || String(e);
    }
  }
  return problem(request, 503, last);
}
