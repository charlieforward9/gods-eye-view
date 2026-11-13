/**
 * The view an answer leaves on screen, captured so tapping that question
 * later puts it back: camera, layers, the followed object and the time
 * range. Putting it back is the host's (`engine.restoreView`, in
 * src/standalone/chatViewHost.js): the embed view applier drives the app's
 * own actions and turns off layers the view does not use.
 */

const FOLLOW_KINDS = Object.freeze({
  flights: 'aircraft',
  military: 'military_aircraft',
  satellites: 'satellite',
});

/**
 * @param {{styleManager: object, dataManager: object, follow?: object|null,
 *   time?: object}} sources
 * @returns {object|null} A JSON-safe view, or null before the camera exists.
 */
export function captureView({
  styleManager,
  dataManager,
  follow = null,
  time,
}) {
  const camera = styleManager.getCameraState?.();
  if (!camera) return null;
  return {
    camera: {
      lat: camera.lat,
      lon: camera.lon,
      altitude_m: camera.alt,
      heading_deg: camera.heading,
      pitch_deg: camera.pitch,
    },
    layers: [...dataManager.getEnabledLayerIds()],
    follow:
      follow?.query && FOLLOW_KINDS[follow.layerId]
        ? { kind: FOLLOW_KINDS[follow.layerId], id: follow.query }
        : null,
    time: time ? { ...time } : { mode: 'live' },
  };
}
