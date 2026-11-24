/**
 * Browser runtime for the shared query engine: the GeoJSON over fetch, and an
 * in-memory SQLite database from the vendored SQLite Wasm build.
 *
 * `server/featureService.js` uses a small slice of the `node:sqlite`
 * `DatabaseSync` API — `exec`, `prepare().all()`, `prepare().run()`, `function()`
 * and `aggregate()`. This module presents exactly that slice on top of the
 * SQLite Wasm OO1 API, so the engine itself needs no browser-specific branch.
 *
 * The aggregates are registered as *window* functions (xStep/xInverse/xValue/xFinal),
 * matching `node:sqlite`'s `inverse` option, so `PERCENTILE_CONT(...) OVER ()`
 * behaves the same here as it does on the server.
 */

/** Values SQLite can store. `undefined` and non-finite numbers become NULL, as in SQLite. */
const toSqlValue = (v) => {
  if (v === undefined) return null;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'number' && !Number.isFinite(v)) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
};

let modulePromise = null;

/** Loads and initialises SQLite Wasm once per page. */
export function loadSqlite() {
  modulePromise ??= import('../../vendor/sqlite-wasm/sqlite3.js')
    .then((m) => m.default({ print: () => {}, printErr: () => {} }));
  return modulePromise;
}

/**
 * Wraps a fresh in-memory database in the `node:sqlite`-shaped API the engine expects.
 * @param sqlite3 the initialised SQLite Wasm namespace
 */
export function openDatabase(sqlite3) {
  const db = new sqlite3.oo1.DB(':memory:', 'c');
  const aggregateContext = sqlite3.capi.sqlite3_js_aggregate_context;

  return {
    /** Run one or more statements, discarding any rows. */
    exec(sql) {
      db.exec(sql);
      return this;
    },

    /**
     * `prepare(sql)` with just the two methods the engine calls. `run()` keeps a
     * compiled statement around, which is what makes the 850-row insert fast.
     */
    prepare(sql) {
      let stmt = null;
      return {
        all(...binds) {
          return db.exec({
            sql,
            ...(binds.length ? { bind: binds.map(toSqlValue) } : {}),
            rowMode: 'object',
            returnValue: 'resultRows',
          });
        },
        run(...binds) {
          stmt ??= db.prepare(sql);
          stmt.reset(true);
          if (binds.length) stmt.bind(binds.map(toSqlValue));
          stmt.step();
          stmt.reset(true);
          return { changes: 1, lastInsertRowid: 0 };
        },
      };
    },

    /** Scalar user-defined function, `node:sqlite`'s `db.function(name, options, fn)`. */
    function(name, options, impl) {
      const fn = typeof options === 'function' ? options : impl;
      const opts = typeof options === 'function' ? {} : (options ?? {});
      db.createFunction({
        name,
        arity: opts.varargs ? -1 : fn.length,
        deterministic: opts.deterministic !== false,
        xFunc: (_ctx, ...args) => toSqlValue(fn(...args)),
      });
      return this;
    },

    /**
     * Aggregate (and window) user-defined function, `node:sqlite`'s
     * `db.aggregate(name, { start, step, inverse, result, varargs })`.
     *
     * Per-aggregation state is held in a Map keyed by SQLite's own aggregate
     * context pointer, which is stable for the life of one aggregation.
     */
    aggregate(name, spec) {
      const states = new Map();
      const keyFor = (ctx) => {
        const key = aggregateContext(ctx, 1);
        if (!states.has(key)) states.set(key, typeof spec.start === 'function' ? spec.start() : spec.start);
        return key;
      };
      const definition = {
        name,
        arity: spec.varargs ? -1 : Math.max(0, (spec.step?.length ?? 1) - 1),
        xStep: (ctx, ...args) => {
          const key = keyFor(ctx);
          states.set(key, spec.step(states.get(key), ...args));
        },
        xFinal: (ctx) => {
          const key = keyFor(ctx);
          const value = toSqlValue(spec.result(states.get(key)));
          states.delete(key);
          return value;
        },
      };
      if (spec.inverse) {
        // xValue must not discard the state: the window is still moving.
        definition.xValue = (ctx) => toSqlValue(spec.result(states.get(keyFor(ctx))));
        definition.xInverse = (ctx, ...args) => {
          const key = keyFor(ctx);
          states.set(key, spec.inverse(states.get(key), ...args));
        };
      }
      db.createFunction(definition);
      return this;
    },
  };
}

/**
 * `{ geojson, openDatabase() }` for `new FeatureService(cfg, runtime)`.
 * @param geojsonUrl where to fetch the feature collection from
 */
export async function browserRuntime(geojsonUrl) {
  const [sqlite3, geojson] = await Promise.all([
    loadSqlite(),
    fetch(geojsonUrl, { cache: 'force-cache' }).then((r) => {
      if (!r.ok) throw new Error(`Could not load ${geojsonUrl} (HTTP ${r.status})`);
      return r.json();
    }),
  ]);
  return { geojson, openDatabase: () => openDatabase(sqlite3) };
}
