import { THEMES, CHANNELS } from './config.js';
import { sql } from './esri.js';
import { restQuery } from './rest.js';

const $ = (id) => document.getElementById(id);
const IDS = ['fTheme', 'fCategory', 'fStatus', 'fChannel', 'fSuburb', 'fSince', 'fText'];

function buildWhere() {
  const c = [];
  const theme = $('fTheme').value;
  if (theme) {
    const cats = THEMES[theme];
    c.push(cats ? `Category IN (${cats.map(sql).join(', ')})` : `Category NOT IN (${Object.values(THEMES).filter(Boolean).flat().map(sql).join(', ')})`);
  }
  if ($('fCategory').value) c.push(`Category = ${sql($('fCategory').value)}`);
  const status = $('fStatus').value;
  if (status === 'notclosed') c.push("Status <> 'Closed'");
  else if (status) c.push(`Status = ${sql(status)}`);
  if ($('fChannel').value) c.push(`Channel = ${sql($('fChannel').value)}`);
  if ($('fSuburb').value) c.push(`Suburb = ${sql($('fSuburb').value)}`);
  if ($('fSince').value) c.push(`DtLogged >= DATE '${$('fSince').value}'`);
  const text = $('fText').value.trim();
  if (text) c.push(`UPPER(Description) LIKE ${sql('%' + text.toUpperCase() + '%')}`);
  return c.join(' AND ') || '1=1';
}

/** Fill a <select> with the layer's distinct values — itself a REST query (returnDistinctValues). */
async function fillDistinct(selectId, field) {
  try {
    const { rows } = await restQuery({ where: `${field} IS NOT NULL`, outFields: field, returnDistinctValues: true, returnGeometry: false, orderByFields: field });
    for (const r of rows) $(selectId).add(new Option(r[field], r[field]));
  } catch { /* leave the "All" option only */ }
}

export function initFilterPanel(map) {
  for (const t of Object.keys(THEMES)) $('fTheme').add(new Option(t, t));
  for (const c of CHANNELS) $('fChannel').add(new Option(c, c));
  fillDistinct('fCategory', 'Category');
  fillDistinct('fSuburb', 'Suburb');
  for (const b of map.basemaps) $('basemap').add(new Option(b.title, b.id));

  let timer;
  const refreshCount = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        const { json } = await restQuery({ where: $('fWhere').value || '1=1', returnCountOnly: true });
        $('fCount').textContent = json.error ? 'error' : json.count.toLocaleString();
      } catch { $('fCount').textContent = 'error'; }
    }, 200);
  };
  const sync = () => { $('fWhere').value = buildWhere(); refreshCount(); };

  IDS.forEach((id) => $(id).addEventListener('input', sync));
  $('fWhere').addEventListener('input', refreshCount);
  $('fApply').onclick = () => map.setDefinitionExpression($('fWhere').value.trim());
  $('fClear').onclick = () => {
    IDS.forEach((id) => { $(id).value = ''; });
    sync();
    map.setDefinitionExpression(null);
    map.highlightIds([]);
  };

  const applyRenderer = () => map.setRenderer($('renderer').value, $('cluster').checked);
  $('renderer').onchange = applyRenderer;
  $('cluster').onchange = applyRenderer;
  $('basemap').onchange = () => map.setBasemap($('basemap').value);
  $('timeSliderToggle').onchange = (e) => map.timeSlider(e.target.checked);

  sync();
  return { setWhere: (w) => { $('fWhere').value = w; refreshCount(); } };
}
