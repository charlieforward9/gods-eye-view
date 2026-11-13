/**
 * A place's weather by day as the chat view says it: "Yesterday in Palm Beach County:
 * heavy rain, a high of 81°F and a low of 72°F, with 1.70 in of rain." The
 * numbers come from the server's daily weather proxy (Open-Meteo); this
 * module only reads them, so it runs in node tests.
 */
import {
  formatDate,
  formatNumber,
  isolate,
  msg,
  t,
  tn,
} from '../i18n/index.js';

// WMO weather codes, as Open-Meteo reports them, in words that sit inside a
// sentence.
const CONDITIONS = [
  [[0], msg('clear skies')],
  [[1, 2], msg('partly cloudy')],
  [[3], msg('overcast')],
  [[45, 48], msg('fog')],
  [[51, 53, 55, 56, 57], msg('drizzle')],
  [[61, 66], msg('light rain')],
  [[63], msg('rain')],
  [[65, 67], msg('heavy rain')],
  [[71, 73, 75, 77], msg('snow')],
  [[80, 81], msg('rain showers')],
  [[82], msg('heavy rain showers')],
  [[85, 86], msg('snow showers')],
  [[95], msg('thunderstorms')],
  [[96, 99], msg('thunderstorms with hail')],
];

/** The words for a WMO weather code, translated, or null. */
export function conditionsOf(code) {
  const match = CONDITIONS.find(([codes]) => codes.includes(code));
  return match ? t(match[1]) : null;
}

/**
 * Whether a browser language reads weather in °F, inches and mph: the United
 * States and the two other countries that never went metric.
 */
export function imperialFor(language = '') {
  return /-(US|LR|MM)\b/i.test(String(language));
}

const value = (number, digits = 0) =>
  isolate(
    formatNumber(number, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }),
  );

export function temperatureText(celsius, imperial) {
  if (!Number.isFinite(celsius)) return null;
  return imperial
    ? `${value((celsius * 9) / 5 + 32)}°F`
    : `${value(celsius)}°C`;
}

/** Rain as an amount, "a trace", or null for none at all. */
export function rainText(mm, imperial) {
  if (!Number.isFinite(mm) || mm <= 0) return null;
  if (imperial)
    return mm / 25.4 < 0.01 ? t('a trace') : `${value(mm / 25.4, 2)} in`;
  return mm < 0.1 ? t('a trace') : `${value(mm, 1)} mm`;
}

export function speedText(kph, imperial) {
  if (!Number.isFinite(kph)) return null;
  return imperial ? `${value(kph / 1.609344)} mph` : `${value(kph)} km/h`;
}

// Gusts worth a sentence: a strong breeze and up.
const GUSTY_KPH = 50;

/** "Yesterday", "Today", "Tomorrow", or the weekday and date. */
function dayName(date, today) {
  const at = Date.parse(`${date}T12:00:00Z`);
  const offset = Math.round((at - Date.parse(`${today}T12:00:00Z`)) / 864e5);
  if (offset === -1) return t('Yesterday');
  if (offset === 0) return t('Today');
  if (offset === 1) return t('Tomorrow');
  return formatDate(at, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

function rowOfDay(entry, today, imperial, at) {
  const high = temperatureText(entry.highC, imperial);
  const low = temperatureText(entry.lowC, imperial);
  return {
    layerKey: 'weather-day',
    id: entry.date,
    name: dayName(entry.date, today),
    detail: [
      conditionsOf(entry.weatherCode),
      high && low ? `${high} / ${low}` : high || low,
      rainText(entry.precipitationMm, imperial) &&
        t('{rain} of rain', {
          rain: rainText(entry.precipitationMm, imperial),
        }),
    ]
      .filter(Boolean)
      .join(' · '),
    lat: at?.lat ?? null,
    lon: at?.lon ?? null,
  };
}

/**
 * The answer to a weather question from the proxy's days.
 * @param {{day?: number, days?: number, place?: string|null}} ask `day` is
 *   −1, 0 or 1; `days` asks for the days before today instead.
 * @param {{today: string, days: Array<object>}} daily From /api/weather-daily.
 * @param {{current?: object|null, imperial?: boolean,
 *   at?: {lat:number, lon:number}|null}} [options] `current` is the
 *   conditions now (/api/weather-effects), for a question about today.
 * @returns {{ok: boolean, say: string, items: Array<object>}}
 */
export function weatherAnswer(ask, daily, options = {}) {
  const { current = null, imperial = false, at = null } = options;
  const place = ask.place || t('this area');
  const list = daily?.days || [];
  const todayAt = list.findIndex((entry) => entry.date === daily?.today);
  if (todayAt < 0)
    return {
      ok: false,
      say: t('Weather by day is not available right now.'),
      items: [],
    };
  const items = list.map((entry) => rowOfDay(entry, daily.today, imperial, at));

  if (ask.days) {
    const past = list.slice(Math.max(0, todayAt - ask.days), todayAt);
    const total = past.reduce(
      (sum, entry) => sum + (entry.precipitationMm || 0),
      0,
    );
    const highs = past.map((entry) => entry.highC).filter(Number.isFinite);
    const rain = rainText(total, imperial);
    const fields = {
      place,
      rain,
      high: temperatureText(Math.max(...highs), imperial),
    };
    return {
      ok: true,
      say: rain
        ? tn(
            past.length,
            'The last {count} day in {place}: {rain} of rain, a high of {high}.',
            'The last {count} days in {place}: {rain} of rain in all, highs up to {high}.',
            fields,
          )
        : tn(
            past.length,
            'The last {count} day in {place}: no rain, a high of {high}.',
            'The last {count} days in {place}: no rain, highs up to {high}.',
            fields,
          ),
      items: items.slice(Math.max(0, todayAt - ask.days), todayAt),
    };
  }

  const entry = list[todayAt + (ask.day || 0)];
  if (!entry)
    return {
      ok: false,
      say: t('Weather by day is not available right now.'),
      items,
    };
  const fields = {
    day: dayName(entry.date, daily.today),
    place,
    conditions: conditionsOf(entry.weatherCode) || t('mixed conditions'),
    high: temperatureText(entry.highC, imperial),
    low: temperatureText(entry.lowC, imperial),
    rain: rainText(entry.precipitationMm, imperial),
  };
  const parts = [];
  if (!ask.day && Number.isFinite(current?.temperatureC))
    parts.push(
      t('Now in {place}: {conditions}, {temperature}.', {
        place,
        conditions: conditionsOf(current.weatherCode) || t('mixed conditions'),
        temperature: temperatureText(current.temperatureC, imperial),
      }),
      fields.rain
        ? t('Today: a high of {high}, a low of {low}, {rain} of rain.', fields)
        : t('Today: a high of {high}, a low of {low}, no rain.', fields),
    );
  else
    parts.push(
      fields.rain
        ? t(
            '{day} in {place}: {conditions}, a high of {high} and a low of {low}, with {rain} of rain.',
            fields,
          )
        : t(
            '{day} in {place}: {conditions}, a high of {high} and a low of {low}, and no rain.',
            fields,
          ),
    );
  if (entry.gustMaxKph >= GUSTY_KPH)
    parts.push(
      t('Gusts up to {gust}.', {
        gust: speedText(entry.gustMaxKph, imperial),
      }),
    );
  // The days around the asked one, in order.
  return { ok: true, say: parts.join(' '), items };
}
