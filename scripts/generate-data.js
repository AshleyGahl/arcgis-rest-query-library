#!/usr/bin/env node
/**
 * Synthetic public service-request generator.
 *
 * Categories, request types, statuses and channels follow the generic "report a problem"
 * model that councils collect: see docs/data-model.md. Coordinates are placed in and
 * around Cape Town.
 *
 *   node scripts/generate-data.js [--count 850] [--seed 20261123] [--asof "2026-11-23 17:00"]
 *
 * Output: data/service_requests.geojson. Deterministic for a given seed. All data is synthetic.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1]]] : acc), []));
const COUNT = Math.min(1000, Math.max(500, parseInt(args.count ?? '850', 10)));
const SEED = parseInt(args.seed ?? '20261123', 10);
const AS_OF = args.asof ?? '2026-11-23 17:00';
const START = '2025-01-01 00:00';
const OUT = path.resolve(__dirname, '..', 'data', 'service_requests.geojson');

// ---------------------------------------------------------------- PRNG
function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const rnd = mulberry32(SEED);
const chance = (p) => rnd() < p;
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const randInt = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const gauss = () => { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
function weighted(items, wfn) {
  const ws = items.map(wfn); let r = rnd() * ws.reduce((a, b) => a + b, 0);
  for (let i = 0; i < items.length; i++) { r -= ws[i]; if (r <= 0) return items[i]; }
  return items[items.length - 1];
}

// "local ms": UTC fields read SAST wall-clock time (UTC+2, no DST)
const OFFSET = 2 * 3600 * 1000;
const parseLocal = (s) => Date.parse(s.replace(' ', 'T') + ':00Z');
const DAY = 86400000;
const startMs = parseLocal(START);
const asOfMs = parseLocal(AS_OF);
const toEpoch = (localMs) => Math.round(localMs - OFFSET);

// ---------------------------------------------------------------- places (Cape Town)
const PLACES = [
  ['City Centre', -33.9235, 18.4205, 0.0045, 5, 'cbd'], ['Sea Point', -33.9185, 18.3895, 0.0028, 3, 'coastal'],
  ['Green Point', -33.9105, 18.4085, 0.0030, 2, 'cbd'], ['Woodstock', -33.9295, 18.4470, 0.0040, 3, 'suburban'],
  ['Observatory', -33.9385, 18.4705, 0.0035, 2, 'suburban'], ['Rondebosch', -33.9600, 18.4760, 0.0050, 3, 'suburban'],
  ['Claremont', -33.9815, 18.4660, 0.0045, 3, 'suburban'], ['Wynberg', -34.0040, 18.4680, 0.0045, 3, 'suburban'],
  ['Constantia', -34.0230, 18.4450, 0.0070, 2, 'suburban'], ['Muizenberg', -34.1000, 18.4720, 0.0030, 2, 'coastal'],
  ['Fish Hoek', -34.1350, 18.4300, 0.0030, 2, 'coastal'], ['Hout Bay', -34.0380, 18.3620, 0.0040, 2, 'coastal'],
  ['Camps Bay', -33.9500, 18.3830, 0.0025, 1, 'coastal'], ['Pinelands', -33.9370, 18.5050, 0.0050, 2, 'suburban'],
  ['Athlone', -33.9640, 18.5040, 0.0050, 3, 'suburban'], ['Gugulethu', -33.9790, 18.5700, 0.0050, 5, 'dense'],
  ['Nyanga', -33.9900, 18.5830, 0.0045, 4, 'dense'], ['Langa', -33.9440, 18.5320, 0.0040, 4, 'dense'],
  ['Philippi', -34.0050, 18.5900, 0.0060, 4, 'dense'], ['Mitchells Plain', -34.0450, 18.6180, 0.0090, 9, 'dense'],
  ['Khayelitsha', -34.0380, 18.6780, 0.0100, 11, 'dense'], ['Hanover Park', -33.9920, 18.5440, 0.0035, 2, 'dense'],
  ['Manenberg', -33.9860, 18.5560, 0.0035, 2, 'dense'], ['Delft', -33.9700, 18.6400, 0.0060, 5, 'dense'],
  ['Blue Downs', -33.9920, 18.6920, 0.0060, 4, 'suburban'], ['Elsies River', -33.9200, 18.5720, 0.0045, 3, 'industrial'],
  ['Goodwood', -33.9110, 18.5500, 0.0045, 2, 'suburban'], ['Parow', -33.9000, 18.5900, 0.0050, 3, 'suburban'],
  ['Bellville', -33.9000, 18.6300, 0.0060, 4, 'cbd'], ['Durbanville', -33.8320, 18.6470, 0.0070, 3, 'suburban'],
  ['Kraaifontein', -33.8480, 18.7200, 0.0070, 4, 'suburban'], ['Brackenfell', -33.8790, 18.6900, 0.0060, 3, 'suburban'],
  ['Kuils River', -33.9300, 18.6850, 0.0060, 3, 'suburban'], ['Milnerton', -33.8700, 18.5050, 0.0060, 3, 'suburban'],
  ['Table View', -33.8220, 18.4950, 0.0050, 3, 'coastal'], ['Bloubergstrand', -33.8040, 18.4800, 0.0030, 1, 'coastal'],
  ['Atlantis', -33.5680, 18.4920, 0.0070, 2, 'dense'], ['Somerset West', -34.0790, 18.8450, 0.0080, 3, 'suburban'],
  ['Strand', -34.1080, 18.8300, 0.0040, 2, 'coastal'], ["Gordon's Bay", -34.1560, 18.8700, 0.0030, 1, 'coastal'],
].map(([name, lat, lon, sd, w, profile]) => ({ name, lat, lon, sd, w, profile }));

// ---------------------------------------------------------------- categories → request types
// [request type, weight, median days to close, description templates]
const CATS = [
  { cat: 'Roads & Footpaths', season: 'winter', types: [
    ['Pothole', 5, 8, ['Pothole on {st}, {sub}. Damaging tyres.', 'Large pothole near {n} {st}. Safety hazard for cyclists.', 'Several potholes along {st} after the rain.']],
    ['Damaged footpath', 3, 21, ['Footpath lifted outside {n} {st}. Trip hazard.', 'Broken paving on {st}, {sub}.']],
    ['Road sign or marking', 2, 14, ['Stop sign knocked over at {st} / {st2}.', 'Road markings faded at {st} intersection.']],
  ] },
  { cat: 'Streetlights', season: 'winter', types: [
    ['Streetlight not working', 6, 5, ['Streetlight out outside {n} {st}.', 'Several streetlights not working on {st}, {sub}.', 'Streetlight flickering at {st}.']],
    ['Damaged streetlight pole', 1, 12, ['Streetlight pole leaning at {n} {st}.', 'Streetlight pole hit by a car on {st}. Urgent.']],
  ] },
  { cat: 'Water Supply', season: 'summer', types: [
    ['Water leak', 7, 2, ['Water leak on the berm outside {n} {st}.', 'Burst pipe on {st}, water running down the road. Urgent.', 'Leak at the toby (water meter box) at {n} {st}.']],
    ['No water or low pressure', 3, 1, ['No water at {n} {st} since this morning.', 'Very low water pressure for houses on {st}, {sub}.']],
    ['Water meter issue', 2, 7, ['Water meter at {n} {st} appears damaged.', 'Water meter lid missing at {n} {st}.']],
  ] },
  { cat: 'Wastewater & Stormwater', season: 'winter', types: [
    ['Blocked drain', 5, 3, ['Blocked stormwater drain on {st}, {sub}.', 'Drain blocked with leaves at {st} / {st2}.']],
    ['Wastewater overflow', 3, 1, ['Wastewater overflowing from manhole on {st}. Urgent.', 'Sewage smell and overflow near {n} {st}.']],
    ['Manhole or catchpit cover', 2, 2, ['Manhole cover missing on {st}. Safety hazard.', 'Catchpit grate dislodged at {n} {st}.']],
  ] },
  { cat: 'Flooding', season: 'winter', types: [
    ['Surface flooding', 3, 2, ['Flooding across {st} near {st2}.', 'Water ponding on the road outside {n} {st} after heavy rain.']],
    ['Blocked culvert', 1, 5, ['Culvert under {st} blocked with debris.']],
  ] },
  { cat: 'Rubbish & Recycling', season: 'none', types: [
    ['Missed collection', 8, 2, ['Bin not collected on {st}, {sub}.', 'Recycling missed on {st} this week.']],
    ['Bin repair or replacement', 4, 6, ['Wheelie bin lid broken at {n} {st}.', 'Bin stolen from {n} {st}, need a replacement.']],
    ['New bin request', 2, 10, ['New bin needed for new house at {n} {st}.']],
  ] },
  { cat: 'Illegal Dumping', season: 'none', types: [
    ['Dumped rubbish', 6, 4, ['Bags of rubbish dumped at {st}, {sub}.', 'Mattress and furniture dumped on the berm at {st}.', 'Building rubble dumped near {st2}.']],
    ['Loose litter', 3, 3, ['Litter build-up along {st}.', 'Overflowing public litter bin on {st}.']],
  ] },
  { cat: 'Graffiti', season: 'none', types: [
    ['Graffiti on public property', 5, 4, ['Graffiti on the bus shelter at {st}.', 'Tagging on the wall of the public toilets in {sub}.', 'Offensive graffiti on {st}. Please remove urgently.']],
  ] },
  { cat: 'Parks & Reserves', season: 'summer', types: [
    ['Broken play equipment', 2, 12, ['Broken swing at the {sub} playground.', 'Slide damaged at the park on {st}. Safety hazard.']],
    ['Grass mowing', 3, 10, ['Grass very long at the reserve on {st}.', 'Sports field in {sub} needs mowing.']],
    ['Public toilet issue', 2, 3, ['Public toilets in {sub} blocked.', 'No toilet paper and broken tap at the {sub} public toilets.']],
  ] },
  { cat: 'Trees', season: 'winter', types: [
    ['Fallen tree or branch', 2, 2, ['Branch down across the footpath on {st}. Urgent.', 'Tree fallen in the park on {st} after the storm.']],
    ['Overhanging vegetation', 3, 18, ['Trees overhanging the footpath at {n} {st}.', 'Hedge blocking sightlines at {st} / {st2}.']],
  ] },
  { cat: 'Noise', season: 'summer', types: [
    ['Party or people noise', 4, 0.2, ['Loud music from {n} {st}.', 'Party noise at {n} {st}, {sub}, ongoing after midnight.']],
    ['Construction noise', 1, 3, ['Construction noise before 7am at {st}.']],
  ] },
  { cat: 'Animals', season: 'none', types: [
    ['Roaming dog', 3, 1, ['Roaming dog on {st}, {sub}.', 'Aggressive dog loose near {n} {st}. Urgent.']],
    ['Barking dog', 2, 10, ['Dog barking constantly at {n} {st}.']],
  ] },
  { cat: 'Abandoned Vehicles', season: 'none', types: [
    ['Abandoned vehicle', 2, 14, ['Car parked on {st} for weeks with no plates.', 'Burnt-out vehicle on the berm at {st}.']],
  ] },
];
const PROFILE_MULT = {
  dense: { 'Wastewater & Stormwater': 1.8, 'Illegal Dumping': 2.0, 'Rubbish & Recycling': 1.4, 'Water Supply': 1.3, Animals: 1.3 },
  coastal: { 'Parks & Reserves': 2.0, Trees: 1.3, Noise: 1.3 },
  cbd: { Graffiti: 2.5, Noise: 1.8, 'Illegal Dumping': 1.3, 'Roads & Footpaths': 1.2 },
  suburban: { Trees: 1.6, 'Parks & Reserves': 1.4, 'Rubbish & Recycling': 1.2 },
  industrial: { 'Illegal Dumping': 2.0, 'Abandoned Vehicles': 2.5, 'Roads & Footpaths': 1.4 },
};
const TYPES = CATS.flatMap((c) => c.types.map(([type, w, med, desc]) => ({ cat: c.cat, season: c.season, type, w, med, desc })));

const CHANNELS = { App: 30, 'Online form': 25, Phone: 30, Email: 10, 'In person': 5 };
const URGENT_TYPES = new Set(['Water leak', 'No water or low pressure', 'Wastewater overflow', 'Party or people noise', 'Roaming dog', 'Fallen tree or branch', 'Surface flooding']);
const STREETS = ['Main Road', 'Church Street', 'Station Road', 'School Street', 'Long Street', 'Park Road', 'Victoria Road',
  'First Avenue', 'Second Avenue', 'Oak Street', 'Protea Road', 'Disa Street', 'Hospital Road', 'Voortrekker Road',
  'Klipfontein Road', 'Lansdowne Road', 'Kloof Street', 'Durban Road', 'Koeberg Road', 'Spine Road'];

// ---------------------------------------------------------------- helpers
function seasonWeight(season, d) {
  const m = d.getUTCMonth() + 1; // southern hemisphere seasons
  if (season === 'winter') return [6, 7, 8].includes(m) ? 1.9 : [5, 9].includes(m) ? 1.3 : 0.8;
  if (season === 'summer') return [12, 1, 2].includes(m) ? 1.8 : [11, 3].includes(m) ? 1.2 : 0.7;
  return 1;
}
function sampleLogged(t, channel) {
  const windowStart = chance(0.03) ? asOfMs - 30 * DAY : startMs; // keep recent weeks populated
  const digital = channel === 'App' || channel === 'Online form' || channel === 'Email';
  for (let i = 0; i < 500; i++) {
    const ts = windowStart + rnd() * (asOfMs - windowStart);
    const d = new Date(ts);
    const growth = 0.85 + 0.3 * ((ts - startMs) / (asOfMs - startMs));
    const weekend = d.getUTCDay() % 6 === 0 ? (digital ? 0.85 : 0.45) : 1;
    if (rnd() < (seasonWeight(t.season, d) * growth * weekend) / 2.6) {
      let hour = digital ? Math.min(23, Math.max(0, Math.round(13 + gauss() * 5)))
        : weighted([7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17], (h) => ({ 7: 3, 8: 8, 9: 10, 10: 9, 11: 7, 12: 5, 13: 6, 14: 7, 15: 6, 16: 4, 17: 2 })[h]);
      if (t.cat === 'Noise') hour = pick([19, 20, 21, 22, 23, 0, 1, 2]);
      const out = Math.floor(ts / DAY) * DAY + hour * 3600000 + randInt(0, 59) * 60000 + randInt(0, 59) * 1000;
      return out > asOfMs ? asOfMs - randInt(5, 600) * 60000 : out;
    }
  }
  return startMs + rnd() * (asOfMs - startMs);
}

// ---------------------------------------------------------------- generate
const rows = [];
for (let i = 0; i < COUNT; i++) {
  const place = weighted(PLACES, (p) => p.w);
  const mult = PROFILE_MULT[place.profile] ?? {};
  const t = weighted(TYPES, (x) => x.w * (mult[x.cat] ?? 1));
  const channel = weighted(Object.keys(CHANNELS), (c) => CHANNELS[c] * (URGENT_TYPES.has(t.type) && c === 'Phone' ? 2.5 : 1));
  const logged = sampleLogged(t, channel);

  const lat = place.lat + gauss() * place.sd;
  const lon = place.lon + gauss() * place.sd * 1.15;

  const st = pick(STREETS);
  let st2 = pick(STREETS); if (st2 === st) st2 = pick(STREETS);
  let description = pick(t.desc).replaceAll('{n}', randInt(1, 240)).replaceAll('{st2}', st2).replaceAll('{st}', st).replaceAll('{sub}', place.name);

  let dur = t.med * Math.exp(gauss() * 1.1);
  if (/urgent|hazard/i.test(description)) dur *= 0.6;
  const completeAt = logged + dur * DAY;

  let status, completed = null;
  if (completeAt <= asOfMs && !chance(0.06)) { status = 'Closed'; completed = Math.round(completeAt / 1000) * 1000; }
  else status = (asOfMs - logged) / 3600000 < 20 || chance(0.4) ? 'Open' : 'In Progress';

  // deliberate data-quality defects (exercised by the data-quality queries)
  if (completed && chance(0.012)) completed = null;                                   // Closed without a completed date
  else if (completed && chance(0.006)) completed = logged - randInt(1, 3) * DAY;       // completed before logged
  if (status !== 'Closed' && chance(0.01)) completed = logged + randInt(1, 5) * DAY;   // dated but not closed
  let suburb = place.name;
  if (chance(channel === 'App' ? 0.08 : 0.03)) suburb = null;                         // pin only, no address match
  if (chance(0.02)) description = null; else if (chance(0.01)) description = '';

  rows.push({ lat, lon, logged, completed, props: { Category: t.cat, RequestType: t.type, Status: status, Channel: channel, Suburb: suburb, Description: description } });
}

rows.sort((a, b) => a.logged - b.logged);
const seq = {};
const features = rows.map((r, i) => {
  const yr = new Date(r.logged).getUTCFullYear();
  seq[yr] = (seq[yr] ?? 0) + 1;
  return {
    type: 'Feature',
    id: i + 1,
    geometry: { type: 'Point', coordinates: [+r.lon.toFixed(6), +r.lat.toFixed(6)] },
    properties: {
      ObjectID: i + 1,
      RequestID: `SR-${yr}-${String(seq[yr]).padStart(5, '0')}`,
      ...r.props,
      DateLogged: toEpoch(r.logged),
      DateCompleted: r.completed == null ? null : toEpoch(r.completed),
    },
  };
});

const fc = {
  type: 'FeatureCollection',
  name: 'ServiceRequests',
  metadata: {
    description: 'Synthetic public service requests (generic council "report a problem" model), located in and around Cape Town.',
    generated: new Date().toISOString(),
    seed: SEED,
    asOf: AS_OF + ' SAST',
    asOfEpoch: toEpoch(asOfMs),
    dateFormat: 'epoch milliseconds (UTC), as returned by ArcGIS REST',
    timeZone: 'Africa/Johannesburg (UTC+02:00)',
    disclaimer: 'Synthetic data for development and testing. No real requests, people or organisations.',
  },
  features,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(fc, null, 1));
console.log(`Wrote ${features.length} features to ${path.relative(process.cwd(), OUT)} (seed ${SEED}, as of ${AS_OF})`);
