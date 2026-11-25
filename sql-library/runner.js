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

/**
 * The half of a run that happens after the service has answered: apply the entry's
 * client-side transforms to the named result sets and work out the columns.
 *
 * Separate from `runEntry` because a caller that already has the rows synchronously --
 * the execute-by-identifier route in `server/restRouter.js`, which holds the engine
 * itself and needs no fetch -- must not be forced to become asynchronous to reuse the
 * transform pipeline. One definition of what finishing an entry means, two ways in.
 */
export function finishEntry(entry, sets) {
  let rows = sets.main ?? sets[Object.keys(sets)[0]];
  for (const t of [entry.transform ?? []].flat()) rows = TRANSFORMS[t.type](rows, t, sets);
  return { rows, columns: [...new Set(rows.flatMap((r) => Object.keys(r)))] };
}

export async function runEntry(entry, fetcher) {
  const requests = [];
  const sets = {};
  for (const r of requestsOf(entry)) {
    const { url, json } = await fetcher(r.params);
    requests.push({ name: r.name, url, params: r.params, response: json });
    sets[r.name] = toRows(json);
  }
  return { ...finishEntry(entry, sets), requests };
}

/**
 * A catalog row, reshaped into the entry object this module runs.
 *
 * The row *is* the wire format of an entry, so this mapping is the one place that
 * knows it. Both the viewer (`viewer/js/catalog.js`, which reads the catalog over
 * REST and may not import the library) and the service's own execute route
 * (`server/restRouter.js`, which looks the row up through its own layer 1) go
 * through here, so neither can drift from the other or from the published columns.
 */
export const entryFromRow = (r) => ({
  id: r.QueryNumber,
  category: r.Category,
  question: r.Question,
  dimension: r.Dimension,
  layer: r.AnalyticLayer,
  portability: r.Portability,
  rest: JSON.parse(r.RestParams),
  transform: r.TransformSpec ? JSON.parse(r.TransformSpec) : undefined,
  params: r.ParamSpec ? JSON.parse(r.ParamSpec) : undefined,
  chart: r.HasChart
    ? { type: r.ChartType, labels: r.ChartLabelColumn, values: r.ChartValueColumns, series: r.ChartSeriesColumn ?? undefined, annotation: r.ChartAnnotationColumn ?? undefined }
    : undefined,
  tsql: r.SqlText,
  notes: r.Notes ?? undefined,
});

// ---------------------------------------------------------------- bounded parameters
// The only sanctioned way to vary a catalogued question: a parameter its author
// declared, within bounds its author ratified. The declaration is published as a
// column of the catalog (`ParamSpec`), so a client is told what may be varied in the
// same request that tells it the question -- and a tier that executes by identifier
// can enforce the bounds rather than trust them. See docs/catalog-pattern.md.
//
// A declaration never carries a fragment of query text that the *client* composes.
// It names a parameter, its type and its range, and where the value lands:
//   { in: 'rest', key: 'resultRecordCount' }                    set that request parameter
//   { in: 'rest', key: 'having', template: 'COUNT(...) >= {v}' } rebuild it from a template
//   { in: 'tsql', find: 'TOP 5', template: 'TOP {v}' }           swap that substring
// Rendering a bind with the declared default must reproduce the published definition
// exactly; `test/params.test.js` asserts that for every parameter in the library, which
// is what makes the default the ratified question rather than merely a sensible value.

export const paramsOf = (entry) => entry.params ?? [];

const render = (template, v) => String(template).replaceAll('{v}', String(v));

/**
 * Resolve submitted values against a declaration.
 * @returns `{ values, errors }` -- every declared name present, defaults filled in.
 *          A non-empty `errors` means nothing should run: this is the check, not advice.
 */
export function validateParams(spec, values = {}) {
  const out = {};
  const errors = [];
  const declared = new Set(spec.map((p) => p.name));
  for (const k of Object.keys(values)) {
    if (values[k] !== undefined && !declared.has(k)) errors.push(`'${k}' is not a parameter of this question`);
  }
  for (const p of spec) {
    const raw = values[p.name];
    if (raw === undefined || raw === null || raw === '') { out[p.name] = p.default; continue; }
    if (p.type !== 'int') { errors.push(`'${p.name}' declares unsupported type '${p.type}'`); continue; }
    const n = Number(raw);
    if (!Number.isInteger(n)) { errors.push(`'${p.name}' must be a whole number (got '${raw}')`); continue; }
    if (p.min !== undefined && n < p.min) { errors.push(`'${p.name}' must be ${p.min} or more (got ${n})`); continue; }
    if (p.max !== undefined && n > p.max) { errors.push(`'${p.name}' must be at most ${p.max} (got ${n})`); continue; }
    out[p.name] = n;
  }
  return { values: out, errors };
}

/**
 * Apply parameter values to an entry, returning a new entry to run.
 *
 * With no values -- or for an entry that declares none -- the result is the question as
 * published. A `rest` bind applies to every request of a multi-request entry that
 * already carries that key, so a bind can never introduce a parameter the author did
 * not write into the definition.
 *
 * @returns `{ entry, values, errors }`. On any error the original entry comes back
 *          unbound, so a caller that ignores `errors` runs the ratified question
 *          rather than a half-applied one.
 */
export function bindEntry(entry, values = {}) {
  const spec = paramsOf(entry);
  const given = Object.keys(values).filter((k) => values[k] !== undefined && values[k] !== '');
  if (!spec.length) return { entry, values: {}, errors: given.length ? ['this question declares no parameters'] : [] };

  const { values: v, errors } = validateParams(spec, values);
  if (errors.length) return { entry, values: v, errors };

  const requests = JSON.parse(JSON.stringify(requestsOf(entry)));
  let tsql = entry.tsql;
  for (const p of spec) {
    for (const b of p.binds ?? []) {
      const value = v[p.name];
      if (b.in === 'rest') {
        let hit = false;
        for (const r of requests) {
          if (!(b.key in r.params)) continue;
          r.params[b.key] = b.template ? render(b.template, value) : value;
          hit = true;
        }
        if (!hit) errors.push(`'${p.name}' binds to request parameter '${b.key}', which this question does not set`);
      } else if (b.in === 'tsql') {
        if (!tsql?.includes(b.find)) errors.push(`'${p.name}' binds to T-SQL text '${b.find}', which this statement does not contain`);
        else tsql = tsql.replace(b.find, render(b.template, value));
      } else {
        errors.push(`'${p.name}' declares an unknown bind target '${b.in}'`);
      }
    }
  }
  if (errors.length) return { entry, values: v, errors };
  return {
    // `paramValues` rides along on the bound entry so that everything downstream — the
    // MCP payload, the envelope the viewer renders, a log line — reports what actually
    // ran without being handed the values separately.
    entry: { ...entry, rest: Array.isArray(entry.rest) ? requests : requests[0].params, tsql, paramValues: v },
    values: v,
    errors: [],
  };
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
