/**
 * Dashboard tab: KPI tiles + charts driven by REST statistics queries.
 * Everything respects the map's current filter (definitionExpression) and, optionally,
 * the map extent. Clicking a bar adds that value to the map filter (cross-filtering).
 */
import { THEMES, THEME_COLORS, STATUS_GROUP_COLORS, CHANNEL_COLORS, CHANNELS, SERIES, OTHER } from './config.js';
import { restQuery } from './rest.js';
import { drawChart, chartsAvailable } from './charts.js';
import { fmtNum, debounce, sqlValue } from './utils.js';

const $ = (id) => document.getElementById(id);
const q = (list) => list.map(sqlValue).join(', ');

// SQL mirror of the map's Arcade theme expression so chart groups == map classes
const THEME_CASE = `CASE ${Object.entries(THEMES).filter(([, c]) => c).map(([t, c]) => `WHEN Category IN (${q(c)}) THEN ${sqlValue(t)}`).join(' ')} ELSE 'Other' END`;
const OPEN = "Status <> 'Closed'";
const RES = 'DATEDIFF(day, DtLogged, DtCompleted)';
const count = (out) => ({ statisticType: 'count', onStatisticField: 'ObjectID', outStatisticFieldName: out });
const sum = (expr, out) => ({ statisticType: 'sum', onStatisticField: expr, outStatisticFieldName: out });
const themeWhere = (t) => (THEMES[t] ? `Category IN (${q(THEMES[t])})` : `Category NOT IN (${q(Object.values(THEMES).filter(Boolean).flat())})`);

export function initDashboard(map, filters) {
  let where = '1=1';
  let visible = false;
  let dirty = true;
  let seq = 0;

  const scopeParams = () => {
    const p = { where };
    if ($('dExtent').checked && map.view) {
      const e = map.view.extent.toJSON();
      Object.assign(p, { geometry: JSON.stringify(e), geometryType: 'esriGeometryEnvelope', inSR: e.spatialReference.wkid, spatialRel: 'esriSpatialRelIntersects' });
    }
    return p;
  };
  const stats = (extra) => restQuery({ ...scopeParams(), ...extra, where: extra.where ? `(${where}) AND (${extra.where})` : where });

  // Cross-filter: AND the clicked value onto the current map filter
  const drill = (clause) => {
    const next = where === '1=1' ? clause : `(${where}) AND ${clause}`;
    map.setDefinitionExpression(next);
    filters.setWhere(next);
  };

  async function refresh() {
    if (!visible) { dirty = true; return; }
    dirty = false;
    const my = ++seq;
    $('dScope').textContent = (where === '1=1' ? 'All requests' : where) + ($('dExtent').checked ? ' · within map extent' : '');
    $('dStatus').textContent = 'Updating…';
    try {
      const [kpi, logged, done, theme, status, channel, suburbs, hours] = await Promise.all([
        stats({ outStatistics: [
          count('Total'),
          sum(`CASE WHEN ${OPEN} THEN 1 ELSE 0 END`, 'OpenCount'),
          sum('CASE WHEN DtCompleted IS NOT NULL THEN 1 ELSE 0 END', 'Closed'),
          sum(`CASE WHEN DtCompleted IS NOT NULL AND ${RES} > 5 THEN 1 ELSE 0 END`, 'Breached'),
          { statisticType: 'percentile_cont', onStatisticField: `CASE WHEN DtCompleted >= DtLogged THEN ${RES} END`, statisticParameters: { value: 0.5 }, outStatisticFieldName: 'MedianDays' },
        ], sqlFormat: 'native' }),
        stats({ groupByFieldsForStatistics: "FORMAT(DtLogged, 'yyyy-MM') AS YM", outStatistics: [count('n')], orderByFields: 'YM', sqlFormat: 'native' }),
        stats({ where: 'DtCompleted IS NOT NULL', groupByFieldsForStatistics: "FORMAT(DtCompleted, 'yyyy-MM') AS YM", outStatistics: [count('n')], orderByFields: 'YM', sqlFormat: 'native' }),
        stats({ groupByFieldsForStatistics: `${THEME_CASE} AS Theme`, outStatistics: [count('n')], orderByFields: 'n DESC' }),
        stats({ groupByFieldsForStatistics: 'Status', outStatistics: [count('n')] }),
        stats({ groupByFieldsForStatistics: 'Channel', outStatistics: [count('n')] }),
        stats({ where: `Suburb IS NOT NULL AND ${OPEN}`, groupByFieldsForStatistics: 'Suburb', outStatistics: [count('n')], orderByFields: 'n DESC, Suburb', resultRecordCount: 10 }),
        stats({ groupByFieldsForStatistics: 'EXTRACT(HOUR FROM DtLogged) AS Hr', outStatistics: [count('n')], orderByFields: 'Hr' }),
      ]);
      if (my !== seq) return; // a newer refresh superseded this one
      for (const r of [kpi, logged, done, theme, status, channel, suburbs, hours]) if (r.json.error) throw new Error(r.json.error.message);

      // KPI tiles
      const k = kpi.rows[0] ?? {};
      $('kTotal').textContent = fmtNum(k.Total);
      $('kOpen').textContent = fmtNum(k.OpenCount);
      $('kOpenPct').textContent = k.Total ? `${fmtNum((k.OpenCount * 100) / k.Total, 1)}% of total` : '';
      $('kMedian').textContent = k.MedianDays == null ? '–' : fmtNum(k.MedianDays, 1);
      $('kBreach').textContent = k.Closed ? `${fmtNum((k.Breached * 100) / k.Closed, 1)}%` : '–';

      // Monthly logged vs completed (one axis, two series)
      const months = [...new Set([...logged.rows, ...done.rows].map((r) => r.YM))].filter(Boolean).sort();
      const lm = Object.fromEntries(logged.rows.map((r) => [r.YM, r.n]));
      const dm = Object.fromEntries(done.rows.map((r) => [r.YM, r.n]));
      drawChart('chMonthly', {
        type: 'line', labels: months,
        datasets: [
          { label: 'Logged', data: months.map((m) => lm[m] ?? 0), color: SERIES[0] },
          { label: 'Completed', data: months.map((m) => dm[m] ?? 0), color: SERIES[1] },
        ],
        onClick: (ym) => {
          const [y, m] = ym.split('-').map(Number);
          const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
          drill(`DtLogged >= DATE '${ym}-01' AND DtLogged < DATE '${next}-01'`);
        },
      });

      drawChart('chTheme', {
        type: 'bar', horizontal: true, labels: theme.rows.map((r) => r.Theme),
        datasets: [{ label: 'Requests', data: theme.rows.map((r) => r.n), colors: theme.rows.map((r) => THEME_COLORS[r.Theme] ?? OTHER) }],
        onClick: (t) => drill(themeWhere(t)),
      });

      const order = Object.keys(STATUS_GROUP_COLORS);
      drawChart('chStatus', {
        type: 'bar', labels: order,
        datasets: [{ label: 'Requests', data: order.map((g) => status.rows.find((r) => r.Status === g)?.n ?? 0), colors: order.map((g) => STATUS_GROUP_COLORS[g]) }],
        onClick: (g) => drill(`Status = ${sqlValue(g)}`),
      });

      drawChart('chChannel', {
        type: 'bar', labels: CHANNELS,
        datasets: [{ label: 'Requests', data: CHANNELS.map((c) => channel.rows.find((r) => r.Channel === c)?.n ?? 0), colors: CHANNELS.map((c) => CHANNEL_COLORS[c]) }],
        onClick: (c) => drill(`Channel = ${sqlValue(c)}`),
      });

      drawChart('chSuburbs', {
        type: 'bar', horizontal: true, labels: suburbs.rows.map((r) => r.Suburb),
        datasets: [{ label: 'Open requests', data: suburbs.rows.map((r) => r.n), color: SERIES[0] }],
        onClick: (sub) => drill(`Suburb = ${sqlValue(sub)}`),
      });

      const hrs = Array.from({ length: 24 }, (_, h) => h);
      const hm = Object.fromEntries(hours.rows.map((r) => [r.Hr, r.n]));
      drawChart('chHour', {
        type: 'bar', labels: hrs.map((h) => `${String(h).padStart(2, '0')}h`),
        datasets: [{ label: 'Requests', data: hrs.map((h) => hm[h] ?? 0), color: SERIES[0] }],
      });

      $('dStatus').textContent = `Updated ${new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })} · 8 REST statistics queries`;
    } catch (e) {
      if (my === seq) $('dStatus').textContent = `Error: ${e.message}`;
    }
  }
  const refreshSoon = debounce(refresh, 300);

  if (!chartsAvailable()) $('dStatus').textContent = 'Chart.js failed to load (viewer/vendor/chart.umd.min.js).';

  window.addEventListener('filterchange', (e) => { where = e.detail || '1=1'; refreshSoon(); });
  $('dExtent').onchange = refreshSoon;
  $('dReset').onclick = () => { map.setDefinitionExpression(null); filters.setWhere('1=1'); };
  if (map.view) map.view.watch('stationary', (s) => { if (s && $('dExtent').checked) refreshSoon(); });

  return {
    setVisible(v) { visible = v; if (v && dirty) refresh(); },
  };
}
