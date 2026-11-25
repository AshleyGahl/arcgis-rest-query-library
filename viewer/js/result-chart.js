/**
 * Builds a chart from ANY query result in the results drawer (library, console).
 *
 * Two sources, in that order of authority:
 *   1. the catalog's presentation contract — the Chart* columns of FeatureServer table 1,
 *      arriving as `chart` on the entry. The question's author said how it is drawn, so
 *      that is what is drawn.
 *   2. inference from the shape of the rows, for everything with no contract: the SQL
 *      console, an edited statement, a result whose declared columns no longer fit.
 *
 * The inference is the fallback rather than the rule, because a guess cannot be wrong
 * loudly — see docs/catalog-pattern.md section 2. Either way the controls stay live: the
 * contract picks the defaults, the reader can still re-cut it.
 */
import { SERIES, OTHER, THEME_COLORS, STATUS_GROUP_COLORS, CHANNEL_COLORS, FILTERABLE } from './config.js';
import { drawChart, chartsAvailable } from './charts.js';
import { esc, fmtDateSAST, sqlValue, fmtNum } from './utils.js';

const DIM_NAME = /^(objectid|year|yr|mo|month|logyear|logmonth|isoyear|isoweek|week|weekday|weekdayno|day|dayofmonth|hour|loghour|hr|bucketstart|bucketend)$|date|name$|^ym$/i;
const TIME_NAME = /date|month|^mo$|year|^yr$|week|^ym$|hour|hr$|day/i;
const NO_CHART = /^(description|requestid|objectid)$/i; // too many distinct values to group by
const COUNT = '__count';
const ALL = '__all';
const MAX_SERIES = 8;
const MAX_BARS = 40;

const KNOWN_COLORS = { ...THEME_COLORS, ...STATUS_GROUP_COLORS, ...CHANNEL_COLORS };

function analyse(rows, columns, dateColumns) {
  const numeric = (c) => rows.every((r) => r[c] == null || typeof r[c] === 'number');
  const dims = columns.filter((c) => !numeric(c) || DIM_NAME.test(c) || dateColumns.has(c));
  const measures = columns.filter((c) => !dims.includes(c));
  const isFeatureSet = columns.includes('ObjectID');
  const groupable = dims.filter((c) => !NO_CHART.test(c) && !(isFeatureSet && dateColumns.has(c)));
  return { dims, groupable, measures, isFeatureSet, dates: dateColumns };
}

function defaults(a, rows) {
  const distinct = (c) => new Set(rows.map((r) => r[c])).size;
  if (a.isFeatureSet || !a.measures.length) {
    const varied = (c) => distinct(c) > 1;
    const x = ['Category', 'CategorySub', 'Status', 'Suburb', 'Channel'].find((c) => a.groupable.includes(c) && varied(c)) ?? a.groupable.find(varied) ?? a.groupable[0];
    return { x, series: '', measure: COUNT };
  }
  const g = a.groupable;
  const timeLike = (c) => TIME_NAME.test(c);
  let x = g[0], series = '';
  if (g.length >= 2 && timeLike(g[0]) && timeLike(g[1])) x = `${g[0]},${g[1]}`; // Yr + Mo
  else if (g.length >= 2 && !a.dates.has(g[1]) && distinct(g[1]) <= 12) series = g[1]; // Category × Status (extras fold to Other)
  return { x, series, measure: a.measures[0] };
}

const isCombo = (x) => x.includes(',');
const parts = (x) => x.split(',').map((c) => c.trim());

const labelOf = (row, x, a, dateColumns) => {
  if (isCombo(x)) {
    return parts(x).map((c) => {
      const v = row[c];
      return v == null ? '(null)' : typeof v === 'number' ? String(v).padStart(2, '0') : String(v);
    }).join('-');
  }
  const v = row[x];
  return v == null ? '(null)' : dateColumns.has(x) ? fmtDateSAST(v).slice(0, 10) : String(v);
};

function build(rows, a, sel, dateColumns) {
  if (sel.measure === ALL) {
    // Several measures on ONE axis — either the set the catalog declared (the author
    // vouched they share a unit) or, with no contract, all of them on the user's say-so.
    const measures = sel.measureList ?? a.measures;
    const labels = rows.map((r) => labelOf(r, sel.x, a, dateColumns));
    const datasets = measures.map((m, i) => ({ label: m, color: SERIES[i % SERIES.length], data: rows.map((r) => Number(r[m] ?? 0)) }));
    return { labels, datasets, truncated: 0 };
  }
  const labels = [];
  const seriesKeys = [];
  const cells = new Map(); // label -> Map(series -> value)
  for (const r of rows) {
    const l = labelOf(r, sel.x, a, dateColumns);
    const s = sel.series ? String(r[sel.series] ?? '(null)') : '_';
    if (!cells.has(l)) { cells.set(l, new Map()); labels.push(l); }
    if (!seriesKeys.includes(s)) seriesKeys.push(s);
    const v = sel.measure === COUNT ? 1 : Number(r[sel.measure] ?? 0);
    cells.get(l).set(s, (cells.get(l).get(s) ?? 0) + v);
  }
  // Fold series past the cap into "Other" (never invent a 9th hue)
  const totals = seriesKeys.map((s) => [s, labels.reduce((t, l) => t + (cells.get(l).get(s) ?? 0), 0)]).sort((p, q) => q[1] - p[1]);
  let keep = totals.map(([s]) => s);
  if (keep.length > MAX_SERIES) keep = keep.slice(0, MAX_SERIES - 1);
  const folded = totals.length > keep.length;
  // Colour follows the entity: known entities keep their colour; others take slots in alphabetical order
  const ordered = [...keep].sort((p, q) => String(p).localeCompare(String(q)));
  const datasets = ordered.map((s, i) => ({ label: s === '_' ? (sel.measure === COUNT ? 'Count' : sel.measure) : s, key: s, color: KNOWN_COLORS[s] ?? SERIES[i % SERIES.length] }));
  if (folded) datasets.push({ label: 'Other', key: '__other', color: OTHER });
  for (const d of datasets) {
    d.data = labels.map((l) => (d.key === '__other'
      ? [...cells.get(l)].filter(([s]) => !keep.includes(s)).reduce((t, [, v]) => t + v, 0)
      : cells.get(l).get(d.key) ?? 0));
  }
  // Per-bar entity colours for single-series charts of known categories (themes, status groups…)
  if (datasets.length === 1 && labels.every((l) => KNOWN_COLORS[l])) datasets[0].colors = labels.map((l) => KNOWN_COLORS[l]);

  // Count-of-rows charts read best ranked; grouped results keep the server's order
  if (sel.measure === COUNT && datasets.length === 1) {
    const idx = labels.map((_, i) => i).sort((p, q) => datasets[0].data[q] - datasets[0].data[p]);
    const re = (arr) => idx.map((i) => arr[i]);
    labels.splice(0, labels.length, ...re(labels));
    datasets[0].data = re(datasets[0].data);
    if (datasets[0].colors) datasets[0].colors = re(datasets[0].colors);
  }
  let truncated = 0;
  const isLine = sel.type === 'line';
  if (!isLine && labels.length > MAX_BARS) {
    truncated = labels.length - MAX_BARS;
    labels.length = MAX_BARS;
    for (const d of datasets) { d.data.length = MAX_BARS; if (d.colors) d.colors.length = MAX_BARS; }
  }
  return { labels, datasets, truncated };
}

/**
 * The catalog's Chart* columns, resolved against the columns this result actually has.
 * Returns null when there is no contract or it no longer fits — a renamed column must
 * degrade to the inference, not to a blank panel. `test/catalog.test.js` is what stops
 * that drift reaching here unnoticed.
 */
function declaredSelection(chart, columns) {
  if (!chart?.values) return null;
  const has = (c) => columns.includes(c);
  const labels = chart.labels ? parts(String(chart.labels)) : [];
  const values = parts(String(chart.values));
  if (!labels.every(has) || !values.every(has)) return null;
  if (chart.series && !has(chart.series)) return null;
  return {
    x: labels.join(','),
    series: chart.series ?? '',
    measure: values.length > 1 ? ALL : values[0],
    measureList: values.length > 1 ? values : undefined,
    type: chart.type === 'line' ? 'line' : 'bar',
    annotation: chart.annotation && has(chart.annotation) ? chart.annotation : null,
  };
}

// A single value is a number, not a chart: show it as a figure.
function renderFigures(host, rows, columns, dateColumns) {
  const val = (v, c, dates) => (v == null ? 'null' : dates?.has(c) ? fmtDateSAST(v) : typeof v === 'number' ? fmtNum(v, Number.isInteger(v) ? 0 : 2) : esc(v));
  const tiles = (side, label, dates) => side.columns.map((c) => `<div class="fig"><span class="fig-label">${esc(label)} · ${esc(c)}</span><span class="fig-value">${val(side.rows[0]?.[c], c, dates)}</span></div>`).join('');
  host.innerHTML = `<div class="figs">${tiles({ rows, columns }, 'Result', dateColumns)}</div>`;
}

/** Render controls + chart into `host` for the given result set. */
export function renderResultChart(host, { rows, columns, dateColumns = [], chart = null }, onFilter) {
  if (!chartsAvailable()) { host.innerHTML = '<div class="error">Chart.js not loaded.</div>'; return; }
  const dc = new Set(dateColumns);
  const a = analyse(rows, columns, dc);
  const declared = declaredSelection(chart, columns);
  const source = declared
    ? 'Chart declared by the catalog (table 1)'
    : 'Chart inferred from the shape of the result';

  // A contract with no label column means the measures themselves are the categories.
  if (declared && !declared.x) {
    const measures = declared.measureList ?? [declared.measure];
    host.innerHTML = `<div class="rc-controls"><span class="hint">${esc(source)} · one bar per measure</span><span class="rc-note hint"></span></div><div class="rc-canvas"><canvas id="resChart"></canvas></div>`;
    drawChart('resChart', { type: declared.type, labels: measures, datasets: [{ label: 'Value', data: measures.map((m) => Number(rows[0]?.[m] ?? 0)), color: SERIES[0] }] });
    return;
  }
  if (rows.length === 1 && !a.groupable.length && a.measures.length === 1) {
    renderFigures(host, rows, columns, dc);
    return;
  }
  // A single summary row with several measures (e.g. Q59 missing-field counts): one bar per measure
  if (rows.length === 1 && !a.groupable.length && a.measures.length >= 2) {
    host.innerHTML = '<div class="rc-controls"><span class="hint">One bar per measure (single summary row)</span><span class="rc-note hint"></span></div><div class="rc-canvas"><canvas id="resChart"></canvas></div>';
    drawChart('resChart', { type: 'bar', labels: a.measures, datasets: [{ label: 'Value', data: a.measures.map((m) => Number(rows[0][m] ?? 0)), color: SERIES[0] }] });
    return;
  }
  if (!rows.length || !a.groupable.length) {
    host.innerHTML = '<div class="error">Nothing to chart: the result has no grouping column (try a statistics query, or a feature query with Category / Suburb / Status).</div>';
    return;
  }
  const sel = declared ? { ...declared } : { ...defaults(a, rows), type: '' };
  const opt = (v, t, cur) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(t)}</option>`;

  const draw = () => {
    const timeX = isCombo(sel.x) || TIME_NAME.test(sel.x);
    const nLabels = new Set(rows.map((r) => labelOf(r, sel.x, a, dc))).size;
    const type = sel.type || (timeX && nLabels > 12 ? 'line' : 'bar');
    const spec = build(rows, a, { ...sel, type }, dc);
    if (type === 'line' && timeX) { // time runs left -> right even when the query sorts newest first
      const idx = spec.labels.map((_, i) => i).sort((p, q) => String(spec.labels[p]).localeCompare(String(spec.labels[q]), undefined, { numeric: true }));
      spec.labels = idx.map((i) => spec.labels[i]);
      for (const d of spec.datasets) { d.data = idx.map((i) => d.data[i]); if (d.colors) d.colors = idx.map((i) => d.colors[i]); }
    }
    const numericLabels = spec.labels.every((l) => l !== '' && !Number.isNaN(Number(l)));
    const horizontal = type === 'bar' && !timeX && !numericLabels && spec.labels.length > 6 && !sel.series;
    host.querySelector('.rc-note').textContent = spec.truncated ? `Showing the first ${MAX_BARS} of ${MAX_BARS + spec.truncated} categories — use the table for the rest.` : '';
    const clickField = !isCombo(sel.x) && FILTERABLE.includes(sel.x) ? sel.x : null;
    // The annotation rides in the tooltip, so it has to follow the labels through
    // build()'s folding, ranking and truncation rather than the original row order.
    const annotation = sel.annotation ? (() => {
      const by = new Map(rows.map((r) => [labelOf(r, sel.x, a, dc), r[sel.annotation]]));
      return { label: sel.annotation, values: spec.labels.map((l) => by.get(l) ?? null) };
    })() : undefined;
    drawChart('resChart', {
      type, horizontal, annotation, stacked: type === 'bar' && spec.datasets.length > 1 && sel.measure !== ALL,
      labels: spec.labels, datasets: spec.datasets,
      yTitle: horizontal || sel.measure === ALL ? undefined : (sel.measure === COUNT ? 'Count' : sel.measure),
      onClick: clickField && onFilter ? (label, series) => {
        let clause = label === '(null)' ? `${clickField} IS NULL` : `${clickField} = ${sqlValue(label)}`;
        if (sel.series && FILTERABLE.includes(sel.series) && series && series !== 'Other') clause += ` AND ${sel.series} = ${sqlValue(series)}`;
        onFilter(clause);
      } : undefined,
    });
  };

  const combos = [
    ...(isCombo(sel.x) ? [sel.x] : []),
    ...(a.groupable.length >= 2 && TIME_NAME.test(a.groupable[0]) && TIME_NAME.test(a.groupable[1]) ? [`${a.groupable[0]},${a.groupable[1]}`] : []),
  ];
  const xOpts = [...new Set([...combos, ...(sel.x ? [sel.x] : []), ...a.groupable])].map((d) => [d, isCombo(d) ? parts(d).join(' + ') : d]);
  const allLabel = sel.measureList ? `Declared measures (${sel.measureList.join(', ')})` : 'All measures (same unit)';
  host.innerHTML = `
    <div class="rc-controls">
      <label>X axis <select data-k="x">${xOpts.map(([v, t]) => opt(v, t, sel.x)).join('')}</select></label>
      <label>Split by <select data-k="series">${opt('', '— none —', sel.series)}${a.groupable.filter((d) => !dc.has(d)).map((d) => opt(d, d, sel.series)).join('')}</select></label>
      <label>Measure <select data-k="measure">${opt(COUNT, 'Count of rows', sel.measure)}${a.measures.map((m) => opt(m, m, sel.measure)).join('')}${a.measures.length > 1 || sel.measureList ? opt(ALL, allLabel, sel.measure) : ''}</select></label>
      <label>Type <select data-k="type">${opt('', 'Auto', sel.type)}${opt('bar', 'Bar', sel.type)}${opt('line', 'Line', sel.type)}</select></label>
      <span class="hint">${esc(source)}</span>
      <span class="rc-note hint"></span>
    </div>
    <div class="rc-canvas"><canvas id="resChart"></canvas></div>`;
  host.querySelectorAll('select').forEach((s) => {
    s.onchange = () => {
      sel[s.dataset.k] = s.value;
      if (s.dataset.k === 'measure' && s.value !== ALL) sel.measureList = undefined;
      if (s.dataset.k === 'x' && sel.series === sel.x) sel.series = '';
      if (sel.measure === ALL && sel.series) { sel.series = ''; host.querySelector('[data-k=series]').value = ''; }
      draw();
    };
  });
  draw();
}
