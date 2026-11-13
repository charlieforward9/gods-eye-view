import { createStandalonePlaceSearch } from './placeSearch.js';
import { loadToolCatalog } from './toolCatalog.js';
import { CITY_POIS } from '../cityPois.js';
import { createUiRuntime } from '../ui/vueRuntime.js';
import { MOBILE_SHELL_MEDIA_QUERY } from '../ui/mobileShell.js';
import { useChatViewStore } from '../ui/stores/chatView.js';
import ChatView from '../ui/views/chatView/ChatView.vue';
import { createChatViewKernel } from '../chatView/kernel.js';
import { createChatViewHost } from './chatViewHost.js';
// The chat view's own styles load with it; the rules that hand it the
// screen (chat-view-mode.css) are in the page's stylesheet from the start.
import '../ui/styles/chat-view.css';

// The chat view's shell, loaded the first time it opens (chatView.js): the
// interface renders at once and comes alive when the kernel connects to the
// globe the panels share.

/**
 * @param {{pinia: object, doc?: Document, googleApiKey?: string,
 *   geospatial?: object}} options
 * @returns {{connect: Function, disconnect: Function, unmount: Function}}
 */
export function mountChatShell({
  pinia,
  doc = globalThis.document,
  googleApiKey,
  geospatial = {},
}) {
  const host = doc.createElement('div');
  host.id = 'cv-app';
  // Above the globe and its overlays, below the loading screen.
  doc.body.insertBefore(host, doc.getElementById('loading-screen'));
  const runtime = createUiRuntime({ pinia });
  const unmountView = runtime.mount(ChatView, host);
  const store = useChatViewStore(pinia);

  const placeSearch = createStandalonePlaceSearch({
    presets: CITY_POIS,
    ...geospatial,
    resolveApiKey: () => googleApiKey,
  });
  const geocode = async (query, { signal } = {}) => {
    const { place } = await placeSearch.geocode(query, { signal });
    return place ? { lat: place.lat, lon: place.lng } : null;
  };

  let kernel = null;
  let disconnectStore = null;
  let restoreResolution = null;

  return {
    /**
     * Start the kernel over the globe.
     * @param {object} components The started application's components.
     * @param {{resume?: boolean}} [options] resume restores the open
     *   session's last view (a reload); a switch from the panels keeps the
     *   globe as it is.
     */
    connect(components, { resume = true } = {}) {
      const { viewer } = components.scene;
      // A phone renders at its own density, up to 2x: the stock 1x canvas
      // upscales every plane and label. Above 2x the pixels cost more than
      // the eye can see; a desktop window keeps the panels' resolution.
      if (globalThis.matchMedia?.(MOBILE_SHELL_MEDIA_QUERY).matches) {
        const before = {
          recommended: viewer.useBrowserRecommendedResolution,
          scale: viewer.resolutionScale,
        };
        viewer.useBrowserRecommendedResolution = false;
        viewer.resolutionScale = Math.min(
          1,
          2 / (globalThis.devicePixelRatio || 1),
        );
        restoreResolution = () => {
          viewer.useBrowserRecommendedResolution = before.recommended;
          viewer.resolutionScale = before.scale;
        };
      }
      const { engine, host, agent, storage } = createChatViewHost({
        components,
        doc,
      });
      kernel = createChatViewKernel({
        engine,
        host,
        agent,
        storage,
        geocode,
        loadCatalog: loadToolCatalog,
        hasGoogleKey: Boolean(googleApiKey),
        resume,
      });
      disconnectStore = store.connect(kernel);
      globalThis.__chatView = { components, kernel };
      return kernel;
    },
    /** Hand the globe back to the panels: live time, the panels' resolution. */
    async disconnect() {
      disconnectStore?.();
      disconnectStore = null;
      await kernel?.release();
      kernel?.destroy();
      kernel = null;
      restoreResolution?.();
      restoreResolution = null;
      if (globalThis.__chatView) delete globalThis.__chatView;
    },
    unmount() {
      unmountView();
      host.remove();
    },
  };
}
