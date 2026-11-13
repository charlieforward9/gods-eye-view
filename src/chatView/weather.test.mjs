import test from 'node:test';
import assert from 'node:assert/strict';
import { imperialFor, rainText, weatherAnswer } from './weather.js';
import { planQuestion } from './planner.js';

// Palm Beach County, 2–4 November 2026, as the daily weather proxy gives it.
const DAILY = Object.freeze({
  today: '2026-11-03',
  days: [
    {
      date: '2026-11-02',
      weatherCode: 65,
      highC: 27,
      lowC: 22.3,
      precipitationMm: 43.2,
      gustMaxKph: 50.8,
    },
    {
      date: '2026-11-03',
      weatherCode: 82,
      highC: 28.2,
      lowC: 23.7,
      precipitationMm: 37.5,
      gustMaxKph: 47.9,
    },
    {
      date: '2026-11-04',
      weatherCode: 3,
      highC: 27.7,
      lowC: 23.1,
      precipitationMm: 0,
      gustMaxKph: 25.9,
    },
  ],
});

test('yesterday, today and tomorrow each answer with their own numbers', () => {
  const place = 'Palm Beach County';
  const yesterday = weatherAnswer({ day: -1, place }, DAILY, {
    imperial: true,
  });
  assert.equal(
    yesterday.say,
    'Yesterday in Palm Beach County: heavy rain, a high of 81°F and a low of 72°F, with 1.70 in of rain. Gusts up to 32 mph.',
  );
  assert.deepEqual(
    yesterday.items.map((item) => item.name),
    ['Yesterday', 'Today', 'Tomorrow'],
  );
  const metric = weatherAnswer({ day: -1, place }, DAILY, { imperial: false });
  assert.match(metric.say, /a high of 27°C and a low of 22°C, with 43.2 mm/);

  const today = weatherAnswer({ day: 0, place }, DAILY, {
    imperial: true,
    current: { temperatureC: 25.4, weatherCode: 80 },
  });
  assert.equal(
    today.say,
    'Now in Palm Beach County: rain showers, 78°F. Today: a high of 83°F, a low of 75°F, 1.48 in of rain.',
  );
  const tomorrow = weatherAnswer({ day: 1, place }, DAILY, { imperial: true });
  assert.match(
    tomorrow.say,
    /^Tomorrow in Palm Beach County: overcast.*no rain\.$/,
  );

  const run = weatherAnswer({ days: 1, place }, DAILY, { imperial: true });
  assert.match(run.say, /1.70 in of rain/);
  assert.equal(run.items.length, 1);
});

test('a missing day or proxy says so instead of guessing', () => {
  const none = weatherAnswer({ day: -1 }, null, { imperial: true });
  assert.equal(none.ok, false);
  assert.match(none.say, /not available/);
});

test('units follow the region a browser reads in, and a trace is a trace', () => {
  assert.equal(imperialFor('en-US'), true);
  assert.equal(imperialFor('en-GB'), false);
  assert.equal(imperialFor('de-DE'), false);
  assert.equal(rainText(0, true), null);
  assert.equal(rainText(0.1, true), 'a trace');
  assert.equal(rainText(0.05, false), 'a trace');
});

test('a weather question plans its place and its day, never "Yesterday" as a place', () => {
  const step = (plan) =>
    plan.calls.find((call) => call.name === 'get_weather_by_day');
  for (const text of [
    'weather in palm beach county yesterday',
    'weather in palm beach county yestarday',
    'What was the weather in Palm Beach County yesterday?',
    'did it rain in palm beach county yesterday',
  ]) {
    const plan = planQuestion(text);
    assert.equal(plan.place, 'Palm Beach County', text);
    assert.deepEqual(step(plan).args, {
      from_day: -1,
      to_day: -1,
      place: 'Palm Beach County',
    });
    assert.equal(step(plan).fill, 'place');
    // Radar shows now, not yesterday.
    assert.deepEqual(plan.layers, [], text);
  }
  const now = planQuestion('is it raining in Seattle?');
  assert.deepEqual(now.layers, ['weather-radar']);
  assert.equal(step(now).args.from_day, 0);
  assert.equal(
    step(planQuestion('forecast for Tokyo tomorrow')).args.from_day,
    1,
  );
  assert.equal(planQuestion('forecast for Tokyo tomorrow').place, 'Tokyo');
  assert.deepEqual(
    step(planQuestion('weather in Miami over the last 3 days')).args,
    { from_day: -3, to_day: -1, place: 'Miami' },
  );
  // Radar and storms keep their own layers.
  assert.deepEqual(planQuestion('show me radar').layers, ['weather-radar']);
  assert.deepEqual(planQuestion('hurricanes').layers, ['weather-cyclones']);
  // Day words leave every other place alone too.
  assert.equal(planQuestion('earthquakes in Japan yesterday').place, 'Japan');
});
