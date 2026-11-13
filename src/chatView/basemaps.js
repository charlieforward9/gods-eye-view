import { keySetupRequirementEnvVars } from '../keySetupCore.mjs';
import { photorealUnavailableReason } from '../maps/availability.js';
import { msg, t } from '../i18n/index.js';

/**
 * The maps under the layers, as the chat view names them: Google 3D, Esri's
 * satellite imagery and OpenStreetMap. The stock app's Bing stacks need an
 * ion token and stay out of the picker; a share that opens on one still
 * shows (nothing lit).
 */
export const BASEMAPS = Object.freeze([
  Object.freeze({ id: 'photoreal', label: msg('3D') }),
  Object.freeze({ id: 'esri-imagery', label: msg('Satellite') }),
  Object.freeze({ id: 'osm', label: msg('Streets') }),
]);

/** A map's chat view name, translated; the stock label for one the picker lacks. */
export function basemapLabel(id, stacks = []) {
  const known = BASEMAPS.find((entry) => entry.id === id);
  if (known) return t(known.label);
  return stacks.find((stack) => stack.id === id)?.label || String(id || '');
}

/** The map the chat view starts on and Reset returns to: 3D when it can load. */
export function homeBasemap(stacks = []) {
  return stacks.find((stack) => stack.id === 'photoreal')?.available
    ? 'photoreal'
    : 'esri-imagery';
}

/**
 * The map picker over the app's map stack controller.
 * @param {{maps: object|null, styleManager: object, hasGoogleKey?: boolean}} options
 */
export function createBasemaps({ maps, styleManager, hasGoogleKey = false }) {
  // Why a map can't load here, in the words of what would fix it.
  const reason = (stack) => {
    if (stack.available) return null;
    if (stack.id !== 'photoreal') return stack.unavailableReason ?? null;
    return hasGoogleKey || maps?.getState?.().hasCesiumIonToken
      ? photorealUnavailableReason(true)
      : t('No {envVars} is set up, so the 3D map can’t load here.', {
          envVars: keySetupRequirementEnvVars('google-maps'),
        });
  };
  return {
    reason,
    activeId: () => maps?.getActiveId?.() ?? null,
    home: () => homeBasemap(maps?.getStacks?.()),
    /** Switch the map; resolves `{ok, say|error}`. */
    async switchTo(id) {
      const stack = maps?.getStacks?.().find((entry) => entry.id === id);
      if (!stack)
        return { ok: false, error: t('That map is not offered here.') };
      if (!stack.available) return { ok: false, error: reason(stack) };
      const result = await styleManager.setMapStack(id);
      if (!result?.ok)
        return {
          ok: false,
          error: result?.error || t('The map did not switch.'),
        };
      return { ok: true, say: t('Map: {map}.', { map: basemapLabel(id) }) };
    },
    /** The picker's rows, or null without a map stack. */
    options() {
      const state = maps?.getState?.();
      if (!state) return null;
      return {
        active: state.activeId,
        options: BASEMAPS.map(({ id }) => state.stacks.find((s) => s.id === id))
          .filter(Boolean)
          .map((stack) =>
            Object.freeze({
              id: stack.id,
              available: stack.available,
              reason: reason(stack),
            }),
          ),
      };
    },
    subscribe: (listener) => maps?.subscribe?.(listener) ?? null,
  };
}
