// Shared helpers: formatting, escaping, timing.
export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** Esri epoch ms -> 'YYYY-MM-DD HH:mm' in SAST (UTC+2, no DST). */
export const fmtDateSAST = (ms) => (ms == null ? null : new Date(ms + 2 * 3600000).toISOString().slice(0, 16).replace('T', ' '));

export const fmtNum = (v, digits = 0) =>
  v == null || Number.isNaN(v) ? '–' : Number(v).toLocaleString('en-GB', { minimumFractionDigits: digits, maximumFractionDigits: digits });

export const fmtCompact = (v) => (v == null ? '–' : Math.abs(v) >= 1000 ? Number(v).toLocaleString('en-GB', { notation: 'compact', maximumFractionDigits: 1 }) : fmtNum(v, Number.isInteger(v) ? 0 : 1));

export const debounce = (fn, ms = 250) => {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
};

/** SQL literal for a value: numbers bare, strings quoted with '' escaping. */
export const sqlValue = (v) => (typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
