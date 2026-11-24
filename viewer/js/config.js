// Viewer configuration. Point layerUrl at a real FeatureServer layer with the same
// schema and the whole viewer (filters, dashboard, library, console) works against it unchanged.

// Where the site is mounted. '' when served from the origin root (the Node server,
// http://127.0.0.1:3000/viewer/); '/<repo>' on a GitHub Pages project site, where the
// viewer lives at https://<user>.github.io/<repo>/viewer/.
// Derived from this module's own URL so nothing has to be configured per deployment.
export const SITE_BASE = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');

export const CONFIG = {
  layerUrl: `${location.origin}${SITE_BASE}/arcgis/rest/services/ServiceRequests/FeatureServer/0`,

  // The query library, published as table 1 of the same FeatureServer. The viewer
  // reads its analytical questions from here at runtime rather than importing them,
  // so adding a query to the service adds it to the UI with no code change.
  catalogUrl: `${location.origin}${SITE_BASE}/arcgis/rest/services/ServiceRequests/FeatureServer/1`,

  // Optional ArcGIS location-platform API key. Leave empty to use the keyless basemaps.
  apiKey: '',

  center: [18.56, -33.97], // Cape Town
  zoom: 10,
  timeZone: 'Africa/Johannesburg',
};

export const THEMES = {
  'Three Waters': ['Water Supply', 'Wastewater & Stormwater', 'Flooding'],
  'Transport': ['Roads & Footpaths', 'Streetlights', 'Abandoned Vehicles'],
  'Waste': ['Rubbish & Recycling', 'Illegal Dumping'],
  'Parks & Open Space': ['Parks & Reserves', 'Trees'],
  'Community & Regulatory': ['Noise', 'Animals', 'Graffiti'],
  'Other': null, // everything else
};

export const STATUSES = ['Open', 'In Progress', 'Closed'];
export const CHANNELS = ['App', 'Online form', 'Phone', 'Email', 'In person'];
export const DATE_FIELDS = ['DtLogged', 'DtCompleted'];

// Chart palette (validated: adjacent CVD ΔE ≥ 9.1, normal-vision ΔE ≥ 19.6 on #fcfcfb).
// Slots are assigned in fixed order and follow the entity, never its rank.
export const SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];
export const OTHER = '#898781';
export const STATUS_COLORS = { good: '#0ca30c', warning: '#fab219', serious: '#ec835a', critical: '#d03b3b', neutral: '#b7b5ad' };
export const INK = { primary: '#0b0b0b', secondary: '#52514e', muted: '#898781', grid: '#e1e0d9', axis: '#c3c2b7', surface: '#fcfcfb' };

// Fixed colours so the map, the legend and every chart agree.
export const THEME_COLORS = {
  'Three Waters': SERIES[0],
  'Transport': SERIES[1],
  'Waste': SERIES[2],
  'Parks & Open Space': SERIES[3],
  'Community & Regulatory': SERIES[4],
  'Other': OTHER,
};
export const STATUS_GROUP_COLORS = {
  'Open': STATUS_COLORS.critical,
  'In Progress': STATUS_COLORS.serious,
  'Closed': STATUS_COLORS.good,
};
export const CHANNEL_COLORS = Object.fromEntries(CHANNELS.map((c, i) => [c, SERIES[i]]));

// Fields a chart click can turn into a map filter
export const FILTERABLE = ['Category', 'CategorySub', 'Status', 'Channel', 'Suburb'];
