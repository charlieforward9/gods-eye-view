/**
 * Answers that stay current. The open answer's rows re-run its query over
 * the records already in the browser, inside the session's time range.
 * Watched sessions that are not on screen poll a server tool instead, so a
 * watch costs no layer, no records and no rendering.
 */
import { formatNumber, t } from '../i18n/index.js';
import { eventsOf, plainSay, rowOf } from './answers.js';
import { queryInRange } from './timeWindow.js';

// At most this many watched sessions poll at once.
const MAX_BACKGROUND = 3;
// The server tool a turn's watch polls; turns saved before `watch` kept it
// on their plan.
const pollOf = (turn) => turn?.watch ?? turn?.plan?.background ?? null;

/** @param {object} ctx The kernel context (kernel.js). */
export function createWatches(ctx) {
  const { engine, store, state, feeds } = ctx;

  // A refreshed answer keeps its own sentence (a refresh has only the bare
  // count). A feed that fails says so instead of shrinking to zero; one
  // that recovers from that turns back into the count.
  const sayOf = (turn, query, result, items) => {
    const issues = feeds.issuesFor(query.layers || []);
    const blind = Boolean(issues.length) && !items.length;
    const wasBlind = turn.answer.ok === false && !turn.answer.rows?.length;
    // "No aircraft is squawking an emergency" cannot stay over a row that
    // squawks 7700, nor a top row over an empty list.
    const flipped = Boolean(items.length) !== Boolean(turn.answer.rows?.length);
    return {
      ok: !blind,
      say: blind
        ? issues[0]
        : wasBlind || flipped
          ? plainSay(result.say) ||
            (items.length
              ? t('{count} found.', {
                  count: formatNumber(result.count ?? items.length),
                })
              : turn.answer.say)
          : turn.answer.say,
      issue: blind ? null : issues[0] || null,
    };
  };

  return {
    async refresh() {
      const session = ctx.active();
      const turn = session?.turns.at(-1);
      if (!turn?.query || turn.status !== 'done' || state.busy || state.playing)
        return;
      // A rolling window moves with the clock.
      if (session.time?.mode === 'recent') ctx.applyStage(session, turn);
      const query = queryInRange(turn.query, session.time);
      let result;
      try {
        result = await engine.run('analyst_query', query);
      } catch {
        return;
      }
      if (!result?.ok || ctx.active()?.id !== session.id) return;
      const items = result.items || [];
      store.updateTurn(session.id, turn.id, {
        answer: {
          ...turn.answer,
          ...sayOf(turn, query, result, items),
          count: Number.isFinite(result.count)
            ? result.count
            : turn.answer.count,
          rows: items.slice(0, 5).map(rowOf),
          ids: items.map((item) => `${item.layerKey}:${item.id}`),
          events: eventsOf(items),
        },
      });
      ctx.emit();
    },

    async background() {
      const watched = store
        .sessions()
        .filter(
          (entry) =>
            entry.watch &&
            entry.id !== store.activeId() &&
            pollOf(entry.turns.at(-1)),
        )
        .slice(0, MAX_BACKGROUND);
      if (!watched.length || !ctx.loadCatalog) return;
      let tools;
      try {
        tools = await ctx.loadCatalog();
      } catch {
        return;
      }
      for (const entry of watched) {
        const { tool, args } = pollOf(entry.turns.at(-1));
        let result;
        try {
          result = await tools.call(tool, args);
        } catch {
          continue;
        }
        const ids = (result?.data?.rows || []).map(
          (row) => `earthquakes:${row.id}`,
        );
        const known = new Set([
          ...(entry.seen || []),
          ...(entry.watchSeen || []),
        ]);
        const fresh = ids.filter((id) => !known.has(id));
        // The first poll only learns what is there.
        const primed = Boolean(entry.watchSeen);
        store.update(entry.id, { watchSeen: ids });
        if (!fresh.length || !primed) continue;
        store.update(entry.id, {
          signals: (entry.signals || 0) + fresh.length,
        });
        state.signal = {
          sessionId: entry.id,
          title: entry.title,
          text: t('{count} new', { count: fresh.length }),
        };
        ctx.emit();
      }
    },
  };
}
