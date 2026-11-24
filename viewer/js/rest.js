// Thin REST helpers shared by the panels.
import { CONFIG } from './config.js';
import { toQueryUrl, toRows } from '../../sql-library/runner.js';

export const layerUrl = CONFIG.layerUrl;

export async function restQuery(params) {
  const url = toQueryUrl(layerUrl, params);
  const res = await fetch(`${layerUrl}/query`, { method: 'POST', body: new URLSearchParams(url.split('?')[1]) });
  const json = await res.json();
  return { url, json, rows: toRows(json), dateColumns: dateColumnsOf(json) };
}

export const dateColumnsOf = (json) => (json.fields ?? []).filter((f) => f.type === 'esriFieldTypeDate').map((f) => f.name);

/** Mock extension: run T-SQL against the same data. */
export async function tsql(statement) {
  const res = await fetch(`${layerUrl}/sql`, { method: 'POST', body: new URLSearchParams({ q: statement, f: 'json' }) });
  const json = await res.json();
  if (json.error) throw new Error(`${json.error.message}${json.error.details?.length ? '\n' + json.error.details.join('\n') : ''}`);
  return json;
}
