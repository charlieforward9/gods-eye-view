import { mapChatTool } from '../../voice/mapChatTools.js';
import { t } from '../../i18n/index.js';
import { OPEN_METEO } from '../sources.js';
import { weatherAnswer } from '../weather.js';
import { TIMELINE_DAYS } from './timeline.js';

const clampDay = (value, fallback) => {
  const day = Math.round(Number(value));
  return Number.isFinite(day)
    ? Math.max(-TIMELINE_DAYS, Math.min(TIMELINE_DAYS, day))
    : fallback;
};

/**
 * A place's weather by day from the server's daily weather (Open-Meteo):
 * observed days up to a week back, forecast days up to a week ahead, and
 * the conditions now for a question about today.
 */
export const weatherByDay = Object.freeze({
  name: 'get_weather_by_day',
  source: OPEN_METEO,
  tool: mapChatTool('get_weather_by_day'),
  async run(args, ctx, { signal } = {}) {
    const from = clampDay(args.from_day, -1);
    const to = Math.max(from, clampDay(args.to_day, from));
    const at =
      Number.isFinite(args.latitude) && Number.isFinite(args.longitude)
        ? { lat: args.latitude, lon: args.longitude }
        : args.place
          ? await ctx.resolvePlace(args.place, { signal }).catch(() => null)
          : ctx.viewPoint();
    if (!at)
      return {
        ok: false,
        error: args.place
          ? t('Could not find {place}.', { place: args.place })
          : t('Name a place for its weather.'),
      };
    const point = `latitude=${at.lat.toFixed(4)}&longitude=${at.lon.toFixed(4)}`;
    const today = from === 0 && to === 0;
    const [daily, now] = await Promise.all([
      ctx.fetchJson(
        `/api/weather-daily?${point}&past=${Math.max(1, -from)}&ahead=${Math.max(1, to)}`,
        { signal },
      ),
      today ? ctx.fetchJson(`/api/weather-effects?${point}`, { signal }) : null,
    ]);
    if (signal?.aborted) return { ok: false, cancelled: true };
    const single = from === to;
    const place = args.place || null;
    const answer = weatherAnswer(
      single ? { day: from, place } : { days: Math.max(1, -from), place },
      daily,
      { current: now?.weather ?? null, imperial: ctx.imperial, at },
    );
    if (!answer.ok) return { ok: false, error: answer.say, items: [] };
    const todayAt = daily.days.findIndex((day) => day.date === daily.today);
    return {
      ok: true,
      say: answer.say,
      items: answer.items,
      // A run of days ahead has no one sentence; the agent reads the days.
      summary: single || to < 0 ? answer.say : null,
      data: {
        place,
        timezone: daily.timezone,
        days: daily.days.slice(
          Math.max(0, todayAt + from),
          Math.max(0, todayAt + to) + 1,
        ),
      },
      source: OPEN_METEO,
    };
  },
  forAgent: (result) =>
    result.ok
      ? { ok: true, summary: result.summary, data: result.data }
      : { ok: false, error: result.error },
});
