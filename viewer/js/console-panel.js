import { restQuery, layerUrl } from './rest.js';
import { toQueryUrl } from '../../sql-library/runner.js';
import { showResults, showError } from './results.js';

const $ = (id) => document.getElementById(id);

export function initConsolePanel(map, filters) {
  let polygon = null;
  let sketchVM = null;

  const params = () => {
    const p = {
      where: $('cWhere').value.trim() || '1=1',
      outFields: $('cOutFields').value.trim() || '*',
      orderByFields: $('cOrderBy').value.trim() || undefined,
      groupByFieldsForStatistics: $('cGroupBy').value.trim() || undefined,
      outStatistics: $('cStats').value.trim() || undefined,
      having: $('cHaving').value.trim() || undefined,
      resultRecordCount: $('cLimit').value || undefined,
      returnCountOnly: $('cCountOnly').checked || undefined,
      returnDistinctValues: $('cDistinct').checked || undefined,
      returnGeometry: true,
      outSR: 4326,
    };
    if (p.outStatistics) { delete p.outFields; delete p.returnGeometry; }
    if (polygon) Object.assign(p, { geometry: JSON.stringify(polygon), geometryType: 'esriGeometryPolygon', inSR: polygon.spatialReference.wkid, spatialRel: 'esriSpatialRelIntersects' });
    else if ($('cExtent').checked && map.view) {
      const e = map.view.extent.toJSON();
      Object.assign(p, { geometry: JSON.stringify(e), geometryType: 'esriGeometryEnvelope', inSR: e.spatialReference.wkid, spatialRel: 'esriSpatialRelIntersects' });
    }
    return p;
  };
  const refreshUrl = () => { $('cUrl').href = toQueryUrl(layerUrl, { ...params(), f: 'pjson' }); };
  document.querySelectorAll('#pane-console input, #pane-console textarea').forEach((el) => el.addEventListener('input', refreshUrl));

  $('cRun').onclick = async () => {
    try {
      const p = params();
      const { url, json, rows, dateColumns } = await restQuery(p);
      if (json.error) throw new Error(`${json.error.message}\n${(json.error.details ?? []).join('\n')}`);
      const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
      showResults({
        title: 'REST Console', meta: json.exceededTransferLimit ? 'exceededTransferLimit: more records available' : '',
        urls: [url], rows, columns, dateColumns,
        onRowClick: (row) => map.highlightIds([row.ObjectID]),
      });
      const ids = rows.map((r) => r.ObjectID).filter((x) => x != null);
      map.highlightIds(ids, ids.length > 0);
    } catch (e) { showError('REST Console', e); }
  };
  $('cApply').onclick = () => { const w = $('cWhere').value.trim(); map.setDefinitionExpression(w); filters.setWhere(w); };

  $('cDraw').onclick = () => {
    if (!sketchVM) {
      sketchVM = map.sketch();
      sketchVM.on('create', (ev) => {
        if (ev.state === 'complete') {
          polygon = ev.graphic.geometry.toJSON();
          $('cGeomState').textContent = 'polygon set — sent as esriGeometryPolygon';
          refreshUrl();
        }
      });
    }
    map.sketchLayer.removeAll();
    polygon = null;
    $('cGeomState').textContent = 'click to add vertices, double-click to finish';
    sketchVM.create('polygon');
  };
  $('cClearGeom').onclick = () => { map.sketchLayer.removeAll(); polygon = null; $('cGeomState').textContent = ''; refreshUrl(); };
  refreshUrl();
}
