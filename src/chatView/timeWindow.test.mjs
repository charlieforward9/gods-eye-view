import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorldClock } from '../time/worldClock.js';
import { createWeatherClock } from '../layers/weather/clock.js';
import { applyTime, keepsHistory } from './timeWindow.js';

const NOW = Date.parse('2026-11-10T12:00:00Z');
const END = NOW - 3_600_000;
const RANGE = { mode: 'range', fromMs: END - 3_600_000, toMs: END };

function dataManager(enabled = []) {
  return {
    getLayerParams: () => ({}),
    setLayerParams: () => true,
    isEnabled: (id) => enabled.includes(id),
    refreshLayer: () => {},
  };
}

test('a fixed session time holds the shared world without an enabled weather layer', () => {
  const world = createWorldClock({
    now: () => NOW,
    follow: ['satellites', 'rocket-launches'],
  });
  const engine = {
    dataManager: dataManager(['satellites', 'rocket-launches']),
    worldClock: world,
  };
  world.play({ continuous: true });
  applyTime(RANGE, engine, NOW);
  assert.equal(world.isPlaying(), false);
  assert.equal(world.isLive(), false);
  assert.equal(world.timeFor('satellites')(), END);
  assert.equal(world.timeFor('rocket-launches')(), END);

  applyTime({ mode: 'live' }, engine, NOW);
  assert.equal(world.isLive(), true);
  assert.equal(world.now(), NOW);

  applyTime(RANGE, engine, NOW);
  applyTime({ mode: 'recent', hours: 6 }, engine, NOW);
  assert.equal(world.isLive(), true, 'a rolling window ends at live time');
});

test('weather follows the shared session time and returns to its latest frame', async (t) => {
  const world = createWorldClock({ now: () => NOW });
  const weather = createWeatherClock({ world, now: () => NOW });
  t.after(() => weather.destroy());
  const earlier = new Date(END).toISOString();
  const latest = new Date(NOW).toISOString();
  let shown = null;
  weather.register({
    id: 'weather-radar',
    maxGapMs: 30 * 60_000,
    getTimes: () => [earlier, latest],
    isSuspended: () => false,
    getShownTime: () => shown,
    apply: async (time) => {
      shown = time;
    },
  });
  const engine = {
    dataManager: dataManager(['weather-radar']),
    worldClock: world,
    weatherClock: weather,
  };
  applyTime(RANGE, engine, NOW);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(shown, earlier);
  applyTime({ mode: 'live' }, engine, NOW);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(shown, latest);
});

test('a host with only a weather clock keeps the existing time controls', () => {
  const calls = [];
  const engine = {
    dataManager: dataManager(['weather-radar']),
    weatherClock: {
      setTarget: (time) => calls.push(time),
      latest: () => calls.push('live'),
    },
  };
  applyTime(RANGE, engine, NOW);
  applyTime({ mode: 'live' }, engine, NOW);
  assert.deepEqual(calls, [new Date(END).toISOString(), 'live']);
});

test('contact sources without a timeline stay live only', () => {
  assert.equal(keepsHistory('satellites'), true);
  assert.equal(keepsHistory('rocket-launches'), true);
  assert.equal(keepsHistory('flights'), false);
  assert.equal(keepsHistory('ais-live-vessels'), false);
  const following = ['flights', 'military', 'ais-live-vessels'];
  for (const id of following)
    assert.equal(keepsHistory(id, { following }), true);
  assert.equal(
    keepsHistory('weather-radar', {
      range: RANGE,
      oldestFrameMs: NOW,
    }),
    false,
    'weather still needs an observed frame near the selected time',
  );
});
