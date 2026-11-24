/**
 * Service settings that are not tied to a platform, so the Node host
 * (`server/config.js`) and the static browser demo (`viewer/js/engine/boot.js`)
 * configure the engine identically.
 */
export const SERVICE_DEFAULTS = {
  serviceName: 'ServiceRequests',
  layerName: 'ServiceRequests',
  maxRecordCount: 2000,
  // 'snapshot' => GETDATE()/CURRENT_DATE return the dataset's asOf time (stable results)
  // 'system'   => real wall-clock time in SAST
  clock: 'snapshot',
  timeZoneOffsetHours: 2, // Africa/Johannesburg, no DST
};
