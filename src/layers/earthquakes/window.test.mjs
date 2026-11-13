import assert from 'node:assert/strict';
import test from 'node:test';
import { createEarthquakesLayer } from './index.js';

// Two events: a small one early and a strong one later.
const ROWS = [
  {
    stableId: 'small',
    usgsId: 'small',
    lon: 30,
    lat: 20,
    depthKm: 3,
    mag: 3,
    place: 'A',
    time: 1000,
  },
  {
    stableId: 'strong',
    usgsId: 'strong',
    lon: 31,
    lat: 21,
    depthKm: 9,
    mag: 6,
    place: 'B',
    time: 5000,
  },
];

function harness(snapshot = () => ROWS) {
  const feeds = [];
  const published = [];
  const viewer = { dataSources: { add() {}, remove() {} } };
  const layer = createEarthquakesLayer({
    source: {
      async getSnapshot(options) {
        feeds.push(options.feed);
        return snapshot(options);
      },
    },
    overlayHost: {
      setEntries: (_source, entries) =>
        published.push(entries.map((entry) => entry.id).sort()),
      setVisible() {},
      clearSource() {},
    },
  });
  layer.init(viewer);
  layer.enable(viewer);
  return { layer, viewer, feeds, shown: () => published.at(-1) };
}

test('a window and a floor filter the discs; a key left out keeps its value, null clears it', async () => {
  const { layer, viewer, feeds, shown } = harness();
  await layer.update(viewer);
  assert.deepEqual(shown(), ['small', 'strong']);

  layer.setParams({ fromMs: 0, toMs: 2000 });
  assert.deepEqual(shown(), ['small']);
  // A floor alone keeps the window.
  layer.setParams({ minMagnitude: 5 });
  assert.deepEqual(shown(), []);
  assert.deepEqual(layer.getParams(), {
    fromMs: 0,
    toMs: 2000,
    minMagnitude: 5,
  });
  // Null clears the window; the floor stays.
  layer.setParams({ fromMs: null, toMs: null });
  assert.deepEqual(shown(), ['strong']);
  layer.setParams({ minMagnitude: null });
  assert.deepEqual(shown(), ['small', 'strong']);
  assert.deepEqual(layer.getParams(), {});

  // The week's feed loads from the next update on, and stays until cleared.
  layer.setParams({ feed: 'week' });
  layer.setParams({ minMagnitude: 4 });
  await layer.update(viewer);
  layer.setParams({ feed: null });
  await layer.update(viewer);
  assert.deepEqual(feeds, ['day', 'week', 'day']);
});

test('switching feeds waits for the requested data and discards a late old refresh', async () => {
  const late = Promise.withResolvers();
  let oldSignal;
  let delayDay = false;
  const { layer, viewer } = harness(({ feed, signal }) => {
    if (feed === 'day' && delayDay) {
      oldSignal = signal;
      return late.promise;
    }
    return feed === 'day' ? ROWS.slice(0, 1) : ROWS;
  });
  assert.equal(await layer.update(viewer), true);
  assert.ok(Number.isFinite(layer.getStats().lastUpdate));
  assert.equal(layer.getStats().count, 1);

  delayDay = true;
  const oldRefresh = layer.update(viewer);
  layer.setParams({ feed: 'week' });
  assert.equal(oldSignal.aborted, true);
  assert.equal(layer.getStats().lastUpdate, null);
  late.resolve(ROWS.slice(0, 1));
  assert.equal(await oldRefresh, false);
  assert.equal(layer.getStats().lastUpdate, null);

  assert.equal(await layer.update(viewer), true);
  assert.ok(Number.isFinite(layer.getStats().lastUpdate));
  assert.equal(layer.getStats().count, 2);
});
