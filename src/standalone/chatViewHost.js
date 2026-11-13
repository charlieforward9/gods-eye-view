import * as Cesium from 'cesium';
import { governorRequestRender } from '../renderGovernor.js';
import { createView } from '../view/index.js';
import { applyView } from '../app/embed.js';
import { imperialFor } from '../chatView/weather.js';
import { worldClock } from '../time/worldClock.js';

// The page's own events for a tap on the globe, and for letting it go.
const SELECTED = ['gev:awareness-subject-selected', 'gev:entity-selected'];
const CLEARED = [
  'gev:awareness-subject-cleared',
  'gev:entity-selection-cleared',
];

function browserStorage(win) {
  try {
    return win?.localStorage ?? null;
  } catch {
    // Blocked site data throws on the first touch of localStorage.
    return null;
  }
}

/**
 * Put a captured view back on screen. applyView runs every step it is
 * given, so a superseded restore stops at its next step here, and its
 * camera flight ends where it is.
 */
async function restoreView(view, { viewer, dataManager, run, signal }) {
  const model = createView({
    camera: {
      ...view.camera,
      pitch_deg: Math.min(0, view.camera.pitch_deg ?? -90),
    },
    layers: view.layers || [],
    follow: view.follow || null,
  });
  const step = (name, args) =>
    signal?.aborted
      ? Promise.resolve({ ok: false, error: 'superseded' })
      : run(name, args, { signal });
  const land = () => viewer.camera.cancelFlight?.();
  signal?.addEventListener('abort', land, { once: true });
  try {
    return await applyView(model, { viewer, dataManager, run: step, signal });
  } finally {
    signal?.removeEventListener('abort', land);
  }
}

/**
 * The browser side of the chat view's kernel (src/chatView/kernel.js): the
 * ports it reaches the globe and the page through, from the started
 * application's components and this page. A native shell builds its own.
 * @param {{components: object, win?: Window, doc?: Document}} options
 * @returns {{engine: object, host: object, agent: object|null, storage: Storage|null}}
 */
export function createChatViewHost({
  components,
  win = globalThis.window,
  doc = globalThis.document,
}) {
  const { viewer } = components.scene;
  const { dataManager, catalog } = components.data;
  const { styleManager } = components.controls;
  const run = components.tools.voiceCommands.runner;
  const body = doc.body;

  const engine = {
    run,
    dataManager,
    styleManager,
    maps: components.scene.mapStackController ?? null,
    worldClock,
    weatherClock: catalog?.weatherClock ?? null,
    immersion: {
      snapshot: () => styleManager.getImmersiveState?.() ?? null,
      act: (action, args) =>
        styleManager.controlImmersive?.(action, args) ?? { ok: false },
    },
    scenes: () => components.tools.sceneDirector?.listScenes?.() || [],
    camera: {
      onMoveStart: (listener) =>
        viewer.camera.moveStart.addEventListener(listener),
      onMoveEnd: (listener) => viewer.camera.moveEnd.addEventListener(listener),
    },
    restoreView: (view, { signal } = {}) =>
      restoreView(view, { viewer, dataManager, run, signal }),
    requestRender: governorRequestRender,
  };

  const fetchJson = (url, options = {}) =>
    fetch(url, { cache: 'no-store', redirect: 'error', ...options })
      .then((response) => (response.ok ? response.json() : null))
      .catch(() => null);

  const surfaceKey = () =>
    `${body.classList.contains('cockpit-mode')}:${body.classList.contains('ui-clean-view')}`;
  const host = {
    fetchJson,
    geolocate: () =>
      new Promise((resolve) => {
        const geolocation = win.navigator?.geolocation;
        if (!geolocation) return resolve(null);
        geolocation.getCurrentPosition(
          (position) =>
            resolve({
              lat: position.coords.latitude,
              lon: position.coords.longitude,
            }),
          () => resolve(null),
          { timeout: 5000, maximumAge: 600_000 },
        );
      }),
    visible: () => doc.visibilityState !== 'hidden',
    imperial: imperialFor(win.navigator?.language || ''),
    surfaces: {
      cockpit: () => body.classList.contains('cockpit-mode'),
      // Map only is the app's own clean view (its V key).
      mapOnly: () => body.classList.contains('ui-clean-view'),
      subscribe(listener) {
        if (typeof MutationObserver !== 'function') return () => {};
        let before = surfaceKey();
        const observer = new MutationObserver(() => {
          const now = surfaceKey();
          if (now === before) return;
          before = now;
          listener();
        });
        observer.observe(body, {
          attributes: true,
          attributeFilter: ['class'],
        });
        return () => observer.disconnect();
      },
    },
    /** A tap on the globe, with the place it names in degrees. */
    onSelection({ selected, cleared }) {
      const onSelected = (event) => {
        const detail = event.detail || {};
        let lat = Number(detail.latitude);
        let lon = Number(detail.longitude);
        if (
          detail.position &&
          (!Number.isFinite(lat) || !Number.isFinite(lon))
        ) {
          const carto = Cesium.Cartographic.fromCartesian(detail.position);
          if (carto) {
            lat = Cesium.Math.toDegrees(carto.latitude);
            lon = Cesium.Math.toDegrees(carto.longitude);
          }
        }
        selected({
          origin: detail.origin,
          layerId: detail.layerId,
          id: detail.id,
          label: detail.label,
          lat,
          lon,
        });
      };
      for (const type of SELECTED) win.addEventListener(type, onSelected);
      for (const type of CLEARED) win.addEventListener(type, cleared);
      return () => {
        for (const type of SELECTED) win.removeEventListener(type, onSelected);
        for (const type of CLEARED) win.removeEventListener(type, cleared);
      };
    },
    onPageHide(listener) {
      win.addEventListener('pagehide', listener);
      return () => win.removeEventListener('pagehide', listener);
    },
  };

  // Provider choice, authentication and text-session lifetime have the same
  // owner as Panels. The mobile host supplies no provider token or transport.
  const agent = components.tools.voiceCommands;

  return { engine, host, agent, storage: browserStorage(win) };
}
