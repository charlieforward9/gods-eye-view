import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentRunner } from './agentRunner.js';

function runner() {
  const calls = [];
  const run = createAgentRunner({
    steps: async (name, args) => {
      calls.push({ name, args });
      return { ok: true };
    },
    resolvePlace: async () => null,
    time: () => ({ mode: 'live' }),
  });
  return { run, calls };
}

test('an unsized chat result fly frames its surroundings instead of a landmark close-up', async () => {
  const { run, calls } = runner();
  const point = { latitude: 13.5362, longitude: -90.8798 };
  await run('fly_to_location', point);
  await run('fly_to_location', { ...point, viewMode: 'overview' });
  await run('fly_to_location', { referent: 1 });
  for (const { args } of calls) {
    assert.equal(args.rangeM, 400_000);
    assert.equal(args.viewMode, 'overview');
  }
  assert.deepEqual(point, { latitude: 13.5362, longitude: -90.8798 });
  assert.equal(
    calls[2].args.referent,
    1,
    'the engine still resolves the live target',
  );
});

test('chat retains explicit close-ups, distances and named-place framing', async () => {
  const { run, calls } = runner();
  const cases = [
    { latitude: 13.5362, longitude: -90.8798, viewMode: 'close' },
    { latitude: 13.5362, longitude: -90.8798, rangeM: 2000 },
    { referent: 1, viewMode: 'close' },
    { referent: 1, rangeM: 800 },
    { query: 'Puerto San José' },
  ];
  for (const args of cases) await run('fly_to_location', args);
  assert.deepEqual(
    calls.map((call) => call.args),
    cases,
  );
});
