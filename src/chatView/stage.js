/**
 * The stage: what the globe shows for the open session. Only the open
 * session streams, so a session that has not answered yet starts from an
 * empty stage, a past answer's view can be put back, and a session's views
 * replay as a scene.
 *
 * Whatever rearranges the stage waits for the step a superseded answer,
 * restore or replay still has in flight (`ctx.superseded()`), or the old
 * session's layer would land on the new session's stage.
 */
import { t } from '../i18n/index.js';
import { applyTime } from './timeWindow.js';
import { delay } from './wait.js';

const PLAY_HOLD_MS = 4500;

/** @param {object} ctx The kernel context (kernel.js). */
export function createStage(ctx) {
  const { engine, host, state } = ctx;
  const { run } = engine;
  let staging = Promise.resolve();
  // Settle once the latest restore, and the latest replay, have stopped.
  let restored = Promise.resolve();
  let played = Promise.resolve();

  async function resetStage() {
    // A running scene re-applies its own shots; it stops before anything.
    await run('control_scene', { action: 'stop' }).catch(() => {});
    if (host.surfaces.cockpit())
      await run('control_cockpit', { action: 'exit' }).catch(() => {});
    await run('stop_tracking', {}).catch(() => {});
    for (const id of engine.dataManager.getEnabledLayerIds())
      await run('set_layer_visibility', { layerId: id, enabled: false }).catch(
        () => {},
      );
    applyTime({ mode: 'live' }, ctx.timeEngine);
    if (engine.styleManager.getVisualState?.()?.style !== 'normal')
      await run('set_visual_style', { style: 'normal' }).catch(() => {});
  }

  function stopPlaying() {
    state.playing?.controller.abort();
    state.playing = null;
  }

  return {
    stopPlaying,
    /** Resolves once the stage is not being cleared, restored or replayed. */
    settled: () => Promise.all([staging, restored, played]),
    /** The stage's own work, for `ctx.superseded()`. */
    pending: () => [restored, played, staging],

    /**
     * Clear the stage: every layer off, nothing followed, live
     * time, the normal look. It is queued at once, so a question asked
     * meanwhile waits for it; `after` is work it waits out first.
     */
    clear(after = null) {
      staging = Promise.all([staging, after]).then(resetStage, resetStage);
      return staging;
    },

    /** Put a past answer's view back on screen. */
    async restoreTurn(turnId) {
      const session = ctx.active();
      const turn = session?.turns.find((entry) => entry.id === turnId);
      if (!turn?.view) return;
      // Putting a view back replaces whatever was answering.
      ctx.supersede({ agent: 'cancel' });
      const controller = new AbortController();
      state.restoring = controller;
      // Taken before `restored` is replaced, so it never waits on itself.
      const previous = ctx.superseded();
      let settle;
      restored = new Promise((resolve) => {
        settle = resolve;
      });
      state.busy = { turnId, label: t('Restoring the view') };
      ctx.emit();
      try {
        await previous;
        if (!controller.signal.aborted) {
          ctx.setTimeFor(session, turn.view.time, turn);
          await engine.restoreView(turn.view, { signal: controller.signal });
        }
      } catch {
        // A step that fails leaves the rest of the view applied.
      }
      settle();
      if (state.restoring === controller) state.restoring = null;
      if (state.busy?.turnId === turnId) state.busy = null;
      ctx.emit();
      if (!controller.signal.aborted) ctx.watches.refresh();
    },

    /** Replay the session's views one after another, as a scene. */
    async play() {
      const session = ctx.active();
      const turns = session?.turns.filter((turn) => turn.view) || [];
      if (!turns.length) return;
      stopPlaying();
      state.restoring?.abort();
      const controller = new AbortController();
      state.playing = { controller, index: 0, total: turns.length };
      ctx.emit();
      const previous = ctx.superseded();
      let settle;
      played = new Promise((resolve) => {
        settle = resolve;
      });
      await previous;
      for (const [index, turn] of turns.entries()) {
        if (controller.signal.aborted) break;
        state.playing = {
          controller,
          index,
          total: turns.length,
          turnId: turn.id,
        };
        ctx.emit();
        ctx.setTimeFor(session, turn.view.time, turn);
        await engine
          .restoreView(turn.view, { signal: controller.signal })
          .catch(() => {});
        await delay(PLAY_HOLD_MS, controller.signal);
      }
      settle();
      if (state.playing?.controller === controller) state.playing = null;
      ctx.emit();
    },
  };
}
