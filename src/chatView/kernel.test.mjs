import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatViewKernel } from './kernel.js';
import { INTENTS } from './intents.js';
import { OPEN_METEO } from './sources.js';
import { seekTime } from './timeWindow.js';
import { call, fakeRealtime, say } from '../testSupport/fakeRealtime.mjs';
import { createWorldClock } from '../time/worldClock.js';
import { createProviderTextAgent } from '../voice/textAgent.js';
import { CLOUD_VOICE_AUTH_STORAGE_KEY } from '../voice/cloudVoiceAuth.js';

function realtimeProvider(realtime, tools = []) {
  const selection = { provider: 'openai', subscribeProvider: () => () => {} };
  return {
    ...selection,
    createTextAgent(options) {
      return createProviderTextAgent({
        ...options,
        selection,
        storage: {
          getItem: (key) =>
            key === CLOUD_VOICE_AUTH_STORAGE_KEY ? 'oauth' : null,
        },
        fetchImpl: async () =>
          Response.json({ value: 't', session: { model: 'm', tools } }),
        connect: realtime.connect,
      });
    },
  };
}
import { createSessionStore } from './sessions.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function until(check, ms = 4000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const memory = () => {
  const items = new Map();
  return {
    items,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => items.set(key, String(value)),
    removeItem: (key) => items.delete(key),
  };
};

const flight = (id, altitudeM) => ({
  layerKey: 'flights',
  id,
  callsign: id.toUpperCase(),
  altitudeM,
  lat: 30,
  lon: -95,
});
const quake = (id, magnitude) => ({
  layerKey: 'earthquakes',
  id,
  magnitude,
  place: 'near Tokyo',
  ageHours: 2,
  lat: 35,
  lon: 139,
});

// The globe as the kernel's ports see it: actions answer from `results`
// (a value or a function), layers live in memory, and the camera stops when
// the test says so.
function fakeEngine(results = {}) {
  const calls = [];
  const enabled = new Set();
  const params = [];
  const stops = new Set();
  const row = (id) => ({
    id,
    name: id,
    enabled: enabled.has(id),
    stats: { lastUpdate: Date.now(), count: 3 },
  });
  const ids = ['flights', 'military', 'earthquakes', 'weather-radar', 'cctv'];
  const dataManager = {
    layers: new Map(),
    getAll: () => ids.map(row),
    isEnabled: (id) => enabled.has(id),
    isEffectivelyEnabled: (id) => enabled.has(id),
    getEnabledLayerIds: () => [...enabled],
    setLayerParams: (id, value, options = {}) => {
      params.push([id, value, options.origin]);
      return true;
    },
    getLayerParams: () => ({}),
    refreshLayer: () => {},
    subscribe: () => () => {},
  };
  const run = async (name, args = {}, options = {}) => {
    calls.push([name, args]);
    if (name === 'set_layer_visibility') {
      if (args.enabled === false) enabled.delete(args.layerId);
      else enabled.add(args.layerId);
    }
    const answer = results[name];
    const result =
      typeof answer === 'function' ? await answer(args, options) : answer;
    return result ?? { ok: true };
  };
  const views = [];
  return {
    calls,
    enabled,
    params,
    views,
    names: () => calls.map(([name]) => name),
    // The camera lands: every answer waiting to take its view takes it.
    land: () => [...stops].forEach((listener) => listener()),
    engine: {
      run,
      dataManager,
      styleManager: {
        getCameraState: () => ({
          lat: 30,
          lon: -97,
          alt: 900_000,
          heading: 0,
          pitch: -90,
        }),
        getVisualState: () => ({ style: 'normal' }),
        setMapStack: async () => ({ ok: true }),
        toggleCleanView: () => {},
      },
      maps: null,
      weatherClock: null,
      scenes: () => [],
      camera: {
        onMoveStart: () => () => {},
        onMoveEnd: (listener) => {
          stops.add(listener);
          return () => stops.delete(listener);
        },
      },
      restoreView: async (view) => {
        views.push(view);
      },
      requestRender: () => {},
    },
  };
}

function fakeHost(json = {}) {
  const fetched = [];
  return {
    fetched,
    host: {
      fetchJson: async (url) => {
        fetched.push(url);
        const path = url.split('?')[0];
        return json[path] ?? null;
      },
      geolocate: async () => null,
      visible: () => true,
      imperial: false,
      surfaces: {
        cockpit: () => false,
        mapOnly: () => false,
        subscribe: () => () => {},
      },
      onSelection: () => () => {},
      onPageHide: () => () => {},
    },
  };
}

function start({
  results,
  json,
  agent = null,
  storage = memory(),
  worldClock = null,
} = {}) {
  const fake = fakeEngine(results);
  fake.engine.worldClock = worldClock;
  const page = fakeHost(json);
  const kernel = createChatViewKernel({
    engine: fake.engine,
    host: page.host,
    agent,
    storage,
    geocode: async (query) =>
      /miami/i.test(query) ? { lat: 25.76, lon: -80.19 } : null,
  });
  let latest = null;
  kernel.subscribe((snapshot) => {
    latest = snapshot;
  });
  const lastTurn = () => latest?.session?.turns.at(-1) ?? null;
  // Asks, waits for the answer, then lets the camera land.
  const ask = async (text, chips) => {
    const before = latest?.session?.turns.length ?? 0;
    const asked = kernel.act('ask', text, chips);
    await until(
      () =>
        (latest?.session?.turns.length ?? 0) > before &&
        lastTurn().status !== 'running',
    );
    fake.land();
    await asked;
    await tick();
    return lastTurn();
  };
  return { kernel, fake, page, storage, ask, lastTurn, snapshot: () => latest };
}

test('every intent is one the kernel runs, and nothing else is', async () => {
  const { kernel } = start();
  assert.deepEqual(kernel.intents, INTENTS);
  for (const name of INTENTS)
    await assert.doesNotReject(kernel.act(name), name);
  await assert.rejects(kernel.act('openPanel'), /Unknown chat view intent/);
  kernel.destroy();
});

test('a snapshot is plain data, and keeps what did not change', async () => {
  const { kernel, ask } = start({
    results: {
      analyst_query: {
        ok: true,
        count: 2,
        items: [flight('a', 9000), flight('b', 8000)],
      },
    },
  });
  await ask('What’s flying over the Gulf of Mexico?');
  await ask('Earthquakes above 4.5 in the last 24 hours');
  const playing = kernel.act('play');
  await until(() => kernel.snapshot().playing);
  const during = kernel.snapshot();
  // Across a message bridge: no functions, controllers or cycles.
  assert.deepEqual(structuredClone(during), during);
  assert.deepEqual(JSON.parse(JSON.stringify(during)), during);
  assert.deepEqual(Object.keys(during.playing).sort(), [
    'index',
    'total',
    'turnId',
  ]);
  await kernel.act('stop');
  await playing;

  const before = kernel.snapshot();
  const again = kernel.snapshot();
  assert.equal(again.sessions, before.sessions);
  assert.equal(again.session, before.session);
  assert.equal(again.layers, before.layers);
  await kernel.act('setGroupBy', 'layers');
  assert.equal(kernel.snapshot().sessions, before.sessions);
  await kernel.act('renameSession', before.activeId, 'Gulf');
  assert.notEqual(kernel.snapshot().sessions, before.sessions);
  assert.equal(kernel.snapshot().session.title, 'Gulf');
  kernel.destroy();
});

test('the planner answers when no agent is set up: rows, title, time and view', async () => {
  const { kernel, fake, ask, snapshot } = start({
    results: {
      analyst_query: {
        ok: true,
        count: 2,
        items: [quake('us1', 5.2), quake('us2', 4.7)],
      },
    },
  });
  const turn = await ask('Earthquakes above 4.5 in the last 24 hours');
  assert.equal(turn.status, 'done');
  assert.equal(turn.answer.ok, true);
  assert.equal(turn.answer.rows.length, 2);
  assert.ok(turn.hasView);
  assert.deepEqual(snapshot().session.time, { mode: 'recent', hours: 24 });
  assert.notEqual(snapshot().session.title, 'New session');
  assert.ok(fake.enabled.has('earthquakes'));
  // The window and the answer's floor reach the layer.
  const [, last] = fake.params.findLast(([id]) => id === 'earthquakes');
  assert.equal(last.minMagnitude, 4.5);
  assert.ok(Number.isFinite(last.fromMs) && Number.isFinite(last.toMs));
  kernel.destroy();
});

test('GEV’s agent answers, a /command reaches it with its actions, and Reset stays the chat view’s', async () => {
  const realtime = fakeRealtime([
    [
      call('analyst_query', {
        layers: ['flights'],
        scope: { kind: 'anywhere' },
      }),
    ],
    [say('2 aircraft over Texas.')],
    [say('The highest is A.')],
  ]);
  const { kernel, fake, ask } = start({
    results: {
      analyst_query: {
        ok: true,
        count: 2,
        items: [flight('a', 9000), flight('b', 8000)],
      },
    },
    agent: realtimeProvider(realtime, [
      { type: 'function', name: 'analyst_query' },
    ]),
  });
  const turn = await ask('What is flying over Texas?');
  assert.equal(turn.answer.say, '2 aircraft over Texas.');
  assert.equal(turn.answer.rows.length, 2);
  const update = realtime.sent.find((event) => event.type === 'session.update');
  assert.ok(
    [
      'set_timeline',
      'get_weather_by_day',
      'find_gps_jamming',
      'set_satellite_catalog',
    ].every((name) => update.session.tools.some((tool) => tool.name === name)),
  );
  assert.ok(!update.session.tools.some((tool) => tool.name === 'chat_reset'));

  const userText = () =>
    realtime.sent.filter((event) => event.item?.role === 'user').at(-1).item
      .content[0].text;
  await ask('/find the highest flights over Texas');
  assert.match(
    userText(),
    /picked the Find command; it answers with analyst_query/,
  );
  assert.match(userText(), /\nFind the highest flights over Texas$/);

  const sentBefore = realtime.sent.filter(
    (event) => event.item?.role === 'user',
  ).length;
  const reset = await ask('/reset');
  assert.equal(reset.answer.ok, true);
  assert.ok(fake.names().includes('zoom_to_globe'));
  assert.equal(
    realtime.sent.filter((event) => event.item?.role === 'user').length,
    sentBefore,
  );
  kernel.destroy();
});

test('a provider failure after zooming preserves the partial result without replaying the planner', async () => {
  const selection = {
    provider: 'openai',
    authMode: 'api-key',
    subscribeProvider: () => () => {},
  };
  let requests = 0;
  const port = {
    ...selection,
    createTextAgent(options) {
      return createProviderTextAgent({
        ...options,
        selection,
        fetchImpl: async () =>
          ++requests === 1
            ? Response.json({
                content: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 'zoom',
                      type: 'function',
                      function: {
                        name: 'adjust_camera_zoom',
                        arguments: '{"direction":"in"}',
                      },
                    },
                  ],
                },
              })
            : Response.json({ code: 'RATE_LIMITED' }, { status: 429 }),
      });
    },
  };
  const { kernel, fake, ask } = start({ agent: port });
  try {
    const turn = await ask('zoom in');
    assert.equal(
      fake.calls.filter(([name]) => name === 'adjust_camera_zoom').length,
      1,
    );
    assert.equal(turn.answer.ok, false);
    assert.equal(turn.answer.partial, true);
    assert.match(turn.answer.say, /Too many chat requests/);
    assert.equal(
      turn.title,
      null,
      'the completed agent action was not rerun as a planner answer',
    );
    assert.equal(kernel.snapshot().provider.status, 'unavailable');
  } finally {
    kernel.destroy();
  }
});

test('stop is stopped at once, and the answer in flight never lands', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { kernel, lastTurn, snapshot } = start({
    results: {
      analyst_query: async () => {
        await gate;
        return { ok: true, count: 1, items: [flight('late', 1000)] };
      },
    },
  });
  const asked = kernel.act('ask', 'What’s flying over the Gulf of Mexico?');
  await until(() => snapshot()?.busy);
  await kernel.act('stop');
  assert.equal(kernel.snapshot().busy, null);
  assert.equal(kernel.snapshot().session.turns.at(-1).status, 'cancelled');
  release();
  await asked;
  await tick();
  assert.equal(lastTurn().status, 'cancelled');
  assert.equal(lastTurn().answer, null);
  kernel.destroy();
});

test('a seed starts from a clean stage and asks its question when opened', async () => {
  const { kernel, fake, snapshot, lastTurn } = start({
    results: { analyst_query: { ok: true, count: 0, items: [] } },
  });
  await fake.engine.run('set_layer_visibility', {
    layerId: 'weather-radar',
    enabled: true,
  });
  const seed = snapshot().sessions.find(
    (entry) => entry.title === 'Emergencies right now',
  );
  const opened = kernel.act('openSession', seed.id);
  await until(() => lastTurn()?.status === 'done');
  fake.land();
  await opened;
  assert.equal(fake.enabled.has('weather-radar'), false);
  assert.equal(lastTurn().q, 'Any emergencies?');
  assert.equal(snapshot().session.pending, 0);
  kernel.destroy();
});

test('a past answer keeps its own coverage and filters when scrubbed after a newer live question', async (t) => {
  const world = createWorldClock();
  const { kernel, fake, ask, snapshot } = start({
    worldClock: world,
    results: {
      analyst_query: { ok: true, count: 1, items: [quake('us1', 5)] },
    },
  });
  t.after(() => kernel.destroy());
  const first = await ask('Earthquakes above 4.5 in the last 24 hours');
  await ask('What’s flying over the Gulf of Mexico?');
  assert.deepEqual(snapshot().session.time, { mode: 'live' });
  await kernel.act('restoreTurn', first.id);
  assert.deepEqual(fake.views.at(-1).time, { mode: 'recent', hours: 24 });
  assert.deepEqual(snapshot().session.time, { mode: 'recent', hours: 24 });
  const cursorMs = Date.now() - 7_200_000;
  await kernel.act('setTime', {
    mode: 'range',
    fromMs: cursorMs - 3_600_000,
    toMs: cursorMs + 3_600_000,
    cursorMs,
  });
  assert.equal(world.isLive(), false);
  assert.equal(world.now(), cursorMs);
  assert.deepEqual(
    snapshot().timeline.layers.map((layer) => layer.id),
    ['earthquakes'],
  );
  const quakeParams = fake.params.findLast(([id]) => id === 'earthquakes')[1];
  assert.equal(quakeParams.minMagnitude, 4.5);
  assert.equal(quakeParams.fromMs, cursorMs - 3_600_000);
});

test('the first scrub preserves a rolling event period as coverage advances', async (t) => {
  let now = Date.parse('2026-11-10T12:00:00Z');
  t.mock.method(Date, 'now', () => now);
  const world = createWorldClock({ now: () => now });
  const { kernel } = start({ worldClock: world });
  t.after(() => kernel.destroy());
  await kernel.act('toggleLayer', 'earthquakes');
  await kernel.act('setTime', { mode: 'recent', hours: 168 });

  const { session, timeline } = kernel.snapshot();
  assert.equal(session.time.mode, 'recent');
  const target = seekTime(session.time, now - 86_400_000, timeline);
  now += 1000;
  await kernel.act('setTime', target, { cursorOnly: true });
  const scrubbed = kernel.snapshot();
  assert.deepEqual(scrubbed.session.time, target);
  assert.equal(scrubbed.timeline.notice, null);
  assert.equal(world.now(), target.cursorMs);

  // A date edit still clamps to the available event period and explains it.
  await kernel.act('setTime', {
    ...target,
    fromMs: target.fromMs - 86_400_000,
  });
  const edited = kernel.snapshot();
  assert.equal(edited.session.time.fromMs, now - 7 * 86_400_000);
  assert.equal(
    edited.timeline.notice,
    'The selected period was limited to available data.',
  );
});

test('new sessions and returning to panels reset the shared world to live', async (t) => {
  const now = Date.parse('2026-11-10T12:00:00Z');
  const world = createWorldClock({ now: () => now });
  const { kernel, fake } = start({ worldClock: world });
  t.after(() => kernel.destroy());
  const range = {
    mode: 'range',
    fromMs: now - 7_200_000,
    toMs: now - 3_600_000,
  };
  await kernel.act('toggleLayer', 'weather-radar');
  await kernel.act('setTime', range);
  assert.equal(world.now(), range.toMs);
  assert.equal(world.isLive(), false);

  await kernel.act('newSession');
  await until(() => world.isLive());
  assert.equal(fake.enabled.size, 0, 'the reset cleared layers before time');
  assert.ok(!fake.calls.some(([name]) => name === 'clear_annotations'));

  await kernel.act('setTime', range);
  assert.equal(world.isLive(), false);
  await kernel.release();
  assert.equal(world.isLive(), true);
  assert.equal(world.now(), now);
  assert.deepEqual(
    kernel.snapshot().session.time,
    range,
    'handing the globe back leaves the session time saved',
  );
});

test('entering from panels applies the session time without restoring its globe view', async (t) => {
  const now = Date.parse('2026-11-10T12:00:00Z');
  const range = {
    mode: 'range',
    fromMs: now - 7_200_000,
    toMs: now - 3_600_000,
  };
  for (const time of [{ mode: 'live' }, range]) {
    await t.test(time.mode, (t) => {
      const storage = memory();
      const sessions = createSessionStore({ storage });
      sessions.load();
      const session = sessions.create();
      sessions.update(session.id, { time });
      sessions.flush();

      const world = createWorldClock({ now: () => now });
      world.seek(now - 10_800_000);
      world.play({ continuous: true });
      const fake = fakeEngine();
      fake.enabled.add('flights');
      fake.enabled.add('earthquakes');
      const camera = fake.engine.styleManager.getCameraState();
      const kernel = createChatViewKernel({
        engine: { ...fake.engine, worldClock: world },
        host: fakeHost().host,
        storage,
        resume: false,
      });
      t.after(() => kernel.destroy());

      assert.deepEqual(kernel.snapshot().session.time, time);
      assert.equal(world.isPlaying(), false);
      assert.equal(world.isLive(), time.mode === 'live');
      assert.equal(world.now(), time.mode === 'live' ? now : range.toMs);
      assert.deepEqual([...fake.enabled], ['flights', 'earthquakes']);
      assert.deepEqual(fake.engine.styleManager.getCameraState(), camera);
      assert.deepEqual(fake.calls, [], 'entry does not run globe actions');
      assert.deepEqual(fake.views, [], 'entry does not restore a saved view');
    });
  }
});

test('a weather answer credits Open-Meteo beside its numbers, whoever answers', async () => {
  const daily = {
    today: '2026-11-04',
    timezone: 'America/New_York',
    days: [
      {
        date: '2026-11-03',
        weatherCode: 63,
        highC: 28,
        lowC: 22,
        precipitationMm: 12,
      },
      {
        date: '2026-11-04',
        weatherCode: 1,
        highC: 29,
        lowC: 23,
        precipitationMm: 0,
      },
      {
        date: '2026-11-05',
        weatherCode: 1,
        highC: 29,
        lowC: 23,
        precipitationMm: 0,
      },
    ],
  };
  const json = { '/api/weather-daily': daily };
  const planned = start({ json });
  const turn = await planned.ask('weather in Miami yesterday');
  assert.equal(turn.answer.ok, true);
  assert.deepEqual(turn.answer.sources, [OPEN_METEO]);
  planned.kernel.destroy();

  const realtime = fakeRealtime([
    [call('get_weather_by_day', { place: 'Miami', from_day: -1, to_day: -1 })],
    [say('Rain yesterday in Miami.')],
  ]);
  const agent = start({
    json,
    agent: realtimeProvider(realtime),
  });
  const answered = await agent.ask('How was the weather in Miami yesterday?');
  assert.deepEqual(answered.answer.sources, [OPEN_METEO]);
  // The agent reads the days, not the rows the answer shows.
  const output = JSON.parse(
    realtime.sent.find((event) => event.item?.type === 'function_call_output')
      .item.output,
  );
  assert.equal(output.ok, true);
  assert.equal(output.items, undefined);
  assert.equal(output.data.days.length, 1);
  agent.kernel.destroy();
});

test('a reload picks the open session back up where its last answer left it', async () => {
  const storage = memory();
  const first = start({
    storage,
    results: {
      analyst_query: { ok: true, count: 1, items: [quake('us1', 5)] },
    },
  });
  await first.ask('Earthquakes above 4.5 in the last 24 hours');
  first.kernel.destroy();
  const again = start({ storage });
  await until(() => again.fake.views.length);
  assert.deepEqual(again.fake.views[0].time, { mode: 'recent', hours: 24 });
  again.kernel.destroy();
});

test('a layer that is on carries desktop’s row controls, and a tap does what the row does', async () => {
  const { kernel, fake, snapshot } = start();
  const used = [];
  let throws = false;
  // Desktop's row model (layerPanel.js): params, a handler, a slider that
  // maps its position, and the functions that act stay with the layer.
  fake.engine.dataManager.layers.set('earthquakes', {
    module: {
      getRowControls() {
        if (throws) throw new Error('not ready');
        return {
          chips: [
            {
              id: 'strong',
              label: 'STRONG',
              active: true,
              params: { strong: false },
            },
            {
              id: 'nearest',
              label: 'Nearest',
              onClick: () => used.push('nearest'),
            },
            {
              id: 'busy',
              label: 'Busy ···',
              disabled: true,
              busy: true,
              state: 'loading',
              params: { busy: true },
            },
          ],
          segmented: {
            id: 'age',
            label: 'Age',
            options: [
              { id: 'age-1', label: '1d', active: true, params: { days: 1 } },
              { id: 'age-7', label: '7d', params: { days: 7 } },
            ],
          },
          slider: {
            id: 'min-mag',
            label: 'Magnitude',
            valueText: '≥ 2',
            min: 0,
            max: 100,
            value: 20,
            track: 'linear-gradient(90deg, red, gold)',
            ticks: [{ at: 0, label: '0' }],
            params: (value) => ({ minMagnitude: value / 10 }),
          },
          legend: [
            { label: 'Shallow', color: '#f00', count: 4, blurb: 'Depth' },
          ],
          info: '4 of 9 shown',
        };
      },
    },
  });
  const controls = () =>
    snapshot().layers.find((row) => row.id === 'earthquakes').controls;
  assert.equal(controls(), null, 'a layer that is off shows no controls');
  assert.deepEqual(await kernel.act('pickLayerChip', 'earthquakes', 'strong'), {
    ok: false,
  });
  assert.equal(fake.params.length, 0);

  await kernel.act('toggleLayer', 'earthquakes');
  await tick();
  const shown = controls();
  assert.deepEqual(structuredClone(shown), shown);
  assert.deepEqual(JSON.parse(JSON.stringify(shown)), shown);
  assert.equal(Object.isFrozen(shown.slider), true);
  assert.deepEqual(
    shown.chips.map(({ id, active, disabled, state }) => [
      id,
      active,
      disabled,
      state,
    ]),
    [
      ['strong', true, false, 'active'],
      ['nearest', false, false, 'idle'],
      ['busy', false, true, 'loading'],
    ],
  );
  assert.equal(shown.segmented.options[0].active, true);
  assert.equal(shown.slider.track, 'linear-gradient(90deg, red, gold)');
  assert.deepEqual(shown.legend, [
    { color: '#f00', label: 'Shallow', count: 4, blurb: 'Depth' },
  ]);
  assert.equal(shown.info, '4 of 9 shown');

  assert.deepEqual(await kernel.act('pickLayerChip', 'earthquakes', 'strong'), {
    ok: true,
  });
  assert.deepEqual(await kernel.act('pickLayerChip', 'earthquakes', 'age-7'), {
    ok: true,
  });
  assert.deepEqual(
    await kernel.act('pickLayerChip', 'earthquakes', 'nearest'),
    { ok: true },
  );
  assert.deepEqual(await kernel.act('pickLayerChip', 'earthquakes', 'busy'), {
    ok: false,
  });
  assert.deepEqual(
    await kernel.act('setLayerSlider', 'earthquakes', 'min-mag', 45),
    { ok: true },
  );
  assert.deepEqual(
    await kernel.act('setLayerSlider', 'earthquakes', 'other', 45),
    { ok: false },
  );
  assert.deepEqual(used, ['nearest']);
  assert.deepEqual(fake.params, [
    ['earthquakes', { strong: false }, 'user'],
    ['earthquakes', { days: 7 }, 'user'],
    ['earthquakes', { minMagnitude: 4.5 }, 'user'],
  ]);

  // A descriptor that throws draws nothing, and a tap still resolves.
  throws = true;
  assert.deepEqual(await kernel.act('pickLayerChip', 'earthquakes', 'strong'), {
    ok: false,
  });
  assert.equal(controls(), null);
  kernel.destroy();
});

test('immersive intents forward to the shared owner and publish only plain state', async (t) => {
  const fake = fakeEngine();
  let active = false;
  const subject = {
    kind: 'satellite',
    layerId: 'satellites',
    id: '25544',
    label: 'ISS',
  };
  const forwarded = [];
  fake.engine.immersion = {
    snapshot: () =>
      Object.freeze({
        active,
        subject: active ? subject : null,
        entry: active ? null : subject,
      }),
    act(action, args) {
      forwarded.push([action, args]);
      active = action !== 'exit';
      return { ok: true };
    },
  };
  const kernel = createChatViewKernel({
    engine: fake.engine,
    host: fakeHost().host,
  });
  t.after(() => kernel.destroy());
  assert.equal(kernel.snapshot().stage.immersion.entry.id, '25544');
  await kernel.act('immersive', 'enter', subject);
  assert.equal(kernel.snapshot().stage.immersion.active, true);
  await kernel.act('immersive', 'lookLeft', { subject });
  assert.deepEqual(forwarded, [
    ['enter', subject],
    ['lookLeft', { subject }],
  ]);
  const snapshot = kernel.snapshot();
  assert.deepEqual(
    structuredClone(snapshot),
    JSON.parse(JSON.stringify(snapshot)),
  );
  await kernel.act('immersive', 'exit', { subject });
  assert.equal(kernel.snapshot().stage.immersion.active, false);
  assert.deepEqual(
    fake.calls,
    [],
    'the kernel never duplicates camera or selection actions',
  );
});

test('time playback uses the shared continuous clock, persists a pause, and releases ownership', async (t) => {
  const now = Date.now();
  let elapsed = 0;
  let driverStarts = 0;
  const world = createWorldClock({
    now: () => now,
    monotonicNow: () => elapsed,
    follow: ['satellites'],
  });
  const unregister = world.register({
    id: 'satellites',
    coverage: () => ({ start: now - 3_600_000, end: now + 3_600_000 }),
  });
  const driver = world.attachDriver({
    play: () => {
      driverStarts++;
      return true;
    },
    pause() {},
  });
  const fake = fakeEngine();
  const original = fake.engine.dataManager.getAll;
  fake.engine.dataManager.getAll = () => [
    ...original(),
    { id: 'satellites', name: 'Satellites', enabled: true },
  ];
  const kernel = createChatViewKernel({
    engine: { ...fake.engine, worldClock: world },
    host: fakeHost().host,
  });
  t.after(() => {
    kernel.destroy();
    unregister();
    driver.detach();
  });
  await kernel.act('setTime', {
    mode: 'range',
    fromMs: now - 3_600_000,
    toMs: now,
    cursorMs: now - 3_600_000,
  });
  assert.equal(kernel.snapshot().timeline.playback, true);
  assert.deepEqual(await kernel.act('timePlayback', 'rate', 60), { ok: true });
  assert.deepEqual(await kernel.act('timePlayback', 'play'), { ok: true });
  assert.equal(world.isPlaying(), true);
  assert.equal(
    driverStarts,
    0,
    'continuous playback follows the same core policy as Panels',
  );
  elapsed = 1000;
  assert.equal(world.now(), now - 3_600_000 + 60_000);
  await kernel.act('timePlayback', 'pause');
  assert.equal(world.isPlaying(), false);
  assert.equal(
    kernel.snapshot().session.time.cursorMs,
    now - 3_600_000 + 60_000,
  );
  assert.deepEqual(await kernel.act('timePlayback', 'rate', Infinity), {
    ok: false,
  });
  await kernel.act('timePlayback', 'play');
  kernel.destroy();
  assert.equal(
    world.isPlaying(),
    false,
    'disposing the shell stops its own player',
  );
});
