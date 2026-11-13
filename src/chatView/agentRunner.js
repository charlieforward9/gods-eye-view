/**
 * How GEV's agent's tool calls run in the chat view: the chat view's own
 * capabilities and the app's actions through one step runner, with the
 * places the chat view knows filled in, analyst questions kept inside the
 * timeline's window, and panel-only actions declined (the chat view shows
 * no panels).
 */
import { plainSay } from './answers.js';
import { PANEL_ONLY_ACTIONS } from './commands.js';
import { airportOf, regionOf } from './planner.js';
import { queryInRange } from './timeWindow.js';

// The planner's "fly me there" uses this regional view too. A bare point
// otherwise reaches the shared navigator's 250 m landmark close-up, which
// cannot frame a quake or the surrounding geography. Explicit close-ups
// and distances still belong to the caller.
const RESULT_OVERVIEW_RANGE_M = 400_000;

const NO_PANELS = Object.freeze({
  ok: false,
  code: 'NOT_IN_CHAT_VIEW',
  error:
    'The chat view shows no panels. Turn layers on with set_layer_visibility; the person can switch to the panels from the top right.',
});

// The analyst speaks to the voice agent; its "anywhere in the loaded data"
// reads as "worldwide" here, for the agent to repeat.
const plainAnalyst = (result) =>
  result && typeof result === 'object'
    ? {
        ...result,
        say: plainSay(result.say),
        scopeLabel: plainSay(result.scopeLabel),
      }
    : result;

/**
 * @param {{steps: Function, resolvePlace: Function, time: () => object}} options
 *   `steps(name, args, {signal})` runs a capability or an app action;
 *   `time()` is the open session's timeline.
 */
export function createAgentRunner({ steps, resolvePlace, time }) {
  // The catalog names places through the server's Nominatim, which is off
  // unless configured; the page's own place search (bundled places,
  // airports, regions, Photon) turns a named location into coordinates
  // first. A named area does too when its size is known here.
  const placed = async (args, signal) => {
    const out = { ...args };
    // An airport code or a named region is a point the chat view knows:
    // "LAX" is the airport, not the Swiss village a geocoder finds.
    const known = (name) => airportOf(name) || regionOf(name);
    if (typeof args?.query === 'string' && known(args.query)) {
      const at = known(args.query);
      delete out.query;
      Object.assign(out, {
        latitude: at.lat,
        longitude: at.lon,
        viewMode: 'overview',
        rangeM: at.km
          ? Math.min(12_000_000, Math.max(300_000, at.km * 2600))
          : 40_000,
      });
    }
    if (typeof args?.locationQuery === 'string' && known(args.locationQuery)) {
      const at = known(args.locationQuery);
      delete out.locationQuery;
      Object.assign(out, { latitude: at.lat, longitude: at.lon });
    }
    for (const key of ['location', 'area']) {
      const value = args?.[key];
      if (!value?.place || value.lat != null || value.bbox) continue;
      const region = regionOf(value.place);
      const at =
        region ||
        (key === 'location'
          ? await resolvePlace(value.place, { signal }).catch(() => null)
          : null);
      if (!at) continue;
      out[key] =
        key === 'location'
          ? { lat: at.lat, lon: at.lon }
          : { lat: at.lat, lon: at.lon, radius_km: Math.min(region.km, 2000) };
    }
    return out;
  };

  return async function run(name, args, options = {}) {
    if (PANEL_ONLY_ACTIONS.includes(name) || name === 'show_data_layers_menu')
      return NO_PANELS;
    // The timeline is the main control: a query about timed feeds answers
    // inside the window it shows.
    if (name === 'analyst_query') args = queryInRange(args, time()) || args;
    const resolved = await placed(args, options.signal);
    if (
      name === 'fly_to_location' &&
      resolved.rangeM == null &&
      resolved.viewMode !== 'close' &&
      (resolved.referent != null ||
        (Number.isFinite(resolved.latitude) &&
          Number.isFinite(resolved.longitude)))
    ) {
      resolved.viewMode = 'overview';
      resolved.rangeM = RESULT_OVERVIEW_RANGE_M;
    }
    const result = await steps(name, resolved, options);
    if (name !== 'analyst_query') return result;
    // A region the analyst's index does not hold is searched around its
    // center, as the planner's answers do.
    if (result?.code === 'REGION_UNRESOLVED' && args.scope?.name) {
      const at =
        regionOf(args.scope.name) ||
        (await resolvePlace(args.scope.name, {
          signal: options.signal,
        }).catch(() => null));
      if (at)
        return plainAnalyst(
          await steps(
            name,
            {
              ...args,
              scope: {
                kind: 'radius',
                km: Math.min(at.km || 200, 2000),
                center: { lat: at.lat, lon: at.lon },
              },
            },
            options,
          ),
        );
    }
    return plainAnalyst(result);
  };
}
