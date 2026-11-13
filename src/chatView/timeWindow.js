/**
 * The time a session looks at:
 *  - `{mode: 'live'}`: now, every layer as it streams;
 *  - `{mode: 'recent', hours}`: the last N hours, rolling with the clock
 *    (what "in the last 6 hours" asks for);
 *  - `{mode: 'range', fromMs, toMs}`: a fixed window the time track set.
 * Only some layers keep history today; this moves each one that does and
 * reports the rest as live only.
 *  - Earthquakes filter their discs to the window (the layer's params).
 *  - The world clock moves the sky and every layer with a clock source.
 *  - Weather imagery steps to the frame nearest the window's end.
 *  - Analyst questions about timed feeds get the window as filters.
 */
import { formatDate, t } from '../i18n/index.js';
import { voiceLayer } from '../voice/layerManifest.js';
import { timeCoverage, validateTime } from './timelineModel.js';
export {
  seekTime,
  timeBounds,
  timeCoverage,
  validateTime,
} from './timelineModel.js';

const WEATHER = new Set([
  'weather-radar',
  'weather-satellite',
  'weather-lightning',
]);
const WORLD_TIME_LAYERS = new Set(['satellites', 'rocket-launches']);
const HOUR_MS = 3_600_000;
// USGS's day feed holds the last 24 h; a window reaching further loads the
// week's.
const DAY_FEED_MS = 23 * HOUR_MS;

/** Normalize a requested time; anything incomplete is live. */
export function normalizeTime(time, options) {
  return validateTime(time, options).time;
}

export function timeNotice(reason) {
  if (reason === 'no-overlap')
    return t(
      'These event sources have no shared period. Explore them separately.',
    );
  if (reason === 'expired')
    return t(
      'Saved time is no longer available. Showing the nearest available period.',
    );
  if (reason === 'clamped')
    return t('The selected period was limited to available data.');
  if (reason === 'outside')
    return t('That period is outside the available data.');
  if (reason === 'live-only') return t('These layers show live data only.');
  if (reason === 'invalid') return t('Choose a valid date and time.');
  return null;
}

/** The plain timeline snapshot every shell can show and validate against. */
export function timelineFor(options = {}) {
  const coverage = timeCoverage(options);
  const checked = validateTime(options.session?.time, {
    bounds: coverage,
    now: coverage.nowMs,
    // A fixed investigation keeps its requested event dates as data ages.
    // Coverage and the cursor can advance without editing those dates.
    preservePeriod: true,
  });
  const time = checked.time;
  const interval = windowOf(time, coverage.nowMs);
  const world = options.worldClock?.getState?.();
  const cursor =
    world?.timeMs ??
    (time.mode === 'range' && !time.cursorLive
      ? (time.cursorMs ?? time.toMs)
      : coverage.nowMs);
  const bounded =
    coverage.status === 'ready'
      ? Math.max(coverage.startMs, Math.min(coverage.endMs, cursor))
      : cursor;
  return Object.freeze({
    ...coverage,
    time,
    interval: interval ? Object.freeze(interval) : null,
    cursorMs: bounded,
    live: world?.live ?? (time.mode !== 'range' || time.cursorLive === true),
    playback: Boolean(
      world &&
      coverage.layers.some(
        (layer) => layer.kind === 'cursor' && layer.status === 'ready',
      ),
    ),
    playing: Boolean(world?.playing),
    rate: world?.rate ?? 1,
    notice: timeNotice(checked.reason),
  });
}

/** The window a time covers right now, or null for live. */
export function windowOf(time, now = Date.now()) {
  const value = normalizeTime(time);
  if (value.mode === 'recent')
    return { fromMs: now - value.hours * HOUR_MS, toMs: now };
  if (value.mode === 'range') return { fromMs: value.fromMs, toMs: value.toMs };
  return null;
}

/**
 * How a time reads on the timeline and its button: Live, the span a
 * question asked for, or how far back the window ends (a weekday and a time
 * past a day).
 */
export function timeLabel(time, now = Date.now()) {
  const value = normalizeTime(time);
  if (value.mode === 'live') return t('Live');
  if (value.cursorLive) return t('Live');
  if (value.mode === 'recent')
    return value.hours < 1
      ? t('Last {count} min', { count: Math.round(value.hours * 60) })
      : value.hours >= 48
        ? t('Last {count} d', { count: Math.round(value.hours / 24) })
        : t('Last {count} h', { count: value.hours });
  const at = value.cursorMs ?? value.toMs;
  const behind = now - at;
  if (behind < -60_000)
    return formatDate(at, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  if (behind < 60_000) return t('Now');
  if (behind >= 24 * HOUR_MS)
    return formatDate(at, {
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
    });
  const total = Math.round(behind / 60_000);
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  if (!hours) return t('−{minutes} min', { minutes });
  return minutes
    ? t('−{hours} h {minutes} min', { hours, minutes })
    : t('−{hours} h', { hours });
}

/**
 * The same, as short as the narrowest phone's composer needs: "24 h",
 * "−6 h", a weekday past a day. Its button still says the whole of it.
 */
export function shortTimeLabel(time, now = Date.now()) {
  const value = normalizeTime(time);
  if (value.mode === 'live') return t('Live');
  if (value.cursorLive) return t('Live');
  if (value.mode === 'recent')
    return value.hours < 1
      ? t('{count} min', { count: Math.round(value.hours * 60) })
      : value.hours >= 48
        ? t('{count} d', { count: Math.round(value.hours / 24) })
        : t('{count} h', { count: value.hours });
  const at = value.cursorMs ?? value.toMs;
  const behind = now - at;
  if (behind < -60_000)
    return formatDate(at, { month: 'short', day: 'numeric' });
  if (behind < 60_000) return t('Now');
  if (behind >= 24 * HOUR_MS) return formatDate(at, { weekday: 'short' });
  const minutes = Math.round(behind / 60_000);
  return minutes < 60
    ? t('−{minutes} min', { minutes })
    : t('−{hours} h', { hours: Math.round(minutes / 60) });
}

/** The magnitude floor a turn's earthquake question asked for, if any. */
export function magnitudeFloor(query) {
  if (!query?.layers?.includes('earthquakes')) return undefined;
  const floor = (query.filters || []).find(
    (filter) => filter.field === 'magnitude' && /^gte?$/.test(filter.op),
  );
  return floor ? Number(floor.value) : undefined;
}

// Radar and cloud frames stay this close to a moment they stand for.
const FRAME_SLACK_MS = 30 * 60_000;

/**
 * Whether a layer can show the moment a window ends at, for the "live only"
 * tag. Weather imagery holds only its recent frames (`oldestFrameMs`).
 */
export function keepsHistory(
  layerId,
  { range = null, oldestFrameMs, following = [] } = {},
) {
  if (WORLD_TIME_LAYERS.has(layerId)) return true;
  if (WEATHER.has(layerId))
    return (
      !range ||
      !Number.isFinite(oldestFrameMs) ||
      range.toMs >= oldestFrameMs - FRAME_SLACK_MS
    );
  return (
    following.includes(layerId) ||
    Boolean(voiceLayer(layerId)?.query?.timeField)
  );
}

/**
 * Analyst filters that keep a query inside a window, for the layers it asks
 * about that have a time field. Live adds none.
 */
export function rangeFilters(time, layers = [], now = Date.now()) {
  const range = windowOf(time, now);
  if (!range) return [];
  if (!layers.length || !layers.every((id) => voiceLayer(id)?.query?.timeField))
    return [];
  const newest = Math.max(0, (now - range.toMs) / HOUR_MS);
  const oldest = Math.max(0, (now - range.fromMs) / HOUR_MS);
  return [
    ...(newest > 0.01
      ? [
          {
            field: 'ageHours',
            op: 'gte',
            value: Math.round(newest * 100) / 100,
          },
        ]
      : []),
    { field: 'ageHours', op: 'lte', value: Math.round(oldest * 100) / 100 },
  ];
}

/**
 * A question's query inside a window: the window replaces the question's own
 * "last N hours" bound. Live leaves the question as it was asked.
 */
export function queryInRange(query, time, now = Date.now()) {
  if (!query) return null;
  const range = rangeFilters(time, query.layers, now);
  if (!range.length) return query;
  return {
    ...query,
    filters: [
      ...(query.filters || []).filter((filter) => filter.field !== 'ageHours'),
      ...range,
    ],
  };
}

/**
 * Apply a time to the layers that keep history, and the answer's own
 * floor to the globe: a question about M4.5+ shows M4.5+.
 * @param {object} time
 * @param {{dataManager: object, worldClock?: object, weatherClock?: object, requestRender?: Function}} engine
 * @param {number} [now]
 * @param {{minMagnitude?: number}} [floors]
 */
export function applyTime(
  time,
  { dataManager, worldClock, weatherClock, requestRender },
  now = Date.now(),
  { minMagnitude } = {},
) {
  const range = windowOf(time, now);
  const feed = range && now - range.fromMs > DAY_FEED_MS ? 'week' : 'day';
  const before = dataManager.getLayerParams?.('earthquakes')?.feed || 'day';
  // Every key, so a window or a floor this time does not name is cleared.
  dataManager.setLayerParams('earthquakes', {
    fromMs: range?.fromMs ?? null,
    toMs: range?.toMs ?? null,
    minMagnitude: Number.isFinite(minMagnitude) ? minMagnitude : null,
    feed,
  });
  if (feed !== before && dataManager.isEnabled('earthquakes'))
    dataManager.refreshLayer?.('earthquakes');
  if (worldClock) {
    // The shared clock drives weather, the sky and layers with cursor coverage.
    // A fixed session window holds its end even if the panels were playing;
    // a rolling window follows now. No enabled layer is needed to go live:
    // a new session clears its layers before it resets the stage's time.
    if (
      range &&
      normalizeTime(time).mode === 'range' &&
      !normalizeTime(time).cursorLive
    ) {
      worldClock.pause();
      worldClock.seek(normalizeTime(time).cursorMs ?? range.toMs);
    } else worldClock.goLive();
  } else if (
    weatherClock &&
    [...WEATHER].some((id) => dataManager.isEnabled(id))
  ) {
    // A rolling window ends now: the newest frame.
    if (
      range &&
      normalizeTime(time).mode === 'range' &&
      !normalizeTime(time).cursorLive
    )
      weatherClock.setTarget?.(
        new Date(normalizeTime(time).cursorMs ?? range.toMs).toISOString(),
      );
    else weatherClock.latest?.();
  }
  requestRender?.('cv-time');
  return normalizeTime(time);
}
