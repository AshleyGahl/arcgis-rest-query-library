import { CONFIG } from './config.js';
import { bootMockService } from './engine/boot.js';
import { createMap } from './map.js';
import { initResults } from './results.js';
import { initFilterPanel } from './filter-panel.js';
import { initLibraryPanel } from './library-panel.js';
import { initConsolePanel } from './console-panel.js';
import { initSqlPanel } from './sql-panel.js';
import { initDashboard } from './dashboard.js';

let dashboard = null;
document.querySelectorAll('.tab').forEach((tab) => {
  tab.onclick = () => {
    document.querySelectorAll('.tab, .pane').forEach((el) => el.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`pane-${tab.dataset.tab}`).classList.add('active');
    dashboard?.setVisible(tab.dataset.tab === 'dash');
  };
});
document.getElementById('serviceLink').href = CONFIG.layerUrl.replace(/\/\d+$/, '');

// The FeatureServer this viewer talks to is either the Node mock server or, when
// there is none (the published static demo), the same engine running in this page
// behind a service worker. Nothing may query before that is settled.
const boot = await bootMockService();
const bootEl = document.getElementById('boot');
if (boot.error) {
  bootEl.className = 'boot error';
  bootEl.innerHTML = `<strong>The mock FeatureServer could not start.</strong><span>${boot.error.message}</span>`;
} else {
  bootEl.remove();
  if (boot.mode === 'static') {
    document.getElementById('serviceMode').textContent = 'in-browser service · SQLite Wasm';
    document.getElementById('serviceMode').title = 'No server: the mock FeatureServer runs in this page and a service worker answers the REST requests.';
  }
}

initSqlPanel();

// If the ArcGIS SDK can't load (offline, CDN blocked) the panels still work against the REST service.
const noMap = {
  basemaps: [], view: null, sketchLayer: null, activeBasemapId: null,
  setBasemap() {}, setRenderer() {}, highlightIds() {}, timeSlider() {},
  setDefinitionExpression(w) { window.dispatchEvent(new CustomEvent('filterchange', { detail: w || '1=1' })); },
  sketch() { throw new Error('Map not available'); },
};
let map = noMap;
try {
  map = await createMap();
  window.app = map; // handy in DevTools: app.layer, app.view
} catch (e) {
  console.error(e);
  document.getElementById('viewDiv').innerHTML = `<p style="padding:20px;color:#a3273b">Map failed to load: ${e.message ?? e}.<br>Check that js.arcgis.com is reachable. The panels still query the REST service.</p>`;
}
const filters = initFilterPanel(map);
// Chart clicks in the results drawer AND the clicked value onto the current map filter
initResults({
  onFilter: (clause) => {
    const cur = document.getElementById('fWhere').value.trim();
    const next = !cur || cur === '1=1' ? clause : `(${cur}) AND ${clause}`;
    map.setDefinitionExpression(next);
    filters.setWhere(next);
  },
});
dashboard = initDashboard(map, filters);
initLibraryPanel(map, filters);
initConsolePanel(map, filters);
