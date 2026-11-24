// Promise wrapper around the ArcGIS Maps SDK AMD loader.
export const load = (modules) =>
  new Promise((resolve, reject) => window.require(modules, (...m) => resolve(m), reject));

export const sql = (s) => `'${String(s).replace(/'/g, "''")}'`;
