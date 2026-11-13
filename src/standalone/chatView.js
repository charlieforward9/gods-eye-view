import { applicationPinia } from '../ui/vueRuntime.js';
import { useChatViewStore } from '../ui/stores/chatView.js';
import { isEmbedded } from '../app/embed.js';

// The chat view is a mode of this page, not a page of its own: one composer
// over the same globe, layers and agent as the panels, a tap away from them
// and back. A switch is remembered on this device, and
// ?ui=chat or ?ui=panels opens either (the old /mob address opens the chat).

/** The body class the chat view owns the screen with (an exclusive surface). */
export const CHAT_VIEW_CLASS = 'chat-view-mode';
export const UI_MODE_KEY = 'gev:ui-mode:v1';
const MODES = new Set(['chat', 'panels']);
const MOB_PATH = /^\/mob\/?$/;
// The chat view opens on the planet; a view in the address is a share
// state, and the start-up flight yields to it.
const PLANET = '#v=2&lat=24&lon=-45&alt=17000000&heading=0&pitch=-90&roll=0';

/**
 * The mode a visit opens in.
 * @param {{url: URL, stored?: string|null}} input
 * @returns {'chat'|'panels'}
 */
export function startingMode({ url, stored = null }) {
  if (isEmbedded(url)) return 'panels';
  const asked = url.searchParams.get('ui');
  if (MODES.has(asked)) return asked;
  if (MOB_PATH.test(url.pathname)) return 'chat';
  if (MODES.has(stored)) return stored;
  return 'panels';
}

function browserStorage(win) {
  try {
    return win?.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Decide the starting mode before the views render, and switch between the
 * chat view and the panels once the globe is up.
 * @param {object} options
 * @param {(options: object) => Promise<{mountChatShell: Function}>} [options.load]
 *   The chat shell's module, loaded the first time the chat view opens.
 * @param {object} [options.shell] Passed through to mountChatShell (keys,
 *   geocoder endpoints).
 * @returns {{shouldPersistLayerIntent: () => boolean, connect: Function,
 *   open: Function, close: Function, active: () => boolean}}
 */
export function createChatView({
  win = globalThis.window,
  doc = globalThis.document,
  storage = browserStorage(win),
  pinia = applicationPinia(),
  load = () => import('./chatViewShell.js'),
  shell: shellOptions = {},
} = {}) {
  const read = () => {
    try {
      return storage?.getItem(UI_MODE_KEY) ?? null;
    } catch {
      return null;
    }
  };
  const remember = (mode) => {
    try {
      storage?.setItem(UI_MODE_KEY, mode);
    } catch {
      // A private window keeps the choice to this visit.
    }
  };

  const url = new URL(win.location.href);
  const embedded = isEmbedded(url);
  const asked = url.searchParams.get('ui');
  let active =
    startingMode({
      url,
      stored: read(),
    }) === 'chat';
  if (!embedded && MODES.has(asked)) remember(asked);
  // The address keeps the view, not the mode: the mode is remembered.
  if (
    !embedded &&
    (url.searchParams.has('ui') || MOB_PATH.test(url.pathname))
  ) {
    url.searchParams.delete('ui');
    if (MOB_PATH.test(url.pathname)) url.pathname = '/';
    win.history.replaceState(
      win.history.state,
      '',
      `${url.pathname}${url.search}${url.hash}`,
    );
  }
  if (active) {
    doc.body.classList.add(CHAT_VIEW_CLASS);
    if (!win.location.hash)
      win.history.replaceState(
        win.history.state,
        '',
        `${win.location.pathname}${win.location.search}${PLANET}`,
      );
  }

  const store = useChatViewStore(pinia);
  let components = null;
  let shell = null;
  let kernel = null;
  // Opens and closes run one after another, so a double tap never races.
  let lane = Promise.resolve();
  const queue = (task) => {
    lane = lane.then(task, task);
    return lane;
  };
  const mountShell = () => {
    shell ??= Promise.resolve()
      .then(load)
      .then((module) => module.mountChatShell({ pinia, doc, ...shellOptions }))
      .catch((error) => {
        shell = null;
        active = false;
        remember('panels');
        doc.body.classList.remove(CHAT_VIEW_CLASS);
        throw error;
      });
    return shell;
  };
  // Start the requested or remembered shell while the globe loads.
  if (active)
    void mountShell().catch((error) =>
      console.error('Chat view failed to load:', error),
    );

  const attach = async (resume) => {
    const mounted = await mountShell();
    if (!active || !components || kernel) return;
    kernel = mounted.connect(components, { resume });
  };
  const detach = async () => {
    const mounted = shell && (await shell);
    kernel = null;
    await mounted?.disconnect();
    shell = null;
    mounted?.unmount();
  };

  function open() {
    return queue(async () => {
      if (embedded) return;
      if (active && kernel) return;
      active = true;
      doc.body.classList.add(CHAT_VIEW_CLASS);
      // The globe stays as the panels left it; the open session goes on from there.
      try {
        await attach(false);
        remember('chat');
      } catch (error) {
        console.error('Chat view failed to open:', error);
      }
    });
  }
  function close() {
    return queue(async () => {
      if (!active) return;
      await detach();
      active = false;
      remember('panels');
      doc.body.classList.remove(CHAT_VIEW_CLASS);
    });
  }

  return {
    shouldPersistLayerIntent: () => !active,
    active: () => active,
    open,
    close,
    /** The globe is up: the switch works from here on. */
    connect(started) {
      if (embedded) return Promise.resolve();
      components = started;
      store.offerSwitch({ open, close });
      // A reload picks the open session back up where its last answer left it.
      if (active) return queue(() => attach(true));
      return Promise.resolve();
    },
  };
}
