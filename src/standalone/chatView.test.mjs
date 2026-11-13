import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia } from 'pinia';
import {
  CHAT_VIEW_CLASS,
  UI_MODE_KEY,
  createChatView,
  startingMode,
} from './chatView.js';
import { useChatViewStore } from '../ui/stores/chatView.js';

const at = (href) => new URL(href, 'http://localhost:4173');

test('a visit opens where it was asked to, then where it was left, then in Panels', () => {
  assert.equal(startingMode({ url: at('/?ui=chat') }), 'chat');
  assert.equal(
    startingMode({ url: at('/?ui=panels'), phone: true, stored: 'chat' }),
    'panels',
  );
  assert.equal(startingMode({ url: at('/mob') }), 'chat');
  assert.equal(startingMode({ url: at('/'), stored: 'chat' }), 'chat');
  assert.equal(
    startingMode({ url: at('/'), stored: 'panels', phone: true }),
    'panels',
  );
  assert.equal(startingMode({ url: at('/'), phone: true }), 'panels');
  assert.equal(startingMode({ url: at('/') }), 'panels');
  assert.equal(startingMode({ url: at('/?ui=other') }), 'panels');
  assert.equal(
    startingMode({ url: at('/?embed=1&ui=chat'), phone: true }),
    'panels',
  );
});

function page(href, { phone = false } = {}) {
  const classes = new Set();
  const items = new Map();
  const location = new URL(href, 'http://localhost:4173');
  const win = {
    location,
    history: {
      state: null,
      replaceState(_state, _title, next) {
        const url = new URL(next, location.href);
        location.pathname = url.pathname;
        location.search = url.search;
        location.hash = url.hash;
      },
    },
    matchMedia: () => ({ matches: phone }),
  };
  const doc = {
    body: {
      classList: {
        add: (name) => classes.add(name),
        remove: (name) => classes.delete(name),
        contains: (name) => classes.has(name),
      },
    },
  };
  const storage = {
    getItem: (key) => (items.has(key) ? items.get(key) : null),
    setItem: (key, value) => items.set(key, String(value)),
  };
  return { win, doc, storage, classes, items, location };
}

function fakeShell(log) {
  return async () => ({
    mountChatShell: () => {
      log.push('mount');
      return {
        connect: (_components, { resume }) => {
          log.push(`connect resume=${resume}`);
          return {};
        },
        disconnect: () => log.push('disconnect'),
        unmount: () => log.push('unmount'),
      };
    },
  });
}

test('a phone starts in the chat view on the planet, and the address keeps only the view', async () => {
  const { win, doc, storage, classes, items, location } = page('/mob?x=1', {
    phone: true,
  });
  const log = [];
  const view = createChatView({
    win,
    doc,
    storage,
    pinia: createPinia(),
    load: fakeShell(log),
  });
  assert.ok(classes.has(CHAT_VIEW_CLASS));
  assert.equal(location.pathname, '/');
  assert.equal(location.search, '?x=1');
  assert.match(location.hash, /^#v=2&lat=24&lon=-45/);
  // Starting by screen size remembers nothing.
  assert.equal(items.has(UI_MODE_KEY), false);
  await view.connect({});
  assert.deepEqual(log, ['mount', 'connect resume=true']);
});

test('switching keeps the panels’ saved layers out of the chat view’s hands', async () => {
  const pinia = createPinia();
  const { win, doc, storage, classes, items, location } = page(
    '/?ui=panels#v=2&lat=1',
  );
  const log = [];
  const view = createChatView({
    win,
    doc,
    storage,
    pinia,
    load: fakeShell(log),
  });
  assert.equal(location.search, '');
  assert.equal(location.hash, '#v=2&lat=1');
  assert.equal(items.get(UI_MODE_KEY), 'panels');
  assert.equal(classes.has(CHAT_VIEW_CLASS), false);

  const store = useChatViewStore(pinia);
  assert.equal(store.switchable, false);
  await view.connect({});
  assert.equal(store.switchable, true);
  assert.deepEqual(log, []);

  assert.equal(view.shouldPersistLayerIntent(), true);
  await store.switchTo('chat');
  assert.ok(classes.has(CHAT_VIEW_CLASS));
  assert.equal(items.get(UI_MODE_KEY), 'chat');
  assert.equal(view.shouldPersistLayerIntent(), false);

  await store.switchTo('panels');
  assert.equal(classes.has(CHAT_VIEW_CLASS), false);
  assert.equal(items.get(UI_MODE_KEY), 'panels');
  assert.equal(view.shouldPersistLayerIntent(), true);
  // From the panels the globe stays as it is; leaving hands it back.
  assert.deepEqual(log, [
    'mount',
    'connect resume=false',
    'disconnect',
    'unmount',
  ]);

  // A double tap opens once.
  await Promise.all([store.switchTo('chat'), store.switchTo('chat')]);
  assert.equal(log.filter((entry) => entry.startsWith('connect')).length, 2);
});

test('a failed lazy load gives Panels back and can be retried', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { win, doc, storage, classes, items } = page('/');
  const log = [];
  let attempts = 0;
  const view = createChatView({
    win,
    doc,
    storage,
    pinia: createPinia(),
    load: () => {
      if (++attempts === 1) throw new Error('Chunk unavailable');
      return fakeShell(log)();
    },
  });
  await view.connect({});
  await view.open();
  assert.equal(view.active(), false);
  assert.equal(classes.has(CHAT_VIEW_CLASS), false);
  assert.equal(items.get(UI_MODE_KEY), 'panels');
  await view.open();
  assert.equal(view.active(), true);
  assert.equal(items.get(UI_MODE_KEY), 'chat');
  assert.deepEqual(log, ['mount', 'connect resume=false']);
});

test('the chat view keeps the attribution line on screen, under the whole shell', async () => {
  const { readFile } = await import('node:fs/promises');
  // The screen's rules load with the page, the chat view's own with it.
  const css = (
    await Promise.all(
      ['chat-view-mode.css', 'chat-view.css'].map((name) =>
        readFile(new URL(`../ui/styles/${name}`, import.meta.url), 'utf8'),
      ),
    )
  ).join('\n');
  const block = (selector) => {
    const at = css.indexOf(`${selector} {`);
    assert.ok(at >= 0, selector);
    return css.slice(at, css.indexOf('}', at));
  };
  const credit = block('body.chat-view-mode #cesium-credits#cesium-credits');
  assert.doesNotMatch(credit, /display\s*:\s*none|visibility\s*:\s*hidden/);
  assert.doesNotMatch(credit, /opacity/);
  assert.match(credit, /bottom: var\(--cv-credit-bottom\) !important/);
  // Everything the shell draws stays above the line.
  assert.match(
    css,
    /--cv-bottom: calc\(var\(--cv-credit-bottom\) \+ var\(--cv-credit-space\)\)/,
  );
  for (const selector of ['.cv-bottom', '.cv-panel'])
    assert.match(block(selector), /bottom: var\(--cv-bottom\)/, selector);
  // And the line stacks above the shell's own layer (its drawer's scrim).
  const z = (text) => Number(/z-index:\s*(\d+)/.exec(text)?.[1]);
  assert.ok(z(credit) > z(block('#cv-app')));
});
