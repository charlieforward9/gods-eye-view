import { createStandaloneApplication } from './standalone/application.js';
import { createChatView } from './standalone/chatView.js';
import { describeError } from './standalone/errors.js';
import { t } from './i18n/index.js';

// The Vite boundary exposes only undefined, null, or a validated URL.
const photonSetting = import.meta.env.PHOTON_URL;
const googleApiKey = import.meta.env.GOOGLE_MAPS_API_KEY;
const geospatial =
  photonSetting === undefined ? {} : { endpoints: { photon: photonSetting } };

// Decided before the views render, so a phone never flashes the panels.
const chatView = createChatView({ shell: { googleApiKey, geospatial } });

const application = createStandaloneApplication({
  googleApiKey,
  cesiumToken: import.meta.env.CESIUM_ION_TOKEN,
  geospatial,
  allowQaRegistration: import.meta.env.DEV,
  shouldPersistLayerIntent: chatView.shouldPersistLayerIntent,
});

application.start().then(
  (components) =>
    chatView
      .connect(components)
      .catch((error) => console.error('The chat view failed to start:', error)),
  (error) => {
    console.error("God's Eye View initialization failed:", error);
    const loaderStatus = document.querySelector(
      '#loading-screen .loader-status',
    );
    loaderStatus.textContent = t('Error: {message}', {
      message: describeError(error),
    });
    loaderStatus.style.color = '#ff4444';
  },
);

export { application };
