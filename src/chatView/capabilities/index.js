/**
 * What the chat view can do beyond the app's own actions, each defined once
 * and reachable two ways: GEV's agent calls it as a tool (when it has a
 * `tool` schema), and the rule planner names it as a step. A `local` one is
 * the chat view's own control (Reset, the map picker): the planner answers
 * it and the agent is never asked.
 *
 * To add one, write it in its own file here and list it below:
 *   {
 *     name,                 // the tool's name and the planner's step name
 *     tool?: {description, parameters},   // offered to GEV's agent
 *     local?: true,         // never the agent's
 *     source?: {id, label, url},          // a provider to credit
 *     run(args, ctx, {signal}),           // resolves like an app action
 *     forAgent?(result),    // what the agent reads, when less than all
 *   }
 * `ctx` is the kernel's capability context (kernel.js, `capabilityContext`).
 */
import { nearestCamera, nearestDeviceCamera } from './cameras.js';
import { basemap, reset } from './controls.js';
import { gpsJamming } from './gpsJamming.js';
import { satelliteCatalog } from './satellites.js';
import { timeline } from './timeline.js';
import { weatherByDay } from './weather.js';

export { TIMELINE_DAYS, timelineOf } from './timeline.js';

export const CAPABILITIES = Object.freeze([
  timeline,
  nearestCamera,
  nearestDeviceCamera,
  weatherByDay,
  gpsJamming,
  satelliteCatalog,
  basemap,
  reset,
]);

const BY_NAME = new Map(CAPABILITIES.map((entry) => [entry.name, entry]));

/** The capability a step names, or null for one of the app's actions. */
export const capabilityOf = (name) => BY_NAME.get(name) ?? null;

/** Whether a step is one of the chat view's own controls. */
export const isLocal = (name) => Boolean(BY_NAME.get(name)?.local);

/** The tools GEV's agent gets on top of the desktop session's. */
export const AGENT_TOOLS = Object.freeze(
  CAPABILITIES.filter((entry) => entry.tool && !entry.local).map((entry) =>
    Object.freeze({ type: 'function', name: entry.name, ...entry.tool }),
  ),
);

/**
 * Run capabilities and app actions alike: `run(name, args, {signal})`
 * resolves a capability's result, with its source, or the app's.
 * @param {object} ctx The capability context.
 * @param {Function} runAction The app's action runner.
 */
export function createStepRunner(ctx, runAction) {
  return async (name, args = {}, options = {}) => {
    const capability = BY_NAME.get(name);
    if (!capability) return runAction(name, args, options);
    const result = await capability.run(args, ctx, options);
    return capability.source && result?.ok !== false
      ? { ...result, source: capability.source }
      : result;
  };
}

/** What the agent reads of a step's result. */
export function forAgent(name, result) {
  const shape = BY_NAME.get(name)?.forAgent;
  return shape && result ? shape(result) : result;
}
