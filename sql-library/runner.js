/**
 * Runs Query Library entries against any ArcGIS-style FeatureServer layer.
 * Works in the browser (fetch) and in Node (direct FeatureService.query).
 *
 *   const result = await runEntry(entry, httpFetcher(layerUrl));
 *   -> { rows, columns, requests: [{ name, url, params, response }] }
 */

/** Build the GET URL for a layer query. Objects (outStatistics, geometry) are JSON-encoded. */
export function toQueryUrl(layerUrl, params) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries({ f: 'json', ...params })) {
    if (v === undefined || v === null) continue;
    qs.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  return `${layerUrl.replace(/\/+$/, '')}/query?${qs.toString()}`;
}

/** Fetcher that calls a real (or mock) FeatureServer layer over HTTP. */
export const httpFetcher = (layerUrl) => async (params) => {
  const url = toQueryUrl(layerUrl, params);
  const body = new URLSearchParams(url.split('?')[1]);
  // POST avoids URL length limits on long CASE expressions, exactly as you would with ArcGIS.
  const res = await fetch(`${layerUrl.replace(/\/+$/, '')}/query`, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  return { url, json: await res.json() };
};

/** Normalise any query response into flat rows. */
export function toRows(json) {
  if (json.error) throw new Error(`${json.error.message}${json.error.details?.length ? ' — ' + json.error.details.join(' | ') : ''}`);
  if (typeof json.count === 'number' && !json.features) return [{ count: json.count, ...(json.extent ? { extent: JSON.stringify(json.extent) } : {}) }];
  if (json.objectIds) return json.objectIds.map((id) => ({ [json.objectIdFieldName]: id }));
  return (json.features ?? []).map((f) => ({ ...f.attributes }));
}

export const requestsOf = (entry) => (Array.isArray(entry.rest) ? entry.rest : [{ name: 'main', params: entry.rest }]);

export async function runEntry(entry, fetcher) {
  const requests = [];
  const sets = {};
  for (const r of requestsOf(entry)) {
    const { url, json } = await fetcher(r.params);
    requests.push({ name: r.name, url, params: r.params, response: json });
    sets[r.name] = toRows(json);
  }
  let rows = sets.main ?? sets[Object.keys(sets)[0]];
  for (const t of [entry.transform ?? []].flat()) rows = TRANSFORMS[t.type](rows, t, sets);
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  return { rows, columns, requests };
}

// ---------------------------------------------------------------- client-side transforms
// The ArcGIS REST query API has no window functions. These run on the returned rows,
// exactly as you would post-process a real FeatureServer response.
const num = (v) => (v == null ? null : Number(v));
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export const TRANSFORMS = {
  /** SUM(x) OVER (ORDER BY ...) */
  runningTotal: (rows, { field, as }) => {
    let acc = 0;
    return rows.map((r) => ({ ...r, [as]: (acc += num(r[field]) ?? 0) }));
  },
  /** LAG(x, offset) OVER (ORDER BY ...) plus % change */
  lag: (rows, { field, offset = 1, as, pctAs }) => rows.map((r, i) => {
    const prev = i >= offset ? num(rows[i - offset][field]) : null;
    const out = { ...r, [as]: prev };
    if (pctAs) out[pctAs] = prev ? +(((num(r[field]) - prev) * 100) / prev).toFixed(2) : null;
    return out;
  }),
  /** AVG(x) OVER (ORDER BY ... ROWS BETWEEN n-1 PRECEDING AND CURRENT ROW) */
  movingAverage: (rows, { field, window = 7, as }) => rows.map((r, i) => {
    const slice = rows.slice(Math.max(0, i - window + 1), i + 1).map((x) => num(x[field]) ?? 0);
    return { ...r, [as]: +(slice.reduce((a, b) => a + b, 0) / slice.length).toFixed(2) };
  }),
  /** RANK() OVER (ORDER BY x) — ties share a rank, gaps follow */
  rank: (rows, { field, as, desc = false }) => {
    const sorted = [...rows].sort((a, b) => (desc ? -1 : 1) * cmp(num(a[field]), num(b[field])));
    let rank = 0, prev;
    return sorted.map((r, i) => { if (i === 0 || num(r[field]) !== prev) rank = i + 1; prev = num(r[field]); return { ...r, [as]: rank }; });
  },
  /** ROW_NUMBER() OVER (PARTITION BY p ORDER BY o DESC) = 1 */
  topPerGroup: (rows, { partition, orderBy, desc = true }) => {
    const best = new Map();
    for (const r of rows) {
      const k = r[partition], cur = best.get(k);
      if (!cur || (desc ? num(r[orderBy]) > num(cur[orderBy]) : num(r[orderBy]) < num(cur[orderBy]))) best.set(k, r);
    }
    return [...best.values()].sort((a, b) => cmp(a[partition], b[partition]));
  },
  /** COUNT(DISTINCT y) per x, from a GROUP BY x, y result */
  groupCount: (rows, { by, as }) => {
    const m = new Map();
    for (const r of rows) m.set(r[by], (m.get(r[by]) ?? 0) + 1);
    return [...m].map(([k, n]) => ({ [by]: k, [as]: n }));
  },
  /** a * scale / b */
  ratio: (rows, { numerator, denominator, as, scale = 100, decimals = 2 }) =>
    rows.map((r) => ({ ...r, [as]: num(r[denominator]) ? +((num(r[numerator]) * scale) / num(r[denominator])).toFixed(decimals) : null })),
  /** FULL OUTER JOIN of two named result sets */
  fullOuterJoin: (_rows, { left, right, on, fill0 = [], diff }, sets) => {
    const key = (r) => on.map((k) => r[k]).join('|');
    const map = new Map();
    for (const r of sets[left]) map.set(key(r), { ...r });
    for (const r of sets[right]) map.set(key(r), { ...(map.get(key(r)) ?? {}), ...r });
    let out = [...map.values()].map((r) => { for (const f of fill0) r[f] ??= 0; return r; });
    if (diff) out = out.map((r) => ({ ...r, [diff.as]: num(r[diff.a]) - num(r[diff.b]) }));
    return out.sort((a, b) => on.reduce((c, k) => c || cmp(a[k], b[k]), 0));
  },
  sort: (rows, { field, desc = false }) => [...rows].sort((a, b) => (desc ? -1 : 1) * cmp(a[field], b[field])),
  limit: (rows, { n }) => rows.slice(0, n),
};
