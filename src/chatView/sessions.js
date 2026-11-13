/**
 * Sessions and projects, kept in one small JSON record. A session holds its
 * questions (each with the view it answered with), whether it is watching,
 * and the ids its answer showed when the person last looked, for the pill's
 * "new since you looked". Storage is injected so the store runs in node tests.
 */
import { msg } from '../i18n/marker.js';

export const STORAGE_KEY = 'gev:chat-view:v1';
// Where sessions lived while the chat view was called /mob; read once and
// carried over.
const LEGACY_KEYS = Object.freeze(['gev:mob:v1']);
// A session keeps its last questions; the oldest beyond these drop.
export const MAX_TURNS = 200;

/** What a session is called until its first question names it. */
export const NEW_SESSION_TITLE = msg('New session');

export const DEFAULT_PROJECTS = Object.freeze([
  Object.freeze({ id: 'air', name: msg('Air') }),
  Object.freeze({ id: 'signals', name: msg('Signals') }),
  Object.freeze({ id: 'hazards', name: msg('Hazards') }),
  Object.freeze({ id: 'orbit', name: msg('Orbit') }),
  Object.freeze({ id: 'sea', name: msg('Sea') }),
  Object.freeze({ id: 'replays', name: msg('Replays') }),
]);

const seed = (title, projectId, question, extra = {}) =>
  Object.freeze({
    title,
    projectId,
    // The planner reads English, so a seed asks in English.
    pending: Object.freeze([question]),
    ...extra,
  });

/**
 * Sessions a first visit starts with: the moments God's Eye View is known
 * for, each answerable with no key. A seed asks its question the first time
 * it is opened, so its answer is live.
 */
export const SEED_SESSIONS = Object.freeze([
  seed(
    msg('Military over the Middle East'),
    'air',
    'Military aircraft over the Middle East, then put me in the cockpit',
  ),
  seed(
    msg('LAX final approach'),
    'air',
    'Take me to LAX, follow a plane, then switch to thermal',
  ),
  seed(msg('Emergencies right now'), 'air', 'Any emergencies?'),
  seed(
    msg('Gulf of Mexico traffic'),
    'air',
    'What’s flying over the Gulf of Mexico?',
  ),
  seed(msg('GPS jamming'), 'signals', 'Where is GPS being jammed right now?'),
  seed(
    msg('Big earthquakes'),
    'hazards',
    'Earthquakes above 4.5 in the last 24 hours',
    { watch: true },
  ),
  seed(
    msg('Strongest quake today'),
    'hazards',
    'Strongest earthquake in the last 24 hours? Fly me there.',
  ),
  seed(
    msg('Biggest wildfires'),
    'hazards',
    'Biggest fire perimeters right now',
  ),
  seed(msg('Hurricanes'), 'hazards', 'Is there a hurricane right now?'),
  seed(msg('Where is the ISS'), 'orbit', 'Where is the ISS?'),
  seed(msg('ISS over me'), 'orbit', 'When does the ISS pass over me?'),
  seed(msg('Starlink shell'), 'orbit', 'Show me every Starlink satellite'),
  seed(msg('Latest launches'), 'orbit', 'Latest rocket launches'),
  seed(
    msg('Undersea cables'),
    'sea',
    'Show me the undersea cables landing in the Bahamas',
  ),
  seed(msg('Nepal Flood Incident'), 'replays', 'Replay the Bhote Koshi flood'),
  seed(msg('Orbital Watch'), 'replays', 'Play Orbital Watch'),
  seed(msg('Omniscience Pullback'), 'replays', 'Play the omniscience pullback'),
]);

const blank = () => ({
  version: 1,
  projects: [],
  sessions: [],
  activeId: null,
  // Seeds arrive once: a person who deletes them all keeps an empty list.
  seeded: false,
});

// randomUUID exists only on secure pages; a phone on the LAN (http) has none.
function randomId() {
  if (typeof globalThis.crypto?.randomUUID === 'function')
    return globalThis.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * What is saved of the sessions: everything but what only the newest
 * answer uses (the ids its +N −M counts, the events its timeline marks).
 */
function stored(state) {
  return {
    ...state,
    sessions: state.sessions.map((entry) => ({
      ...entry,
      turns: entry.turns.map((turn, i, turns) =>
        i === turns.length - 1 || !turn.answer
          ? turn
          : {
              ...turn,
              answer: { ...turn.answer, ids: undefined, events: undefined },
            },
      ),
    })),
  };
}

/**
 * @param {{storage?: Storage|null, now?: () => number, newId?: () => string}} [options]
 *   With no storage, sessions last for the visit.
 */
export function createSessionStore({
  storage = null,
  now = Date.now,
  newId = randomId,
} = {}) {
  let state = blank();
  let saveTimer = null;
  // Counts changes, so a snapshot rebuilds only what changed.
  let revision = 0;

  const parse = (key) => {
    try {
      const parsed = JSON.parse(storage?.getItem(key) || 'null');
      return parsed?.version === 1 && Array.isArray(parsed.sessions)
        ? parsed
        : null;
    } catch {
      return null;
    }
  };
  const read = () => {
    const current = parse(STORAGE_KEY);
    if (current) return current;
    for (const key of LEGACY_KEYS) {
      const legacy = parse(key);
      if (!legacy) continue;
      // Copied before the old key goes, so a closed page loses nothing.
      try {
        storage.setItem(STORAGE_KEY, JSON.stringify(legacy));
        storage.removeItem(key);
      } catch {
        // Left behind, it is read again only if the new key is lost.
      }
      return legacy;
    }
    return null;
  };

  const write = () => {
    saveTimer = null;
    try {
      storage?.setItem(STORAGE_KEY, JSON.stringify(stored(state)));
    } catch {
      // A full or blocked store keeps the sessions in memory for this visit.
    }
  };

  // Writes coalesce: a question touches its session several times as it
  // answers, and one write after the last is enough.
  const save = () => {
    revision += 1;
    if (saveTimer !== null) return;
    saveTimer = setTimeout(write, 250);
  };

  const session = (fields) => ({
    id: newId(),
    title: NEW_SESSION_TITLE,
    projectId: null,
    createdAt: now(),
    updatedAt: now(),
    turns: [],
    pending: [],
    watch: false,
    seen: [],
    signals: 0,
    time: { mode: 'live' },
    ...fields,
  });

  const find = (id) => state.sessions.find((entry) => entry.id === id) || null;

  return {
    /** Load saved sessions, seeding a first visit. */
    load() {
      state = read() || blank();
      // A question still answering when the page closed never will.
      for (const entry of state.sessions)
        for (const turn of entry.turns || [])
          if (turn.status === 'running') turn.status = 'cancelled';
      if (!state.projects.length)
        state.projects = DEFAULT_PROJECTS.map((project) => ({ ...project }));
      // A store saved before the flag had its seeds already.
      if (state.sessions.length) state.seeded = true;
      if (!state.seeded) {
        state.seeded = true;
        state.sessions = SEED_SESSIONS.map((seed, i) =>
          session({
            title: seed.title,
            projectId: seed.projectId,
            pending: [...seed.pending],
            watch: Boolean(seed.watch),
            updatedAt: now() - i,
          }),
        );
      }
      if (!find(state.activeId)) state.activeId = null;
      save();
      return state;
    },
    /** A number that changes whenever anything in the store does. */
    revision: () => revision,
    flush() {
      if (saveTimer !== null) {
        clearTimeout(saveTimer);
        write();
      }
    },
    projects: () => state.projects,
    sessions: () =>
      [...state.sessions].sort((a, b) => b.updatedAt - a.updatedAt),
    get: find,
    activeId: () => state.activeId,
    setActive(id) {
      state.activeId = find(id) ? id : null;
      save();
    },
    create({ projectId = null, title } = {}) {
      const created = session({
        projectId,
        ...(title ? { title } : {}),
      });
      state.sessions.push(created);
      state.activeId = created.id;
      save();
      return created;
    },
    update(id, patch) {
      const target = find(id);
      if (!target) return null;
      Object.assign(target, patch, { updatedAt: now() });
      save();
      return target;
    },
    addTurn(id, turn) {
      const target = find(id);
      if (!target) return null;
      const created = { id: newId(), at: now(), ...turn };
      target.turns.push(created);
      if (target.turns.length > MAX_TURNS)
        target.turns.splice(0, target.turns.length - MAX_TURNS);
      target.updatedAt = now();
      save();
      return created;
    },
    updateTurn(id, turnId, patch) {
      const turn = find(id)?.turns.find((entry) => entry.id === turnId);
      if (!turn) return null;
      Object.assign(turn, patch);
      save();
      return turn;
    },
    addProject(name) {
      const project = { id: newId(), name: String(name).slice(0, 40) };
      state.projects.push(project);
      save();
      return project;
    },
    remove(id) {
      state.sessions = state.sessions.filter((entry) => entry.id !== id);
      if (state.activeId === id) state.activeId = null;
      save();
    },
  };
}
