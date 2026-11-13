/**
 * The chat view's kernel: sessions of questions over one live engine.
 *
 * Intents go in through `act(name, ...args)` (intents.js); an immutable
 * snapshot comes out to every subscriber (snapshot.js). The Vue shell is
 * one subscriber; a native shell can be another over a message bridge.
 *
 * The kernel reaches the globe and the page only through the ports it is
 * given, so it runs in node tests and imports no DOM, Cesium or Vue
 * (scripts/check-import-directions.mjs keeps it that way):
 *  - `engine`: the app's action runner, layers, camera events, map picker
 *    and view restore (src/standalone/chatViewHost.js builds it);
 *  - `host`: the page's network, location, visibility and screen modes;
 *  - `agent`: GEV's shared provider facade, or null for the planner.
 *
 * It does no per-frame work: it samples layers once a second, refreshes
 * the open answer every ten seconds while the page is visible, and polls
 * watched sessions in the background every ninety.
 *
 * Modules share one context, `ctx`:
 *  - questions.js asks (GEV's agent, or the rule planner);
 *  - stage.js clears, restores and replays what the globe shows;
 *  - watches.js keeps answers current;
 *  - capabilities/ is what the chat view can do beyond the app's actions.
 */
import {
  applyRowChip,
  findRowChip,
  rowSliderParams,
} from '../data/rowControls.js';
import { t } from '../i18n/index.js';
import { createChatAgent } from './agent.js';
import { createAgentRunner } from './agentRunner.js';
import { createAnswerRunner } from './answers.js';
import { basemapLabel, createBasemaps } from './basemaps.js';
import { createCameraWatch } from './camera.js';
import {
  AGENT_TOOLS,
  createStepRunner,
  forAgent,
} from './capabilities/index.js';
import { createContext } from './context.js';
import { createFeeds } from './feeds.js';
import { INTENTS } from './intents.js';
import { describeLayers } from './layers.js';
import { airportOf, regionOf } from './planner.js';
import { createQuestions } from './questions.js';
import { createSessionStore } from './sessions.js';
import { createSnapshots } from './snapshot.js';
import { createStage } from './stage.js';
import {
  applyTime,
  magnitudeFloor,
  normalizeTime,
  seekTime,
  timelineFor,
  validateTime,
} from './timeWindow.js';
import { createWatches } from './watches.js';

const SAMPLE_MS = 1000;
const REFRESH_MS = 10_000;
const BACKGROUND_MS = 90_000;
const ZOOMED_IN_M = 2_500_000;
const FOLLOWABLE = new Set(['flights', 'military', 'satellites']);

/**
 * @param {object} options
 * @param {object} options.engine `{run, dataManager, styleManager, maps,
 *   worldClock, weatherClock, scenes, camera: {onMoveStart, onMoveEnd}, restoreView,
 *   requestRender}`.
 * @param {object} options.host `{fetchJson, geolocate, visible, imperial,
 *   surfaces: {cockpit, mapOnly, subscribe}, onSelection, onPageHide}`.
 * @param {{createTextAgent: Function}|null} [options.agent]
 * @param {Storage|null} [options.storage] Where sessions persist.
 * @param {Function} [options.geocode] `(query, {signal})` → `{lat, lon}`.
 * @param {Function} [options.loadCatalog] The server tool catalog, for
 *   background watches.
 * @param {boolean} [options.hasGoogleKey]
 * @param {boolean} [options.resume] Put the open session's last view back
 *   (a reload); a switch from the panels keeps the globe as they left it.
 */
export function createChatViewKernel({
  engine,
  host,
  agent: agentPort = null,
  storage = null,
  geocode,
  loadCatalog,
  hasGoogleKey = false,
  resume = true,
}) {
  const { run, dataManager, styleManager } = engine;
  const store = createSessionStore({ storage });
  const camera = createCameraWatch(engine.camera);
  const feeds = createFeeds({ dataManager, camera });
  const basemaps = createBasemaps({
    maps: engine.maps,
    styleManager,
    hasGoogleKey,
  });
  const cameraState = () => styleManager.getCameraState?.() ?? null;
  const context = createContext({ cameraState, geolocate: host.geolocate });
  const state = {
    busy: null,
    focus: null,
    signal: null,
    playing: null,
    restoring: null,
    // Counts questions and what replaces them (questions.js).
    generation: 0,
    groupBy: 'projects',
    layers: Object.freeze([]),
    layerDigest: '',
    stage: null,
    basemap: null,
    basemapNotice: null,
    provider: null,
    timeContext: null,
    timeNotice: null,
    timePlaybackOwned: false,
  };
  const listeners = new Set();
  const cleanups = [
    () => camera.destroy(),
    () => {
      if (state.timePlaybackOwned) engine.worldClock?.pause();
      engine.worldClock?.gate?.('chat-view', null);
    },
  ];
  let emitQueued = false;
  let disposed = false;

  // Airports and named regions resolve here; anything else geocodes.
  const resolvePlace = async (query, options) =>
    airportOf(query) ||
    regionOf(query) ||
    (geocode ? geocode(query, options) : null);
  const viewCenter = () => {
    const at = cameraState();
    return at ? { lat: at.lat, lon: at.lon } : null;
  };
  // The view's center, once it is close enough to mean one place.
  const viewPoint = () =>
    (cameraState()?.alt ?? Infinity) < ZOOMED_IN_M ? viewCenter() : null;

  const ctx = {
    engine,
    host,
    store,
    state,
    feeds,
    camera,
    context,
    basemaps,
    loadCatalog,
    timeEngine: {
      dataManager,
      worldClock: engine.worldClock ?? null,
      weatherClock: engine.weatherClock ?? null,
      requestRender: engine.requestRender,
    },
    active: () => store.get(store.activeId()),
    emit,
    timeTurn(session = ctx.active(), turn = null) {
      const saved =
        state.timeContext?.sessionId === session?.id ? state.timeContext : null;
      const recorded =
        saved?.turnId &&
        session?.turns.find((entry) => entry.id === saved.turnId);
      return (
        turn ||
        (recorded?.query || recorded?.plan ? recorded : saved?.turn) ||
        session?.turns.at(-1) ||
        null
      );
    },
    timeline(session = ctx.active(), turn = null) {
      const contextTurn = ctx.timeTurn(session, turn);
      const labels = new Map(state.layers.map((row) => [row.id, row.label]));
      return timelineFor({
        session:
          session && contextTurn
            ? { ...session, turns: [contextTurn] }
            : session,
        rows: dataManager
          .getAll()
          .map((row) => ({ ...row, label: labels.get(row.id) || row.name })),
        worldClock: engine.worldClock,
        weatherClock: engine.weatherClock,
      });
    },
    // The session's time and the floors of the answer on screen, applied to
    // the layers that can show them.
    applyStage(session, turn = null) {
      const target = ctx.timeTurn(session, turn);
      return applyTime(
        normalizeTime(session?.time, {
          bounds: ctx.timeline(session, target),
          preservePeriod: true,
        }),
        ctx.timeEngine,
        Date.now(),
        {
          minMagnitude: magnitudeFloor(target?.query),
        },
      );
    },
    setTimeFor(session, time, turn, { cursorOnly = false } = {}) {
      state.timePlaybackOwned = false;
      engine.worldClock?.gate?.('chat-view', null);
      if (turn)
        state.timeContext = {
          sessionId: session.id,
          turnId: turn.id || state.busy?.turnId || null,
          turn,
        };
      const checked = validateTime(time, {
        bounds: ctx.timeline(session, turn),
        preservePeriod:
          !turn &&
          time?.mode === 'range' &&
          (cursorOnly ||
            (session.time?.mode === 'range' &&
              time.fromMs === session.time.fromMs &&
              time.toMs === session.time.toMs)),
      });
      const range = checked.time;
      state.timeNotice = checked.reason
        ? { sessionId: session.id, reason: checked.reason }
        : null;
      store.update(session.id, { time: range });
      ctx.applyStage(session, turn);
      return range;
    },
    // A newer question, restore, stop or session replaces whatever was
    // answering: the agent's conversation is cancelled, or reset for
    // another session.
    supersede({ agent = null } = {}) {
      ctx.stage.stopPlaying();
      state.generation += 1;
      ctx.answers.cancel();
      if (agent === 'reset') ctx.agent?.reset();
      else if (agent === 'cancel') ctx.agent?.cancel();
      state.restoring?.abort();
    },
    // Resolves once every superseded answer, restore and replay has
    // finished the step it had in flight.
    superseded: () =>
      Promise.all([
        ctx.answers.settled(),
        ctx.agent?.settled?.(),
        ...ctx.questions.pending(),
        ...ctx.stage.pending(),
      ]),
  };

  // What capabilities reach (capabilities/index.js).
  const capabilityContext = {
    run,
    dataManager,
    feeds,
    camera,
    basemaps,
    resolvePlace,
    viewPoint,
    viewCenter,
    fetchJson: host.fetchJson,
    imperial: Boolean(host.imperial),
    timeline: () => ctx.timeline(),
    setTime(time) {
      const session = ctx.active();
      const applied = session ? ctx.setTimeFor(session, time) : time;
      emit();
      return applied;
    },
    clearStage: () => ctx.stage.clear(),
    get agent() {
      return ctx.agent;
    },
  };
  const steps = createStepRunner(capabilityContext, run);
  ctx.answers = createAnswerRunner({
    run: steps,
    geocode: resolvePlace,
    emptyFor: feeds.emptyFor,
    prepare: feeds.prepare,
    issuesFor: feeds.issuesFor,
    describeFor: feeds.describeFor,
  });
  // The same selected provider and authentication owner as Panels, typed to.
  ctx.agent = agentPort
    ? createChatAgent({
        provider: agentPort,
        run: createAgentRunner({
          steps,
          resolvePlace,
          time: () => ctx.active()?.time,
        }),
        toModel: forAgent,
        // A layer that just came on has no records until its first fetch.
        beforeTool: (name, args, { signal }) =>
          name === 'analyst_query'
            ? feeds.prepare(args.layers || [], { flew: false, signal })
            : null,
        history: () =>
          (ctx.active()?.turns || [])
            .filter((turn) => turn.status === 'done' && turn.answer?.say)
            .map((turn) => ({ q: turn.q, say: turn.answer.say })),
        extraTools: AGENT_TOOLS,
      })
    : null;
  ctx.stage = createStage(ctx);
  ctx.questions = createQuestions(ctx);
  ctx.watches = createWatches(ctx);
  const sampleProvider = () => {
    if (!agentPort) {
      state.provider = null;
      return;
    }
    const current = ctx.agent?.state?.() || {};
    state.provider = Object.freeze({
      id: agentPort.provider ?? current.provider ?? 'openai',
      options: Object.freeze(
        (agentPort.supportedProviders || []).map((id) =>
          Object.freeze({
            value: id,
            label: id === 'gemini' ? t('Gemini') : t('OpenAI'),
          }),
        ),
      ),
      authMode: agentPort.authMode ?? current.authMode ?? 'api-key',
      authModes: Object.freeze([...(agentPort.authModes || ['api-key'])]),
      status: current.status || 'idle',
      detail:
        typeof current.detail === 'string'
          ? current.detail.slice(0, 300)
          : null,
    });
  };
  sampleProvider();
  if (ctx.agent?.subscribe)
    cleanups.push(
      ctx.agent.subscribe(() => {
        sampleProvider();
        emit();
      }),
    );
  const snapshot = createSnapshots(ctx);

  function emit() {
    if (emitQueued || disposed) return;
    emitQueued = true;
    queueMicrotask(() => {
      emitQueued = false;
      if (disposed) return;
      const next = snapshot();
      for (const listener of listeners) listener(next);
    });
  }

  // What desktop's display, scene and camera panels show, for the chat
  // view's.
  const stageOf = () => {
    const visual = styleManager.getVisualState?.() || {};
    const cctv = dataManager.isEnabled('cctv')
      ? dataManager.layers.get('cctv')?.module?.getUIState?.()
      : null;
    const active = cctv?.activeCamera || null;
    return Object.freeze({
      look: Object.freeze({
        style: visual.style || 'normal',
        detection:
          Boolean(visual.detection?.mode) && visual.detection.mode !== 'OFF',
        bloom: Boolean(visual.bloom?.enabled),
        sharpen: Boolean(visual.sharpen?.enabled),
      }),
      scenes: Object.freeze(
        (engine.scenes?.() || []).map(({ id, title }) =>
          Object.freeze({ id, title }),
        ),
      ),
      camera: active
        ? Object.freeze({
            id: active.id,
            name: active.name || active.id,
            city: active.city || null,
            provider: active.provider || null,
            status:
              active.sourceStatus === 'degraded' ||
              active.sourceStatus === 'error'
                ? active.sourceMessage || t('Unavailable')
                : null,
            projecting: Boolean(cctv.showProjection),
          })
        : null,
      cockpit: host.surfaces.cockpit(),
      immersion: engine.immersion?.snapshot?.() ?? null,
    });
  };
  // A layer's row controls, as desktop's row reads them; a descriptor that
  // throws draws none.
  const rowControlsOf = (id) => {
    try {
      return dataManager.layers?.get(id)?.module?.getRowControls?.() || null;
    } catch {
      return null;
    }
  };
  // A tap on a row control does what it does on desktop's row, against the
  // live controls of a layer that is on; resolves `{ok}`.
  function actOnRowControls(layerId, use) {
    let ok = false;
    try {
      ok =
        dataManager.isEnabled(layerId) &&
        use(rowControlsOf(layerId), (params) =>
          dataManager.setLayerParams(layerId, params, { origin: 'user' }),
        );
    } catch {
      ok = false;
    }
    sample();
    return { ok: Boolean(ok) };
  }

  // The one reader of layer state. A sample that changes nothing a person
  // can see emits nothing, and keeps the last rows.
  function sample() {
    const world = engine.worldClock;
    const clock = world?.getState?.();
    if (clock && state.timePlaybackOwned) {
      const timeline = ctx.timeline();
      if (
        !clock.playing ||
        !timeline.playback ||
        timeline.status !== 'ready' ||
        clock.timeMs >= timeline.endMs
      ) {
        world.pause();
        state.timePlaybackOwned = false;
        world.gate?.('chat-view', null);
        const session = ctx.active();
        if (session && timeline.status === 'ready') {
          ctx.setTimeFor(
            session,
            seekTime(
              session.time,
              Math.min(clock.timeMs, timeline.endMs),
              timeline,
            ),
          );
        }
      }
    }
    const rows = describeLayers(dataManager.getAll(), {
      controlsOf: rowControlsOf,
    });
    const stage = stageOf();
    const { look } = stage;
    const digest = `${rows
      .map(
        (row) =>
          `${row.id}:${row.state}:${row.count}:${row.ageLabel ?? ''}:${row.error ?? ''}:${row.controls ? JSON.stringify(row.controls) : ''}`,
      )
      .join(
        '|',
      )}#${look.style}:${look.detection}:${look.bloom}:${look.sharpen}:${JSON.stringify(stage.camera)}:${stage.cockpit}:${stage.scenes.length}:${JSON.stringify(stage.immersion)}:${JSON.stringify(ctx.timeline())}`;
    if (digest === state.layerDigest) return;
    state.layerDigest = digest;
    state.layers = Object.freeze(rows);
    state.stage = stage;
    emit();
  }

  const refreshBasemap = () => {
    const picker = basemaps.options();
    state.basemap = picker
      ? Object.freeze({
          active: picker.active,
          options: Object.freeze(picker.options),
          notice: state.basemapNotice,
        })
      : null;
  };
  // A map the app swapped for another (its tiles stopped loading) is said
  // once, so the change never looks like something the person did.
  let shownBasemap = basemaps.activeId();
  const stopMaps = basemaps.subscribe((mapState) => {
    const was = shownBasemap;
    shownBasemap = mapState.activeId;
    if (
      mapState.switchOrigin === 'automatic' &&
      was &&
      was !== mapState.activeId
    )
      state.basemapNotice = Object.freeze({
        at: Date.now(),
        text: t(
          '{from} stopped loading, so the map switched to {to}. Change it in + › Layers.',
          {
            from: basemapLabel(was, mapState.stacks),
            to: basemapLabel(mapState.activeId, mapState.stacks),
          },
        ),
      });
    refreshBasemap();
    emit();
  });
  if (stopMaps) cleanups.push(stopMaps);
  refreshBasemap();

  // A tap on the globe becomes the context chip of the next question.
  const onCleared = () => {
    if (!state.focus) return;
    state.focus = null;
    emit();
  };
  cleanups.push(
    host.onSelection({
      selected(detail) {
        if (detail.origin && detail.origin !== 'user') return;
        const asked = Object.freeze({
          kind: 'object',
          layerId: detail.layerId || null,
          id: String(detail.id ?? ''),
          label: String(detail.label || detail.id || t('Selected')),
          lat: Number.isFinite(detail.lat) ? detail.lat : null,
          lon: Number.isFinite(detail.lon) ? detail.lon : null,
        });
        state.focus = asked;
        emit();
        // What desktop's context panel says about it, once the app has it.
        run('get_entity_context', { scope: 'selected' })
          .then((found) => {
            if (state.focus !== asked || !found || found.ok === false) return;
            state.focus = Object.freeze({
              ...asked,
              detail: Object.freeze({
                title: found.display?.title || asked.label,
                line: found.identityLine || null,
                lines: Object.freeze(
                  (found.display?.lines || [])
                    .filter((line) => typeof line === 'string')
                    .slice(0, 4),
                ),
              }),
            });
            emit();
          })
          .catch(() => {});
      },
      cleared: onCleared,
    }),
  );
  // The screen modes (map only, the cockpit) flip from buttons, keys or the
  // app itself.
  cleanups.push(
    host.surfaces.subscribe(() => {
      sample();
      emit();
    }),
  );
  cleanups.push(
    dataManager.subscribe((event) => {
      if (/^visibility|^refresh$/.test(event?.type || '')) sample();
    }),
  );
  const every = (ms, task) => {
    const timer = setInterval(() => {
      if (host.visible()) task();
    }, ms);
    cleanups.push(() => clearInterval(timer));
  };
  store.load();
  sample();
  every(SAMPLE_MS, sample);
  every(REFRESH_MS, () => ctx.watches.refresh());
  every(BACKGROUND_MS, () => ctx.watches.background());
  cleanups.push(host.onPageHide(() => store.flush()));

  const intents = {
    ask: (text, chips = []) => ctx.questions.ask(text, chips),
    stop() {
      ctx.questions.halt();
      emit();
    },
    /** Open GEV's agent ahead of a question (the composer took focus). */
    warm() {
      ctx.agent?.warm();
    },
    async pickRow(row) {
      if (!row) return;
      state.focus = Object.freeze({
        kind: 'object',
        layerId: row.layerId,
        id: row.followId || row.id,
        label: row.title,
        lat: row.lat,
        lon: row.lon,
      });
      emit();
      if (row.followId && FOLLOWABLE.has(row.layerId)) {
        await run('track_entity', {
          query: row.followId,
          layerId: row.layerId,
        }).catch(() => {});
      } else if (Number.isFinite(row.lat) && Number.isFinite(row.lon)) {
        await run('fly_to_location', {
          latitude: row.lat,
          longitude: row.lon,
          viewMode: 'overview',
          rangeM: row.layerId === 'gnss-region' ? 1_400_000 : 400_000,
          waitForArrival: false,
        }).catch(() => {});
        if (row.layerId === 'gnss-region')
          await run('set_layer_visibility', {
            layerId: 'gnss-integrity',
            enabled: true,
          }).catch(() => {});
      }
    },
    restoreTurn: (turnId) => ctx.stage.restoreTurn(turnId),
    play: () => ctx.stage.play(),
    markSeen() {
      const session = ctx.active();
      if (!session) return;
      store.update(session.id, {
        seen: session.turns.at(-1)?.answer?.ids || [],
      });
      emit();
    },

    async openSession(id) {
      const session = store.get(id);
      if (!session) return;
      // Another session is another conversation.
      ctx.supersede({ agent: store.activeId() === id ? 'cancel' : 'reset' });
      state.busy = null;
      store.setActive(id);
      store.update(id, { signals: 0 });
      if (state.signal?.sessionId === id) state.signal = null;
      emit();
      const last = session.turns.findLast((turn) => turn.view);
      if (last && !session.pending.length)
        return ctx.stage.restoreTurn(last.id);
      // A seed, or a session with nothing to put back, starts from a clean
      // stage once the work it replaced has stopped. A seed keeps its
      // question until it is asked, so opening another session meanwhile
      // leaves it to ask next time.
      const pending = [...session.pending];
      await ctx.stage.clear(ctx.superseded());
      for (const [index, question] of pending.entries()) {
        if (store.activeId() !== id) return;
        store.update(id, { pending: pending.slice(index + 1) });
        await ctx.questions.ask(question);
      }
    },
    newSession(projectId = null) {
      ctx.supersede({ agent: 'reset' });
      state.busy = null;
      const { id } = store.create({ projectId });
      emit();
      ctx.stage
        .clear(ctx.superseded())
        .then(() =>
          store.activeId() === id
            ? run('zoom_to_globe', {}).catch(() => {})
            : null,
        );
      return id;
    },
    renameSession(id, title) {
      const name = String(title || '')
        .trim()
        .slice(0, 60);
      if (name) store.update(id, { title: name });
      emit();
    },
    deleteSession(id) {
      store.remove(id);
      emit();
    },
    moveSession(id, projectId) {
      store.update(id, { projectId });
      emit();
    },
    addProject(name) {
      const project = store.addProject(name);
      emit();
      return { ...project };
    },
    setGroupBy(mode) {
      state.groupBy = mode === 'layers' ? 'layers' : 'projects';
      emit();
    },
    toggleWatch() {
      const session = ctx.active();
      if (!session) return;
      store.update(session.id, { watch: !session.watch, watchSeen: null });
      emit();
    },
    dismissSignal() {
      state.signal = null;
      emit();
    },

    setTime(time, options) {
      const session = ctx.active() || store.create({});
      ctx.setTimeFor(session, time, null, options);
      emit();
      ctx.watches.refresh();
    },
    timePlayback(action, rate) {
      const world = engine.worldClock;
      const timeline = ctx.timeline();
      if (!world || !timeline.playback || timeline.status !== 'ready')
        return { ok: false };
      const session = ctx.active() || store.create({});
      if (action === 'pause') {
        const at = world.now();
        world.pause();
        state.timePlaybackOwned = false;
        ctx.setTimeFor(session, seekTime(session.time, at, timeline));
      } else if (action === 'rate') {
        if (![1, 60, 3600, 86400].includes(rate)) return { ok: false };
        world.setRate(rate);
        if (world.getState().stepping) {
          world.pause();
          world.gate?.('chat-view', timeline.endMs);
          state.timePlaybackOwned = true;
          world.play({ continuous: true, rate });
        }
      } else if (action === 'play') {
        const current = world.getState();
        if (current.live || current.timeMs >= timeline.endMs) {
          ctx.setTimeFor(
            session,
            seekTime(session.time, timeline.startMs, timeline),
          );
        }
        world.gate?.('chat-view', timeline.endMs);
        state.timePlaybackOwned = true;
        world.play({ continuous: true });
      } else return { ok: false };
      emit();
      return { ok: true };
    },
    async toggleLayer(layerId) {
      await run('set_layer_visibility', {
        layerId,
        enabled: !dataManager.isEffectivelyEnabled(layerId),
      }).catch(() => {});
      sample();
    },
    /** A chip or switch option under a layer's row; resolves `{ok}`. */
    pickLayerChip: (layerId, chipId) =>
      actOnRowControls(layerId, (controls, setParams) =>
        applyRowChip(findRowChip(controls, chipId), setParams),
      ),
    /** A position of the slider under a layer's row; resolves `{ok}`. */
    setLayerSlider: (layerId, sliderId, value) =>
      actOnRowControls(layerId, (controls, setParams) => {
        const params = rowSliderParams(controls, sliderId, Number(value));
        if (params) setParams(params);
        return Boolean(params);
      }),
    /** Switch the map under the layers; resolves `{ok, say|error}`. */
    async setBasemap(id) {
      if (basemaps.activeId() === id) return { ok: true };
      const result = await basemaps.switchTo(id).catch((error) => ({
        ok: false,
        error: error?.message || String(error),
      }));
      emit();
      return result;
    },
    /**
     * Desktop's display controls, through its own actions: `style` takes a
     * style name; `detection`, `bloom` and `sharpen` take on or off.
     */
    async setLook(key, value) {
      const calls = {
        style: ['set_visual_style', { style: value }],
        detection: ['set_detection', { enabled: Boolean(value) }],
        bloom: ['set_post_processing', { bloom: { enabled: Boolean(value) } }],
        sharpen: [
          'set_post_processing',
          { sharpen: { enabled: Boolean(value) } },
        ],
      };
      if (!calls[key]) return;
      await run(...calls[key]).catch(() => {});
      emit();
    },
    /** Play one of the director's scenes, or stop the one playing (null). */
    async playScene(id) {
      await run('control_scene', { action: 'stop' }).catch(() => {});
      if (id)
        await run('control_scene', { action: 'play', sceneId: id }).catch(
          () => {},
        );
      emit();
    },
    /** The cockpit's own steps: 'previous', 'next' or 'exit'. */
    async cockpit(action) {
      await run('control_cockpit', { action }).catch(() => {});
      emit();
    },
    async immersive(action, args = {}) {
      if (!engine.immersion?.act) return { ok: false };
      if (['enter', 'exit', 'previous', 'next', 'signal'].includes(action)) {
        ctx.questions.halt();
        await ctx.superseded();
      }
      const result = await Promise.resolve(
        engine.immersion.act(action, args),
      ).catch((error) => ({
        ok: false,
        error: error?.message || String(error),
      }));
      sample();
      emit();
      return result;
    },
    async setProvider(id) {
      ctx.questions.halt();
      await ctx.superseded();
      const ok = Boolean(agentPort?.selectProvider?.(id));
      sampleProvider();
      emit();
      return { ok };
    },
    async setAuthMode(mode) {
      ctx.questions.halt();
      await ctx.superseded();
      const ok = Boolean(agentPort?.selectAuthMode?.(mode));
      sampleProvider();
      emit();
      return { ok };
    },
    /** Camera controls use the same owner as Panels. */
    async camera(action) {
      const result = await run('control_cctv', { action }).catch(() => ({
        ok: false,
      }));
      sample();
      emit();
      return result;
    },
    /** Map only is the app's own clean view (its V key). */
    setMapOnly(on = !host.surfaces.mapOnly()) {
      styleManager.toggleCleanView?.(Boolean(on));
    },
    clearFocus: onCleared,
    viewChip: () => context.viewChip(),
    hereChip: () => context.hereChip(),
  };

  const last = resume && ctx.active()?.turns.findLast((turn) => turn.view);
  if (last) ctx.stage.restoreTurn(last.id);
  // Switching from panels keeps their layers and camera, but time belongs
  // to the open session: its Live label must not hide a paused world clock.
  else if (!resume) ctx.applyStage(ctx.active());

  return Object.freeze({
    /** Every intent's name (intents.js). */
    intents: INTENTS,
    /**
     * Run an intent. It always resolves, to the intent's result if it has
     * one, and rejects only for a name that is not an intent.
     */
    act(name, ...args) {
      if (!Object.hasOwn(intents, name))
        return Promise.reject(new Error(`Unknown chat view intent: ${name}`));
      try {
        return Promise.resolve(intents[name](...args));
      } catch (error) {
        return Promise.reject(error);
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      listener(snapshot());
      return () => listeners.delete(listener);
    },
    snapshot,
    /**
     * Hand the globe back to the panels at live time. The sessions keep
     * their own times; the panels' world timeline can move independently.
     */
    async release() {
      const wasPlaying = state.timePlaybackOwned;
      state.timePlaybackOwned = false;
      if (wasPlaying) engine.worldClock?.pause();
      engine.worldClock?.gate?.('chat-view', null);
      ctx.questions.halt();
      await ctx.superseded();
      applyTime({ mode: 'live' }, ctx.timeEngine);
    },
    destroy() {
      disposed = true;
      ctx.stage.stopPlaying();
      ctx.answers.cancel();
      ctx.agent?.close();
      store.flush();
      for (const cleanup of cleanups.splice(0)) cleanup?.();
      listeners.clear();
    },
  });
}
