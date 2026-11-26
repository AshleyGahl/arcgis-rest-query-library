import { load } from './esri.js';
import { CONFIG } from './config.js';
import { RENDERERS, CLUSTER, POPUP } from './renderers.js';

/**
 * Creates the map. The FeatureLayer points at the mock FeatureServer URL, so every
 * draw, popup, count and extent request goes through the REST `query` endpoint.
 */
export async function createMap() {
  const [esriConfig, Map, MapView, FeatureLayer, Basemap, WebTileLayer, TileLayer, GraphicsLayer, Legend, Expand, Home, ScaleBar, TimeSlider, SketchViewModel] = await load([
    'esri/config', 'esri/Map', 'esri/views/MapView', 'esri/layers/FeatureLayer', 'esri/Basemap',
    'esri/layers/WebTileLayer', 'esri/layers/TileLayer', 'esri/layers/GraphicsLayer',
    'esri/widgets/Legend', 'esri/widgets/Expand', 'esri/widgets/Home', 'esri/widgets/ScaleBar',
    'esri/widgets/TimeSlider', 'esri/widgets/Sketch/SketchViewModel',
  ]);
  if (CONFIG.apiKey) esriConfig.apiKey = CONFIG.apiKey;

  // Ordered: the first that loads becomes the default. Each is built explicitly rather than
  // with Basemap.fromId(), whose well-known ids resolve through the web-map JSON layer factory.
  const basemaps = [
    { id: 'imagery', title: 'Esri World Imagery', make: () => new Basemap({ title: 'Imagery', baseLayers: [new TileLayer({ url: 'https://services.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer' })] }) },
    { id: 'osm', title: 'OpenStreetMap', make: () => new Basemap({
      title: 'OpenStreetMap',
      baseLayers: [new WebTileLayer({
        urlTemplate: 'https://tile.openstreetmap.org/{level}/{col}/{row}.png',
        copyright: '© OpenStreetMap contributors',
      })],
    }) },
    ...(CONFIG.apiKey ? [
      { id: 'gray-vector', title: 'Esri Light Gray', make: () => Basemap.fromId('gray-vector') },
      { id: 'streets-navigation-vector', title: 'Esri Navigation', make: () => Basemap.fromId('streets-navigation-vector') },
    ] : []),
  ];

  /**
   * A basemap whose tiles never arrive leaves the view blank, with nothing in the UI to say
   * why — so load it explicitly and report what failed. `Basemap.load()` resolves once its
   * base layers have loaded their metadata; a tile request that is blocked downstream (an
   * extension, a proxy, a filtered network) surfaces here as a layer load error.
   */
  async function loadBasemap(entry) {
    const basemap = entry.make();
    await basemap.load();
    const broken = basemap.baseLayers.find((l) => l.loadStatus === 'failed');
    if (broken) throw broken.loadError ?? new Error(`${entry.title} failed to load`);
    return basemap;
  }

  function notify(message) {
    const el = document.getElementById('mapNotice');
    if (!el) return;
    el.textContent = message ?? '';
    el.classList.toggle('hidden', !message);
  }

  /** The first basemap that loads, so one blocked tile host does not leave a blank map. */
  async function firstWorkingBasemap() {
    const failures = [];
    for (const entry of basemaps) {
      try {
        const basemap = await loadBasemap(entry);
        if (failures.length) {
          notify(`${failures[0].title} did not load (${failures[0].message}). Showing ${entry.title} instead.`);
        }
        return { basemap, entry };
      } catch (e) {
        const message = e?.message ?? String(e);
        console.error(`Basemap "${entry.title}" failed to load:`, e);
        failures.push({ title: entry.title, message });
      }
    }
    notify(`No basemap could be loaded, so the map shows the request points only. Tried: ${failures.map((f) => f.title).join(', ')}. See the console for details.`);
    return { basemap: null, entry: null };
  }

  const layer = new FeatureLayer({
    url: CONFIG.layerUrl,
    title: 'Service Requests',
    outFields: ['*'],
    popupTemplate: POPUP,
    renderer: RENDERERS.theme(),
  });
  const sketchLayer = new GraphicsLayer({ title: 'Query geometry', listMode: 'hide' });

  const { basemap, entry: activeEntry } = await firstWorkingBasemap();
  const map = new Map({ basemap, layers: [layer, sketchLayer] });
  const view = new MapView({ container: 'viewDiv', map, center: CONFIG.center, zoom: CONFIG.zoom, timeZone: CONFIG.timeZone });

  view.ui.add(new Home({ view }), 'top-left');
  view.ui.add(new Expand({ view, content: new Legend({ view }), expanded: true, expandTooltip: 'Legend', group: 'top-right' }), 'top-right');
  view.ui.add(new ScaleBar({ view, unit: 'metric' }), 'bottom-left');

  const layerView = await view.whenLayerView(layer);
  let highlight;

  return {
    view, layer, layerView, sketchLayer, basemaps,
    /** The basemap actually in use, which is not always the first one when a tile host is blocked. */
    activeBasemapId: activeEntry?.id ?? null,
    async setBasemap(id) {
      const entry = basemaps.find((b) => b.id === id);
      if (!entry) return;
      try {
        map.basemap = await loadBasemap(entry);
        notify(null);
      } catch (e) {
        console.error(`Basemap "${entry.title}" failed to load:`, e);
        notify(`${entry.title} did not load: ${e?.message ?? e}`);
      }
    },
    setRenderer(key, cluster) {
      layer.renderer = RENDERERS[key]();
      layer.featureReduction = cluster && key !== 'heatmap' ? CLUSTER : null;
    },
    setDefinitionExpression(where) {
      layer.definitionExpression = where && where !== '1=1' ? where : null;
      window.dispatchEvent(new CustomEvent('filterchange', { detail: layer.definitionExpression ?? '1=1' }));
    },
    async highlightIds(ids, zoom = true) {
      highlight?.remove();
      highlight = null;
      if (!ids?.length) return;
      highlight = layerView.highlight(ids);
      if (zoom) {
        const { extent } = await layer.queryExtent({ objectIds: ids.slice(0, 2000) });
        if (extent) await view.goTo(ids.length === 1 ? { target: extent.center, zoom: 16 } : extent.expand(1.3)).catch(() => {});
      }
    },
    timeSlider(on) {
      const el = document.getElementById('timeSliderDiv');
      if (on) {
        el.classList.remove('hidden');
        this._slider = new TimeSlider({
          container: el, view, mode: 'time-window', timeZone: CONFIG.timeZone,
          fullTimeExtent: layer.timeInfo.fullTimeExtent,
          stops: { interval: { value: 1, unit: 'months' } },
        });
      } else {
        this._slider?.destroy();
        this._slider = null;
        view.timeExtent = null;
        el.replaceChildren();
        el.classList.add('hidden');
      }
    },
    sketch: () => new SketchViewModel({ view, layer: sketchLayer, polygonSymbol: { type: 'simple-fill', color: [11, 111, 184, 0.12], outline: { color: [11, 111, 184], width: 1.5 } } }),
  };
}
