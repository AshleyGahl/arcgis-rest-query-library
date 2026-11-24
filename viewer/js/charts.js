/**
 * All Chart.js instance creation, update and destroy logic lives here.
 * Chart.js 4 is vendored at viewer/vendor/chart.umd.min.js (window.Chart).
 *
 * Mark conventions: thin bars with a 4px rounded data end anchored to the baseline,
 * 2px lines, one y-axis only, recessive grid, legend only when there are ≥ 2 series,
 * shared-index tooltip (crosshair behaviour) on lines, per-bar tooltip on bars.
 */
import { INK } from './config.js';
import { fmtNum } from './utils.js';

const Chart = window.Chart;
const instances = new Map(); // canvasId -> Chart

if (Chart) {
  Chart.defaults.font.family = "system-ui, -apple-system, 'Segoe UI', sans-serif";
  Chart.defaults.font.size = 11;
  Chart.defaults.color = INK.secondary;
  Chart.defaults.borderColor = INK.grid;
  Chart.defaults.animation.duration = 250;
}

export const chartsAvailable = () => Boolean(Chart);

export function destroyChart(canvasId) {
  instances.get(canvasId)?.destroy();
  instances.delete(canvasId);
}

/**
 * spec = {
 *   type: 'bar' | 'line', labels: [], datasets: [{ label, data, color | colors }],
 *   horizontal, stacked, yTitle, xTitle, onClick(label, datasetLabel, index), digits
 * }
 */
export function drawChart(canvasId, spec) {
  if (!Chart) return null;
  destroyChart(canvasId); // always destroy before re-render (canvas reuse)
  const canvas = document.getElementById(canvasId);
  if (!canvas) return null;

  const isLine = spec.type === 'line';
  const multi = spec.datasets.length > 1;
  const valueAxis = spec.horizontal ? 'x' : 'y';
  const catAxis = spec.horizontal ? 'y' : 'x';

  const datasets = spec.datasets.map((d) => (isLine
    ? {
      label: d.label, data: d.data, borderColor: d.color, backgroundColor: d.color,
      borderWidth: 2, pointRadius: spec.labels.length > 40 ? 0 : 3, pointHoverRadius: 5,
      pointBackgroundColor: d.color, pointBorderColor: INK.surface, pointBorderWidth: 2,
      tension: 0.25, spanGaps: true,
    }
    : {
      label: d.label, data: d.data, backgroundColor: d.colors ?? d.color,
      borderRadius: spec.stacked ? 0 : 4, borderSkipped: 'start',
      borderColor: INK.surface, borderWidth: spec.stacked ? { top: 2, right: 2, bottom: 0, left: 0 } : 0,
      maxBarThickness: 26, barPercentage: 0.85, categoryPercentage: 0.8,
    }));

  const chart = new Chart(canvas, {
    type: isLine ? 'line' : 'bar',
    data: { labels: spec.labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      indexAxis: spec.horizontal ? 'y' : 'x',
      interaction: isLine ? { mode: 'index', intersect: false } : { mode: 'nearest', intersect: true },
      scales: {
        [valueAxis]: {
          beginAtZero: true,
          stacked: Boolean(spec.stacked),
          grid: { color: INK.grid, drawTicks: false },
          border: { display: false },
          ticks: { color: INK.muted, padding: 6, maxTicksLimit: 6, callback: (v) => fmtNum(v, Number.isInteger(v) ? 0 : 1) },
          title: spec.yTitle ? { display: true, text: spec.yTitle, color: INK.muted } : undefined,
        },
        [catAxis]: {
          stacked: Boolean(spec.stacked),
          grid: { display: false },
          border: { color: INK.axis },
          ticks: { color: INK.secondary, autoSkip: true, maxRotation: 0, autoSkipPadding: 8,
            callback(v) { const l = String(this.getLabelForValue(v)); return l.length > 22 ? l.slice(0, 21) + '…' : l; } },
          title: spec.xTitle ? { display: true, text: spec.xTitle, color: INK.muted } : undefined,
        },
      },
      plugins: {
        legend: { display: multi, position: 'top', align: 'start', labels: isLine
          ? { usePointStyle: false, boxWidth: 14, boxHeight: 2, color: INK.secondary }
          : { usePointStyle: true, pointStyle: 'rectRounded', boxWidth: 10, boxHeight: 10, color: INK.secondary } },
        tooltip: {
          backgroundColor: '#ffffff', titleColor: INK.primary, bodyColor: INK.secondary,
          borderColor: 'rgba(11,11,11,0.12)', borderWidth: 1, padding: 8, boxPadding: 4, usePointStyle: true,
          callbacks: {
            label: (ctx) => `${multi ? ctx.dataset.label + ': ' : ''}${fmtNum(ctx.parsed[valueAxis], spec.digits ?? (Number.isInteger(ctx.parsed[valueAxis]) ? 0 : 1))}`,
            footer: spec.onClick ? () => 'Click to filter the map' : undefined,
          },
          footerColor: INK.muted, footerFont: { weight: 'normal', size: 10 },
        },
      },
      onHover: spec.onClick ? (e, els) => { e.native.target.style.cursor = els.length ? 'pointer' : 'default'; } : undefined,
      onClick: spec.onClick ? (e, els) => {
        const hit = els[0] ?? chart.getElementsAtEventForMode(e, isLine ? 'index' : 'nearest', { intersect: !isLine }, false)[0];
        if (hit) spec.onClick(spec.labels[hit.index], spec.datasets[hit.datasetIndex]?.label, hit.index);
      } : undefined,
    },
  });
  instances.set(canvasId, chart);
  return chart;
}
