import '../../../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, h, nextTick, reactive } from 'vue';
import TimeRange from './TimeRange.vue';
import { timelineFor } from '../../../chatView/timeWindow.js';
import { DAY_MS } from '../../../chatView/timelineModel.js';

const NOW = Date.parse('2026-11-10T12:00:00Z');
function mount(
  t,
  {
    time = { mode: 'range', fromMs: NOW - 7 * DAY_MS, toMs: NOW },
    layers = ['earthquakes'],
    sources = {},
    worldState = null,
  } = {},
) {
  document.body.replaceChildren();
  const state = reactive({ time, layers, worldState, now: NOW });
  const sets = [];
  const playback = [];
  const world = {
    coverageFor: (ids) => sources[ids[0]] ?? null,
    ...(worldState ? { getState: () => state.worldState } : {}),
  };
  const app = createApp({
    setup: () => () =>
      h(TimeRange, {
        time: state.time,
        timeline: timelineFor({
          session: {
            time: state.time,
            turns: [{ query: { layers: state.layers } }],
          },
          worldClock: world,
          now: state.now,
        }),
        events: [
          { t: NOW - 30 * DAY_MS },
          { t: NOW + DAY_MS },
          { t: NOW - DAY_MS },
        ],
        onSet: (time) => {
          sets.push(time);
          state.time = time;
        },
        onPlayback: (...args) => playback.push(args),
      }),
  });
  app.mount(document.body.appendChild(document.createElement('div')));
  t.after(() => app.unmount());
  return {
    state,
    sets,
    playback,
    bar: () => document.getElementById('cv-time'),
    input: () => document.querySelector('input[type=range]'),
  };
}
async function change(input, value) {
  input.value = String(value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await nextTick();
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await nextTick();
}

test('a complete week remains selected while the native slider moves its cursor', async (t) => {
  const view = mount(t);
  const input = view.input();
  assert.equal(Number(input.min), NOW - 7 * DAY_MS);
  assert.equal(Number(input.max), NOW);
  input.value = String(NOW - 3 * DAY_MS);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await nextTick();
  assert.equal(view.sets.length, 0, 'drag preview has not changed the world');
  assert.equal(
    view.bar().querySelector('time').getAttribute('datetime'),
    new Date(NOW - 3 * DAY_MS).toISOString(),
  );
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await nextTick();
  assert.equal(view.state.time.cursorMs, NOW - 3 * DAY_MS);
  assert.equal(view.state.time.fromMs, NOW - 7 * DAY_MS);
  assert.equal(view.state.time.toMs, NOW);
  assert.equal(
    view.bar().querySelectorAll('.ev').length,
    1,
    'out-of-domain events do not pile up at the edges',
  );
  await change(view.input(), NOW);
  assert.equal(view.state.time.cursorLive, true);
  assert.equal(
    view.state.time.fromMs,
    NOW - 7 * DAY_MS,
    'live cursor preserves the event period',
  );
});

test('pointer cancellation discards a preview and a secondary button cannot start one', async (t) => {
  const view = mount(t);
  const input = view.input();
  input.dispatchEvent(
    new PointerEvent('pointerdown', {
      bubbles: true,
      pointerId: 1,
      button: 0,
      isPrimary: true,
    }),
  );
  input.value = String(NOW - DAY_MS);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(
    new PointerEvent('pointercancel', { bubbles: true, pointerId: 1 }),
  );
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await nextTick();
  assert.equal(view.sets.length, 0);
  assert.equal(Number(view.input().value), NOW);
  const secondary = new PointerEvent('pointerdown', {
    bubbles: true,
    cancelable: true,
    pointerId: 2,
    button: 2,
    isPrimary: true,
  });
  input.dispatchEvent(secondary);
  assert.equal(secondary.defaultPrevented, true);
});

test('period endpoints are independently editable and invalid endpoints do not commit', async (t) => {
  const view = mount(t);
  const fields = view.bar().querySelectorAll('input[type=datetime-local]');
  const compactTo = view
    .bar()
    .querySelector('summary .cv-time-endpoint:last-child');
  const oldEnd = compactTo.textContent;
  const local = (ms) => {
    const d = new Date(ms);
    const two = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}`;
  };
  // The start of the original complete week has aged out by one second.
  // Editing the end still works, with the uncovered fraction clipped.
  view.state.now += 1000;
  await nextTick();
  fields[1].value = local(NOW - DAY_MS);
  fields[1].dispatchEvent(new Event('change', { bubbles: true }));
  await nextTick();
  assert.equal(view.state.time.fromMs, NOW - 7 * DAY_MS + 1000);
  assert.equal(view.state.time.toMs, NOW - DAY_MS);
  assert.notEqual(
    compactTo.textContent,
    oldEnd,
    'the summary shows the edited end',
  );
  fields[0].value = local(NOW - 6 * DAY_MS);
  fields[0].dispatchEvent(new Event('change', { bubbles: true }));
  await nextTick();
  assert.equal(view.state.time.fromMs, NOW - 6 * DAY_MS);
  assert.equal(view.state.time.toMs, NOW - DAY_MS);
  assert.equal(
    view.state.time.cursorMs,
    NOW,
    'changing the interval did not move the cursor',
  );
  const before = view.sets.length;
  fields[0].value = local(NOW);
  fields[0].dispatchEvent(new Event('change', { bubbles: true }));
  await nextTick();
  assert.equal(view.sets.length, before);
  assert.match(
    view.bar().querySelector('[role=status]').textContent,
    /start must be before/,
  );
  assert.match(
    view.bar().textContent,
    new RegExp(Intl.DateTimeFormat().resolvedOptions().timeZone),
  );
});

test('keyboard endpoints, page steps and event steps stay within source coverage', async (t) => {
  const view = mount(t);
  const key = async (name) => {
    view.input().dispatchEvent(
      new KeyboardEvent('keydown', {
        key: name,
        bubbles: true,
        cancelable: true,
      }),
    );
    await nextTick();
  };
  await key('Home');
  assert.equal(view.state.time.cursorMs, NOW - 7 * DAY_MS);
  await key('ArrowUp');
  assert.equal(view.state.time.cursorMs, NOW - DAY_MS, 'next event mark');
  await key('PageDown');
  assert.ok(view.state.time.cursorMs < NOW - DAY_MS);
  assert.ok(view.state.time.cursorMs >= NOW - 7 * DAY_MS);
  await key('End');
  assert.equal(view.state.time.cursorLive, true);
});

test('editing the event period leaves a live or paused world cursor in its own state', async (t) => {
  const view = mount(t, { time: { mode: 'live' } });
  const all = [...view.bar().querySelectorAll('.cv-time-presets button')].find(
    (button) => button.textContent.includes('All available'),
  );
  all.click();
  await nextTick();
  assert.equal(view.state.time.cursorLive, true);
  await change(view.input(), NOW - 3 * DAY_MS);
  const at = view.state.time.cursorMs;
  const recent = view.bar().querySelector('.cv-time-presets button');
  recent.click();
  await nextTick();
  assert.equal(view.state.time.cursorMs, at);
  assert.equal(view.state.time.cursorLive, undefined);
});

test('the selected source changes the domain; live-only and loading sources have no scrubber', async (t) => {
  const sources = {
    satellites: { start: NOW - 14 * DAY_MS, end: NOW + 14 * DAY_MS, marks: [] },
  };
  const view = mount(t, { sources });
  view.state.layers = ['satellites'];
  await nextTick();
  assert.equal(Number(view.input().max), NOW + 14 * DAY_MS);
  assert.equal(
    view.bar().querySelectorAll('input[type=datetime-local]').length,
    0,
  );
  view.state.layers = ['flights'];
  await nextTick();
  assert.equal(view.input(), null);
  assert.match(view.bar().textContent, /live data only/);
  view.state.layers = ['weather-radar'];
  await nextTick();
  assert.equal(view.input(), null);
  assert.match(view.bar().textContent, /Loading time coverage/);
});

test('playback controls reflect the core clock and send its play, pause and rate intents', async (t) => {
  const view = mount(t, {
    layers: ['satellites'],
    sources: {
      satellites: {
        start: NOW - 14 * DAY_MS,
        end: NOW + 14 * DAY_MS,
        marks: [],
      },
    },
    worldState: { live: false, timeMs: NOW - DAY_MS, playing: false, rate: 1 },
  });
  assert.equal(Number(view.input().value), NOW - DAY_MS);
  view.bar().querySelector('.cv-time-playback button').click();
  assert.deepEqual(view.playback.at(-1), ['play']);
  view.state.worldState.playing = true;
  view.state.worldState.timeMs = NOW + DAY_MS;
  await nextTick();
  assert.equal(
    Number(view.input().value),
    NOW + DAY_MS,
    'the actual core cursor advances the view',
  );
  view.bar().querySelector('.cv-time-playback button').click();
  assert.deepEqual(view.playback.at(-1), ['pause']);
  const rate = view.bar().querySelector('.cv-time-playback select');
  rate.value = '3600';
  rate.dispatchEvent(new Event('change', { bubbles: true }));
  assert.deepEqual(view.playback.at(-1), ['rate', 3600]);
});
