/**
 * Run a plan against the app's action runner and turn what came back into an
 * answer: one sentence, up to five numbered rows, and the verbs that ran.
 * One question runs at a time; a new one aborts the last through its signal.
 */
import { layerLabel } from './layers.js';
import { basemapLabel } from './basemaps.js';
import { capabilityOf } from './capabilities/index.js';
import { styleLabel } from './planner.js';
import { sourcesOf } from './sources.js';
import { formatNumber, t } from '../i18n/index.js';

const FEET_PER_M = 3.28084;
const KNOTS_PER_MPS = 1.94384;

const number = (value) => (Number.isFinite(value) ? value : null);
const whole = (value) => formatNumber(Math.round(value));

function ago(hours) {
  if (!Number.isFinite(hours)) return null;
  if (hours < 1 / 60) return t('just now');
  if (hours < 1) return t('{count} min ago', { count: Math.round(hours * 60) });
  if (hours < 48) return t('{count} h ago', { count: Math.round(hours) });
  return t('{count} d ago', { count: Math.round(hours / 24) });
}

function aircraftRow(item) {
  const altitude = number(item.altitudeM);
  const speed = number(item.speedMps);
  // The emergency code (7700, UNLAWFUL) stays as the transponder sends it.
  const emergency = item.emergency
    ? `${String(item.emergencyKind || 'emergency').toUpperCase()}${item.squawk ? ` · ${item.squawk}` : ''}`
    : null;
  return {
    title:
      item.callsign ||
      item.registration ||
      String(item.icao24 || item.id).toUpperCase(),
    meta: [
      emergency,
      item.onGround
        ? t('on the ground')
        : altitude !== null
          ? t('{value} ft', {
              value: whole(Math.round((altitude * FEET_PER_M) / 100) * 100),
            })
          : null,
      speed !== null && !item.onGround
        ? t('{value} kt', { value: whole(speed * KNOTS_PER_MPS) })
        : null,
      item.routeOrigin && item.routeDestination
        ? `${item.routeOrigin} → ${item.routeDestination}`
        : item.originCountry || null,
    ],
    alert: Boolean(item.emergency),
    followId: item.icao24 || item.id,
  };
}

const ROWS = {
  flights: aircraftRow,
  military: aircraftRow,
  earthquakes: (item) => ({
    title: `M${Number(item.magnitude).toFixed(1)} ${item.place || ''}`.trim(),
    meta: [
      ago(item.ageHours),
      Number.isFinite(item.depthKm)
        ? t('{value} km deep', { value: whole(item.depthKm) })
        : null,
    ],
    alert: Number(item.magnitude) >= 6,
  }),
  satellites: (item) => ({
    title: item.name || String(item.id),
    meta: [
      Number.isFinite(item.altitudeM)
        ? t('{value} km up', { value: whole(item.altitudeM / 1000) })
        : null,
    ],
    followId: item.name || item.id,
  }),
  'fire-perimeters': (item) => ({
    title: item.name || String(item.id),
    meta: [
      Number.isFinite(item.acres)
        ? t('{value} acres', { value: whole(item.acres) })
        : null,
      Number.isFinite(item.containedPct)
        ? t('{value}% contained', { value: whole(item.containedPct) })
        : null,
      item.state || null,
    ],
    alert: Number(item.acres) >= 50_000,
  }),
  'weather-cyclones': (item) => ({
    title: item.name || String(item.id),
    meta: [
      item.classification || null,
      Number.isFinite(item.windKt)
        ? t('{value} kt', { value: whole(item.windKt) })
        : null,
      item.basin || null,
    ],
    alert: Number(item.windKt) >= 64,
  }),
  'rocket-launches': (item) => ({
    title: item.name || item.missionName || String(item.id),
    meta: [
      Number.isFinite(item.hoursUntil)
        ? item.hoursUntil >= 0
          ? item.hoursUntil < 48
            ? t('in {count} h', { count: Math.round(item.hoursUntil) })
            : t('in {count} d', { count: Math.round(item.hoursUntil / 24) })
          : ago(-item.hoursUntil)
        : null,
      item.provider || null,
      item.launchSite || null,
    ],
  }),
  'weather-day': (item) => ({ title: item.name, meta: [item.detail] }),
  'gnss-region': (item) => ({
    title: item.name,
    meta: [
      t('{degraded} of {total} aircraft degraded', {
        degraded: item.degraded,
        total: item.total,
      }),
    ],
    alert: item.degraded >= 5,
  }),
  'local-firms': (item) => ({
    title: t('{value} MW fire', { value: whole(Number(item.frp) || 0) }),
    meta: [ago(item.ageHours), item.confidence || null],
  }),
};

/** One analyst item as a row: `{layerId, id, title, meta, lat, lon}`. */
/**
 * The analyst's sentence as the chat view says it. The analyst speaks English to the
 * voice agent; "anywhere in the loaded data" is its way to say worldwide.
 */
export function plainSay(say) {
  return typeof say === 'string'
    ? say.replace(/ ?\banywhere in the loaded data\b/, ' worldwide').trim()
    : say;
}

// "Picked UAL2409, 1.3 km from LAX airport, at 1,100 ft." The app's own
// sentence names the place by its coordinates.
function pickedSay(result, place) {
  const aircraft = result.aircraft || {};
  const target = aircraft.callsign || result.label || aircraft.id;
  if (!target) return null;
  const km = Number(aircraft.distanceKm);
  const feet = Number(aircraft.altitudeM) * FEET_PER_M;
  if (place && Number.isFinite(km) && Number.isFinite(feet))
    return t('Picked {target}, {distance} km from {place}, at {altitude} ft.', {
      target,
      distance: formatNumber(Math.round(km * 10) / 10),
      place,
      altitude: whole(feet),
    });
  return t('Picked {target}.', { target });
}

export function rowOf(item, index = 0) {
  const describe =
    ROWS[item.layerKey] ||
    ((entry) => ({
      title: entry.name || entry.label || entry.place || String(entry.id),
      meta: [ago(entry.ageHours)],
    }));
  const row = describe(item);
  return Object.freeze({
    n: index + 1,
    layerId: item.layerKey,
    id: String(item.id),
    title: row.title,
    meta: row.meta.filter(Boolean).join(' · '),
    alert: Boolean(row.alert),
    followId: row.followId ? String(row.followId) : null,
    lat: number(item.lat),
    lon: number(item.lon),
  });
}

/** When each timed item happened, for the dots on the time track. */
export function eventsOf(items = [], now = Date.now()) {
  return items
    .filter((item) => Number.isFinite(item.ageHours))
    .map((item) => ({
      t: now - item.ageHours * 3_600_000,
      alert: Number(item.magnitude) >= 5 || Boolean(item.emergency),
    }));
}

const layerList = (layers = []) =>
  layers.map((id) => layerLabel(id)).join(' + ');

/** A short past-tense verb for each action that ran, for the answer's "Ran" line. */
export function verbOf(name, args = {}, result = {}) {
  switch (name) {
    case 'set_layer_visibility':
      return args.enabled
        ? t('{layer} on', { layer: layerLabel(args.layerId) })
        : t('{layer} off', { layer: layerLabel(args.layerId) });
    case 'fly_to_location':
      if (args.referent) return t('Flew to #{n}', { n: args.referent });
      return args.query
        ? t('Flew to {place}', { place: args.query })
        : t('Flew there');
    case 'zoom_to_globe':
      return t('The whole Earth');
    case 'analyst_query':
      return t('Searched {layers}', { layers: layerList(args.layers) });
    case 'track_entity':
      return t('Following {target}', {
        target: result.label || args.query || `#${args.referent}`,
      });
    case 'stop_tracking':
      return t('Stopped following');
    case 'next_iss_pass':
    case 'next_satellite_pass':
      return t('Computed the pass');
    case 'annotate_map':
      return t('Marked');
    case 'clear_annotations':
      return t('Cleared marks');
    case 'set_visual_style':
      return t('{style} look', { style: styleLabel(args.style) });
    case 'frame_overhead':
      return t('Framed');
    case 'control_cctv':
      return args.action === 'nearest' ? t('Nearest camera') : t('Cameras on');
    case 'show_nearest_camera':
    case 'show_nearest_camera_to_device':
      return t('Nearest camera');
    case 'get_weather':
    case 'get_weather_by_day':
    case 'get_wind':
      return t('Checked the weather');
    case 'set_timeline':
      return args.live ? t('Live') : t('Moved the timeline');
    case 'get_entity_context':
    case 'get_current_view_state':
      return t('Looked at the view');
    case 'search_places':
    case 'places_nearby':
      return t('Searched places');
    case 'plan_route':
      return t('Planned a route');
    case 'control_radio':
      return t('Radio');
    case 'control_scene':
      return t('Played the scene');
    case 'set_satellite_catalog':
      return args.catalog === 'core'
        ? t('{layer} settings', { layer: layerLabel('satellites') })
        : t('Loaded the full catalog');
    case 'find_gps_jamming':
      return t('Checked {count} GPS hotspots', {
        count: result.items?.length ?? 0,
      });
    case 'chat_reset':
      return t('Back to normal');
    case 'chat_basemap':
      return t('{map} map', { map: basemapLabel(args.stack) });
    case 'select_nearest_aircraft':
      return result.label
        ? t('Picked {target}', { target: result.label })
        : t('Picked the nearest aircraft');
    case 'control_cockpit':
      return args.action === 'exit' ? t('Left the cockpit') : t('Cockpit');
    case 'move_camera':
      return args.motion === 'stop' ? t('Camera still') : t('Orbiting');
    case 'adjust_camera_zoom':
      return args.direction === 'in' ? t('Zoomed in') : t('Zoomed out');
    default:
      return name.replace(/_/g, ' ');
  }
}

function passRows(result) {
  if (!result?.riseIso) return [];
  const rise = new Date(result.riseIso);
  const time = rise.toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });
  return [
    Object.freeze({
      n: 1,
      layerId: 'satellites',
      id: result.riseIso,
      title: result.riseDirection
        ? t('Rises at {time} from the {direction}', {
            time,
            // The catalogs hold the 16 compass points (de: NE → NO).
            direction: t(result.riseDirection),
          })
        : t('Rises at {time}', { time }),
      meta: [
        startsIn(result.minutesFromNow),
        t('{count} min overhead', { count: result.durationMin }),
        t('peaks at {degrees}°', { degrees: result.peakElevationDeg }),
        result.visible ? t('visible') : t('not visible to the eye'),
      ].join(' · '),
      alert: false,
      followId: 'ISS',
      lat: null,
      lon: null,
    }),
  ];
}

const FOLLOW_RETRIES = 3;
const FOLLOW_RETRY_MS = 1200;
// No step holds an answer forever: one that stalls (a feed retrying its
// upstream, say) counts as failed and the rest of the plan goes on. The
// longest honest wait is the dense Starlink catalog, up to 25 s.
const STEP_TIMEOUT_MS = 30_000;
// Steps that need their layer's records before they can act.
const FOLLOWS = new Set([
  'track_entity',
  'select_nearest_aircraft',
  'frame_overhead',
  'control_cockpit',
  // A pass is computed from the satellite catalog the layer loads.
  'next_iss_pass',
  'next_satellite_pass',
]);

const withinTime = (work, ms = STEP_TIMEOUT_MS) => {
  let timer;
  const late = new Promise((resolve) => {
    timer = setTimeout(
      () => resolve({ ok: false, error: t('That took too long.') }),
      ms,
    );
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
};

// "in 12 h 31 min" reads better than "in 751 min".
function startsIn(minutes) {
  if (!Number.isFinite(minutes)) return null;
  if (minutes <= 0) return t('passing now');
  if (minutes < 60) return t('in {count} min', { count: minutes });
  return t('in {hours} h {minutes} min', {
    hours: Math.floor(minutes / 60),
    minutes: minutes % 60,
  });
}

// What each kind of step adds after the main answer, when it ran.
const FOLLOW_UPS = Object.freeze({
  fly_to_location: (step, rows) =>
    step.args.referent && rows[0]
      ? t('Flying to {place}.', { place: rows[0].title })
      : null,
  control_cockpit: () => t('You’re in the cockpit.'),
  select_nearest_aircraft: (step) => step.result?.say || null,
  set_visual_style: (step) =>
    t('{style} look on.', { style: styleLabel(step.args.style) }),
});
// The steps whose words are the answer, most telling first.
const MAIN_STEPS = [
  ['analyst_query'],
  ['find_gps_jamming', 'chat_reset', 'get_weather_by_day'],
  ['select_nearest_aircraft', 'track_entity'],
];

/**
 * The answer's sentence: the main finding, then what the later asks did
 * ("…; flying to the first one"). A failure with nothing else to say is
 * the answer.
 */
function sayOf(steps, plan, rows) {
  const done = steps.filter((step) => step.result?.ok !== false);
  const failed = steps.find((step) => step.result?.ok === false);
  let main = null;
  for (const names of MAIN_STEPS) {
    main = done.findLast(
      (step) => names.includes(step.name) && step.result?.say,
    );
    if (main) break;
  }
  // A follow says what it is following; the action has no sentence of its own.
  const followed = done.findLast(
    (step) => step.name === 'track_entity' && !step.result?.say,
  );
  if (!main && followed)
    main = {
      ...followed,
      result: {
        ...followed.result,
        say: t('Following {target}.', {
          target: followed.result.label || followed.args.query || '',
        }),
      },
    };
  main ??= done.findLast((step) => step.result?.say) ?? null;
  if (!main && failed) {
    // An action's own words ("Couldn't find asdfghjkl.") before a bare code.
    const error =
      failed.result.error || failed.result.say || failed.result.code;
    return {
      say: error ? t(String(error)) : t('That did not work.'),
      ok: false,
    };
  }
  const at = main
    ? steps.findIndex(
        (step) => step.name === main.name && step.args === main.args,
      )
    : -1;
  const after = at >= 0 ? steps.slice(at + 1) : [];
  const extra = after
    .filter((step) => step.result?.ok !== false)
    .map((step) => FOLLOW_UPS[step.name]?.(step, rows))
    .filter(Boolean);
  let said = main?.result.say || plan.title || t('Done.');
  if (main?.name === 'analyst_query') {
    const count = main.result.count;
    // "Strongest: M5.3 near Palekastro, Greece. 44 in all." reads better
    // than the count alone when the question asked for the top one.
    if (plan.lead && rows[0]) {
      const top = rows[0].meta
        ? t('{lead}: {top} ({detail}).', {
            lead: plan.lead,
            top: rows[0].title,
            detail: rows[0].meta.split(' · ')[0],
          })
        : t('{lead}: {top}.', { lead: plan.lead, top: rows[0].title });
      said = Number.isFinite(count)
        ? `${top} ${t('{count} in all.', { count: formatNumber(count) })}`
        : top;
    } else if (plan.countSay && Number.isFinite(count))
      said = t(plan.countSay, { count: formatNumber(count) });
  }
  return { say: [said, ...extra].join(' '), ok: !failed };
}

// Rows can come from a capability that lists what it found (the GPS
// sweep's regions, the weather's days) when no analyst query ran.
const listedOf = (steps) =>
  steps.findLast(
    (step) =>
      capabilityOf(step.name) &&
      step.result?.ok !== false &&
      Array.isArray(step.result?.items),
  )?.result.items ?? null;

/**
 * The answer to steps GEV's agent chose: its own sentence, with the rows,
 * verbs, follow and query read from what the steps returned, as for a plan.
 * @param {Array<{name: string, args: object, result: object}>} steps
 * @param {string} say The agent's words; empty falls back to the steps'.
 */
export function answerOfSteps(steps, say) {
  const analyst = steps.findLast(
    (step) => step.name === 'analyst_query' && step.result?.ok !== false,
  );
  const pass = steps.findLast(
    (step) => /_pass$/.test(step.name) && step.result?.ok !== false,
  );
  const tracked = steps.findLast(
    (step) => step.name === 'track_entity' && step.result?.ok !== false,
  );
  const items = analyst?.result?.items || listedOf(steps) || [];
  const rows = pass ? passRows(pass.result) : items.slice(0, 5).map(rowOf);
  const fallback = sayOf(steps, {}, rows);
  return {
    cancelled: false,
    ok: Boolean(say) || fallback.ok,
    say: say || fallback.say,
    issue: null,
    count: Number.isFinite(analyst?.result?.count)
      ? analyst.result.count
      : null,
    caveat: analyst?.result?.display?.caveat || null,
    rows,
    ids: items.map((item) => `${item.layerKey}:${item.id}`),
    events: eventsOf(items),
    verbs: steps
      .filter((step) => step.result?.ok !== false)
      .map((step) => verbOf(step.name, step.args, step.result)),
    follow: tracked
      ? {
          layerId: tracked.result.layerId || tracked.args.layerId || null,
          query: tracked.args.query || tracked.result.label || null,
          label: tracked.result.label || tracked.args.query || null,
        }
      : null,
    query: analyst ? analyst.args : null,
    sources: sourcesOf(steps),
  };
}

/**
 * @param {{run: Function, geocode?: Function}} services `run(name, args,
 *   {signal})` runs the chat view's capabilities and the app's actions
 *   (capabilities/index.js, createStepRunner); `geocode(query, {signal})`
 *   resolves `{lat, lon}` for plans that need a place's coordinates.
 */
export function createAnswerRunner({
  run,
  geocode = async () => null,
  prepare = async () => {},
  issuesFor = () => [],
  describeFor = () => [],
  emptyFor = () => false,
}) {
  let current = null;
  // Answers still running, cancelled ones included: a cancelled answer
  // finishes the step it has in flight before it returns.
  const running = new Set();

  const place = async (plan, signal) => {
    if (!plan.place) return null;
    try {
      return await geocode(plan.place, { signal });
    } catch {
      return null;
    }
  };

  async function answerPlan(plan, { onStep } = {}) {
    current?.abort();
    const controller = new AbortController();
    current = controller;
    const { signal } = controller;
    const steps = [];
    let query = plan.query;
    let coordinates = null;
    for (const call of plan.calls) {
      if (signal.aborted) return { cancelled: true };
      let args = call.args;
      if (call.fill === 'place') {
        coordinates ??= await place(plan, signal);
        if (coordinates)
          args = {
            ...args,
            latitude: coordinates.lat,
            longitude: coordinates.lon,
          };
      }
      onStep?.(verbOf(call.name, args));
      // Following or picking from a layer this plan just turned on
      // waits for its records, as a query does.
      if (FOLLOWS.has(call.name)) {
        const turnedOn = steps
          .filter((step) => step.name === 'set_layer_visibility')
          .map((step) => step.args.layerId);
        if (turnedOn.length) await prepare(turnedOn, { flew: false, signal });
        if (signal.aborted) return { cancelled: true };
      }
      // A layer that just came on has no records until its first
      // fetch lands; asking before then would answer "none".
      if (call.name === 'analyst_query') {
        onStep?.(
          t('Waiting for {layers}', {
            layers: (args.layers || []).map(layerLabel).join(' + '),
          }),
        );
        await prepare(args.layers || [], {
          flew: steps.some((step) => step.name === 'fly_to_location'),
          signal,
        });
        if (signal.aborted) return { cancelled: true };
        onStep?.(verbOf(call.name, args));
      }
      let result;
      // A follow can land before the layer has placed what it names
      // (satellite positions trail their catalog); it tries again briefly.
      for (let attempt = 0; ; attempt += 1) {
        try {
          // `run` takes the chat view's capabilities and the app's actions.
          result = await withinTime(run(call.name, args, { signal }));
        } catch (error) {
          result = { ok: false, error: error?.message || String(error) };
        }
        if (
          result?.ok !== false ||
          !FOLLOWS.has(call.name) ||
          attempt >= FOLLOW_RETRIES ||
          signal.aborted
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, FOLLOW_RETRY_MS));
      }
      // A scene that was not running has nothing to stop.
      if (call.name === 'control_scene' && args.action === 'stop')
        result = { ok: true };
      // A place the region index does not know is searched around its
      // geocoded center instead.
      if (
        call.name === 'analyst_query' &&
        result?.code === 'REGION_UNRESOLVED'
      ) {
        coordinates ??= await place(plan, signal);
        if (coordinates) {
          args = {
            ...args,
            scope: { kind: 'radius', km: 200, center: coordinates },
          };
          query = args;
          result = await withinTime(run(call.name, args, { signal })).catch(
            (error) => ({ ok: false, error: error?.message || String(error) }),
          );
        }
      }
      // the chat view's own words for what the app's actions report.
      if (call.name === 'analyst_query' && result?.say)
        result = { ...result, say: plainSay(result.say) };
      if (call.name === 'select_nearest_aircraft' && result?.ok !== false)
        result = {
          ...result,
          say: pickedSay(result, plan.place) || result.say,
        };
      steps.push({ name: call.name, args, result });
    }
    if (signal.aborted) return { cancelled: true };
    if (current === controller) current = null;
    const analyst = steps.findLast((step) => step.name === 'analyst_query');
    const pass = steps.findLast((step) => /_pass$/.test(step.name));
    const tracked = steps.findLast(
      (step) => step.name === 'track_entity' && step.result?.ok !== false,
    );
    const items = analyst?.result?.items || listedOf(steps) || [];
    const rows = pass ? passRows(pass.result) : items.slice(0, 5).map(rowOf);
    const spoken = pass
      ? pass.result?.ok === false
        ? {
            say: t(String(pass.result.error || 'That did not work.')),
            ok: false,
          }
        : {
            say: rows[0]
              ? t('The ISS: {when}, {detail}.', {
                  when: rows[0].title,
                  detail: rows[0].meta.split(' · ').slice(0, 2).join(', '),
                })
              : t('No pass in the next day.'),
            ok: true,
          }
      : sayOf(steps, plan, rows);
    const count = Number.isFinite(analyst?.result?.count)
      ? analyst.result.count
      : null;
    // A feed in trouble is the answer when it leaves nothing to show: "0
    // aircraft" would claim an empty sky the feed never saw.
    const issues = analyst ? issuesFor(analyst.args.layers || []) : [];
    const blind = Boolean(issues.length) && !items.length;
    // A feed that loaded fine and holds nothing ("no active cyclones")
    // is an answer, not a failure.
    const empty =
      analyst && !blind && !items.length && emptyFor(analyst.args.layers || []);
    // A layer with nothing to count (GPS interference, cables) answers
    // with what it shows once its data lands.
    let shown = [];
    const onlyShows = steps.every((step) =>
      ['set_layer_visibility', 'fly_to_location', 'zoom_to_globe'].includes(
        step.name,
      ),
    );
    if (onlyShows && plan.layers?.length) {
      await prepare(plan.layers, { flew: false, signal });
      if (signal.aborted) return { cancelled: true };
      shown = describeFor(plan.layers);
    }
    return {
      cancelled: false,
      ok: Boolean(spoken.ok || empty) && !blind,
      say: blind
        ? issues[0]
        : empty
          ? t(plan.emptySay || 'Nothing matches that right now.')
          : shown[0] || spoken.say,
      issue: blind ? null : issues[0] || null,
      count,
      caveat: blind ? null : analyst?.result?.display?.caveat || null,
      rows,
      ids: items.map((item) => `${item.layerKey}:${item.id}`),
      events: eventsOf(items),
      verbs: steps
        .filter((step) => step.result?.ok !== false)
        .map((step) => verbOf(step.name, step.args, step.result)),
      follow: tracked
        ? {
            layerId: tracked.result.layerId || tracked.args.layerId || null,
            query: tracked.args.query || tracked.result.label || null,
            label: tracked.result.label || tracked.args.query || null,
          }
        : null,
      query,
      sources: sourcesOf(steps),
    };
  }

  return {
    cancel() {
      current?.abort();
      current = null;
    },

    /** Resolves once every answer, cancelled ones too, has returned. */
    settled() {
      return Promise.all([...running]).then(() => {});
    },

    /**
     * Answer a plan. Resolves `{cancelled: true}` when a newer question took
     * over.
     * @param {object} plan From planQuestion.
     * @param {{onStep?: Function}} [options]
     */
    answer(plan, options) {
      const work = answerPlan(plan, options);
      const done = work.then(
        () => {},
        () => {},
      );
      running.add(done);
      done.then(() => running.delete(done));
      return work;
    },
  };
}
