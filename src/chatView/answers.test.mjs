import test from 'node:test';
import assert from 'node:assert/strict';
import { createAnswerRunner } from './answers.js';
import { planQuestion } from './planner.js';

// A runner that answers every action from a table, as the app's would.
const runnerFrom = (results) => async (name) => results[name] ?? { ok: true };

test('a feed in trouble is the answer, not an empty sky', async () => {
  const answers = createAnswerRunner({
    run: runnerFrom({
      analyst_query: {
        ok: true,
        count: 0,
        items: [],
        say: '0 aircraft over Gulf of Mexico.',
      },
    }),
    issuesFor: () => [
      'Flights are limited right now: the worldwide feed is rate-limited.',
    ],
  });
  const answer = await answers.answer(
    planQuestion("What's flying over the Gulf of Mexico?"),
  );
  assert.equal(answer.ok, false);
  assert.match(answer.say, /^Flights are limited/);
  assert.doesNotMatch(answer.say, /0 aircraft/);
});

test('a feed in trouble that still answers says so beside the answer', async () => {
  const answers = createAnswerRunner({
    run: runnerFrom({
      analyst_query: {
        ok: true,
        count: 1,
        items: [
          { layerKey: 'flights', id: 'abc', callsign: 'AAL1', lat: 1, lon: 2 },
        ],
        say: '1 aircraft over Gulf of Mexico.',
      },
    }),
    issuesFor: () => ['Flights data is stale; the feed has not refreshed.'],
  });
  const answer = await answers.answer(
    planQuestion("What's flying over the Gulf of Mexico?"),
  );
  assert.equal(answer.ok, true);
  assert.equal(answer.say, '1 aircraft over Gulf of Mexico.');
  assert.match(answer.issue, /stale/);
  assert.equal(answer.rows[0].title, 'AAL1');
});

test('a superlative leads with the winner, then says where the camera went', async () => {
  const answers = createAnswerRunner({
    run: runnerFrom({
      analyst_query: {
        ok: true,
        count: 44,
        items: [
          {
            layerKey: 'earthquakes',
            id: 'us1',
            magnitude: 5.3,
            place: 'near Palekastro, Greece',
            ageHours: 6,
            depthKm: 49,
            lat: 34,
            lon: 26,
          },
        ],
        say: '44 earthquakes anywhere in the loaded data.',
      },
      fly_to_location: { ok: true, say: 'Flying to 34, 26.' },
    }),
  });
  const answer = await answers.answer(
    planQuestion('Strongest earthquake in the last 24 hours? Fly me there.'),
  );
  assert.equal(
    answer.say,
    'Strongest: M5.3 near Palekastro, Greece (6 h ago). 44 in all. Flying to M5.3 near Palekastro, Greece.',
  );
});

test('a newer question cancels the one still running', async () => {
  let release;
  const answers = createAnswerRunner({
    run: (name) =>
      name === 'set_layer_visibility'
        ? new Promise((resolve) => {
            release = () => resolve({ ok: true });
          })
        : Promise.resolve({ ok: true, say: 'Done.' }),
  });
  const first = answers.answer(planQuestion('earthquakes in the last 6 hours'));
  const second = answers.answer(planQuestion('make it thermal'));
  release();
  assert.equal((await first).cancelled, true);
  assert.equal((await second).cancelled, false);
});

test('a feed that loaded fine and holds nothing answers "none", not a failure', async () => {
  const answers = createAnswerRunner({
    run: runnerFrom({
      analyst_query: { ok: false, code: 'NOT_READY', error: 'no records yet' },
    }),
    emptyFor: () => true,
  });
  const answer = await answers.answer(
    planQuestion('Is there a hurricane right now?'),
  );
  assert.equal(answer.ok, true);
  assert.match(answer.say, /^No active cyclones right now/);
});

test('following waits for the layer the same question turned on', async () => {
  const order = [];
  const answers = createAnswerRunner({
    run: async (name) => {
      order.push(name);
      return { ok: true, say: 'Done.' };
    },
    prepare: async (layers) => {
      order.push(`wait:${layers.join(',')}`);
    },
  });
  await answers.answer(planQuestion('Where is the ISS?'));
  assert.deepEqual(order, [
    'set_layer_visibility',
    'wait:satellites',
    'track_entity',
  ]);
});

test('an action that fails in its own words says them, and a failed pass says why', async () => {
  const lost = createAnswerRunner({
    run: runnerFrom({
      fly_to_location: { ok: false, say: "Couldn't find Asdfghjkl." },
    }),
  });
  const gibberish = await lost.answer(planQuestion('asdfghjkl'));
  assert.equal(gibberish.ok, false);
  assert.equal(gibberish.say, "Couldn't find Asdfghjkl.");

  const early = createAnswerRunner({
    run: runnerFrom({
      next_iss_pass: {
        ok: false,
        error: 'ISS orbital elements not loaded yet.',
      },
    }),
  });
  const pass = await early.answer(
    planQuestion('when does the ISS pass over me?'),
  );
  assert.equal(pass.ok, false);
  assert.match(pass.say, /not loaded yet/);
});

test('a pass hours away reads in hours, and a worldwide count says worldwide', async () => {
  const answers = createAnswerRunner({
    run: runnerFrom({
      next_iss_pass: {
        ok: true,
        riseIso: '2026-11-04T10:33:00.000Z',
        riseDirection: 'SSE',
        minutesFromNow: 751,
        durationMin: 3,
        peakElevationDeg: 13,
        visible: false,
      },
      analyst_query: {
        ok: true,
        count: 11,
        items: [
          { layerKey: 'earthquakes', id: 'q1', magnitude: 5, lat: 1, lon: 2 },
        ],
        say: '11 earthquakes anywhere in the loaded data.',
      },
    }),
  });
  const pass = await answers.answer(
    planQuestion('when does the ISS pass over Tokyo?'),
  );
  assert.match(pass.rows[0].meta, /^in 12 h 31 min/);
  const quakes = await answers.answer(
    planQuestion('earthquakes above 4.5 in the last 24 hours'),
  );
  assert.equal(quakes.say, '11 earthquakes worldwide.');
});

test('settled() waits out a cancelled answer’s step in flight', async () => {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const answers = createAnswerRunner({
    run: async (name) => (name === 'fly_to_location' ? held : { ok: true }),
  });
  const first = answers.answer(planQuestion('show me Tokyo'));
  answers.cancel();
  let settled = false;
  const waiting = answers.settled().then(() => {
    settled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(settled, false);
  release({ ok: true });
  assert.deepEqual(await first, { cancelled: true });
  await waiting;
  assert.equal(settled, true);
});
