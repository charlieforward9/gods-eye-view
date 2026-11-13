/**
 * The layers a session can turn on, grouped the way the layer panel groups
 * them, with the live state a pill or a menu row shows and the controls
 * desktop's row has. Pure: reads `dataManager.getAll()` rows and the
 * layers' own row controls, renders nothing.
 */
import { LAYER_GROUPS } from '../data/layerGroups.js';
import { layerSnapshot } from '../data/layerSnapshot.js';
import { msg, t } from '../i18n/index.js';

/** The layer panel's sections, in its order, shared with the panel. */
export const LAYER_CATEGORIES = LAYER_GROUPS;

const CATEGORY_OF = new Map(
  LAYER_CATEGORIES.flatMap((category) =>
    category.ids.map((id) => [id, category.id]),
  ),
);

// What a layer costs while it is on: `stream` animates every frame,
// `view` refetches as the camera moves, `static` loads once, `poll` refreshes
// on a timer. The menu shows it; the kernel keeps streams to one session.
const STREAMS = new Set([
  'flights',
  'military',
  'satellites',
  'ais-live-vessels',
  'local-adsb',
  'traffic',
  'transit',
]);
const VIEW_DRIVEN = new Set([
  'cctv',
  'recent-imagery',
  'street-level',
  'alpr-cameras',
  'military-installations',
  'gnss-integrity',
  'wildlife-sightings',
]);
const STATIC = new Set([
  'telegeography-submarine-cables',
  'local-datacenters',
  'local-dams',
  'sea-marks',
  'ski-pistes',
  // The results of the agent's last OpenStreetMap search; it fetches nothing.
  'osm-places',
]);

/** Short names for the pill and the menu; the panel's names are longer. */
const SHORT_LABELS = Object.freeze({
  flights: msg('Flights'),
  military: msg('Military'),
  satellites: msg('Satellites'),
  'ais-live-vessels': msg('Ships'),
  'local-adsb': msg('Local ADS-B'),
  traffic: msg('Traffic'),
  transit: msg('Transit'),
  bikeshare: msg('Bikeshare'),
  earthquakes: msg('Earthquakes'),
  'local-firms': msg('Fires'),
  'fire-perimeters': msg('Fire perimeters'),
  'rocket-launches': msg('Launches'),
  'gnss-integrity': msg('GPS jamming'),
  's2-ghostmaps': msg('GhostMaps'),
  'wildlife-sightings': msg('Wildlife Sightings'),
  'weather-radar': msg('Rain radar'),
  'weather-satellite': msg('Clouds'),
  'weather-lightning': msg('Lightning'),
  'weather-cyclones': msg('Cyclones'),
  wind: msg('Wind'),
  'air-quality': msg('Air quality'),
  cctv: msg('Cameras'),
  'recent-imagery': msg('Recent imagery'),
  'street-level': msg('Street level'),
  'telegeography-submarine-cables': msg('Undersea cables'),
  'local-datacenters': msg('Datacenters'),
  'local-dams': msg('Dams'),
  'military-installations': msg('Installations'),
  'alpr-cameras': msg('ALPR cameras'),
  'sea-marks': msg('Sea Marks'),
  'ski-pistes': msg('Ski Pistes'),
  directions: msg('Directions'),
  'osm-places': msg('OSM Places'),
  radio: msg('Radio'),
});

// Map tiles drawn over the globe: no records to count or wait for.
const TILE_OVERLAYS = new Set(['sea-marks', 'ski-pistes']);

/** Whether a layer only draws map tiles (nothing to count or query). */
export function drawsTiles(id) {
  return TILE_OVERLAYS.has(id);
}

/** The cost class of one layer. */
export function layerCost(id) {
  if (STREAMS.has(id)) return 'stream';
  if (VIEW_DRIVEN.has(id)) return 'view';
  if (STATIC.has(id)) return 'static';
  return 'poll';
}

/**
 * One layer's live state from its layer row: `off`, `loading`, `live`,
 * `degraded` (stale, fallback or partial) or `connect` (its source is
 * unavailable, usually a missing key).
 */
export function layerState(row, snapshot = layerSnapshot(row)) {
  if (!row?.enabled) {
    return row?.lifecycleState === 'enabling' ? 'loading' : 'off';
  }
  if (row.lifecycleState === 'enabling') return 'loading';
  switch (snapshot.feedState) {
    case 'nominal':
      return 'live';
    case 'loading':
      return 'loading';
    case 'unavailable':
      return 'connect';
    default:
      return 'degraded';
  }
}

const text = (value) => (value == null ? '' : String(value));

// A chip or switch option as the row draws it; what it does stays with the
// layer (data/rowControls.js resolves a tap against the live descriptor).
const chipOf = (chip) =>
  Object.freeze({
    id: text(chip.id),
    label: text(chip.label),
    title: text(chip.title),
    active: Boolean(chip.active),
    disabled: Boolean(chip.disabled),
    busy: Boolean(chip.busy),
    state: chip.state || (chip.active ? 'active' : 'idle'),
    color: chip.color ? text(chip.color) : null,
  });

/**
 * A layer row's controls (its `getRowControls()`) as plain data: the chips,
 * one-of-many switch, slider, legend and info line desktop's row draws under
 * a layer that is on, without the functions that act. Null when there is
 * nothing to draw, or when desktop shows them as a rail readout instead.
 * @param {object|null} controls
 * @returns {object|null}
 */
export function describeControls(controls) {
  if (!controls || controls.readout) return null;
  const chips = (controls.chips || []).map(chipOf);
  const { segmented, slider } = controls;
  const legend = (controls.legend || []).map((item) =>
    Object.freeze({
      color: text(item.color),
      label: text(item.label),
      count: Number.isFinite(item.count) ? item.count : null,
      blurb: text(item.blurb),
    }),
  );
  const info = text(controls.info);
  if (!chips.length && !segmented && !slider && !legend.length && !info)
    return null;
  return Object.freeze({
    chips: Object.freeze(chips),
    segmented: segmented
      ? Object.freeze({
          id: text(segmented.id),
          label: text(segmented.label),
          ariaLabel: text(segmented.ariaLabel || segmented.label),
          options: Object.freeze((segmented.options || []).map(chipOf)),
        })
      : null,
    slider: slider
      ? Object.freeze({
          id: text(slider.id),
          label: text(slider.label),
          ariaLabel: text(slider.ariaLabel),
          valueText: text(slider.valueText),
          min: Number(slider.min),
          max: Number(slider.max),
          step: Number(slider.step ?? 1),
          value: Number(slider.value),
          // A CSS background that paints the track (a color ramp).
          track: slider.track ? text(slider.track) : null,
          ticks: Object.freeze(
            (slider.ticks || []).map((tick) =>
              Object.freeze({ at: Number(tick.at), label: text(tick.label) }),
            ),
          ),
        })
      : null,
    legend: Object.freeze(legend),
    info,
    infoTitle: text(controls.infoTitle),
  });
}

/**
 * Describe every layer a person can turn on, in category order. Layers
 * the panel hides (scene layers, the awareness engine) are not layers.
 * @param {Array<object>} rows `dataManager.getAll()`.
 * @param {{now?: number, controlsOf?: (id: string) => object|null}} [options]
 *   `controlsOf` reads a layer's row controls, for the layers that are on.
 * @returns {Array<object>}
 */
export function describeLayers(
  rows = [],
  { now = Date.now(), controlsOf = () => null } = {},
) {
  const order = new Map(
    LAYER_CATEGORIES.flatMap((category) => category.ids).map((id, i) => [
      id,
      i,
    ]),
  );
  return rows
    .filter((row) => row && row.showInTogglePanel !== false)
    .map((row) => {
      const snapshot = layerSnapshot(row, { now });
      return Object.freeze({
        id: row.id,
        label: layerLabel(row.id, row.name),
        name: row.name || row.id,
        icon: row.icon || '◦',
        category: CATEGORY_OF.get(row.id) || 'other',
        cost: layerCost(row.id),
        keyId: row.requiresKeyId || null,
        enabled: Boolean(row.enabled),
        state: layerState(row, snapshot),
        count: snapshot.count,
        source: snapshot.source,
        error: snapshot.error,
        ageLabel: snapshot.ageLabel,
        controls: row.enabled ? describeControls(controlsOf(row.id)) : null,
      });
    })
    .sort(
      (a, b) =>
        (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
        (order.get(b.id) ?? Number.MAX_SAFE_INTEGER),
    );
}

/** The short label for a layer id, for rows and chips, translated. */
export function layerLabel(id, fallback = id) {
  return SHORT_LABELS[id] ? t(SHORT_LABELS[id]) : fallback;
}

/** The category id a layer belongs to. */
export function layerCategory(id) {
  return CATEGORY_OF.get(id) || 'other';
}
