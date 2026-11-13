/**
 * Plain time data shared by the chat kernel and its shells. A query interval
 * filters events; its independent cursor moves the world's one clock. A
 * focused timeline takes the union of its investigation's sources, and keeps
 * each source's coverage so mixed investigations disclose partial coverage.
 */
export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;
const MAX_DATE_MS = 8.64e15;
const LIVE = Object.freeze({ mode: 'live' });
const WORLD_TIME = new Set([
  'satellites',
  'rocket-launches',
  'weather-radar',
  'weather-satellite',
  'weather-lightning',
]);

export const isTime = (value) =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  Math.abs(value) <= MAX_DATE_MS;

export function timeBounds(bounds) {
  const start = bounds?.startMs ?? bounds?.start;
  const end = bounds?.endMs ?? bounds?.end;
  return isTime(start) && isTime(end) && start <= end ? { start, end } : null;
}

/**
 * Validate at the boundary shared by restored sessions, planner, agent and UI.
 * Strict callers reject a request wholly outside coverage; restored sessions
 * recover at the nearest available moment and report why. No implicit week is
 * invented here: bounds come from the selected sources.
 */
export function validateTime(
  input,
  {
    bounds = null,
    now = Date.now(),
    strict = false,
    preservePeriod = false,
  } = {},
) {
  const answer = (time, reason = null, rejected = false) => ({
    time: Object.freeze(time),
    reason,
    rejected,
  });
  if (!input || input.mode === 'live') return answer(LIVE);
  if (bounds?.status === 'live-only') return answer(LIVE, 'live-only', strict);
  if (bounds?.status === 'unavailable')
    return answer(LIVE, 'no-overlap', strict);
  const cursorDomain = timeBounds(bounds);
  const domain =
    timeBounds({
      startMs: bounds?.intervalStartMs,
      endMs: bounds?.intervalEndMs,
    }) || cursorDomain;
  if (input.mode === 'recent') {
    const hours = Number(input.hours);
    if (!(hours > 0) || !Number.isFinite(hours))
      return answer(LIVE, 'invalid', strict);
    if (!domain) return answer({ mode: 'recent', hours });
    const to = Math.min(now, domain.end);
    if (to < domain.start) return answer(LIVE, 'outside', strict);
    const span = Math.min(hours * HOUR_MS, Math.max(0, to - domain.start));
    if (!span)
      return answer(
        { mode: 'range', fromMs: to, toMs: to, cursorMs: to },
        'clamped',
      );
    const reason = span < hours * HOUR_MS ? 'clamped' : null;
    // A source whose newest frame is historical cannot claim a rolling live edge.
    return to < now - 5000
      ? answer(
          { mode: 'range', fromMs: to - span, toMs: to, cursorMs: to },
          reason,
        )
      : answer({ mode: 'recent', hours: span / HOUR_MS }, reason);
  }
  if (input.mode !== 'range' || !isTime(input.fromMs) || !isTime(input.toMs))
    return answer(LIVE, 'invalid', strict);
  let from = Math.min(input.fromMs, input.toMs);
  let to = Math.max(input.fromMs, input.toMs);
  let cursor = isTime(input.cursorMs) ? input.cursorMs : to;
  let reason = from !== input.fromMs ? 'clamped' : null;
  if (domain) {
    const outside = to < domain.start || from > domain.end;
    if (outside && strict) return answer(LIVE, 'outside', true);
    if (outside) {
      const edge = to < domain.start ? domain.start : domain.end;
      const width = Math.min(to - from, domain.end - domain.start);
      from = edge === domain.start ? edge : edge - width;
      to = edge === domain.end ? edge : edge + width;
      reason = 'expired';
    } else if (!preservePeriod) {
      const nextFrom = Math.max(domain.start, from);
      const nextTo = Math.min(domain.end, to);
      if (nextFrom !== from || nextTo !== to) reason = 'clamped';
      from = nextFrom;
      to = nextTo;
    }
    const nextCursor = Math.max(
      (cursorDomain || domain).start,
      Math.min((cursorDomain || domain).end, cursor),
    );
    if (cursor !== nextCursor && !reason) reason = 'clamped';
    cursor = nextCursor;
  }
  const value = { mode: 'range', fromMs: from, toMs: to };
  if (isTime(input.cursorMs) || cursor !== to) value.cursorMs = cursor;
  if (input.cursorLive === true) value.cursorLive = true;
  return answer(value, reason);
}

/** The newest question chooses the investigation; otherwise use enabled layers. */
export function investigationLayers(session, rows = []) {
  const last = session?.turns?.at(-1);
  const asked = last?.query?.layers || last?.plan?.layers;
  return [
    ...new Set(
      asked?.length
        ? asked
        : rows
            .filter((row) => row.enabled && row.showInTogglePanel !== false)
            .map((row) => row.id),
    ),
  ];
}

export function timeCoverage({
  session = null,
  rows = [],
  worldClock = null,
  weatherClock = null,
  now = Date.now(),
} = {}) {
  const ids = investigationLayers(session, rows);
  const events = (session?.turns?.at(-1)?.answer?.events || [])
    .map((event) => event.t)
    .filter(isTime);
  const layers = ids.map((id) => {
    const label =
      rows.find((row) => row.id === id)?.label ||
      rows.find((row) => row.id === id)?.name ||
      id;
    let span = null;
    let kind = 'live';
    let status = 'live-only';
    if (id === 'earthquakes') {
      kind = 'window';
      span = { start: now - 7 * DAY_MS, end: now, marks: events };
    } else if (id === 'local-firms') {
      // FIRMS offers its current 24-hour snapshot, not a historical archive.
      kind = 'window';
      const stats = rows.find((row) => row.id === id)?.stats || {};
      const end = isTime(stats.at) ? stats.at : now;
      if (isTime(stats.lastUpdate) || isTime(stats.at))
        span = { start: end - DAY_MS, end, marks: events };
      status =
        stats.keyRequired || stats.sourceUnavailable ? 'live-only' : 'loading';
    } else {
      span = worldClock?.coverageFor?.([id]) ?? null;
      // A live contact source joins the world clock only when it declares
      // historical snapshots. A following source can still be loading coverage.
      if (span || worldClock?.follows?.(id) || WORLD_TIME.has(id)) {
        kind = 'cursor';
        status = 'loading';
        // Older portable hosts expose only one weather clock. Its frames are
        // usable when this investigation names exactly one weather product.
        if (
          !span &&
          !worldClock?.coverageFor &&
          ids.length === 1 &&
          id.startsWith('weather-')
        ) {
          const marks = (weatherClock?.getTimeline?.() || [])
            .map(Date.parse)
            .filter(isTime);
          if (marks.length)
            span = {
              start: Math.min(...marks),
              end: Math.max(...marks),
              marks,
            };
        }
      }
    }
    const bounds = timeBounds(span);
    if (bounds) status = 'ready';
    return Object.freeze({
      id,
      label,
      kind,
      status,
      startMs: bounds?.start ?? null,
      endMs: bounds?.end ?? null,
      marks: Object.freeze(
        (span?.marks || []).filter(
          (mark) =>
            isTime(mark) &&
            bounds &&
            mark >= bounds.start &&
            mark <= bounds.end,
        ),
      ),
    });
  });
  const ready = layers.filter((layer) => layer.status === 'ready');
  const windows = ready.filter((layer) => layer.kind === 'window');
  const intervalStart = windows.length
    ? Math.max(...windows.map((layer) => layer.startMs))
    : null;
  const intervalEnd = windows.length
    ? Math.min(...windows.map((layer) => layer.endMs))
    : null;
  const disjoint = windows.length > 1 && intervalStart > intervalEnd;
  return Object.freeze({
    status: disjoint
      ? 'unavailable'
      : ready.length
        ? 'ready'
        : !layers.length || layers.some((layer) => layer.status === 'loading')
          ? 'loading'
          : 'live-only',
    startMs: ready.length
      ? Math.min(...ready.map((layer) => layer.startMs))
      : null,
    endMs: ready.length ? Math.max(...ready.map((layer) => layer.endMs)) : null,
    intervalStartMs: intervalStart,
    intervalEndMs: intervalEnd,
    nowMs: now,
    marks: Object.freeze(
      [...new Set(ready.flatMap((layer) => layer.marks))].sort((a, b) => a - b),
    ),
    layers: Object.freeze(layers),
  });
}

/** A scrub moves only the cursor; the event query's selected interval stays put. */
export function seekTime(time, cursorMs, timeline) {
  const bounds = timeBounds(timeline);
  if (!bounds || !isTime(cursorMs)) return LIVE;
  const at = Math.max(bounds.start, Math.min(bounds.end, cursorMs));
  const now = timeline.nowMs;
  if (
    Math.abs(at - now) <= Math.max(5000, (bounds.end - bounds.start) * 0.0005)
  ) {
    if (time?.mode === 'recent')
      return validateTime(time, { bounds: timeline, now }).time;
    if (time?.mode === 'range')
      return validateTime(
        { ...time, cursorMs: now, cursorLive: true },
        { bounds: timeline, now, preservePeriod: true },
      ).time;
    return LIVE;
  }
  const width = Math.min(DAY_MS, bounds.end - bounds.start);
  const interval =
    time?.mode === 'range'
      ? time
      : time?.mode === 'recent'
        ? { fromMs: now - Number(time.hours) * HOUR_MS, toMs: now }
        : {
            fromMs: Math.max(bounds.start, Math.min(now, bounds.end) - width),
            toMs: Math.min(now, bounds.end),
          };
  return validateTime(
    {
      mode: 'range',
      fromMs: interval.fromMs,
      toMs: interval.toMs,
      cursorMs: at,
    },
    { bounds: timeline, now, preservePeriod: time?.mode === 'range' },
  ).time;
}
