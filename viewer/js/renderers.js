import { THEMES, THEME_COLORS, STATUS_GROUP_COLORS, CHANNEL_COLORS, OTHER } from './config.js';

const marker = (color, size = 7) => ({ type: 'simple-marker', style: 'circle', color, size, outline: { color: [255, 255, 255, 0.9], width: 0.6 } });
const arr = (list) => `[${list.map((s) => `'${s.replace(/'/g, "\\'")}'`).join(', ')}]`;

export const THEME_ARCADE = Object.entries(THEMES)
  .map(([theme, cats]) => (cats ? `if (Includes(${arr(cats)}, $feature.Category)) { return '${theme}'; }` : `return '${theme}';`))
  .join('\n');

/**
 * A unique-value renderer over `classes` ([value, colour] pairs).
 *
 * The catch-all is added only when the classes do not already define their own
 * 'Other'. The theme renderer does: its Arcade expression always returns one of
 * the named themes, so a second catch-all would never be used and would simply
 * show up as a duplicate 'Other' in the legend. `status` and `channel` read a
 * field directly, where an unexpected value really can turn up, so they keep it.
 */
const unique = (title, { field, valueExpression }, classes) => {
  const hasOwnOther = classes.some(([value]) => value === 'Other');
  return {
    type: 'unique-value',
    field,
    valueExpression,
    valueExpressionTitle: title,
    uniqueValueInfos: classes.map(([value, color]) => ({ value, label: value, symbol: marker(color) })),
    // The palette's grey, so the map agrees with the charts (see config.js).
    ...(hasOwnOther ? {} : { defaultSymbol: marker(OTHER), defaultLabel: 'Other' }),
  };
};

export const RENDERERS = {
  theme: () => unique('Theme', { valueExpression: THEME_ARCADE }, Object.entries(THEME_COLORS)),
  status: () => unique('Status', { field: 'Status' }, Object.entries(STATUS_GROUP_COLORS)),
  channel: () => unique('Channel', { field: 'Channel' }, Object.entries(CHANNEL_COLORS)),
  heatmap: () => ({
    type: 'heatmap',
    radius: 16,
    maxDensity: 0.012,
    minDensity: 0,
    colorStops: [
      { ratio: 0, color: 'rgba(255,255,255,0)' },
      { ratio: 0.15, color: 'rgba(66,146,198,0.6)' },
      { ratio: 0.4, color: '#41b6c4' },
      { ratio: 0.65, color: '#fed976' },
      { ratio: 0.85, color: '#fd8d3c' },
      { ratio: 1, color: '#bd0026' },
    ],
  }),
};

export const CLUSTER = {
  type: 'cluster',
  clusterRadius: '60px',
  clusterMinSize: '18px',
  clusterMaxSize: '44px',
  popupTemplate: { title: 'Cluster summary', content: '{cluster_count} service requests. Zoom in to see individual points.' },
  labelingInfo: [{
    deconflictionStrategy: 'none',
    labelExpressionInfo: { expression: "Text($feature.cluster_count, '#,###')" },
    symbol: { type: 'text', color: '#ffffff', haloColor: [0, 0, 0, 0.45], haloSize: 1, font: { weight: 'bold', size: '11px' } },
    labelPlacement: 'center-center',
  }],
};

export const POPUP = {
  title: '{RequestID} · {CategorySub}',
  outFields: ['*'],
  expressionInfos: [
    { name: 'theme', title: 'Theme', expression: THEME_ARCADE },
    { name: 'resolution', title: 'Resolution', expression: "IIf(IsEmpty($feature.DtCompleted), 'Not completed', Text(DateDiff($feature.DtCompleted, $feature.DtLogged, 'days'), '#.#') + ' days to complete')" },
  ],
  content: [
    { type: 'text', text: '<b>{Description}</b>' },
    {
      type: 'fields',
      fieldInfos: [
        { fieldName: 'Category' },
        { fieldName: 'CategorySub', label: 'Sub-category' },
        { fieldName: 'Status' },
        { fieldName: 'expression/resolution' },
        { fieldName: 'expression/theme' },
        { fieldName: 'Channel' },
        { fieldName: 'Suburb' },
        { fieldName: 'DtLogged', label: 'Logged', format: { dateFormat: 'short-date-short-time' } },
        { fieldName: 'DtCompleted', label: 'Completed', format: { dateFormat: 'short-date-short-time' } },
        { fieldName: 'ObjectID' },
      ],
    },
  ],
};
