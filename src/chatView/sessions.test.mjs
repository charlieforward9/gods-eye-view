import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_TURNS,
  STORAGE_KEY,
  SEED_SESSIONS,
  createSessionStore,
} from './sessions.js';
import {
  normalizeTime,
  queryInRange,
  rangeFilters,
  shortTimeLabel,
  timeLabel,
  windowOf,
} from './timeWindow.js';

const memory = () => {
  const values = new Map();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
};

test('a first visit seeds projects and sessions; a later one reads them back', () => {
  const storage = memory();
  let n = 0;
  const first = createSessionStore({ storage, newId: () => `id${(n += 1)}` });
  first.load();
  assert.equal(first.sessions().length, SEED_SESSIONS.length);
  assert.deepEqual(
    first.projects().map((project) => project.name),
    ['Air', 'Signals', 'Hazards', 'Orbit', 'Sea', 'Replays'],
  );
  const created = first.create({ projectId: 'sea' });
  first.addTurn(created.id, { q: 'ships in the Red Sea', status: 'done' });
  first.flush();
  assert.ok(storage.getItem(STORAGE_KEY));

  const again = createSessionStore({ storage });
  again.load();
  assert.equal(again.activeId(), created.id);
  assert.equal(again.get(created.id).turns[0].q, 'ships in the Red Sea');
  assert.equal(again.sessions().length, SEED_SESSIONS.length + 1);
});

test('a broken record starts over instead of throwing', () => {
  const storage = memory();
  storage.setItem(STORAGE_KEY, '{not json');
  const store = createSessionStore({ storage });
  store.load();
  assert.equal(store.sessions().length, SEED_SESSIONS.length);
});

test('times: live, a rolling span, a fixed window', () => {
  const now = 10 * 3_600_000;
  assert.deepEqual(normalizeTime(null), { mode: 'live' });
  assert.equal(windowOf({ mode: 'live' }, now), null);
  assert.deepEqual(windowOf({ mode: 'recent', hours: 6 }, now), {
    fromMs: 4 * 3_600_000,
    toMs: now,
  });
  assert.deepEqual(
    normalizeTime({ mode: 'range', fromMs: now, toMs: now - 1 }),
    { mode: 'range', fromMs: now - 1, toMs: now },
  );
});

test('a time reads as live, the span asked for, or how far back it ends', () => {
  const now = Date.UTC(2026, 10, 4, 12);
  const back = (ms) => ({ mode: 'range', fromMs: 0, toMs: now - ms });
  assert.equal(timeLabel({ mode: 'live' }, now), 'Live');
  assert.equal(timeLabel({ mode: 'recent', hours: 0.5 }, now), 'Last 30 min');
  assert.equal(timeLabel({ mode: 'recent', hours: 6 }, now), 'Last 6 h');
  assert.equal(timeLabel({ mode: 'recent', hours: 72 }, now), 'Last 3 d');
  assert.equal(timeLabel(back(20_000), now), 'Now');
  assert.equal(timeLabel(back(25 * 60_000), now), '−25 min');
  assert.equal(timeLabel(back(3 * 3_600_000), now), '−3 h');
  // A minute short of two hours never reads as "1 h 60 min".
  assert.equal(timeLabel(back(2 * 3_600_000 - 20_000), now), '−2 h');
  assert.equal(timeLabel(back(90 * 60_000), now), '−1 h 30 min');
  assert.match(timeLabel(back(2 * 86_400_000), now), /\d/);
});

test('the narrowest composer reads the same times short', () => {
  const now = Date.UTC(2026, 10, 4, 12);
  const back = (ms) => ({ mode: 'range', fromMs: 0, toMs: now - ms });
  assert.equal(shortTimeLabel({ mode: 'live' }, now), 'Live');
  assert.equal(shortTimeLabel({ mode: 'recent', hours: 0.5 }, now), '30 min');
  assert.equal(shortTimeLabel({ mode: 'recent', hours: 24 }, now), '24 h');
  assert.equal(shortTimeLabel({ mode: 'recent', hours: 72 }, now), '3 d');
  assert.equal(shortTimeLabel(back(20_000), now), 'Now');
  assert.equal(shortTimeLabel(back(25 * 60_000), now), '−25 min');
  assert.equal(shortTimeLabel(back(407 * 60_000), now), '−7 h');
  // Past a day, the weekday alone.
  assert.doesNotMatch(shortTimeLabel(back(3 * 86_400_000), now), /\d/);
});

test('a window becomes age filters for timed feeds only', () => {
  const now = 10 * 3_600_000;
  const range = { mode: 'range', fromMs: 2 * 3_600_000, toMs: 7 * 3_600_000 };
  assert.deepEqual(rangeFilters(range, ['earthquakes'], now), [
    { field: 'ageHours', op: 'gte', value: 3 },
    { field: 'ageHours', op: 'lte', value: 8 },
  ]);
  assert.deepEqual(rangeFilters(range, ['flights'], now), []);
  const asked = {
    layers: ['earthquakes'],
    filters: [
      { field: 'magnitude', op: 'gte', value: 4 },
      { field: 'ageHours', op: 'lte', value: 6 },
    ],
  };
  assert.deepEqual(queryInRange(asked, range, now).filters, [
    { field: 'magnitude', op: 'gte', value: 4 },
    { field: 'ageHours', op: 'gte', value: 3 },
    { field: 'ageHours', op: 'lte', value: 8 },
  ]);
  assert.equal(queryInRange(asked, { mode: 'live' }, now), asked);
});

test('seeds arrive once, and blocked storage still works', () => {
  const storage = memory();
  const first = createSessionStore({ storage });
  first.load();
  for (const entry of first.sessions()) first.remove(entry.id);
  first.flush();
  const again = createSessionStore({ storage });
  again.load();
  assert.equal(again.sessions().length, 0);

  const blocked = {
    getItem() {
      throw new Error('SecurityError');
    },
    setItem() {
      throw new Error('SecurityError');
    },
  };
  const offline = createSessionStore({ storage: blocked });
  assert.equal(offline.load().sessions.length, SEED_SESSIONS.length);
  assert.ok(offline.create({}).id);
});

test('a reload marks a question that was still answering as cancelled', () => {
  const storage = memory();
  const before = createSessionStore({ storage });
  before.load();
  const session = before.create({});
  before.addTurn(session.id, { q: 'Any emergencies?', status: 'running' });
  before.flush();
  const after = createSessionStore({ storage });
  after.load();
  assert.equal(after.get(session.id).turns[0].status, 'cancelled');
});

test('sessions saved while the chat view was /mob carry over to its own key', () => {
  const storage = memory();
  const old = createSessionStore({ storage });
  old.load();
  const kept = old.create({ title: 'Kept' });
  old.flush();
  // As the store wrote it before the rename.
  storage.setItem('gev:mob:v1', storage.getItem(STORAGE_KEY));
  storage.removeItem(STORAGE_KEY);

  const renamed = createSessionStore({ storage });
  renamed.load();
  assert.equal(renamed.get(kept.id).title, 'Kept');
  assert.equal(renamed.activeId(), kept.id);
  assert.ok(storage.getItem(STORAGE_KEY));
  assert.equal(storage.getItem('gev:mob:v1'), null);
});

test('a session keeps its last questions, and only the newest answer keeps its ids', () => {
  const storage = memory();
  const store = createSessionStore({ storage });
  store.load();
  const { id } = store.create({});
  const answer = {
    ok: true,
    say: 'Two.',
    rows: [{ id: 'a' }],
    ids: ['flights:a'],
    events: [{ t: 1 }],
  };
  for (let i = 0; i < MAX_TURNS + 5; i += 1)
    store.addTurn(id, { q: `question ${i}`, status: 'done', answer });
  assert.equal(store.get(id).turns.length, MAX_TURNS);
  assert.equal(store.get(id).turns[0].q, 'question 5');
  const before = store.revision();
  store.update(id, { watch: true });
  assert.ok(store.revision() > before);
  store.flush();

  const saved = JSON.parse(storage.getItem(STORAGE_KEY)).sessions.find(
    (entry) => entry.id === id,
  );
  const [older, newest] = [saved.turns.at(-2), saved.turns.at(-1)];
  assert.equal(older.answer.ids, undefined);
  assert.equal(older.answer.events, undefined);
  assert.deepEqual(older.answer.rows, [{ id: 'a' }]);
  assert.deepEqual(newest.answer.ids, ['flights:a']);
});
