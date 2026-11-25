// Results drawer: sortable grid, chart view, CSV export.
import { renderResultChart } from './result-chart.js';
import { destroyChart } from './charts.js';

const $ = (id) => document.getElementById(id);
const SORT_PRIORITY = ['objectid', 'created', 'received']; // newest-first default when present
let current = { rows: [], columns: [], title: 'results' };
let mode = 'table';          // 'table' | 'chart'
let renderTable = () => {};  // re-renders the table view for the current result
let onFilter = null;         // chart click -> map filter

const fmtDate = (ms) => (ms == null ? null : new Date(ms + 2 * 3600000).toISOString().slice(0, 16).replace('T', ' '));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function defaultSort(columns) {
  for (const key of SORT_PRIORITY) {
    const col = columns.find((c) => c.toLowerCase() === key);
    if (col) return { col, desc: true };
  }
  return null;
}

function buildTable(rows, columns, { dateColumns = new Set(), onRowClick } = {}) {
  const table = document.createElement('table');
  table.className = 'grid';
  let state = defaultSort(columns);
  const render = () => {
    let data = rows;
    if (state) {
      const { col, desc } = state;
      data = [...rows].sort((a, b) => {
        const x = a[col], y = b[col];
        if (x == null) return 1; if (y == null) return -1;
        return (x < y ? -1 : x > y ? 1 : 0) * (desc ? -1 : 1);
      });
    }
    table.innerHTML = `<thead><tr>${columns.map((c) => `<th data-col="${esc(c)}" class="${state?.col === c ? `sorted ${state.desc ? '' : 'asc'}` : ''}">${esc(c)}</th>`).join('')}</tr></thead>`;
    const tbody = document.createElement('tbody');
    for (const r of data.slice(0, 2000)) {
      const tr = document.createElement('tr');
      if (onRowClick && r.ObjectID != null) { tr.className = 'clickable'; tr.onclick = () => onRowClick(r); }
      tr.innerHTML = columns.map((c) => {
        let v = r[c];
        if (v == null) return '<td class="null">null</td>';
        if (dateColumns.has(c)) v = fmtDate(v);
        const isNum = typeof v === 'number';
        if (isNum && !Number.isInteger(v)) v = Math.round(v * 100) / 100;
        return `<td class="${isNum ? 'num' : ''}" title="${esc(v)}">${esc(v)}</td>`;
      }).join('');
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    table.querySelectorAll('th').forEach((th) => {
      th.onclick = () => {
        const col = th.dataset.col;
        state = state?.col === col ? { col, desc: !state.desc } : { col, desc: false };
        render();
      };
    });
  };
  render();
  return table;
}

function renderBody() {
  destroyChart('resChart');
  if (mode === 'chart') {
    const host = document.createElement('div');
    host.className = 'rc';
    $('resBody').replaceChildren(host);
    renderResultChart(host, current, onFilter);
  } else renderTable();
}

function setMode(m) {
  mode = m;
  $('resViewTable').classList.toggle('on', m === 'table');
  $('resViewChart').classList.toggle('on', m === 'chart');
  renderBody();
}

export function showResults({ title, meta = '', urls = [], rows, columns, dateColumns, chart = null, onRowClick }) {
  current = { rows, columns, title, dateColumns, chart };
  $('resTitle').textContent = title;
  $('resMeta').textContent = `${rows.length} row${rows.length === 1 ? '' : 's'}${meta ? ' · ' + meta : ''}`;
  $('resRequest').innerHTML = urls.map((u) => `<a href="${esc(u.replace('f=json', 'f=pjson'))}" target="_blank">${esc(decodeURIComponent(u))}</a>`).join('<br>');
  renderTable = () => $('resBody').replaceChildren(rows.length ? buildTable(rows, columns, { dateColumns: new Set(dateColumns ?? []), onRowClick }) : Object.assign(document.createElement('div'), { className: 'error', textContent: 'No rows returned.' }));
  renderBody();
  open();
}

export function showError(title, err) {
  $('resTitle').textContent = title;
  $('resMeta').textContent = 'error';
  destroyChart('resChart');
  renderTable = () => $('resBody').replaceChildren(Object.assign(document.createElement('div'), { className: 'error', textContent: err?.message ?? String(err) }));
  renderTable();
  open();
}

function open() { $('results').classList.remove('collapsed'); $('resToggle').textContent = '▾'; }

export function initResults(opts = {}) {
  onFilter = opts.onFilter ?? null;
  $('resViewTable').onclick = () => setMode('table');
  $('resViewChart').onclick = () => setMode('chart');
  $('resToggle').onclick = () => {
    const r = $('results');
    r.classList.toggle('collapsed');
    $('resToggle').textContent = r.classList.contains('collapsed') ? '▴' : '▾';
  };
  $('resCsv').onclick = () => {
    const { rows, columns, title, dateColumns = [] } = current;
    if (!rows.length) return;
    const dc = new Set(dateColumns);
    const cell = (c, v) => { if (v == null) return ''; if (dc.has(c)) v = fmtDate(v); const s = String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const csv = [columns.join(','), ...rows.map((r) => columns.map((c) => cell(c, r[c])).join(','))].join('\n');
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })), download: `${title.replace(/[^\w]+/g, '_')}.csv` });
    a.click();
    URL.revokeObjectURL(a.href);
  };
}
