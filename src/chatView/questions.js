/**
 * A question from the composer to the answer on screen. GEV's own agent
 * answers; the rule planner answers the chat view's own controls (Reset,
 * the map picker) and every question when the agent cannot be reached (an
 * install with no OpenAI key or ChatGPT sign-in).
 *
 * Every question counts a generation (`state.generation`), as does whatever
 * replaces it (a stop, a restore, another session): a question that resumes
 * after an await to find a newer generation gives way, so a stopped or
 * replaced question never lands its answer later.
 */
import { t } from '../i18n/index.js';
import { answerOfSteps, verbOf } from './answers.js';
import { isLocal } from './capabilities/index.js';
import { layerLabel } from './layers.js';
import { parseSlash } from './commands.js';
import { planQuestion } from './planner.js';
import { NEW_SESSION_TITLE } from './sessions.js';
import { captureView } from './views.js';

const ZOOMED_IN_M = 2_500_000;

const slimPlan = (plan) => ({
  intent: plan.intent,
  title: plan.title,
  layers: plan.layers,
  hours: plan.hours,
  background: plan.background,
  suggestions: plan.suggestions,
});

// A session named by its first question, as asked.
const titleOf = (question) => {
  const text = question.replace(/[?!.]+$/, '').trim();
  const short =
    text.length > 48 ? `${text.slice(0, 47).replace(/\s+\S*$/, '')}…` : text;
  return short.charAt(0).toUpperCase() + short.slice(1);
};

// The layers an agent's steps put on screen, for the session's grouping.
const layersOfSteps = (steps) => [
  ...new Set(
    steps.flatMap((step) =>
      step.name === 'set_layer_visibility' && step.args.enabled !== false
        ? [step.args.layerId]
        : step.name === 'analyst_query'
          ? step.args.layers || []
          : [],
    ),
  ),
];

/**
 * A `/command` as GEV's agent reads it: the command's words, and the
 * actions it stands for as a hint.
 */
function commandText(slash) {
  const words = `${slash.command.label} ${slash.rest}`.trim();
  const actions = slash.command.actions.join(', ');
  return actions
    ? `[The person picked the ${slash.command.label} command; it answers with ${actions}.]\n${words}`
    : words;
}

/** @param {object} ctx The kernel context (kernel.js). */
export function createQuestions(ctx) {
  const { engine, host, store, state, feeds, answers } = ctx;
  // A cancelled agent answer still finishes its tool in flight; the stage
  // waits for it.
  const agentWork = new Set();

  const zoomedIn = () =>
    (engine.styleManager.getCameraState?.()?.alt ?? Infinity) < ZOOMED_IN_M;

  // GEV's agent's answer, or null when it cannot be reached.
  async function agentAnswer(text, chips, session, onStep) {
    const work = ctx.agent.ask(
      ctx.context.forAgent(text, chips, session.time),
      {
        onStep: (said, step) =>
          onStep(step ? verbOf(step.name, step.args) : said),
      },
    );
    const done = work.then(
      () => {},
      () => {},
    );
    agentWork.add(done);
    done.then(() => agentWork.delete(done));
    let reply;
    try {
      reply = await work;
    } catch {
      return null;
    }
    if (reply.cancelled) return { cancelled: true };
    return {
      ...answerOfSteps(reply.steps, reply.say),
      ...(reply.partial && {
        ok: false,
        partial: true,
        issue: reply.detail || reply.say,
      }),
      layers: layersOfSteps(reply.steps),
    };
  }

  // The rule planner's answer.
  async function plannedAnswer(
    question,
    context,
    plan,
    session,
    onStep,
    stale,
  ) {
    // The cockpit owns the camera; a question that is not about it leaves.
    if (
      host.surfaces.cockpit() &&
      !plan.calls.some((call) => call.name === 'control_cockpit')
    )
      await engine.run('control_cockpit', { action: 'exit' }).catch(() => {});
    // A question that names a span moves the session's time range with it.
    // A question's span lasts until a question that names none; a range set
    // on the time track stays until the track or Live moves it.
    if (plan.hours)
      ctx.setTimeFor(session, { mode: 'recent', hours: plan.hours }, { plan });
    else if (session.time?.mode === 'recent')
      ctx.setTimeFor(session, { mode: 'live' });
    let result = await answers.answer(plan, { onStep });
    // A layer that turns out to need a missing key answers through its
    // keyless stand-in instead, once, in the same turn.
    if (!result.cancelled && !result.ok && !plan.standIn) {
      const retry = planQuestion(question, {
        ...context,
        unavailable: feeds.needsKey(),
      });
      if (retry.standIn) {
        await engine
          .run('set_layer_visibility', {
            layerId: retry.standIn.from,
            enabled: false,
          })
          .catch(() => {});
        if (stale()) return null;
        plan = retry;
        result = await answers.answer(plan, { onStep });
      }
    }
    // The stand-in says so for as long as the answer is up; a refresh keeps
    // `note` and recomputes only the feed's own `issue`.
    if (!result.cancelled && plan.standIn)
      result.note = t('No {envVars} is set up for {from}, so this uses {to}.', {
        envVars: feeds.keyOf(plan.standIn.from),
        from: layerLabel(plan.standIn.from),
        to: layerLabel(plan.standIn.to),
      });
    return { ...result, plan, layers: plan.layers };
  }

  async function ask(text, givenChips = []) {
    const question = String(text || '').trim();
    if (!question) return;
    state.timeContext = null;
    state.timeNotice = null;
    const generation = ++state.generation;
    const stale = () => generation !== state.generation;
    ctx.stage.stopPlaying();
    state.restoring?.abort();
    await ctx.stage.settled();
    if (stale()) return;
    const session = ctx.active() || store.create({});
    const last = session.turns.at(-1);
    const chips = await ctx.context.implied(question, givenChips);
    if (stale()) return;
    const context = {
      chips,
      zoomedIn: zoomedIn(),
      hasRows: Boolean(last?.answer?.rows?.length),
      rows: last?.answer?.rows || [],
    };
    let plan = planQuestion(question, {
      ...context,
      unavailable: feeds.needsKey(),
    });
    // The chat view's own controls are the planner's; everything else is
    // the agent's while it can be reached, a /command too.
    const viaAgent =
      Boolean(ctx.agent?.ready()) &&
      !plan.calls.some((call) => isLocal(call.name));
    const slash = parseSlash(question);
    const turn = store.addTurn(session.id, {
      q: question,
      chips: chips.map((chip) => chip.label).filter(Boolean),
      plan: viaAgent ? null : slimPlan(plan),
      // What a watch polls while the session is not on screen, whichever
      // of the two answers.
      watch: plan.background || null,
      answer: null,
      view: null,
      query: null,
      status: 'running',
    });
    // A new session takes its first question's title; a seed or a name the
    // person gave stays.
    const title = viaAgent
      ? titleOf(slash ? `${t(slash.command.label)} ${slash.rest}` : question)
      : plan.intent !== 'unknown'
        ? plan.title
        : null;
    if (
      session.turns.length === 1 &&
      session.title === NEW_SESSION_TITLE &&
      title
    )
      store.update(session.id, { title });
    state.focus = null;
    state.busy = { turnId: turn.id, label: t('Thinking') };
    ctx.emit();
    const giveWay = () => {
      store.updateTurn(session.id, turn.id, { status: 'cancelled' });
      if (state.busy?.turnId === turn.id) state.busy = null;
      ctx.emit();
    };
    const onStep = (label) => {
      if (state.busy?.turnId !== turn.id || !label) return;
      state.busy = { ...state.busy, label };
      ctx.emit();
    };
    let result = viaAgent
      ? await agentAnswer(
          slash ? commandText(slash) : question,
          chips,
          session,
          onStep,
        )
      : null;
    if (stale()) return giveWay();
    if (!result) {
      if (viaAgent)
        store.updateTurn(session.id, turn.id, { plan: slimPlan(plan) });
      if (plan.intent === 'unknown') {
        store.updateTurn(session.id, turn.id, {
          status: 'done',
          answer: { ok: false, say: plan.say, rows: [], verbs: [], ids: [] },
        });
        state.busy = null;
        ctx.emit();
        return;
      }
      const planned = await plannedAnswer(
        question,
        context,
        plan,
        session,
        onStep,
        stale,
      );
      if (!planned || stale()) return giveWay();
      ({ plan, ...result } = planned);
      store.updateTurn(session.id, turn.id, { plan: slimPlan(plan) });
    }
    if (result.cancelled || stale()) return giveWay();
    const { query, layers, ...answer } = result;
    store.updateTurn(session.id, turn.id, {
      status: 'done',
      answer,
      query: query || null,
    });
    store.update(session.id, {
      seen: answer.ids,
      layers: layers || plan.layers,
    });
    ctx.applyStage(store.get(session.id));
    if (state.busy?.turnId === turn.id) state.busy = null;
    // The view as it stands now, kept if something replaces this answer
    // before the camera lands.
    const capture = () =>
      captureView({
        styleManager: engine.styleManager,
        dataManager: engine.dataManager,
        follow: answer.follow,
        time: store.get(session.id)?.time,
      });
    store.updateTurn(session.id, turn.id, { view: capture() });
    ctx.emit();
    // The view an answer leaves: after the camera lands, or at once when
    // the answer follows something (the follow owns the camera).
    if (!answer.follow) await ctx.camera.still();
    // A view taken after something replaced this answer would be that
    // thing's view; the one kept above stays.
    if (stale() || store.activeId() !== session.id) return;
    store.updateTurn(session.id, turn.id, { view: capture() });
    ctx.emit();
  }

  return {
    ask,
    /** The agent's answers still finishing a step, for `ctx.superseded()`. */
    pending: () => [...agentWork],
    /**
     * Stop the answer under way; stopped is stopped at once, not when the
     * step in flight returns.
     */
    halt() {
      const turnId = state.busy?.turnId;
      ctx.supersede({ agent: 'cancel' });
      const session = ctx.active();
      const turn =
        turnId && session?.turns.find((entry) => entry.id === turnId);
      if (turn?.status === 'running')
        store.updateTurn(session.id, turn.id, { status: 'cancelled' });
      state.busy = null;
    },
  };
}
