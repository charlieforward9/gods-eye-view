/**
 * The local planner: a typed question becomes the map actions that answer
 * it, with no model and no network. Pure and synchronous, so the camera can
 * start moving the moment a question is sent; `answers.js` runs the plan.
 *
 * A plan is `{intent, title, calls, layers, query, hours, place, follow,
 * background, say, suggestions}`:
 *  - `calls` are `{name, args, fill?}` for the action runner, in order.
 *    `fill: 'place'` asks the runner to copy the coordinates the plan's
 *    fly_to_location resolved into this call.
 *  - `query` is the analyst_query the answer's rows come from; a watch
 *    re-runs it, so live rows and the pill's +N −M stay current.
 *  - `background` is the server tool a watch polls while its session is not
 *    on screen, when one fits.
 */
import { isGeoPoint } from '../geoDistance.js';
import { voiceLayer } from '../voice/layerManifest.js';
import { parseSlash } from './commands.js';
import {
  asksForDeviceCameras,
  cameraDestination,
  CAMERA_QUESTION,
} from './context.js';
import { layerLabel } from './layers.js';
import { basemapLabel } from './basemaps.js';
import { msg, t, tn } from '../i18n/index.js';

// The moments God's Eye View is known for (the README's field missions, the
// Iran replay, the cockpit), each answerable with no key.
export const SUGGESTIONS = Object.freeze([
  'Military aircraft over the Middle East, then put me in the cockpit',
  'Where is GPS being jammed right now?',
  'Strongest earthquake in the last 24 hours? Fly me there.',
  'Take me to LAX, follow a plane, then switch to thermal',
  'When does the ISS pass over me?',
  'Show me every Starlink satellite',
  'Any emergencies?',
]);

const STYLES = ['retro', 'surveillance', 'thermal', 'anime', 'noir'];
/** Every look, normal first, for the Look tab. */
export const STYLE_NAMES = Object.freeze(['normal', ...STYLES]);
const STYLE_LABELS = Object.freeze({
  normal: msg('Normal'),
  retro: msg('Retro'),
  surveillance: msg('Surveillance'),
  thermal: msg('Thermal'),
  anime: msg('Anime'),
  noir: msg('Noir'),
});
/** The style's name, translated, for answers ("Thermal look on"). */
export function styleLabel(style) {
  return STYLE_LABELS[style] ? t(STYLE_LABELS[style]) : style;
}
// The word that leads a superlative answer ("Strongest: …").
const LEADS = Object.freeze({
  highest: msg('Highest'),
  tallest: msg('Highest'),
  lowest: msg('Lowest'),
  fastest: msg('Fastest'),
  quickest: msg('Fastest'),
  slowest: msg('Slowest'),
  biggest: msg('Biggest'),
  largest: msg('Biggest'),
  strongest: msg('Strongest'),
  'most powerful': msg('Strongest'),
  'most intense': msg('Strongest'),
  hottest: msg('Hottest'),
  worst: msg('Worst'),
  deepest: msg('Deepest'),
  shallowest: msg('Shallowest'),
  newest: msg('Newest'),
  latest: msg('Latest'),
  'most recent': msg('Newest'),
  next: msg('Next'),
  last: msg('Latest'),
  recent: msg('Latest'),
  soonest: msg('Next'),
  upcoming: msg('Next'),
});

// Earlier rows win: "military flights" is military, "fire perimeters" is
// perimeters.
const LAYER_WORDS = [
  ['military', /\b(military|warplanes?|fighter jets?|air ?force)\b/],
  ['fire-perimeters', /\b(fire perimeters?|burn scars?|perimeters?)\b/],
  [
    'flights',
    /\b(flights?|flying|planes?|aircraft|airliners?|jets?(?! stream)|air traffic|airborne)\b/,
  ],
  [
    'ais-live-vessels',
    /\b(ships?|vessels?|boats?|shipping|tankers?|cargo ships?|freighters?)\b/,
  ],
  ['satellites', /\b(satellites?|starlink|in orbit|orbiting)\b/],
  ['earthquakes', /\b(earthquakes?|quakes?|seismic|tremors?)\b/],
  ['local-firms', /\b(fires?|wildfires?|burning|hotspots?)\b/],
  ['rocket-launches', /\b(launch(es)?|rockets?)\b/],
  [
    'weather-cyclones',
    /\b(hurricanes?|cyclones?|typhoons?|tropical storms?)\b/,
  ],
  ['weather-lightning', /\b(lightning|thunderstorms?)\b/],
  [
    'weather-radar',
    /\b(rain(ing|y|fall)?|radar|precipitation|storms?|snow(ing|fall)?|weather)\b/,
  ],
  ['weather-satellite', /\b(clouds?|cloud cover)\b/],
  ['wind', /\b(winds?|jet stream)\b/],
  ['gnss-integrity', /\b(gps|gnss|jamming|spoofing|interference)\b/],
  [
    'telegeography-submarine-cables',
    /\b(undersea cables?|submarine cables?|cables?)\b/,
  ],
  ['air-quality', /\b(air quality|air pollution|smog|aqi|pm2\.?5)\b/],
  ['traffic', /\b(road traffic|traffic jams?|congestion|traffic)\b/],
  ['local-datacenters', /\b(data ?cent(er|re)s?)\b/],
  ['local-dams', /\bdams?\b/],
  ['sea-marks', /\b(sea ?marks?|buoys?|lighthouses?|nautical charts?)\b/],
  ['ski-pistes', /\b(ski (pistes?|runs?|slopes?)|pistes?)\b/],
];

// Keyless layers that answer for a keyed one when its key is not set up:
// fire perimeters (NIFC) for FIRMS active fires.
const STAND_INS = Object.freeze({ 'local-firms': 'fire-perimeters' });

// Orderings a question can ask for, by the record field they sort on.
const SORTS = [
  [/\b(highest|tallest)\b/, 'altitudeM', 'desc'],
  [/\b(lowest)\b/, 'altitudeM', 'asc'],
  [/\b(fastest|quickest)\b/, 'speedMps', 'desc'],
  [/\b(slowest)\b/, 'speedMps', 'asc'],
  [/\b(biggest|largest|strongest|most powerful|worst)\b/, 'magnitude', 'desc'],
  [/\b(biggest|largest|strongest|most intense|hottest)\b/, 'frp', 'desc'],
  [/\b(deepest)\b/, 'depthKm', 'desc'],
  [/\b(shallowest)\b/, 'depthKm', 'asc'],
  [/\b(biggest|largest|worst)\b/, 'acres', 'desc'],
  [/\b(strongest|most powerful|worst)\b/, 'windKt', 'desc'],
  [/\b(next|soonest|upcoming)\b/, 'hoursUntil', 'asc'],
  [/\b(latest|last|most recent|recent)\b/, 'hoursUntil', 'desc'],
  [/\b(newest|latest|most recent)\b/, 'ageHours', 'asc'],
];
const DEFAULT_SORT = Object.freeze({
  flights: ['altitudeM', 'desc'],
  military: ['altitudeM', 'desc'],
  earthquakes: ['magnitude', 'desc'],
  'local-firms': ['frp', 'desc'],
  'fire-perimeters': ['acres', 'desc'],
  'weather-cyclones': ['windKt', 'desc'],
  'rocket-launches': ['hoursUntil', 'asc'],
});
// Layers whose events are scattered over the planet: with no place
// named, their question is about anywhere, not the current view.
const GLOBAL_FEEDS = new Set([
  'earthquakes',
  'rocket-launches',
  'weather-cyclones',
  'local-firms',
  'fire-perimeters',
]);

const ORDINALS = Object.freeze({
  first: 1,
  '1st': 1,
  one: 1,
  second: 2,
  '2nd': 2,
  two: 2,
  third: 3,
  '3rd': 3,
  three: 3,
  fourth: 4,
  '4th': 4,
  four: 4,
  fifth: 5,
  '5th': 5,
  five: 5,
  last: -1,
});
const ORDINAL =
  /\b(?:the\s+|number\s+|#)?(first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|last|one|two|three|four|five|[1-5])(?:\s+one)?\b/;
const PRONOUN =
  /^(it|this|that|this one|that one|him|her|them|the plane|the flight|the aircraft|the ship|the satellite|)$/;

const HOURS =
  /\b(?:in|over|during|within|for|from)?\s*(?:the\s+)?(?:last|past)\s+(\d+(?:\.\d+)?|an?|one)?\s*(h|hrs?|hours?|mins?|minutes?|d|days?|w|wks?|weeks?|months?)\b/;
const NOW_WORDS =
  /\b(today|tonight|right now|now|currently|at the moment|this hour|live)\b/g;
// Days a question is about; never part of a place ("Palm Beach County
// yesterday"). Common misspellings count.
const DAY_WORDS =
  /\b(yesterday'?s?|yest[ae]rday|yesturday|last night|this morning|this afternoon|this evening|tomorrow'?s?|tomm?orr?ow|tmrw)\b/g;
const MAGNITUDE =
  /\b(?:magnitude|mag|above|over|greater than|bigger than|stronger than|at least|more than)\s*(?:m\s*)?(\d(?:\.\d)?)\b\+?|\bm\s?(\d(?:\.\d)?)\+?(?=\s|$)/;
const PLACE =
  /\b(?:over|near|around|in|above|across|off|at|across|along|close to|next to)\s+(.+)$/;
const NOT_PLACES =
  /^(view|the view|sight|frame|the frame|screen|the screen|here|me|my area|this area|the area|my location|range|air|sky|orbit|space|sea|ocean|water|flight|motion|the news)$/;
// "Flights above 30000 feet", "earthquakes over 10": a number, not a place.
const MEASURE =
  /^[\d.,]+\s*(feet|foot|ft|m|meters?|metres?|km|kilometers?|miles?|mi|knots?|kts?|kt|mph|kph|km\/h|%)?$/;
const ANYWHERE =
  /^(the world|the planet|the globe|earth|the earth|everywhere|anywhere|the whole world|the entire world)$/;
const SMALL_WORDS = new Set(['of', 'the', 'and', 'de', 'la', 'el', 'on']);

const plain = (text) =>
  String(text || '')
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

/** "gulf of mexico" → "Gulf of Mexico". */
export function placeName(text) {
  return String(text)
    .split(' ')
    .map((word, i) =>
      i > 0 && SMALL_WORDS.has(word)
        ? word
        : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join(' ');
}

/**
 * Hours named by "the last 6 hours", "the past day", "the last 30 minutes",
 * "the last week".
 */
export function hoursOf(text) {
  const match = HOURS.exec(text);
  if (!match) return null;
  const count = /^(an?|one)?$/.test(match[1] || '') ? 1 : Number(match[1]);
  const unit = match[2];
  if (!Number.isFinite(count) || count <= 0) return null;
  if (/^d/.test(unit)) return count * 24;
  if (/^w/.test(unit)) return count * 24 * 7;
  if (/^mo/.test(unit)) return count * 24 * 30;
  if (/^m/.test(unit)) return count / 60;
  return count;
}

/** −1 for yesterday, 1 for tomorrow, 0 for today or no day named. */
export function dayOffset(text) {
  if (/\b(yesterday'?s?|yest[ae]rday|yesturday|last night)\b/.test(text))
    return -1;
  if (/\b(tomorrow'?s?|tomm?orr?ow|tmrw)\b/.test(text)) return 1;
  return 0;
}

function magnitudeOf(text) {
  const match = MAGNITUDE.exec(text);
  if (!match) return null;
  const value = Number(match[1] ?? match[2]);
  return Number.isFinite(value) && value >= 1 && value <= 10 ? value : null;
}

/** The text with times, thresholds and filler removed, for reading a place. */
function withoutQualifiers(text) {
  return (
    text
      .replace(HOURS, ' ')
      .replace(MAGNITUDE, ' ')
      .replace(NOW_WORDS, ' ')
      .replace(DAY_WORDS, ' ')
      // A sentence's full stop goes; "D.C." and "U.S." keep theirs.
      .replace(/[?!,]+/g, ' ')
      .replace(/(?<!\b[a-z])\.(?=\s|$)/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/**
 * Where a question is about: `{name}` for a named place, `{here: true}`,
 * `{view: true}`, `{anywhere: true}`, or null when it names nowhere.
 */
export function placeOf(text) {
  const match = PLACE.exec(withoutQualifiers(text));
  if (!match) return null;
  let place = match[1]
    .replace(
      /\s+(right now|now|today|please|with .*|that .*|which .*|sorted .*)$/,
      '',
    )
    .replace(/^(the\s+)/, '')
    .trim();
  if (!place) return null;
  if (
    /^(view|sight|frame|screen)$/.test(place) ||
    /^the (view|frame)$/.test(place)
  )
    return { view: true };
  if (/^(me|here|my area|my location|this area|the area)$/.test(place))
    return { here: true };
  if (ANYWHERE.test(place) || ANYWHERE.test(`the ${place}`))
    return { anywhere: true };
  if (NOT_PLACES.test(place) || MEASURE.test(place)) return null;
  if (place.split(' ').length > 6) return null;
  return { name: placeName(place) };
}

function layersOf(text) {
  const found = [];
  for (const [id, pattern] of LAYER_WORDS) {
    if (!pattern.test(text)) continue;
    // "military flights" names military alone; "fire perimeters" names
    // perimeters, not fires.
    if (
      id === 'flights' &&
      found.includes('military') &&
      !/\b(civilian|commercial|airliners?|all (the )?(planes|aircraft|flights))\b/.test(
        text,
      )
    )
      continue;
    // Air traffic is flights; "traffic" alone is the roads.
    if (id === 'traffic' && /\bair traffic\b/.test(text)) continue;
    if (id === 'local-firms' && found.includes('fire-perimeters')) continue;
    if (id === 'weather-radar' && found.includes('weather-lightning')) continue;
    found.push(id);
  }
  return found;
}

const hasField = (layerId, field) =>
  Boolean(voiceLayer(layerId)?.query?.fields?.[field]) || field === 'ageHours';

function sortFor(text, layers) {
  for (const [pattern, field, dir] of SORTS) {
    if (pattern.test(text) && layers.every((id) => hasField(id, field)))
      return { sortBy: field, sortDir: dir };
  }
  const fallback = DEFAULT_SORT[layers[0]];
  if (fallback && layers.every((id) => hasField(id, fallback[0])))
    return { sortBy: fallback[0], sortDir: fallback[1] };
  return {};
}

function objectChip(context) {
  return (context.chips || []).find((chip) => chip?.kind === 'object') || null;
}

function hereOf(context) {
  const chip = (context.chips || []).find((entry) => entry?.kind === 'here');
  return chip || context.here || null;
}

const layersOn = (ids) =>
  ids.map((layerId) => ({
    name: 'set_layer_visibility',
    args: { layerId, enabled: true },
  }));

// Seas, straits and regions a geocoder resolves to the wrong thing (the
// "Middle East" is an airline's headquarters to it) or the region index does
// not hold: [lat, lon, radius km, whether the region index knows its shape].
// Naming one moves the camera at once; a known shape still scopes the query.
const REGIONS = Object.freeze({
  'middle east': [29, 45, 1800],
  'persian gulf': [27, 51.5, 450],
  'arabian gulf': [27, 51.5, 450],
  'strait of hormuz': [26.6, 56.4, 150],
  hormuz: [26.6, 56.4, 150],
  'red sea': [20.5, 38.5, 800, true],
  'eastern mediterranean': [34.5, 32.5, 500],
  'east med': [34.5, 32.5, 500],
  mediterranean: [37, 15, 1600],
  baltic: [58, 20, 600],
  'baltic sea': [58, 20, 600],
  'black sea': [43.5, 34.5, 600],
  'south china sea': [13, 114, 1100],
  'taiwan strait': [24.3, 119.6, 250],
  'gulf of mexico': [25, -90, 900, true],
  caribbean: [16, -72, 1200],
  europe: [50, 12, 1800, true],
  'north atlantic': [50, -35, 1800],
  'english channel': [50.2, -1.5, 250],
  'suez canal': [30.6, 32.4, 120],
  'panama canal': [9.1, -79.7, 80],
  'korean peninsula': [37.5, 127.5, 450],
});
// Busy airports by IATA code: [lat, lon]. A geocoder turns "LAX" into a
// Swiss village; a code typed in capitals means the airport.
const AIRPORTS = Object.freeze({
  LAX: [33.9425, -118.4081],
  SFO: [37.6213, -122.379],
  SAN: [32.7338, -117.1933],
  SEA: [47.4502, -122.3088],
  LAS: [36.084, -115.1537],
  PHX: [33.4352, -112.0101],
  DEN: [39.8561, -104.6737],
  DFW: [32.8998, -97.0403],
  IAH: [29.9902, -95.3368],
  AUS: [30.1975, -97.6664],
  ORD: [41.9742, -87.9073],
  MSP: [44.8848, -93.2223],
  DTW: [42.2162, -83.3554],
  ATL: [33.6407, -84.4277],
  CLT: [35.214, -80.9431],
  MCO: [28.4312, -81.3081],
  MIA: [25.7959, -80.287],
  IAD: [38.9531, -77.4565],
  DCA: [38.8512, -77.0402],
  JFK: [40.6413, -73.7781],
  EWR: [40.6895, -74.1745],
  LGA: [40.7769, -73.874],
  BOS: [42.3656, -71.0096],
  YYZ: [43.6777, -79.6248],
  MEX: [19.4361, -99.0719],
  GRU: [-23.4356, -46.4731],
  LHR: [51.47, -0.4543],
  CDG: [49.0097, 2.5479],
  AMS: [52.3105, 4.7683],
  FRA: [50.0379, 8.5622],
  MUC: [48.3537, 11.775],
  ZRH: [47.4582, 8.5555],
  MAD: [40.4983, -3.5676],
  FCO: [41.8003, 12.2389],
  IST: [41.2753, 28.7519],
  DXB: [25.2532, 55.3657],
  DOH: [25.2731, 51.6081],
  DEL: [28.5562, 77.1],
  BOM: [19.0896, 72.8656],
  SIN: [1.3644, 103.9915],
  BKK: [13.69, 100.7501],
  HKG: [22.308, 113.9185],
  PVG: [31.1443, 121.8083],
  PEK: [40.0799, 116.6031],
  ICN: [37.4602, 126.4407],
  HND: [35.5494, 139.7798],
  NRT: [35.772, 140.3929],
  SYD: [-33.9399, 151.1753],
});

/**
 * An airport from its code as typed ("LAX", or "LAX airport"), or null. The
 * code must be in capitals: "sea" is a sea, "SEA" is Seattle.
 */
export function airportOf(typed) {
  const code = /^([A-Z]{3})(?: airport)?$/.exec(
    String(typed || '').trim(),
  )?.[1];
  const entry = code && AIRPORTS[code];
  return entry ? { code, lat: entry[0], lon: entry[1] } : null;
}

/** A named region from the gazetteer, or null. */
export function regionOf(name) {
  const entry = REGIONS[String(name || '').toLowerCase()];
  return entry
    ? { lat: entry[0], lon: entry[1], km: entry[2], indexed: Boolean(entry[3]) }
    : null;
}

const flyTo = (name, viewMode = 'overview', rangeM) => {
  const region = regionOf(name);
  // A known region flies straight to its center; anything else geocodes.
  if (region)
    return {
      name: 'fly_to_location',
      args: {
        latitude: region.lat,
        longitude: region.lon,
        viewMode: 'overview',
        waitForArrival: false,
        rangeM: Math.min(12_000_000, Math.max(300_000, region.km * 2600)),
      },
    };
  return {
    name: 'fly_to_location',
    args: {
      query: name,
      viewMode,
      waitForArrival: false,
      ...(rangeM ? { rangeM } : {}),
    },
  };
};
// A question about what is in a place frames the whole region, not a street.
const REGION_RANGE_M = 1_400_000;

function plan(fields) {
  return Object.freeze({
    intent: 'action',
    title: null,
    calls: [],
    layers: [],
    query: null,
    hours: null,
    place: null,
    follow: null,
    background: null,
    lead: null,
    countSay: null,
    emptySay: null,
    standIn: null,
    say: null,
    suggestions: [],
    ...fields,
  });
}

/** A scope for analyst_query from a place, a chip and the question. */
function scopeFor(place, layers, context) {
  const chip = objectChip(context);
  const region = regionOf(place?.name);
  if (region && !region.indexed)
    return {
      kind: 'radius',
      km: region.km,
      center: { lat: region.lat, lon: region.lon },
    };
  if (place?.name) return { kind: 'region', name: place.name };
  if (place?.here) {
    const here = hereOf(context);
    return here
      ? { kind: 'radius', km: 150, center: { lat: here.lat, lon: here.lon } }
      : { kind: 'view' };
  }
  if (place?.view) return { kind: 'view' };
  if (place?.anywhere) return { kind: 'anywhere' };
  if (chip && Number.isFinite(chip.lat) && Number.isFinite(chip.lon))
    return {
      kind: 'radius',
      km: 100,
      center: { lat: chip.lat, lon: chip.lon },
    };
  const attached = (context.chips || []).find(
    (entry) => entry?.kind === 'view' || entry?.kind === 'here',
  );
  if (attached?.kind === 'view') return { kind: 'view' };
  if (attached?.kind === 'here')
    return {
      kind: 'radius',
      km: 150,
      center: { lat: attached.lat, lon: attached.lon },
    };
  if (layers.every((id) => GLOBAL_FEEDS.has(id))) return { kind: 'anywhere' };
  return context.zoomedIn ? { kind: 'view' } : { kind: 'anywhere' };
}

function where(scope, place) {
  if (place) return ` · ${place}`;
  if (scope.kind === 'region') return ` · ${scope.name}`;
  if (scope.kind === 'radius') return ` · ${t('nearby')}`;
  if (scope.kind === 'view') return ` · ${t('in view')}`;
  return '';
}

function queryPlan(text, layers, context) {
  const queryable = layers.filter((id) => voiceLayer(id)?.query);
  const place = placeOf(text);
  const hours = hoursOf(text);
  const magnitude = layers.includes('earthquakes') ? magnitudeOf(text) : null;
  const scope = scopeFor(place, queryable.length ? queryable : layers, context);
  // The camera moves first: it starts the instant the question is sent,
  // while the layers fetch behind it.
  const calls = [];
  if (place?.name) calls.push(flyTo(place.name, 'overview', REGION_RANGE_M));
  // An answer about anywhere is seen from space.
  else if (scope.kind === 'anywhere' && context.zoomedIn)
    calls.push({ name: 'zoom_to_globe', args: {} });
  calls.push(...layersOn(layers));
  let query = null;
  if (queryable.length) {
    const filters = [];
    if (magnitude !== null)
      filters.push({ field: 'magnitude', op: 'gte', value: magnitude });
    if (
      hours !== null &&
      queryable.every((id) => voiceLayer(id).query.timeField)
    )
      filters.push({ field: 'ageHours', op: 'lte', value: hours });
    // Upcoming launches leave out the ones already flown.
    if (queryable.length === 1 && queryable[0] === 'rocket-launches') {
      if (/\b(next|upcoming|soon|scheduled)\b/.test(text))
        filters.push({ field: 'hoursUntil', op: 'gte', value: 0 });
      else if (/\b(latest|last|recent)\b/.test(text))
        filters.push({ field: 'hoursUntil', op: 'lte', value: 0 });
    }
    query = {
      layers: queryable,
      scope,
      ...(filters.length ? { filters } : {}),
      ...sortFor(text, queryable),
      limit: 50,
    };
    calls.push({ name: 'analyst_query', args: query });
  }
  const label = layers.map(layerLabel).join(' + ');
  // "Strongest earthquake…" is answered by the strongest one, first.
  const superlative = SORTS.find(
    ([pattern, field]) => pattern.test(text) && query?.sortBy === field,
  );
  const word = superlative?.[0].exec(text)[1];
  const lead = word ? t(LEADS[word] || msg('Top')) : null;
  const threshold = magnitude !== null ? ` M${magnitude}+` : '';
  const span =
    hours !== null
      ? ` · ${hours < 1 ? t('{count} min', { count: Math.round(hours * 60) }) : t('{count} h', { count: hours })}`
      : '';
  return plan({
    intent: 'query',
    emptySay:
      EMPTY_SAYS[queryable[0]] || msg('Nothing matches that right now.'),
    title: `${label}${threshold}${where(scope, place?.name)}${span}`,
    calls,
    layers,
    query,
    hours,
    lead,
    place: place?.name || null,
    background:
      layers.length === 1 && layers[0] === 'earthquakes'
        ? {
            tool: 'get_earthquakes',
            args: {
              ...(magnitude !== null ? { min_magnitude: magnitude } : {}),
              ...(place?.name ? { area: place.name } : {}),
              limit: 20,
            },
          }
        : null,
  });
}

function emergencyPlan(text, context) {
  const place = placeOf(text);
  const layers = ['flights', 'military'];
  const scope = place ? scopeFor(place, layers, context) : { kind: 'anywhere' };
  const query = {
    layers,
    scope,
    filters: [{ field: 'emergency', op: 'eq', value: true }],
    limit: 50,
  };
  return plan({
    intent: 'query',
    emptySay: msg('No aircraft is squawking an emergency right now.'),
    countSay: msg('{count} aircraft squawking an emergency right now.'),
    title: `${t('Emergencies')}${where(scope, place?.name)}`,
    calls: [
      ...(place?.name ? [flyTo(place.name, 'overview', REGION_RANGE_M)] : []),
      ...layersOn(layers),
      { name: 'analyst_query', args: query },
    ],
    layers,
    query,
    place: place?.name || null,
  });
}

function followTarget(rest, context) {
  const target = plain(rest).replace(/[?!.]+$/, '');
  const chip = objectChip(context);
  if (/\b(iss|space station)\b/.test(target))
    return { query: 'ISS', layerId: 'satellites' };
  const ordinal = ORDINAL.exec(target);
  if (ordinal && target.split(' ').length <= 4) {
    const n = ORDINALS[ordinal[1]] ?? Number(ordinal[1]);
    if (n) return { referent: n };
  }
  if (PRONOUN.test(target)) {
    if (chip?.id) return { query: chip.id, layerId: chip.layerId || undefined };
    if (context.hasRows) return { referent: 1 };
    return null;
  }
  return { query: rest.trim() };
}

// "Follow the highest one": the top of a fresh list sorted that way, since
// the last list may be sorted another way or hold nothing.
function topThenFollowPlan(rest, context) {
  const named = layersOf(plain(rest)).filter((id) => voiceLayer(id)?.query);
  const asked = queryPlan(rest, named.length ? named : ['flights'], context);
  if (!asked.lead) return null;
  return plan({
    ...asked,
    title: `${asked.title} → ${t('Following')}`,
    calls: [...asked.calls, { name: 'track_entity', args: { referent: 1 } }],
    follow: { referent: 1 },
  });
}

function followPlan(rest, context) {
  if (!objectChip(context) && SORTS.some(([pattern]) => pattern.test(rest))) {
    const top = topThenFollowPlan(rest, context);
    if (top) return top;
  }
  const target = followTarget(rest, context);
  if (!target)
    return plan({
      intent: 'unknown',
      say: t(
        'Follow what? Tap something on the globe, or name a flight or satellite.',
      ),
      suggestions: ['Follow the ISS', 'Any emergencies?'],
    });
  const args = Object.fromEntries(
    Object.entries(target).filter(([, value]) => value !== undefined),
  );
  const calls = [];
  if (args.layerId === 'satellites') calls.push(...layersOn(['satellites']));
  calls.push({ name: 'track_entity', args });
  return plan({
    intent: 'follow',
    title: args.query
      ? t('Following {target}', { target: args.query })
      : t('Following'),
    calls,
    layers: args.layerId ? [args.layerId] : [],
    follow: args,
  });
}

function passPlan(text, context = {}) {
  const place = placeOf(text);
  const here = place?.here ? hereOf(context) : null;
  const iss = /\b(iss|space station)\b/.test(text);
  const target =
    !iss &&
    (/\b(?:does|will|is)\s+(?:the\s+)?(.+?)\s+(?:pass|fly|go|come)\b/.exec(
      text,
    ) ||
      /\b(starlink|hubble|tiangong)\b/.exec(text));
  const calls = [];
  if (place?.name) calls.push(flyTo(place.name));
  // A pass is computed from the catalog the satellites layer loads.
  calls.push(...layersOn(['satellites']));
  const where = here ? { latitude: here.lat, longitude: here.lon } : {};
  calls.push(
    iss || !target
      ? { name: 'next_iss_pass', args: where, fill: 'place' }
      : {
          name: 'next_satellite_pass',
          args: { target: target[1], ...where },
          fill: 'place',
        },
  );
  return plan({
    intent: 'query',
    title: `${iss || !target ? t('Next ISS pass') : t('{satellite} passes', { satellite: placeName(target[1]) })}${place?.name ? ` · ${place.name}` : here ? ` · ${t('here')}` : ''}`,
    calls,
    layers: ['satellites'],
    place: place?.name || null,
  });
}

function markPlan(rest, context) {
  const chip = objectChip(context);
  if (chip && Number.isFinite(chip.lat) && Number.isFinite(chip.lon)) {
    return plan({
      intent: 'action',
      title: t('Marked {target}', { target: chip.label || chip.id }),
      calls: [
        {
          name: 'annotate_map',
          args: {
            annotations: [
              {
                type: 'pin',
                latitude: chip.lat,
                longitude: chip.lon,
                label: String(chip.label || chip.id).slice(0, 60),
              },
            ],
          },
        },
      ],
    });
  }
  const which = plain(rest).replace(/[?!.]+$/, '');
  const ordinal = ORDINAL.exec(which);
  const nth =
    ordinal && which.split(' ').length <= 4
      ? (ORDINALS[ordinal[1]] ?? Number(ordinal[1]))
      : null;
  const rows = (context.rows || [])
    .filter((row) => Number.isFinite(row.lat) && Number.isFinite(row.lon))
    .filter((row, i) => !nth || (row.n ?? i + 1) === nth);
  if (
    !rows.length &&
    (nth || PRONOUN.test(which) || /^(them|all)$/.test(which))
  )
    return plan({
      intent: 'unknown',
      say: t('Mark what? Ask a question first, or tap something on the globe.'),
    });
  if (rows.length) {
    return plan({
      intent: 'action',
      title: t('Marked {target}', { target: rows.length }),
      calls: [
        {
          name: 'annotate_map',
          args: {
            annotations: rows.slice(0, 12).map((row) => ({
              type: 'pin',
              latitude: row.lat,
              longitude: row.lon,
              label: String(row.title).slice(0, 60),
            })),
          },
        },
      ],
    });
  }
  const place = rest.trim();
  if (place)
    return plan({
      intent: 'action',
      title: t('Marked {target}', { target: placeName(plain(place)) }),
      calls: [
        {
          name: 'annotate_map',
          args: {
            annotations: [{ type: 'highlight', target: place }],
            flyTo: true,
          },
        },
      ],
    });
  return plan({
    intent: 'unknown',
    say: t('Mark what? Ask a question first, or tap something on the globe.'),
  });
}

function framePlan(text) {
  const target =
    ['military', 'satellites', 'vessels'].find((id) =>
      new RegExp(`\\b${id === 'vessels' ? '(ships?|vessels?)' : id}\\b`).test(
        text,
      ),
    ) || 'flights';
  const layerId = target === 'vessels' ? 'ais-live-vessels' : target;
  const place = placeOf(text);
  return plan({
    intent: 'action',
    title: `${t('Framing {what}', { what: layerLabel(layerId) })}${place?.name ? ` · ${place.name}` : ''}`,
    calls: [
      ...(place?.name ? [flyTo(place.name, 'overview', REGION_RANGE_M)] : []),
      ...layersOn([layerId]),
      { name: 'frame_overhead', args: { target } },
    ],
    layers: [layerId],
    place: place?.name || null,
  });
}

function deviceCamerasPlan(context) {
  const at = hereOf(context);
  return plan({
    intent: 'action',
    title: t('Cameras'),
    calls: [
      {
        name: 'show_nearest_camera_to_device',
        args: isGeoPoint(at) ? { latitude: at.lat, longitude: at.lon } : {},
      },
    ],
    layers: ['cctv'],
  });
}

function camerasPlan(text) {
  const destination = cameraDestination(text);
  const place = placeOf(destination ? `near ${destination}` : text);
  return plan({
    intent: 'action',
    title: `${t('Cameras')}${place?.name ? ` · ${place.name}` : ''}`,
    calls: place?.name
      ? [
          {
            name: 'show_nearest_camera',
            args: { place: place.name },
            fill: 'place',
          },
        ]
      : [
          { name: 'control_cctv', args: { action: 'enable' } },
          { name: 'show_nearest_camera', args: {} },
        ],
    layers: ['cctv'],
    place: place?.name || null,
  });
}

function radioPlan(rest) {
  const place =
    placeOf(rest) || (rest.trim() ? { name: placeName(plain(rest)) } : null);
  return plan({
    intent: 'action',
    title: `${t('Radio')}${place?.name ? ` · ${place.name}` : ''}`,
    calls: [
      {
        name: 'control_radio',
        args: place?.name
          ? { action: 'play', locationQuery: place.name }
          : { action: 'play' },
      },
    ],
    layers: ['radio'],
  });
}

function goPlan(target) {
  const text = plain(target).replace(/[?!.]+$/, '');
  if (
    !text ||
    ANYWHERE.test(text) ||
    /^(the )?(whole|entire) (earth|globe|planet|world)$/.test(text)
  )
    return plan({
      intent: 'action',
      title: t('The whole Earth'),
      calls: [{ name: 'zoom_to_globe', args: {} }],
    });
  const name = placeName(text.replace(/^the\s+/, ''));
  return plan({
    intent: 'action',
    title: name,
    calls: [flyTo(name, 'close')],
    place: name,
  });
}

// The map under the layers: "satellite map", "3D view", "switch the map
// to streets", "go back to satellite". A bare "satellites" is the layer,
// and "street view" is a place up close.
const BASEMAP_WORDS = [
  ['photoreal', /\b(3d|three[- ]d|photo ?real(istic)?)\b/],
  ['esri-imagery', /\b(satellite|aerial)\b/],
  ['osm', /\b(streets?|roads?|osm|openstreetmap)\b/],
];
const MAP_NAMES =
  '3d|three[- ]d|photo ?real(?:istic)?|satellite|aerial|streets?|roads?|osm|openstreetmap';
const BASEMAP_ASK = new RegExp(
  `\\b(base ?map|map (to|style|type|source))\\b|\\b(${MAP_NAMES}) (map|imagery|tiles|buildings)\\b|\\b(3d|three[- ]d|satellite|aerial) view\\b|^(switch|change|go)( back)? to (the )?(${MAP_NAMES})$|^(3d|three[- ]d|photo ?real(?:istic)?|osm|openstreetmap)( map| view)?$`,
);
function basemapOf(text) {
  return BASEMAP_WORDS.find(([, pattern]) => pattern.test(text))?.[0] ?? null;
}
function basemapPlan(id, place = null) {
  return plan({
    intent: 'action',
    title: `${t('{map} map', { map: basemapLabel(id) })}${place ? ` · ${place}` : ''}`,
    calls: [
      { name: 'chat_basemap', args: { stack: id } },
      ...(place ? [flyTo(place, 'overview')] : []),
    ],
    place,
  });
}

// "Weather in Palm Beach County yesterday", "is it raining in Seattle?",
// "forecast for Tokyo tomorrow": a place's weather on a day, or over the
// last few days. Radar shows now, so only a question about today turns it on.
const WEATHER =
  /\b(weather|forecast|temperatures?|how (hot|cold|warm)|hot|cold|warm|rain(ed|ing|fall|y)?|snow(ed|ing|fall|y)?|humid(ity)?|sunny|cloudy)\b/;
function weatherPlan(text, context) {
  // "Forecast for Tokyo": in a weather question, "for" names the place.
  const place = placeOf(text) || placeOf(text.replace(/\bfor\b/, 'in'));
  const named = place?.name || null;
  const here = place?.here ? hereOf(context) : null;
  const hours = hoursOf(text);
  // "The last day" or "24 hours" is yesterday's numbers; two days and more
  // are a run of days.
  const days = hours >= 48 ? Math.min(7, Math.ceil(hours / 24)) : 0;
  const day = days ? 0 : hours >= 24 ? -1 : dayOffset(text);
  const now = !days && day === 0;
  const title = days
    ? tn(days, 'Weather · last {count} day', 'Weather · last {count} days')
    : day < 0
      ? t('Weather yesterday')
      : day > 0
        ? t('Weather tomorrow')
        : t('Weather');
  return plan({
    intent: 'query',
    title: `${title}${named ? ` · ${named}` : here ? ` · ${t('here')}` : ''}`,
    calls: [
      ...(named ? [flyTo(named, 'overview')] : []),
      ...(now ? layersOn(['weather-radar']) : []),
      {
        name: 'get_weather_by_day',
        // The last few days end yesterday; a day is itself.
        args: {
          from_day: days ? -days : day,
          to_day: days ? -1 : day,
          ...(named ? { place: named } : {}),
          ...(here ? { latitude: here.lat, longitude: here.lon } : {}),
        },
        ...(named ? { fill: 'place' } : {}),
      },
    ],
    layers: now ? ['weather-radar'] : [],
    place: named,
  });
}

// "Hi", "thanks", "help": not places to fly to.
const SMALL_TALK =
  /^(help|hi|hello|hey|yo|thanks|thank you|thx|ok|okay|test|testing|yes|no|nope|cool|nice|wow|great|pause|play|hmm+|lol)[?.!]*$/;

// "Where am I": the device's location, never the camera's.
function herePlan(context) {
  const here = (context.chips || []).find((chip) => chip?.kind === 'here');
  if (!here || !Number.isFinite(here.lat) || !Number.isFinite(here.lon))
    return plan({
      intent: 'unknown',
      say: t('I can’t see where you are. Allow location, or name a place.'),
      suggestions: SUGGESTIONS,
    });
  return plan({
    intent: 'action',
    title: t('Here'),
    calls: [
      {
        name: 'fly_to_location',
        args: {
          latitude: here.lat,
          longitude: here.lon,
          viewMode: 'overview',
          rangeM: 25_000,
          waitForArrival: false,
        },
      },
    ],
  });
}

// "Zoom in on it": what was tapped, else the first row of the last answer.
function itPlan(context) {
  const chip = objectChip(context);
  if (chip && Number.isFinite(chip.lat) && Number.isFinite(chip.lon))
    return plan({
      intent: 'action',
      title: chip.label || t('There'),
      calls: [
        {
          name: 'fly_to_location',
          args: {
            latitude: chip.lat,
            longitude: chip.lon,
            viewMode: 'close',
            waitForArrival: false,
          },
        },
      ],
    });
  return therePlan(context);
}

function stylePlan(style) {
  return plan({
    intent: 'action',
    title: t('{style} look', { style: t(STYLE_LABELS[style]) }),
    calls: [{ name: 'set_visual_style', args: { style } }],
  });
}

// "Put me in the cockpit": of what you tapped, else the first row of the
// last answer, else the nearest aircraft.
function cockpitPlan(text, context) {
  const chip = objectChip(context);
  const military =
    /\bmilitary\b/.test(text) ||
    chip?.layerId === 'military' ||
    Boolean(context.lastLayers?.includes('military'));
  const targetLayer = military ? 'military' : 'flights';
  const calls = [...layersOn([targetLayer])];
  if (chip?.id && ['flights', 'military'].includes(chip.layerId))
    calls.push({
      name: 'track_entity',
      args: { query: chip.id, layerId: chip.layerId },
    });
  else if (context.hasRows)
    calls.push({ name: 'track_entity', args: { referent: 1 } });
  calls.push({
    name: 'control_cockpit',
    args: { action: 'enter', targetLayer },
  });
  return plan({
    intent: 'follow',
    title: t('Cockpit'),
    calls,
    layers: [targetLayer],
  });
}

// "Follow a plane near LAX": the airborne aircraft nearest a place, or
// nearest the place an earlier part of the question flew to.
function nearestPlanePlan(text, military, context) {
  const named = placeOf(text)?.name || context.place || null;
  const layerId = military ? 'military' : 'flights';
  return plan({
    intent: 'follow',
    title: `${military ? t('Nearest military aircraft') : t('Nearest aircraft')}${named ? ` · ${named}` : ''}`,
    calls: [
      {
        name: 'select_nearest_aircraft',
        args: { layerId },
        ...(named ? { fill: 'place' } : {}),
      },
    ],
    layers: [layerId],
    place: named,
  });
}

// "Fly me there": to the first thing the last answer listed.
function therePlan(context) {
  if (!context.hasRows)
    return plan({
      intent: 'unknown',
      say: t('Fly where? Ask about something first, then say “fly me there”.'),
      suggestions: SUGGESTIONS,
    });
  return plan({
    intent: 'action',
    title: t('There'),
    calls: [
      {
        name: 'fly_to_location',
        args: {
          referent: 1,
          viewMode: 'overview',
          rangeM: 400_000,
          waitForArrival: false,
        },
      },
    ],
  });
}

// Starlink is the satellites layer's dense catalog: the whole shell.
function starlinkPlan(text = '') {
  const place = placeOf(text);
  const query = {
    layers: ['satellites'],
    scope: { kind: 'anywhere' },
    filters: [{ field: 'name', op: 'contains', value: 'STARLINK' }],
    limit: 50,
  };
  return plan({
    intent: 'query',
    // i18n-ignore: product name
    title: `Starlink${place?.name ? ` · ${place.name}` : ''}`,
    calls: [
      place?.name
        ? flyTo(place.name, 'overview', REGION_RANGE_M)
        : { name: 'zoom_to_globe', args: {} },
      ...layersOn(['satellites']),
      { name: 'set_satellite_catalog', args: { catalog: 'dense' } },
      { name: 'analyst_query', args: query },
    ],
    layers: ['satellites'],
    query,
    place: place?.name || null,
    countSay: msg('{count} Starlink satellites in orbit right now.'),
  });
}

// "X, then Y" and "X? Y.": each part plans on what the part before it left.
// A part keeps its "?" (a question fragment is never a place to fly to), and
// "St. Louis", "Mt. Fuji" or "D.C." are not the end of a sentence.
const PARTS =
  /(?:([?!]|(?<!\b(?:st|mt|ft|dr|mr|mrs|ms|jr|sr|vs|etc|no|[a-z]))\.)\s+|;\s*|,?\s+(?:and\s+)?then\s+|,\s*and\s+(?=(?:enter|switch|put|fly|follow|track|show|make|zoom|mark|turn|go)\b)|,\s*(?=(?:enter|switch|put|fly|follow|track|make|zoom|mark|turn)\b))/i;

// Long enough for any spoken or typed ask; a pasted page plans as its start.
const MAX_QUESTION = 400;
const MAX_PARTS = 4;

function partsOf(raw) {
  const parts = [];
  for (const piece of raw.split(PARTS)) {
    if (piece === undefined) continue;
    if (/^[?!.]$/.test(piece)) {
      if (parts.length) parts[parts.length - 1] += piece;
      continue;
    }
    const part = piece.trim().replace(/^(?:and\s+)?then\s+|^and\s+/i, '');
    if (part) parts.push(part);
  }
  return parts.slice(0, MAX_PARTS);
}

/**
 * Plan one question, which may be several asks in a row ("take me to LAX,
 * follow a plane, then switch to thermal"). Each part plans with what the
 * parts before it will have left: a place, numbered rows, a layer.
 * @param {string} input What the person typed or said.
 * @param {{chips?: Array<object>, here?: {lat:number,lon:number}|null,
 *   zoomedIn?: boolean, hasRows?: boolean, rows?: Array<object>,
 *   unavailable?: Set<string>}} [context] `unavailable` lists the layers
 *   whose key is missing here.
 * @returns {object} A plan; `intent: 'unknown'` carries `say` and suggestions.
 */
export function planQuestion(input, context = {}) {
  const raw = String(input || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_QUESTION);
  const parts = parseSlash(raw) ? [raw] : partsOf(raw);
  if (parts.length <= 1) return planPart(raw, context);
  const plans = [];
  let running = { ...context };
  for (const part of parts) {
    const next = planPart(part, running);
    plans.push(next);
    running = {
      ...running,
      place: next.place || running.place,
      hasRows:
        running.hasRows || Boolean(next.query) || next.intent === 'follow',
      lastLayers: next.layers.length ? next.layers : running.lastLayers,
      zoomedIn: running.zoomedIn || Boolean(next.place),
    };
  }
  const known = plans.filter((entry) => entry.intent !== 'unknown');
  if (!known.length) return plans[0];
  const asked = known.findLast((entry) => entry.query) || null;
  return plan({
    intent: asked ? 'query' : known.at(-1).intent,
    title: known
      .map((entry) => entry.title)
      .filter(Boolean)
      .slice(0, 2)
      .join(' → '),
    // "Is it raining? Show me radar" turns the radar on once.
    calls: known
      .flatMap((entry) => entry.calls)
      .filter(
        (call, i, calls) =>
          call.name !== 'set_layer_visibility' ||
          calls.findIndex(
            (other) =>
              other.name === call.name &&
              other.args.layerId === call.args.layerId &&
              other.args.enabled === call.args.enabled,
          ) === i,
      ),
    layers: [...new Set(known.flatMap((entry) => entry.layers))],
    query: asked?.query || null,
    hours: known.find((entry) => entry.hours)?.hours ?? null,
    place: known.find((entry) => entry.place)?.place ?? null,
    follow: known.findLast((entry) => entry.follow)?.follow ?? null,
    background: asked?.background ?? null,
    lead: asked?.lead ?? null,
    countSay: asked?.countSay ?? null,
    emptySay: asked?.emptySay ?? null,
    standIn: known.find((entry) => entry.standIn)?.standIn ?? null,
  });
}

// What an answer says when its feed loaded fine and holds nothing.
const EMPTY_SAYS = Object.freeze({
  'weather-cyclones': msg(
    'No active cyclones right now. NOAA covers the Atlantic and the eastern and central Pacific.',
  ),
  'rocket-launches': msg('No launches in the feed match that right now.'),
});

// The director's built-in scenes: [what names it, scene id, its title]. The
// catalogs already translate the titles.
const SCENES = Object.freeze([
  [
    /\b(flood|bhote|koshi|nepal)\b/,
    'bhote-koshi-nepal-scene',
    msg('Nepal Flood Incident'),
  ],
  [/\borbital watch\b/, 'orbital-watch', msg('Orbital Watch')],
  [
    /\b(flights radar|global flights)\b/,
    'flights-radar',
    msg('Global Flights Radar'),
  ],
  [/\bthermal threat/, 'thermal-threats', msg('Thermal Threat Board')],
  [/\bcity overload\b/, 'city-overload', msg('City Overload')],
  [/\bomniscience\b/, 'omniscience-pullback', msg('Omniscience Pullback')],
]);

// Everything back as it was before the first question.
function resetPlan() {
  return plan({
    intent: 'action',
    title: t('Back to normal'),
    calls: [{ name: 'chat_reset', args: {} }],
  });
}

const COMMAND_PLANS = {
  reset: () => resetPlan(),
  go: (rest) => goPlan(rest),
  find: (rest, context) => planPart(rest, context),
  follow: (rest, context) => followPlan(rest, context),
  frame: (rest) => framePlan(plain(rest)),
  mark: (rest, context) => markPlan(rest, context),
  passes: (rest, context) => {
    const [, what = '', where = ''] =
      /^(.*?)(?:\s+(?:over|above|from|in|near)\s+(.+))?$/.exec(
        ` ${plain(rest)}`,
      ) || [];
    return passPlan(
      `when does the ${what.trim() || 'iss'} pass${where ? ` over ${where}` : ''}`,
      context,
    );
  },
  look: (rest) => {
    const style = STYLES.find((name) => plain(rest).includes(name));
    return stylePlan(style || 'normal');
  },
  map: (rest) => basemapPlan(basemapOf(plain(rest)) || 'esri-imagery'),
  cameras: (rest, context) => {
    const text = `cameras ${plain(rest)}`;
    return asksForDeviceCameras(text)
      ? deviceCamerasPlan(context)
      : camerasPlan(text);
  },
  radio: (rest) => radioPlan(rest),
  scenes: (rest) =>
    plan({
      intent: 'action',
      title: t('Scenes'),
      calls: [
        {
          name: 'control_scene',
          args: /\b(play|start)\b/.test(plain(rest))
            ? { action: 'play' }
            : { action: 'list' },
        },
      ],
    }),
};

/**
 * A place named in the plan, in the casing it was typed with when that has
 * capitals ("LAX", "the UAE"); planning reads lower-cased text.
 */
// Three capitals a person means as a country or a city.
const NOT_AIRPORTS = new Set(['USA', 'UAE', 'NYC', 'KSA', 'PRC', 'DRC', 'ROK']);

function withTypedCase(planned, raw) {
  const named = planned.place;
  if (!named) return planned;
  const at = raw.toLowerCase().indexOf(named.toLowerCase());
  const typed = at >= 0 ? raw.slice(at, at + named.length) : '';
  if (!typed || typed === typed.toLowerCase() || typed === named)
    return planned;
  // "LAX" is an airport to a person and a Swiss village to a geocoder.
  const airport =
    /^[A-Z]{3}$/.test(typed) && !NOT_AIRPORTS.has(typed)
      ? `${typed} airport`
      : typed;
  const known = airportOf(typed);
  const swap = (value, to = typed) =>
    typeof value === 'string' ? value.split(named).join(to) : value;
  return Object.freeze({
    ...planned,
    title: swap(planned.title),
    place: airport,
    calls: planned.calls.map((call) => {
      if (known && call.name === 'fly_to_location' && call.args.query)
        return {
          ...call,
          args: {
            latitude: known.lat,
            longitude: known.lon,
            viewMode: 'overview',
            rangeM: 40_000,
            waitForArrival: false,
          },
        };
      return {
        ...call,
        args: Object.fromEntries(
          Object.entries(call.args).map(([key, value]) => [
            key,
            key === 'query' || key === 'locationQuery'
              ? swap(value, airport)
              : swap(value),
          ]),
        ),
      };
    }),
  });
}

/**
 * Plan one part of a question.
 * @param {string} input What the person typed or said.
 * @param {{chips?: Array<object>, here?: {lat:number,lon:number}|null,
 *   zoomedIn?: boolean, hasRows?: boolean, rows?: Array<object>}} [context]
 * @returns {object} A plan; `intent: 'unknown'` carries `say` and suggestions.
 */
function planPart(input, context = {}) {
  return withTypedCase(planLowerPart(input, context), String(input || ''));
}

function planLowerPart(input, context = {}) {
  const raw = String(input || '').trim();
  if (!raw)
    return plan({ intent: 'unknown', say: null, suggestions: SUGGESTIONS });
  const slash = parseSlash(raw);
  if (slash) return COMMAND_PLANS[slash.command.id](slash.rest, context);
  const text = plain(raw);

  // An unknown command is not a place.
  if (raw.startsWith('/'))
    return plan({
      intent: 'unknown',
      say: t('There is no such command. Type / to see them all.'),
      suggestions: SUGGESTIONS,
    });

  // The whole ask, so "clear all marks" or "reset the time" mean less.
  if (
    /^(reset( everything| it all| all)?|start over|clean slate|clear (everything|it all|all|the map|the globe)|(put )?(everything )?back to normal|go back to normal)( please| now)?[.!]*$/.test(
      text,
    )
  )
    return resetPlan();
  if (
    /^((reset|clear) (the )?(time|clock|time range|timeline)|(go |back to |switch to )?live( time)?)( please| now)?[.!]*$/.test(
      text,
    )
  )
    return plan({
      intent: 'action',
      title: t('Live'),
      calls: [{ name: 'set_timeline', args: { live: true } }],
    });
  if (/^reset (the )?(view|camera)[.!]*$/.test(text))
    return goPlan('whole earth');

  if (asksForDeviceCameras(text)) return deviceCamerasPlan(context);

  const basemap = BASEMAP_ASK.test(text) && basemapOf(text);
  if (basemap) {
    // "Satellite view of Paris": the map, then the place.
    const of = /\b(?:view|map|imagery) of (.+?)[?.!]*$/.exec(text);
    return basemapPlan(basemap, of ? placeName(of[1]) : placeOf(text)?.name);
  }

  const scene =
    /\b(replay|play|run)\b/.test(text) &&
    SCENES.find(([pattern]) => pattern.test(text));
  if (scene)
    return plan({
      intent: 'action',
      title: t('Replay · {scene}', { scene: t(scene[2]) }),
      calls: [
        // One scene plays at a time.
        { name: 'control_scene', args: { action: 'stop' } },
        {
          name: 'control_scene',
          args: { action: 'play', sceneId: scene[1] },
        },
      ],
    });

  const style =
    STYLES.find((name) => new RegExp(`\\b${name}\\b`).test(text)) ||
    (/\b(normal|regular|default) (view|look|style|mode|colou?rs?)\b|^normal$/.test(
      text,
    )
      ? 'normal'
      : null);
  if (style && !layersOf(text).length) return stylePlan(style);

  if (
    /\b(clear|erase|remove|delete)\b.*\b(marks?|annotations?|pins?|drawings?)\b/.test(
      text,
    )
  )
    return plan({
      intent: 'action',
      title: t('Cleared marks'),
      calls: [{ name: 'clear_annotations', args: {} }],
    });
  if (/^stop (the )?(scenes?|replay|playback|tour)\b/.test(text))
    return plan({
      intent: 'action',
      title: t('Replay stopped'),
      calls: [{ name: 'control_scene', args: { action: 'stop' } }],
    });
  if (/^stop (spinning|orbiting|rotating|moving)\b/.test(text))
    return plan({
      intent: 'action',
      title: t('Camera still'),
      calls: [{ name: 'move_camera', args: { motion: 'stop' } }],
    });
  if (
    /^(stop|unfollow|let (it )?go|release|stop following|stop tracking)\b/.test(
      text,
    )
  )
    return plan({
      intent: 'action',
      title: t('Stopped following'),
      calls: [{ name: 'stop_tracking', args: {} }],
    });
  if (
    /\b(whole|entire) (earth|globe|planet|world)\b/.test(text) ||
    /^(zoom (all the way )?out|show me the (earth|globe|world|planet))$/.test(
      text,
    )
  )
    return goPlan('whole earth');
  const zoom = /^zoom (in|out)(?: a (little|lot))?$/.exec(text);
  if (zoom)
    return plan({
      intent: 'action',
      title: zoom[1] === 'in' ? t('Zoomed in') : t('Zoomed out'),
      calls: [
        {
          name: 'adjust_camera_zoom',
          args: { direction: zoom[1], amount: zoom[2] || 'medium' },
        },
      ],
    });
  if (/^(orbit|spin|circle)\b/.test(text))
    return plan({
      intent: 'action',
      title: t('Orbiting'),
      calls: [
        {
          name: 'move_camera',
          args: { motion: 'orbit', mode: 'continuous', speed: 'slow' },
        },
      ],
    });

  if (/\b(cockpit|pilot'?s seat|ride along|ride with)\b/.test(text))
    return cockpitPlan(text, context);
  const pick =
    /\b(?:follow|track|find|pick|grab|lock on to)\s+(?:a|any|one|some|the nearest)\s+(military\s+)?(?:plane|aircraft|flight|jet|airliner)s?\b/.exec(
      text,
    );
  if (pick) return nearestPlanePlan(text, Boolean(pick[1]), context);
  if (
    /^(?:fly|take) me there\b|^(?:go|fly) there\b|^take me to (?:it|that|the first one)\b/.test(
      text,
    )
  )
    return therePlan(context);
  const follow =
    /^(?:follow|track|chase|lock on(?: to)?|stay with)\b\s*(.*)$/.exec(text);
  if (follow) return followPlan(follow[1], context);

  if (
    (/\b(pass(es)?|fly over|flies over)\b/.test(text) ||
      (/\bwhen\b/.test(text) && /\b(overhead|visible)\b/.test(text))) &&
    /\b(iss|space station|satellite|starlink|hubble|tiangong)\b/.test(text)
  )
    return passPlan(text, context);
  // "Is the ISS visible tonight?" asks for a pass, not a follow.
  if (
    /\b(iss|space station)\b/.test(text) &&
    /\b(visible|see it|spot it|look up)\b/.test(text)
  )
    return passPlan(text, context);
  if (/\bstarlink\b/.test(text)) return starlinkPlan(text);
  if (/\b(iss|space station)\b/.test(text)) return followPlan('iss', context);

  if (
    /\b(emergenc(y|ies)|mayday|squawk(ing)?|7700|7600|7500|hijack(ed|ing)?|distress)\b/.test(
      text,
    )
  )
    return emergencyPlan(text, context);
  if (CAMERA_QUESTION.test(text)) return camerasPlan(text);
  // Police, train or gas stations are not radio.
  if (/\bradio\b|\b(fm|am|music|news) stations?\b/.test(text))
    return radioPlan(
      placeOf(text)?.name ||
        text
          .replace(
            /\b(play|listen to|tune (in )?to|radio|stations?|please|some|the|a|an|music|fm|am|news|from|on)\b/g,
            ' ',
          )
          .replace(/[?!.,]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim(),
    );
  if (/^frame\b/.test(text)) return framePlan(text);
  if (/^(mark|pin|highlight|ring)\b/.test(text))
    return markPlan(
      raw.replace(/^\s*\S+\s*/, '').replace(/^(it|this|that|them)$/i, ''),
      context,
    );

  if (
    WEATHER.test(text) &&
    !/\b(radar|hurricanes?|cyclones?|typhoons?|lightning|air quality)\b/.test(
      text,
    ) &&
    (placeOf(text.replace(/\bfor\b/, 'in')) ||
      dayOffset(text) ||
      /\b(weather|forecast|temperatures?)\b/.test(text))
  )
    return weatherPlan(text, context);

  // A layer whose key is missing here answers through a keyless one.
  const asked = layersOf(text);
  const swap = asked.find(
    (id) => STAND_INS[id] && context.unavailable?.has?.(id),
  );
  const layers = swap
    ? [...new Set(asked.map((id) => (id === swap ? STAND_INS[id] : id)))]
    : asked;
  if (swap)
    return plan({
      ...queryPlan(text, layers, context),
      standIn: { from: swap, to: STAND_INS[swap] },
    });
  if (layers.length === 1 && layers[0] === 'gnss-integrity') {
    const place = placeOf(text);
    if (!place?.name)
      return plan({
        intent: 'query',
        title: t('GPS jamming'),
        calls: [{ name: 'find_gps_jamming', args: {} }],
        layers,
      });
  }
  if (layers.length) return queryPlan(text, layers, context);

  if (
    /^(where am i|show me where i am|take me to my location|my location|find me)[?.!]*$/.test(
      text,
    )
  )
    return herePlan(context);
  if (
    /^what('s| is) (above|over|overhead|up there|flying)( me| here)?[?.!]*$/.test(
      text,
    )
  )
    return queryPlan(`flights over me`, ['flights'], context);
  if (
    /^(?:zoom in on|zoom to|go to|fly to|fly me to|take me to|show me|go) (it|this|that|them|there|the first one)[?.!]*$/.test(
      text,
    )
  )
    return itPlan(context);
  const go =
    /^(?:go to|fly to|take me to|show me|show|zoom to|zoom in on|head to|jump to|find|where is|where's)\s+(.+)$/.exec(
      text,
    );
  if (go) return goPlan(go[1]);
  // Small talk and bare words are not places.
  if (SMALL_TALK.test(text))
    return plan({
      intent: 'unknown',
      say: t(
        'Ask about something on the globe, or type / to see what I can do.',
      ),
      suggestions: SUGGESTIONS,
    });
  // "Police stations in Paris" is shown as Paris.
  if (!/[?]/.test(raw) && text.split(' ').length <= 5)
    return goPlan(placeOf(text)?.name || text);

  return plan({
    intent: 'unknown',
    say: t(
      'I can’t answer that one yet. Try asking about something on the globe.',
    ),
    suggestions: SUGGESTIONS,
  });
}
