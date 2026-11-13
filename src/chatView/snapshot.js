/**
 * The snapshot every shell renders from: plain, frozen data that survives
 * `structuredClone` and JSON, so a native shell can take it over a message
 * bridge. Parts that did not change keep their identity between snapshots
 * (sessions, layers, the stage), so a layer count ticking every second
 * re-renders only what shows layers.
 */
import { categoryOf } from './sessionGroups.js';
import {
  keepsHistory,
  normalizeTime,
  timeNotice,
  timelineFor,
  windowOf,
} from './timeWindow.js';

/** The ids an answer's +N −M counts against, as `layer:id`. */
export function diffOf(session) {
  const ids = session.turns.at(-1)?.answer?.ids || [];
  const seen = new Set(session.seen || []);
  const now = new Set(ids);
  return {
    added: ids.filter((id) => !seen.has(id)).length,
    removed: (session.seen || []).filter((id) => !now.has(id)).length,
  };
}

// One value per key, rebuilt only when its key changes.
function memo(build) {
  let key;
  let value;
  return (next, ...args) => {
    if (next !== key) {
      key = next;
      value = build(...args);
    }
    return value;
  };
}

/** @param {object} ctx The kernel context (kernel.js). */
export function createSnapshots(ctx) {
  const { store, state, host, engine } = ctx;

  const openSession = memo((session, time) =>
    session
      ? Object.freeze({
          id: session.id,
          title: session.title,
          projectId: session.projectId,
          watch: session.watch,
          time,
          diff: Object.freeze(diffOf(session)),
          pending: session.pending.length,
          turns: Object.freeze(
            session.turns.map((turn) =>
              Object.freeze({
                id: turn.id,
                q: turn.q,
                chips: turn.chips || [],
                status: turn.status,
                title: turn.plan?.title || null,
                answer: turn.answer || null,
                hasView: Boolean(turn.view),
                at: turn.at,
              }),
            ),
          ),
        })
      : null,
  );
  const sessionRows = memo(() =>
    Object.freeze(
      store.sessions().map((entry) =>
        Object.freeze({
          id: entry.id,
          title: entry.title,
          projectId: entry.projectId,
          watch: entry.watch,
          signals: entry.signals,
          updatedAt: entry.updatedAt,
          turns: entry.turns.length,
          category: categoryOf(entry),
          diff: Object.freeze(diffOf(entry)),
        }),
      ),
    ),
  );
  const projects = memo(() =>
    Object.freeze(
      store.projects().map((project) => Object.freeze({ ...project })),
    ),
  );
  const playing = memo(() =>
    state.playing
      ? Object.freeze({
          index: state.playing.index,
          total: state.playing.total,
          turnId: state.playing.turnId ?? null,
        })
      : null,
  );
  // Layers a window in the past cannot show, by name.
  const liveOnly = memo((time, rows, oldestFrameMs, following) =>
    time.mode === 'live'
      ? Object.freeze([])
      : Object.freeze(
          rows
            .filter(
              (row) =>
                row.enabled &&
                !keepsHistory(row.id, {
                  range: windowOf(time),
                  oldestFrameMs,
                  following,
                }),
            )
            .map((row) => row.label),
        ),
  );

  return function snapshot() {
    const revision = store.revision();
    const session = ctx.active();
    const time = normalizeTime(session?.time);
    const focusedTime =
      ctx.timeline?.(session) ||
      timelineFor({
        session,
        rows: engine.dataManager.getAll(),
        worldClock: engine.worldClock,
        weatherClock: engine.weatherClock,
      });
    const timeline = Object.freeze({
      ...focusedTime,
      notice:
        focusedTime.notice ||
        (state.timeNotice && state.timeNotice.sessionId === session?.id
          ? timeNotice(state.timeNotice.reason)
          : null),
    });
    const following = engine.worldClock?.getState?.()?.following ?? [];
    const oldestFrameMs = Date.parse(
      engine.weatherClock?.getTimeline?.()?.[0] ?? '',
    );
    return Object.freeze({
      ready: true,
      activeId: session?.id ?? null,
      session: openSession(
        `${revision}:${session?.id}:${JSON.stringify(timeline.time)}`,
        session,
        timeline.time,
      ),
      timeline,
      sessions: sessionRows(revision),
      projects: projects(revision),
      groupBy: state.groupBy,
      layers: state.layers,
      liveOnly: liveOnly(
        `${JSON.stringify(time)}|${state.layerDigest}|${oldestFrameMs}|${JSON.stringify(following)}`,
        time,
        state.layers,
        oldestFrameMs,
        following,
      ),
      busy: state.busy,
      focus: state.focus,
      signal: state.signal,
      playing: playing(state.playing),
      mapOnly: host.surfaces.mapOnly(),
      stage: state.stage,
      basemap: state.basemap,
      provider: state.provider,
      signals: store
        .sessions()
        .filter((entry) => entry.id !== session?.id)
        .reduce((sum, entry) => sum + (entry.signals || 0), 0),
    });
  };
}
