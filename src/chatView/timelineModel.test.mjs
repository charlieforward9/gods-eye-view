import test from 'node:test';
import assert from 'node:assert/strict';
import { createSnapshotTimeline } from '../time/snapshotTimeline.js';
import { createWorldClock } from '../time/worldClock.js';
import { timeline, timelineOf } from './capabilities/timeline.js';
import { timelineFor } from './timeWindow.js';
import {
  DAY_MS,
  HOUR_MS,
  seekTime,
  timeCoverage,
  validateTime,
} from './timelineModel.js';

const NOW = Date.parse('2026-11-10T12:00:00Z');
const quakeBounds = {
  status: 'ready',
  startMs: NOW - 7 * DAY_MS,
  endMs: NOW,
  nowMs: NOW,
};
const sessionFor = (layers, time = { mode: 'live' }) => ({
  time,
  turns: [{ query: { layers }, answer: { events: [] } }],
});

test('focused coverage uses only the current investigation and actual core sources', () => {
  const world = createWorldClock({ now: () => NOW });
  world.register({
    id: 'satellites',
    coverage: () => ({ start: NOW - 14 * DAY_MS, end: NOW + 14 * DAY_MS }),
  });
  world.register({
    id: 'rocket-launches',
    coverage: () => ({
      start: NOW - 30 * DAY_MS,
      end: NOW + 10 * DAY_MS,
      marks: [NOW - DAY_MS, NOW + DAY_MS],
    }),
  });
  const rows = [
    { id: 'earthquakes', enabled: true },
    { id: 'satellites', enabled: true },
    { id: 'rocket-launches', enabled: true },
  ];
  const quakes = timeCoverage({
    session: sessionFor(['earthquakes']),
    rows,
    worldClock: world,
    now: NOW,
  });
  assert.equal(quakes.startMs, NOW - 7 * DAY_MS);
  assert.equal(quakes.endMs, NOW);
  const sats = timeCoverage({
    session: sessionFor(['satellites']),
    rows,
    worldClock: world,
    now: NOW,
  });
  assert.equal(sats.endMs, NOW + 14 * DAY_MS);
  const launches = timeCoverage({
    session: sessionFor(['rocket-launches']),
    rows,
    worldClock: world,
    now: NOW,
  });
  assert.equal(launches.startMs, NOW - 30 * DAY_MS);
  assert.deepEqual(launches.marks, [NOW - DAY_MS, NOW + DAY_MS]);
});

test('weather uses observed frames, and an unknown or live feed gets no invented history', () => {
  const world = createWorldClock({ now: () => NOW });
  const weather = () =>
    timeCoverage({
      session: sessionFor(['weather-radar']),
      worldClock: world,
      now: NOW,
    });
  assert.equal(weather().status, 'loading');
  assert.equal(weather().startMs, null);
  world.register({
    id: 'weather-radar',
    coverage: () => ({
      start: NOW - 2 * HOUR_MS,
      end: NOW - 5 * 60_000,
      marks: [NOW - HOUR_MS],
    }),
  });
  assert.equal(weather().startMs, NOW - 2 * HOUR_MS);
  assert.equal(weather().endMs, NOW - 5 * 60_000);
  const flights = timeCoverage({
    session: sessionFor(['flights']),
    worldClock: world,
    now: NOW,
  });
  assert.equal(flights.status, 'live-only');
  assert.equal(flights.startMs, null);
  assert.equal(flights.endMs, null);
  const mixed = timeCoverage({
    session: sessionFor(['earthquakes', 'weather-radar', 'flights']),
    worldClock: world,
    now: NOW,
  });
  assert.equal(
    mixed.startMs,
    NOW - 7 * DAY_MS,
    'union keeps the earthquake history available',
  );
  assert.equal(
    mixed.layers.find((row) => row.id === 'weather-radar').startMs,
    NOW - 2 * HOUR_MS,
  );
  assert.equal(
    mixed.layers.find((row) => row.id === 'flights').status,
    'live-only',
  );
});

test('declared contact timelines drive Chat coverage and the shared cursor', async (t) => {
  const world = createWorldClock({ now: () => NOW });
  const contactIds = ['flights', 'military', 'ais-live-vessels'];
  for (const id of contactIds) {
    await t.test(id, async () => {
      const session = sessionFor([id]);
      const read = () => timelineFor({ session, worldClock: world, now: NOW });
      const span = { start: NOW - 2 * HOUR_MS, end: NOW - HOUR_MS };
      let coverage = null;
      let notifyCoverage;
      const calls = [];
      const follower = createSnapshotTimeline({
        id,
        clock: world,
        source: () => ({
          timeline: {
            coverage: () => coverage,
            stepMs: 1000,
            subscribe(listener) {
              notifyCoverage = listener;
              return () => {};
            },
          },
        }),
        async load(atMs, { replace }) {
          calls.push({ atMs, replace });
          return true;
        },
        clear: () => {},
        resumeLive: () => calls.push('live'),
      });
      try {
        assert.equal(read().status, 'live-only');
        follower.start();
        assert.equal(read().status, 'loading');
        assert.equal(read().layers[0].kind, 'cursor');
        assert.equal(read().playback, false);
        coverage = span;
        notifyCoverage();
        const timeline = read();
        assert.equal(timeline.status, 'ready');
        assert.equal(timeline.startMs, span.start);
        assert.equal(timeline.endMs, span.end);
        assert.equal(timeline.playback, true);
        const at = (span.start + span.end) / 2;
        world.seek(seekTime(session.time, at, timeline).cursorMs);
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(calls, [{ atMs: at, replace: true }]);
        world.goLive();
        assert.deepEqual(calls, [{ atMs: at, replace: true }, 'live']);
      } finally {
        follower.stop();
        world.goLive();
      }
      assert.equal(read().status, 'live-only');
    });
  }
});

test('all input paths share valid bounds, and disjoint requests are rejected', () => {
  for (const bad of [null, '', Infinity, NaN, 9e15]) {
    assert.deepEqual(
      validateTime({ mode: 'range', fromMs: bad, toMs: NOW }).time,
      { mode: 'live' },
    );
  }
  const request = {
    mode: 'range',
    fromMs: NOW - 30 * DAY_MS,
    toMs: NOW - 29 * DAY_MS,
  };
  assert.equal(
    validateTime(request, { bounds: quakeBounds, now: NOW, strict: true })
      .rejected,
    true,
  );
  assert.equal(
    timelineOf(
      {
        from: new Date(request.fromMs).toISOString(),
        to: new Date(request.toMs).toISOString(),
      },
      NOW,
      quakeBounds,
    ),
    null,
  );
  const restored = validateTime(request, { bounds: quakeBounds, now: NOW });
  assert.equal(restored.reason, 'expired');
  assert.ok(restored.time.fromMs >= quakeBounds.startMs);
  assert.ok(restored.time.toMs <= quakeBounds.endMs);
  assert.ok(restored.time.fromMs <= restored.time.toMs);
  assert.equal(
    validateTime(
      { mode: 'recent', hours: 720 },
      { bounds: quakeBounds, now: NOW },
    ).time.hours,
    168,
  );
  assert.equal(
    validateTime(request, { bounds: { status: 'live-only' }, now: NOW }).time
      .mode,
    'live',
  );
});

test('the timeline tool preserves the original request for the kernel adjustment notice', async () => {
  const now = Date.now();
  const bounds = {
    status: 'ready',
    startMs: now - 7 * DAY_MS,
    endMs: now,
    nowMs: now,
  };
  let requested;
  let reason;
  const result = await timeline.run(
    { hours_back: 720 },
    {
      timeline: () => bounds,
      setTime(time) {
        requested = time;
        const checked = validateTime(time, { bounds, now });
        reason = checked.reason;
        return checked.time;
      },
    },
  );
  assert.equal(requested.hours, 720);
  assert.equal(reason, 'clamped');
  assert.equal(result.timeline.hours, 168);
  assert.equal(result.ok, true);
});

test('FIRMS coverage is its loaded 24-hour snapshot, including a fixed source end', () => {
  const session = sessionFor(['local-firms']);
  const unloaded = timeCoverage({
    session,
    rows: [{ id: 'local-firms', enabled: true, stats: { keyRequired: true } }],
    now: NOW,
  });
  assert.equal(unloaded.status, 'live-only');
  assert.equal(unloaded.startMs, null);
  const end = NOW - 3 * DAY_MS;
  const loaded = timeCoverage({
    session,
    rows: [
      { id: 'local-firms', enabled: true, stats: { at: end, lastUpdate: NOW } },
    ],
    now: NOW,
  });
  assert.equal(loaded.startMs, end - DAY_MS);
  assert.equal(loaded.endMs, end);
});

test('mixed event periods use common coverage while the world cursor keeps its wider domain', () => {
  const world = createWorldClock({ now: () => NOW });
  world.register({
    id: 'satellites',
    coverage: () => ({ start: NOW - 14 * DAY_MS, end: NOW + 14 * DAY_MS }),
  });
  const session = sessionFor(['earthquakes', 'local-firms', 'satellites']);
  const rows = [
    { id: 'local-firms', enabled: true, stats: { lastUpdate: NOW } },
  ];
  const coverage = timeCoverage({ session, rows, worldClock: world, now: NOW });
  assert.equal(coverage.startMs, NOW - 14 * DAY_MS);
  assert.equal(coverage.endMs, NOW + 14 * DAY_MS);
  assert.equal(coverage.intervalStartMs, NOW - DAY_MS);
  assert.equal(coverage.intervalEndMs, NOW);
  const selected = validateTime(
    {
      mode: 'range',
      fromMs: NOW - 7 * DAY_MS,
      toMs: NOW,
      cursorMs: NOW + DAY_MS,
    },
    { bounds: coverage, now: NOW },
  );
  assert.equal(selected.time.fromMs, NOW - DAY_MS);
  assert.equal(
    selected.time.cursorMs,
    NOW + DAY_MS,
    'the cursor can still inspect a satellite forecast',
  );
  rows[0].stats.at = NOW - 10 * DAY_MS;
  const disjoint = timeCoverage({ session, rows, worldClock: world, now: NOW });
  assert.equal(disjoint.status, 'unavailable');
  assert.equal(
    validateTime(selected.time, { bounds: disjoint, now: NOW, strict: true })
      .rejected,
    true,
  );
});

test('a complete event interval remains selected while its independent cursor scrubs', () => {
  const time = {
    mode: 'range',
    fromMs: quakeBounds.startMs,
    toMs: quakeBounds.endMs,
  };
  const moved = seekTime(time, NOW - 3 * DAY_MS, quakeBounds);
  assert.equal(moved.fromMs, time.fromMs);
  assert.equal(moved.toMs, time.toMs);
  assert.equal(moved.cursorMs, NOW - 3 * DAY_MS);
  const live = seekTime(moved, NOW, quakeBounds);
  assert.equal(live.cursorLive, true);
  assert.equal(live.fromMs, time.fromMs);
  assert.equal(live.toMs, time.toMs);

  const later = timelineFor({
    session: sessionFor(['earthquakes'], time),
    now: NOW + HOUR_MS,
  });
  assert.equal(later.startMs, time.fromMs + HOUR_MS);
  assert.deepEqual(later.interval, {
    fromMs: time.fromMs,
    toMs: time.toMs,
  });
  const afterCoverageMoves = seekTime(moved, NOW - DAY_MS, later);
  assert.equal(afterCoverageMoves.fromMs, time.fromMs);
  assert.equal(afterCoverageMoves.toMs, time.toMs);
  assert.equal(afterCoverageMoves.cursorMs, NOW - DAY_MS);
});

test('satellite forecasts remain selectable and saved expired periods disclose recovery', () => {
  const world = createWorldClock({ now: () => NOW });
  world.register({
    id: 'satellites',
    coverage: () => ({ start: NOW - 14 * DAY_MS, end: NOW + 14 * DAY_MS }),
  });
  const future = timelineOf(
    {
      from: new Date(NOW + DAY_MS).toISOString(),
      to: new Date(NOW + 2 * DAY_MS).toISOString(),
    },
    NOW,
    timeCoverage({
      session: sessionFor(['satellites']),
      worldClock: world,
      now: NOW,
    }),
  );
  assert.equal(future.toMs, NOW + 2 * DAY_MS);
  const expired = timelineFor({
    session: sessionFor(['earthquakes'], {
      mode: 'range',
      fromMs: NOW - 10 * DAY_MS,
      toMs: NOW - 9 * DAY_MS,
    }),
    now: NOW,
  });
  assert.match(expired.notice, /no longer available/);
  assert.ok(expired.interval.fromMs <= expired.interval.toMs);
  assert.ok(
    expired.cursorMs >= expired.startMs && expired.cursorMs <= expired.endMs,
  );
});
