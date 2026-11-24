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

  const carto = (style, title) => () => new Basemap({
    title,
    baseLayers: [new WebTileLayer({
      urlTemplate: `https://{subDomain}.basemaps.cartocdn.com/${style}/{level}/{col}/{row}.png`,
      subDomains: ['a', 'b', 'c', 'd'],
      copyright: '© OpenStreetMap contributors © CARTO',
    })],
  });
  const basemaps = [
    { id: 'light', title: 'Light (CARTO)', make: carto('light_all', 'Light') },
    { id: 'dark', title: 'Dark (CARTO)', make: carto('dark_all', 'Dark') },
    { id: 'osm', title: 'OpenStreetMap', make: () => new Basemap({
      title: 'OpenStreetMap',
      // Built explicitly rather than with Basemap.fromId('osm'): the well-known id resolves
      // through the web-map JSON layer factory, which does not reliably produce a drawable
      // layer here. A WebTileLayer on the OSM standard tile URL is the same tiles, directly.
      baseLayers: [new WebTileLayer({
        urlTemplate: 'https://tile.openstreetmap.org/{level}/{col}/{row}.png',
        copyright: '© OpenStreetMap contributors',
      })],
    }) },
    { id: 'imagery', title: 'Esri World Imagery', make: () => new Basemap({ title: 'Imagery', baseLayers: [new TileLayer({ url: 'https://services.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer' })] }) },
    ...(CONFIG.apiKey ? [
      { id: 'gray-vector', title: 'Esri Light Gray', make: () => Basemap.fromId('gray-vector') },
      { id: 'streets-navigation-vector', title: 'Esri Navigation', make: () => Basemap.fromId('streets-navigation-vector') },
    ] : []),
  ];

  const layer = new FeatureLayer({
    url: CONFIG.layerUrl,
    title: 'Service Requests',
    outFields: ['*'],
    popupTemplate: POPUP,
    renderer: RENDERERS.theme(),
  });
  const sketchLayer = new GraphicsLayer({ title: 'Query geometry', listMode: 'hide' });

  const map = new Map({ basemap: basemaps[0].make(), layers: [layer, sketchLayer] });
  const view = new MapView({ container: 'viewDiv', map, center: CONFIG.center, zoom: CONFIG.zoom, timeZone: CONFIG.timeZone });

  view.ui.add(new Home({ view }), 'top-left');
  view.ui.add(new Expand({ view, content: new Legend({ view }), expanded: true, expandTooltip: 'Legend', group: 'top-right' }), 'top-right');
  view.ui.add(new ScaleBar({ view, unit: 'metric' }), 'bottom-left');

  const layerView = await view.whenLayerView(layer);
  let highlight;

  return {
    view, layer, layerView, sketchLayer, basemaps,
    setBasemap: (id) => { map.basemap = basemaps.find((b) => b.id === id).make(); },
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
