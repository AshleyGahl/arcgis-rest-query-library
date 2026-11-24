/**
 * Esri field schema for the ServiceRequests layer — a generic council "report a problem"
 * model (see docs/data-model.md). The facts that matter: DtLogged, DtCompleted, Category.
 */
export const FIELDS = [
  { name: 'ObjectID', type: 'esriFieldTypeOID', alias: 'ObjectID', sql: 'INTEGER PRIMARY KEY' },
  { name: 'RequestID', type: 'esriFieldTypeString', alias: 'Request ID', length: 20 },
  { name: 'Category', type: 'esriFieldTypeString', alias: 'Category', length: 50 },
  { name: 'CategorySub', type: 'esriFieldTypeString', alias: 'Sub-category', length: 60 },
  { name: 'Status', type: 'esriFieldTypeString', alias: 'Status', length: 20 },
  { name: 'Channel', type: 'esriFieldTypeString', alias: 'Channel', length: 20 },
  { name: 'Suburb', type: 'esriFieldTypeString', alias: 'Suburb', length: 60 },
  { name: 'Description', type: 'esriFieldTypeString', alias: 'Description', length: 600 },
  { name: 'DtLogged', type: 'esriFieldTypeDate', alias: 'Date Logged', length: 8 },
  { name: 'DtCompleted', type: 'esriFieldTypeDate', alias: 'Date Completed', length: 8 },
];

export const OID_FIELD = 'ObjectID';
export const TIME_FIELD = 'DtLogged';      // layer timeInfo + `time=` parameter
export const DISPLAY_FIELD = 'RequestID';
export const DATE_FIELDS = FIELDS.filter((f) => f.type === 'esriFieldTypeDate').map((f) => f.name);
export const FIELD_BY_LOWER = Object.fromEntries(FIELDS.map((f) => [f.name.toLowerCase(), f]));

export const sqlTypeOf = (f) => {
  if (f.sql) return f.sql;
  switch (f.type) {
    case 'esriFieldTypeString': return 'TEXT COLLATE NOCASE'; // SQL Server default CI collation
    case 'esriFieldTypeSmallInteger':
    case 'esriFieldTypeInteger': return 'INTEGER';
    case 'esriFieldTypeDouble': return 'REAL';
    case 'esriFieldTypeDate': return 'TEXT';
    default: return 'TEXT';
  }
};

/** Esri field JSON as returned in layer and query responses. */
export const esriField = (f) => ({
  name: f.name,
  type: f.type,
  alias: f.alias ?? f.name,
  sqlType: f.type === 'esriFieldTypeOID' ? 'sqlTypeInteger' : 'sqlTypeOther',
  ...(f.length ? { length: f.length } : {}),
  nullable: f.type !== 'esriFieldTypeOID',
  editable: false,
  domain: null,
  defaultValue: null,
});
