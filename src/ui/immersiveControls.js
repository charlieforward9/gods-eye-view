/**
 * The same first-person controller through a data-and-command surface. A
 * shell gets no camera or layer handle: entry and every turn remain with
 * Cockpit's existing gates, selection, navigation and disposal owners.
 */
import { lookKeyStep } from '../cockpitLook.js';
import { t } from '../i18n/index.js';

const LAYERS = Object.freeze({
  satellite: 'satellites',
  vessel: 'ais-live-vessels',
});
const text = (value) => (value == null ? '' : String(value));
const finite = (value) => (Number.isFinite(value) ? value : null);
const freeze = (value) => {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};

function subjectOf(controller, kind) {
  const info =
    kind === 'satellite'
      ? controller.readSatelliteInfo?.()
      : kind === 'vessel'
        ? controller.readVesselInfo?.()
        : kind === 'aircraft'
          ? controller.readAircraftInfo?.()
          : null;
  if (!info) return null;
  const id = info.noradId ?? info.mmsi ?? info.icao24 ?? info.id;
  if (id == null || !text(id)) return null;
  return {
    kind,
    layerId: LAYERS[kind] ?? text(info.layerId),
    id: text(id),
    label: text(info.name || info.callsign || info.label || id),
  };
}

const sameSubject = (a, b) =>
  Boolean(
    a &&
    b &&
    a.kind === b.kind &&
    a.layerId === b.layerId &&
    text(a.id) === text(b.id),
  );

function entryOf(controller) {
  if (controller.active || controller.destroyed) return null;
  const kind = controller.resolveEntryKind?.();
  const subject = subjectOf(controller, kind);
  if (!subject) return null;
  const enabled =
    kind === 'satellite'
      ? controller.isOrbitEntryAllowed?.()
      : kind === 'vessel'
        ? controller.isBridgeEntryAllowed?.()
        : controller.isEntryAllowed?.();
  return { ...subject, enabled: Boolean(enabled) };
}

function signalsOf(controller) {
  return (controller.signalItems || []).slice(0, 5).map((row) => ({
    key: text(row.key),
    title: text(row.title),
    detail: text(row.detail),
    target: row.target
      ? {
          layerId: text(row.target.layerId),
          id: text(row.target.id),
          label: text(row.target.label || row.title),
        }
      : null,
  }));
}

function satelliteStep(signals, previous) {
  return signals.find(
    (row) =>
      row.target?.layerId === 'satellites' &&
      row.key.startsWith(previous ? 'satellite-return:' : 'satellite:'),
  );
}

/** A bounded, frozen snapshot suitable for structuredClone or JSON. */
export function describeImmersion(controller) {
  const active = Boolean(controller.active && !controller.destroyed);
  const kind = active ? controller.subjectKind : null;
  const subject = active ? subjectOf(controller, kind) : null;
  // Drop working controls as soon as the selected subject disappears, even
  // before the controller's next camera frame ends the old picture.
  const current = Boolean(
    subject &&
    (kind === 'aircraft' || text(controller.subjectId) === subject.id),
  );
  const orbital =
    current && kind === 'satellite'
      ? controller.immersivePresentation?.orbital
      : null;
  const radar =
    current && kind === 'vessel'
      ? controller.immersivePresentation?.radar
      : null;
  const signals = active && current ? signalsOf(controller) : [];
  const navigation =
    current && kind === 'aircraft'
      ? controller.services.militaryAwarenessLayer?.getContextSnapshot?.()
          ?.navigation
      : null;
  const look = orbital?.look;
  const bridgeLook = controller.instruments?.look;
  return freeze({
    active,
    subjectKind: kind,
    subject: current ? subject : null,
    entry: entryOf(controller),
    controls: {
      previous: Boolean(
        navigation?.canPrevious ||
        (kind === 'satellite' && satelliteStep(signals, true)),
      ),
      next: Boolean(
        navigation?.canNext ||
        (kind === 'satellite' && satelliteStep(signals, false)),
      ),
      zoomIn: Boolean(orbital && orbital.zoom < orbital.maxZoom),
      zoomOut: Boolean(orbital && orbital.zoom > 1),
      sensor: Boolean(orbital && Number.isFinite(orbital.sensor?.zoom)),
      nadir: Boolean(orbital && look?.offset),
      look: current && (kind === 'satellite' || kind === 'vessel'),
      radar: Boolean(radar),
    },
    orbital: orbital
      ? {
          zoom: finite(orbital.zoom),
          maxZoom: finite(orbital.maxZoom),
          sensorLabel: text(orbital.sensor?.label),
          look: {
            offset: Boolean(look?.offset),
            readout: text(look?.readout),
            focus: look?.focus
              ? { key: text(look.focus.key), label: text(look.focus.label) }
              : null,
          },
        }
      : null,
    bridge:
      current && kind === 'vessel'
        ? {
            look: {
              offset: Boolean(bridgeLook?.offset),
              readout: text(bridgeLook?.readout),
            },
            rangeLabel: text(radar?.rangeLabel),
            totalContacts: radar?.contacts?.length ?? 0,
            contacts: (radar?.contacts || []).slice(0, 6).map((row) => ({
              id: text(row.id),
              name: text(row.name),
              distanceNm: finite(row.distanceNm),
              stale: Boolean(row.stale),
            })),
          }
        : null,
    signals,
  });
}

const refused = (code, error) => ({ ok: false, code, error });
const unavailable = () =>
  refused('UNAVAILABLE', t('That control is unavailable for this view.'));

/** Execute against current identities, through the existing controller. */
export function controlImmersion(controller, action, args = {}) {
  if (controller.destroyed) return unavailable();
  const state = describeImmersion(controller);
  if (action === 'status') return { ok: true, state };
  if (action === 'enter') {
    if (!sameSubject(state.entry, args))
      return refused('STALE_TARGET', t('The selected target has changed.'));
    if (!state.entry.enabled) return unavailable();
    return { ok: controller.enter({ kind: state.entry.kind }) === true };
  }
  if (!state.active)
    return refused('NOT_ACTIVE', t('The immersive view is no longer active.'));
  // Leaving remains possible after the feed drops its selected subject.
  if (action === 'exit') return { ok: controller.exit() === true };
  if (args.subject && !sameSubject(state.subject, args.subject))
    return refused('STALE_TARGET', t('The ridden target has changed.'));
  if (!state.subject) return unavailable();
  const { controls } = state;
  if (action === 'previous' || action === 'next') {
    if (!controls[action]) return unavailable();
    if (state.subjectKind === 'satellite') {
      const row = satelliteStep(state.signals, action === 'previous');
      return { ok: controller.rideOrbitalSatellite(row.target.id) === true };
    }
    return {
      ok:
        controller.navigateContext(action === 'previous' ? -1 : 1, {
          origin: 'user',
        }) === true,
    };
  }
  const simple = {
    zoomIn: ['zoomIn', () => controller.stepOrbitalZoom(1)],
    zoomOut: ['zoomOut', () => controller.stepOrbitalZoom(-1)],
    sensor: ['sensor', () => controller.jumpToSensorSwath()],
    nadir: ['nadir', () => controller.orbitalNadir()],
    lookAhead: ['look', () => controller.lookAhead()],
    radarRange: [
      'radar',
      () => {
        controller.cycleRadarRange();
        return true;
      },
    ],
  };
  if (simple[action]) {
    const [required, act] = simple[action];
    if (!controls[required]) return unavailable();
    return { ok: act() === true };
  }
  const lookKey = {
    lookLeft: 'ArrowLeft',
    lookRight: 'ArrowRight',
    lookUp: 'ArrowUp',
    lookDown: 'ArrowDown',
  }[action];
  if (lookKey) {
    if (!controls.look) return unavailable();
    const step = lookKeyStep(lookKey);
    return {
      ok:
        (state.subjectKind === 'satellite'
          ? controller.turnOrbitalLook(step)
          : controller.turnLook(step)) === true,
    };
  }
  if (action === 'signal') {
    const row = state.signals.find(
      (row) =>
        row.key === args.key &&
        row.target?.layerId === args.layerId &&
        row.target?.id === text(args.id),
    );
    if (!row)
      return refused('STALE_TARGET', t('That signal is no longer available.'));
    if (state.subjectKind === 'satellite') {
      const ok =
        row.target.layerId === 'satellites'
          ? controller.rideOrbitalSatellite(row.target.id)
          : row.target.layerId === 'military-installations'
            ? controller.toggleOrbitalFocus(row.target.id)
            : false;
      return { ok: ok === true };
    }
    return {
      ok:
        controller.services.militaryAwarenessLayer?.focusTarget?.(
          row.target.layerId,
          row.target.id,
          { origin: 'user' },
        ) === true,
    };
  }
  return refused('UNKNOWN_ACTION', t('Unknown immersive control.'));
}
