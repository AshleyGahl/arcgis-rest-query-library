import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SERVICE_DEFAULTS } from './serviceConfig.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const config = {
  ...SERVICE_DEFAULTS,
  root,
  host: process.env.HOST ?? '127.0.0.1',
  port: parseInt(process.env.PORT ?? '3001', 10),
  geojsonPath: process.env.GEOJSON ?? path.join(root, 'data', 'service_requests.geojson'),
  clock: process.env.CLOCK ?? SERVICE_DEFAULTS.clock,
  logQueries: process.env.LOG_QUERIES !== 'false',
};
