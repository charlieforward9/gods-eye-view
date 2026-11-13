import { mapChatTool } from '../../voice/mapChatTools.js';
import { greatCircleKm, isGeoPoint } from '../../geoDistance.js';
import { formatNumber, t } from '../../i18n/index.js';

const nearbyLimitKm = 50;

function pointOf({ latitude: lat, longitude: lon }) {
  const point = { lat, lon };
  return isGeoPoint(point) ? point : null;
}

function distanceAnswer(camera, place, km) {
  return km < 1
    ? t('Nearest camera to {place}: {camera}, {distance} m away.', {
        place,
        camera,
        distance: formatNumber(Math.max(10, Math.round(km * 100) * 10)),
      })
    : t('Nearest camera to {place}: {camera}, {distance} km away.', {
        place,
        camera,
        distance: formatNumber(Math.round(km)),
      });
}

async function selectLiveCamera(point, place, ctx, signal) {
  const cctv = ctx.dataManager.layers.get('cctv')?.module;
  const best = await cctv?.findNearestLiveCamera?.(point, {
    signal,
    radiusKm: nearbyLimitKm,
  });
  if (signal?.aborted) return { ok: false, cancelled: true };
  if (!best)
    return {
      ok: false,
      error: place
        ? t('No camera is loaded here yet.')
        : t('No CCTV cameras are available near your location.'),
    };

  const enabled = await ctx.run(
    'set_layer_visibility',
    { layerId: 'cctv', enabled: true },
    { signal },
  );
  if (signal?.aborted) return { ok: false, cancelled: true };
  if (enabled?.ok === false) return enabled;
  await ctx.run('stop_tracking', {}, { signal }).catch(() => {});
  if (signal?.aborted) return { ok: false, cancelled: true };
  const result = await ctx.run(
    'control_cctv',
    { action: 'select', cameraQuery: best.id },
    { signal },
  );
  if (result?.ok === false) return result;
  return {
    ...result,
    say: distanceAnswer(
      result?.activeCamera || best.id,
      place || t('Your location'),
      best.distanceKm,
    ),
  };
}

/**
 * Select a live camera near an explicit place, or the nearest in the map view.
 */
export const nearestCamera = Object.freeze({
  name: 'show_nearest_camera',
  tool: mapChatTool('show_nearest_camera'),
  async run(args, ctx, { signal } = {}) {
    let at = pointOf(args);
    if (!at && args.place)
      at = await ctx.resolvePlace(args.place, { signal }).catch(() => null);
    if (signal?.aborted) return { ok: false, cancelled: true };
    if (args.place && !at)
      return {
        ok: false,
        error: t('Could not find {place}.', { place: args.place }),
      };
    if (at) return selectLiveCamera(at, args.place, ctx, signal);
    await ctx
      .run(
        'set_layer_visibility',
        { layerId: 'cctv', enabled: true },
        { signal },
      )
      .catch(() => {});
    await ctx.camera.arrive(signal);
    if (signal?.aborted) return { ok: false, cancelled: true };
    const ui = ctx.dataManager.layers.get('cctv')?.module?.getUIState?.() || {};
    const from = ctx.viewCenter();
    let best = null;
    let bestKm = Infinity;
    const cameras = ui.cameras || [];
    for (const camera of from ? cameras : []) {
      const km = greatCircleKm(from, camera);
      if (km < bestKm) {
        best = camera;
        bestKm = km;
      }
    }
    // An explicit camera request takes over the map from a followed subject.
    // Leave tracking alone if the layer has no camera to show.
    if (cameras.length) {
      await ctx.run('stop_tracking', {}, { signal }).catch(() => {});
      if (signal?.aborted) return { ok: false, cancelled: true };
    }
    const result = best
      ? await ctx.run(
          'control_cctv',
          { action: 'select', cameraQuery: best.id },
          { signal },
        )
      : await ctx.run('control_cctv', { action: 'nearest' }, { signal });
    if (result?.ok === false) return result;
    const camera = result?.activeCamera || best?.name || best?.id;
    if (!camera)
      return { ok: false, error: t('No camera is loaded here yet.') };
    return {
      ...result,
      ok: true,
      say: t('Nearest camera: {camera}.', { camera }),
    };
  },
});

/** Resolve a device-relative request on the client with the registered CCTV layer. */
export const nearestDeviceCamera = Object.freeze({
  name: 'show_nearest_camera_to_device',
  local: true,
  async run(args, ctx, { signal } = {}) {
    const point = pointOf(args);
    if (!point)
      return {
        ok: false,
        error: t('I can’t see where you are. Allow location, or name a place.'),
      };
    return selectLiveCamera(point, null, ctx, signal);
  },
});
