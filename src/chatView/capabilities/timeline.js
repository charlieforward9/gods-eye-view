import { mapChatTool } from '../../voice/mapChatTools.js';
import { t } from '../../i18n/index.js';
import { timeBounds, validateTime } from '../timelineModel.js';

// Legacy hosts without coverage ports retain the earthquake feed's week.
export const TIMELINE_DAYS = 7;
const DAY_MS = 86_400_000;

function requestedTime(args, now, bounds) {
  if (args.live) return { mode: 'live' };
  const hours = Number(args.hours_back);
  if (Number.isFinite(hours) && hours > 0) return { mode: 'recent', hours };
  const toMs = Date.parse(args.to);
  const fromMs = Date.parse(args.from);
  if (!Number.isFinite(fromMs) && !Number.isFinite(toMs)) return null;
  if (Number.isFinite(fromMs) && Number.isFinite(toMs) && fromMs > toMs)
    return null;
  const domain = timeBounds(bounds);
  const to = Number.isFinite(toMs)
    ? toMs
    : Math.min(domain?.end ?? now, Math.max(now, fromMs + 60_000));
  const from = Number.isFinite(fromMs) ? fromMs : to - DAY_MS;
  return { mode: 'range', fromMs: from, toMs: to };
}

/** A tool request inside its investigation's actual layer coverage. */
export function timelineOf(
  args = {},
  now = Date.now(),
  bounds = { startMs: now - TIMELINE_DAYS * DAY_MS, endMs: now },
) {
  if (args.live) return { mode: 'live' };
  if (bounds?.status && bounds.status !== 'ready') return null;
  const requested = requestedTime(args, now, bounds);
  if (!requested) return null;
  const checked = validateTime(requested, { now, bounds, strict: true });
  return checked.rejected ? null : checked.time;
}

/** The timeline every time-aware layer follows. */
export const timeline = Object.freeze({
  name: 'set_timeline',
  tool: mapChatTool('set_timeline'),
  async run(args, ctx) {
    const bounds = ctx.timeline?.();
    const now = Date.now();
    const time = timelineOf(args, now, bounds);
    if (!time)
      return {
        ok: false,
        code: 'TIME_UNAVAILABLE',
        error:
          bounds?.status === 'live-only'
            ? 'The investigation has live feeds only. Enable a layer with historical or forecast data first.'
            : bounds?.status === 'unavailable'
              ? 'These event sources have no shared period. Explore them separately.'
              : bounds?.status === 'loading'
                ? 'Time coverage is still loading. Enable the relevant layer and wait for its data.'
                : 'Choose a valid period inside the investigation’s available coverage.',
        coverage: bounds
          ? {
              startMs: bounds.startMs,
              endMs: bounds.endMs,
              intervalStartMs: bounds.intervalStartMs,
              intervalEndMs: bounds.intervalEndMs,
            }
          : null,
      };
    // Keep the original request at the kernel boundary, so its central
    // normalizer can surface a visible adjustment notice instead of losing
    // that evidence after the tool's preflight validation.
    const applied =
      ctx.setTime(bounds ? requestedTime(args, now, bounds) : time) || time;
    return {
      ok: true,
      timeline: applied,
      ...(time.mode === 'live' ? { say: t('Live time.') } : {}),
    };
  },
});
