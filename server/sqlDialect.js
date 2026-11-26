/**
 * T-SQL / ArcGIS-SQL  ->  SQLite translation layer.
 *
 * The mock FeatureServer stores the GeoJSON in an in-memory SQLite table. To make
 * where clauses, statistic expressions and the original T-SQL library behave as they
 * would against an RDBMS-backed ArcGIS Enterprise service (sqlFormat=native) — SQL
 * Server is this repo's example database, hence the T-SQL dialect —
 * we (1) rewrite a handful of syntax differences and (2) register T-SQL functions.
 *
 * Dates are stored as 'YYYY-MM-DD HH:MM:SS' strings in SAST (UTC+2), mirroring a
 * datetime column holding local time.
 */

const DAY = 86400000;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// ------------------------------------------------------------------ date helpers
// "local ms": a Date whose UTC fields read SAST wall-clock time.
export function makeDateTools(offsetHours) {
  const OFFSET = offsetHours * 3600000;
  const parse = (v) => {
    if (v == null) return null;
    if (typeof v === 'bigint') v = Number(v);
    if (typeof v === 'number') return v > 1e11 ? v + OFFSET : null; // epoch ms (UTC) -> local
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?/.exec(String(v));
    if (!m) return null;
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
  };
  const fmt = (ms) => (ms == null ? null : new Date(ms).toISOString().slice(0, 19).replace('T', ' '));
  const fmtDate = (ms) => (ms == null ? null : new Date(ms).toISOString().slice(0, 10));
  const toEpoch = (s) => { const l = parse(s); return l == null ? null : l - OFFSET; };
  const fromEpoch = (ms) => (ms == null ? null : fmt(ms + OFFSET));
  return { parse, fmt, fmtDate, toEpoch, fromEpoch, OFFSET };
}

const PART_ALIASES = {
  year: 'year', yy: 'year', yyyy: 'year',
  quarter: 'quarter', qq: 'quarter', q: 'quarter',
  month: 'month', mm: 'month', m: 'month',
  dayofyear: 'dayofyear', dy: 'dayofyear', y: 'dayofyear',
  day: 'day', dd: 'day', d: 'day',
  week: 'week', wk: 'week', ww: 'week',
  weekday: 'weekday', dw: 'weekday', w: 'weekday', dow: 'weekday',
  hour: 'hour', hh: 'hour',
  minute: 'minute', mi: 'minute', n: 'minute',
  second: 'second', ss: 'second', s: 'second',
  iso_week: 'iso_week', isowk: 'iso_week', isoww: 'iso_week',
};
const normPart = (p) => {
  const k = PART_ALIASES[String(p).toLowerCase()];
  if (!k) throw new Error(`Unsupported datepart '${p}'`);
  return k;
};

function isoWeek(ms) {
  const d = new Date(ms);
  const day = (d.getUTCDay() + 6) % 7; // Mon=0
  const thursday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day + 3);
  const firstThursday = new Date(thursday);
  const jan1 = Date.UTC(firstThursday.getUTCFullYear(), 0, 1);
  return 1 + Math.floor((thursday - jan1) / DAY / 7);
}
function datePart(part, ms) {
  const d = new Date(ms);
  switch (part) {
    case 'year': return d.getUTCFullYear();
    case 'quarter': return Math.floor(d.getUTCMonth() / 3) + 1;
    case 'month': return d.getUTCMonth() + 1;
    case 'day': return d.getUTCDate();
    case 'dayofyear': return Math.floor((ms - Date.UTC(d.getUTCFullYear(), 0, 1)) / DAY) + 1;
    case 'weekday': return d.getUTCDay() + 1; // DATEFIRST 7 (us_english): Sunday = 1
    case 'week': {
      const jan1 = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
      return Math.floor((datePart('dayofyear', ms) - 1 + jan1.getUTCDay()) / 7) + 1;
    }
    case 'iso_week': return isoWeek(ms);
    case 'hour': return d.getUTCHours();
    case 'minute': return d.getUTCMinutes();
    case 'second': return d.getUTCSeconds();
  }
}
// DATEDIFF counts datepart boundaries crossed, exactly like SQL Server.
function dateDiff(part, a, b) {
  const da = new Date(a), db = new Date(b);
  switch (part) {
    case 'year': return db.getUTCFullYear() - da.getUTCFullYear();
    case 'quarter': return (db.getUTCFullYear() * 4 + datePart('quarter', b)) - (da.getUTCFullYear() * 4 + datePart('quarter', a));
    case 'month': return (db.getUTCFullYear() * 12 + db.getUTCMonth()) - (da.getUTCFullYear() * 12 + da.getUTCMonth());
    case 'day': case 'dayofyear': return Math.floor(b / DAY) - Math.floor(a / DAY);
    case 'week': case 'weekday': return Math.floor((Math.floor(b / DAY) + 4) / 7) - Math.floor((Math.floor(a / DAY) + 4) / 7);
    case 'iso_week': return Math.floor((Math.floor(b / DAY) + 3) / 7) - Math.floor((Math.floor(a / DAY) + 3) / 7);
    case 'hour': return Math.floor(b / 3600000) - Math.floor(a / 3600000);
    case 'minute': return Math.floor(b / 60000) - Math.floor(a / 60000);
    case 'second': return Math.floor(b / 1000) - Math.floor(a / 1000);
  }
}
function dateAdd(part, n, ms) {
  const d = new Date(ms);
  switch (part) {
    case 'year': d.setUTCFullYear(d.getUTCFullYear() + n); return d.getTime();
    case 'quarter': d.setUTCMonth(d.getUTCMonth() + 3 * n); return d.getTime();
    case 'month': d.setUTCMonth(d.getUTCMonth() + n); return d.getTime();
    case 'day': case 'dayofyear': case 'weekday': return ms + n * DAY;
    case 'week': case 'iso_week': return ms + 7 * n * DAY;
    case 'hour': return ms + n * 3600000;
    case 'minute': return ms + n * 60000;
    case 'second': return ms + n * 1000;
  }
}
function dateTrunc(part, ms) {
  const d = new Date(ms);
  const y = d.getUTCFullYear(), m = d.getUTCMonth(), day = d.getUTCDate();
  switch (part) {
    case 'year': return Date.UTC(y, 0, 1);
    case 'quarter': return Date.UTC(y, m - (m % 3), 1);
    case 'month': return Date.UTC(y, m, 1);
    case 'week': return Date.UTC(y, m, day - d.getUTCDay());
    case 'iso_week': return Date.UTC(y, m, day - ((d.getUTCDay() + 6) % 7));
    case 'day': case 'dayofyear': return Date.UTC(y, m, day);
    case 'hour': return Math.floor(ms / 3600000) * 3600000;
    case 'minute': return Math.floor(ms / 60000) * 60000;
    default: return Math.floor(ms / 1000) * 1000;
  }
}
// .NET custom date format strings as used by T-SQL FORMAT()
function formatDate(ms, pattern) {
  const d = new Date(ms);
  const p2 = (n) => String(n).padStart(2, '0');
  return pattern.replace(/yyyy|yy|MMMM|MMM|MM|M|dddd|ddd|dd|d|HH|H|hh|h|mm|m|ss|s|tt|'[^']*'|"[^"]*"/g, (t) => {
    switch (t) {
      case 'yyyy': return d.getUTCFullYear();
      case 'yy': return p2(d.getUTCFullYear() % 100);
      case 'MMMM': return MONTHS[d.getUTCMonth()];
      case 'MMM': return MONTHS[d.getUTCMonth()].slice(0, 3);
      case 'MM': return p2(d.getUTCMonth() + 1);
      case 'M': return d.getUTCMonth() + 1;
      case 'dddd': return WEEKDAYS[d.getUTCDay()];
      case 'ddd': return WEEKDAYS[d.getUTCDay()].slice(0, 3);
      case 'dd': return p2(d.getUTCDate());
      case 'd': return d.getUTCDate();
      case 'HH': return p2(d.getUTCHours());
      case 'H': return d.getUTCHours();
      case 'hh': return p2(d.getUTCHours() % 12 || 12);
      case 'h': return d.getUTCHours() % 12 || 12;
      case 'mm': return p2(d.getUTCMinutes());
      case 'm': return d.getUTCMinutes();
      case 'ss': return p2(d.getUTCSeconds());
      case 's': return d.getUTCSeconds();
      case 'tt': return d.getUTCHours() < 12 ? 'AM' : 'PM';
      default: return t.slice(1, -1);
    }
  });
}
function percentile(values, p, discrete) {
  const v = values.filter((x) => x != null).map(Number).sort((a, b) => a - b);
  if (!v.length) return null;
  if (discrete) return v[Math.max(0, Math.ceil(p * v.length) - 1)];
  const rn = p * (v.length - 1), lo = Math.floor(rn), hi = Math.ceil(rn);
  return v[lo] + (rn - lo) * (v[hi] - v[lo]);
}
function variance(values, sample) {
  const v = values.filter((x) => x != null).map(Number);
  const n = v.length;
  if (n === 0 || (sample && n < 2)) return null;
  const mean = v.reduce((a, b) => a + b, 0) / n;
  return v.reduce((a, b) => a + (b - mean) ** 2, 0) / (sample ? n - 1 : n);
}

// ------------------------------------------------------------------ function registration
export function registerFunctions(db, dates, nowLocal) {
  const fn = (name, impl, opts = {}) => db.function(name, { deterministic: opts.deterministic ?? true, varargs: opts.varargs ?? false }, impl);
  const P = dates.parse;

  fn('GETDATE', () => dates.fmt(nowLocal()), { deterministic: false });
  fn('SYSDATETIME', () => dates.fmt(nowLocal()), { deterministic: false });
  fn('CURRENT_DATE_SAST', () => dates.fmtDate(nowLocal()), { deterministic: false });
  fn('YEAR', (d) => { const t = P(d); return t == null ? null : datePart('year', t); });
  fn('MONTH', (d) => { const t = P(d); return t == null ? null : datePart('month', t); });
  fn('DAY', (d) => { const t = P(d); return t == null ? null : datePart('day', t); });
  fn('DATEPART', (part, d) => { const t = P(d); return t == null ? null : datePart(normPart(part), t); });
  fn('DATENAME', (part, d) => {
    const t = P(d); if (t == null) return null;
    const k = normPart(part);
    if (k === 'month') return MONTHS[new Date(t).getUTCMonth()];
    if (k === 'weekday') return WEEKDAYS[new Date(t).getUTCDay()];
    return String(datePart(k, t));
  });
  fn('DATEDIFF', (part, a, b) => { const x = P(a), y = P(b); return x == null || y == null ? null : dateDiff(normPart(part), x, y); });
  fn('DATEADD', (part, n, d) => { const t = P(d); return t == null || n == null ? null : dates.fmt(dateAdd(normPart(part), Number(n), t)); });
  fn('DATETRUNC', (part, d) => { const t = P(d); return t == null ? null : dates.fmt(dateTrunc(normPart(part), t)); });
  fn('EOMONTH', (d) => { const t = P(d); if (t == null) return null; const x = new Date(t); return dates.fmtDate(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 0)); });
  fn('TO_SQLDATE', (d) => { const t = P(d); return t == null ? null : dates.fmtDate(t); });
  fn('TO_SQLDATETIME', (d) => { const t = P(d); return t == null ? null : dates.fmt(t); });
  fn('FORMAT', (...a) => {
    const [v, pattern] = a;
    if (v == null || pattern == null) return null;
    const t = typeof v === 'string' ? P(v) : null;
    if (t != null) return formatDate(t, String(pattern));
    const num = Number(v), pat = String(pattern);
    let m;
    if ((m = /^[Nn](\d*)$/.exec(pat))) return num.toLocaleString('en-US', { minimumFractionDigits: +(m[1] || 2), maximumFractionDigits: +(m[1] || 2) });
    if ((m = /^[Pp](\d*)$/.exec(pat))) return (num * 100).toFixed(+(m[1] || 2)) + '%';
    if ((m = /^0\.(0+)$/.exec(pat))) return num.toFixed(m[1].length);
    return String(v);
  }, { varargs: true });
  fn('LEN', (s) => (s == null ? null : String(s).replace(/\s+$/, '').length));
  // NVARCHAR storage: 2 bytes per UTF-16 code unit (identical to Buffer.byteLength(s, 'utf16le'),
  // but without a Node built-in, so this module also runs in the browser).
  fn('DATALENGTH', (s) => (s == null ? null : String(s).length * 2));
  fn('CHAR_LENGTH', (s) => (s == null ? null : String(s).length));
  fn('SUBSTRING', (s, start, len) => (s == null ? null : String(s).substr(Math.max(0, start - 1), len)));
  fn('CHARINDEX', (...a) => (a[1] == null ? null : String(a[1]).toLowerCase().indexOf(String(a[0]).toLowerCase(), (a[2] ?? 1) - 1) + 1), { varargs: true });
  fn('T_LEFT', (s, n) => (s == null ? null : String(s).slice(0, n)));
  fn('T_RIGHT', (s, n) => (s == null ? null : String(s).slice(-n)));
  fn('FLOOR', (x) => (x == null ? null : Math.floor(x)));
  fn('CEILING', (x) => (x == null ? null : Math.ceil(x)));
  fn('POWER', (x, y) => (x == null || y == null ? null : Math.pow(x, y)));
  fn('SQRT', (x) => (x == null ? null : Math.sqrt(x)));
  fn('SQUARE', (x) => (x == null ? null : x * x));

  // Aggregates. `inverse` makes them usable as window functions (e.g. PERCENTILE_CONT ... OVER ()).
  const listAgg = (name, result) => db.aggregate(name, {
    start: () => [],
    step: (acc, v, ...rest) => { if (v != null) acc.push(typeof v === 'bigint' ? Number(v) : v); if (rest.length) acc.p = rest[0]; return acc; },
    inverse: (acc, v) => { const i = acc.indexOf(typeof v === 'bigint' ? Number(v) : v); if (i >= 0) acc.splice(i, 1); return acc; },
    result: (acc) => result(acc, acc.p),
    varargs: true,
  });
  listAgg('PCT_CONT', (acc, p) => percentile(acc, p ?? 0.5, false));
  listAgg('PCT_DISC', (acc, p) => percentile(acc, p ?? 0.5, true));
  listAgg('MEDIAN', (acc) => percentile(acc, 0.5, false));
  listAgg('STDEV', (acc) => { const v = variance(acc, true); return v == null ? null : Math.sqrt(v); });
  listAgg('STDEVP', (acc) => { const v = variance(acc, false); return v == null ? null : Math.sqrt(v); });
  listAgg('VAR', (acc) => variance(acc, true));
  listAgg('VARP', (acc) => variance(acc, false));
}

// ------------------------------------------------------------------ syntax rewriting
const FORBIDDEN = /\b(ATTACH|DETACH|PRAGMA|VACUUM|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|REPLACE\s+INTO|load_extension|sqlite_\w+)\b/i;

/** Find index of the ')' matching the '(' at openIdx (string literals already masked). */
export function matchParen(s, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')' && --depth === 0) return i;
  }
  throw new Error('Unbalanced parentheses');
}

/** Split on a separator (default ',') only at paren depth 0, outside string literals. */
export function splitTopLevel(s, sep = ',') {
  const out = []; let depth = 0, cur = '', q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { cur += c; if (c === q) { if (s[i + 1] === q) { cur += s[++i]; } else q = null; } continue; }
    if (c === "'" || c === '"') { q = c; cur += c; continue; }
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === sep && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function maskStrings(sql) {
  const lits = [];
  const masked = sql.replace(/'(?:[^']|'')*'/g, (m) => { lits.push(m); return `\u0000${lits.length - 1}\u0000`; });
  if (/'/.test(masked)) throw new Error('Unterminated string literal');
  return { masked, unmask: (s) => s.replace(/\u0000(\d+)\u0000/g, (_, i) => lits[+i]) };
}

function mapCastType(t) {
  const type = t.trim().toUpperCase();
  if (type === 'DATE') return (e) => `TO_SQLDATE(${e})`;
  if (/^(SMALL)?DATETIME2?(\(\d+\))?$|^DATETIMEOFFSET/.test(type)) return (e) => `TO_SQLDATETIME(${e})`;
  if (/^(TINY|SMALL|BIG)?INT(EGER)?$|^BIT$/.test(type)) return (e) => `CAST(${e} AS INTEGER)`;
  let m;
  if ((m = /^(DECIMAL|NUMERIC)\s*\(\s*\d+\s*,\s*(\d+)\s*\)$/.exec(type))) return (e) => `ROUND(CAST(${e} AS REAL), ${m[2]})`;
  if (/^(FLOAT|REAL|DECIMAL|NUMERIC|MONEY)/.test(type)) return (e) => `CAST(${e} AS REAL)`;
  if (/CHAR|TEXT/.test(type)) return (e) => `CAST(${e} AS TEXT)`;
  throw new Error(`Unsupported CAST type '${t}'`);
}

function rewriteCasts(s) {
  const re = /\b(TRY_CAST|CAST|TRY_CONVERT|CONVERT)\s*\(/gi;
  let m;
  while ((m = re.exec(s))) {
    const open = m.index + m[0].length - 1;
    const close = matchParen(s, open);
    const inner = s.slice(open + 1, close);
    let replacement;
    if (/CAST/i.test(m[1])) {
      const asMatch = [...inner.matchAll(/\s+AS\s+/gi)].pop();
      if (!asMatch) throw new Error('CAST without AS');
      const expr = rewriteCasts(inner.slice(0, asMatch.index));
      replacement = mapCastType(inner.slice(asMatch.index + asMatch[0].length))(expr);
    } else {
      const [type, ...rest] = splitTopLevel(inner);
      replacement = mapCastType(type)(rewriteCasts(rest[0]));
    }
    s = s.slice(0, m.index) + replacement + s.slice(close + 1);
    re.lastIndex = m.index + 1;
  }
  return s;
}

function rewritePercentiles(s) {
  // PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY expr [ASC|DESC])  ->  PCT_CONT(expr, 0.5)
  const re = /\bPERCENTILE_(CONT|DISC)\s*\(\s*([\d.]+)\s*\)\s*WITHIN\s+GROUP\s*\(/gi;
  let m;
  while ((m = re.exec(s))) {
    const open = m.index + m[0].length - 1;
    const close = matchParen(s, open);
    let inner = s.slice(open + 1, close).replace(/^\s*ORDER\s+BY\s+/i, '');
    let p = parseFloat(m[2]);
    const dir = /\s+(ASC|DESC)\s*$/i.exec(inner);
    if (dir) { inner = inner.slice(0, dir.index); if (dir[1].toUpperCase() === 'DESC') p = 1 - p; }
    s = s.slice(0, m.index) + `PCT_${m[1].toUpperCase()}(${inner}, ${p})` + s.slice(close + 1);
  }
  return s;
}

/**
 * Translate a T-SQL / ArcGIS SQL fragment (where clause, expression, or full SELECT)
 * into SQLite. Throws on anything that could write or escape the sandbox.
 */
export function translate(sql, { fullStatement = false } = {}) {
  if (sql == null) return sql;
  let { masked: s, unmask } = maskStrings(String(sql));

  s = s.replace(/;\s*$/, '');
  if (s.includes(';')) throw new Error('Multiple statements are not allowed');
  if (FORBIDDEN.test(s)) throw new Error('Only read-only queries are allowed');
  if (!fullStatement && /\bSELECT\b/i.test(s)) throw new Error('Sub-queries are not allowed in this parameter');

  s = s.replace(/\b(?:DATE|TIMESTAMP)\s*(\u0000\d+\u0000)/gi, '$1'); // DATE '2026-01-01' -> '2026-01-01'
  s = s.replace(/\bN(\u0000\d+\u0000)/g, '$1');                       // N'unicode' -> 'unicode'
  s = s.replace(/\[([^\]]+)\]/g, '"$1"');                              // [Field] -> "Field"
  s = s.replace(/\b(DATEDIFF_BIG|DATEDIFF|DATEADD|DATEPART|DATENAME|DATETRUNC)\s*\(\s*([A-Za-z_]+)\s*,/gi,
    (_, f, p) => `${f.toUpperCase().replace('_BIG', '')}('${normPart(p)}',`);
  s = s.replace(/\bEXTRACT\s*\(\s*([A-Za-z_]+)\s+FROM\s+/gi, (_, p) => `DATEPART('${normPart(p)}', `);
  s = s.replace(/\bCURRENT_DATE\b(?!\s*\()/gi, 'CURRENT_DATE_SAST()');
  s = s.replace(/\bCURRENT_TIMESTAMP\b(?!\s*\()/gi, 'GETDATE()');
  s = s.replace(/\bNOW\s*\(\s*\)/gi, 'GETDATE()');
  // ArcGIS standardized SQL interval arithmetic: CURRENT_TIMESTAMP - INTERVAL '7' DAY
  s = s.replace(/(GETDATE\(\)|CURRENT_DATE_SAST\(\)|"[^"]+"|\b[A-Za-z_]\w*)\s*([+-])\s*INTERVAL\s*(\u0000\d+\u0000)\s*(DAY|HOUR|MINUTE|SECOND|MONTH|YEAR)S?\b/gi,
    (_, lhs, op, lit, part) => `DATEADD('${normPart(part)}', ${op === '-' ? '-' : ''}${lit}, ${lhs})`);
  s = s.replace(/\bLEFT\s*\(/gi, 'T_LEFT(').replace(/\bRIGHT\s*\(/gi, 'T_RIGHT(');
  s = s.replace(/\bCHARACTER_LENGTH\s*\(/gi, 'CHAR_LENGTH(');
  s = s.replace(/\bISNULL\s*\(/gi, 'IFNULL('); // ISNULL is a postfix operator in SQLite
  s = rewriteCasts(s);
  s = rewritePercentiles(s);

  if (fullStatement) {
    if (!/^\s*(SELECT|WITH)\b/i.test(s)) throw new Error('Only SELECT / WITH statements are allowed');
    // SELECT [DISTINCT] TOP n ...  ->  ... LIMIT n   (outermost / last SELECT only)
    const top = /\bSELECT\s+(DISTINCT\s+)?TOP\s*\(?\s*(\d+)\s*\)?\s+(PERCENT\s+)?/i;
    const tm = top.exec(s);
    if (tm) {
      if (tm[3]) throw new Error('TOP n PERCENT is not supported');
      s = s.replace(top, `SELECT ${tm[1] ?? ''}`) + ` LIMIT ${tm[2]}`;
    }
  }
  return unmask(s);
}
