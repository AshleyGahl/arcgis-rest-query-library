/**
 * Node runtime for the shared query engine: reads the GeoJSON from disk and
 * opens an in-memory `node:sqlite` database.
 *
 * The browser demo supplies the same two things from
 * `viewer/js/engine/sqliteWasmRuntime.js`, which is why `FeatureService` itself
 * imports neither `node:fs` nor `node:sqlite`.
 */
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { FeatureService } from './featureService.js';

/** `{ geojson, openDatabase() }` for the engine, backed by Node built-ins. */
export function nodeRuntime(cfg) {
  return {
    geojson: JSON.parse(fs.readFileSync(cfg.geojsonPath, 'utf8')),
    openDatabase: () => new DatabaseSync(':memory:'),
  };
}

/** The usual way to build the engine in Node. */
export const createFeatureService = (cfg) => new FeatureService(cfg, nodeRuntime(cfg));
