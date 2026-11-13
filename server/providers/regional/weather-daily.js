import { makeRateLimiter, clientKey } from '../common/rate-limit.js';
import { clampInt } from '../common/query.js';
import { coalesceProxyRequest } from '../common/http.js';
import { fetchRegionalJson } from './http.js';
import { validRegionalPoint } from './query.js';

// A place's weather by day from Open-Meteo, which needs no key: up to a week
// before today (`past`) through up to a week after it (`ahead`), each day in
// the place's own time zone. Past days are observations; they change little,
// so an answer is kept for half an hour.
const WEATHER_DAILY_CACHE_MS = 30 * 60_000;

const WEATHER_DAILY_STALE_MS = 6 * 60 * 60_000;

const WEATHER_DAILY_MAX_CACHE = 180;

const WEATHER_DAILY_MAX_RESPONSE_BYTES = 256 * 1024;

const MAX_DAYS = 7;

const DAILY_FIELDS = [
  'weather_code',
  'temperature_2m_max',
  'temperature_2m_min',
  'precipitation_sum',
  'precipitation_hours',
  'wind_speed_10m_max',
  'wind_gusts_10m_max',
].join(',');

const _weatherDailyCache = new Map();

const _weatherDailyInFlight = new Map();

const _weatherDailyRateLimiter = makeRateLimiter({
  windowMs: 60_000,
  max: 30,
  globalMax: 90,
});

function trimWeatherDailyCache() {
  while (_weatherDailyCache.size > WEATHER_DAILY_MAX_CACHE) {
    const oldest = _weatherDailyCache.keys().next().value;
    if (oldest === undefined) break;
    _weatherDailyCache.delete(oldest);
  }
}

const observed = (value) =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/**
 * Open-Meteo's `daily` columns as one record a day, oldest first, or null
 * when the payload holds no days.
 * @param {object} payload
 * @param {number} past How many of the days come before today.
 */
export function normalizeDailyWeather(payload, past = 0) {
  const daily = payload?.daily;
  const dates = Array.isArray(daily?.time) ? daily.time : [];
  if (!dates.length) return null;
  const column = (name, i) => observed(daily[name]?.[i]);
  const days = dates.map((date, i) => ({
    date: String(date),
    weatherCode: column('weather_code', i),
    highC: column('temperature_2m_max', i),
    lowC: column('temperature_2m_min', i),
    precipitationMm: column('precipitation_sum', i),
    precipitationHours: column('precipitation_hours', i),
    windMaxKph: column('wind_speed_10m_max', i),
    gustMaxKph: column('wind_gusts_10m_max', i),
  }));
  return {
    timezone: typeof payload.timezone === 'string' ? payload.timezone : null,
    today: days[Math.min(past, days.length - 1)].date,
    days,
  };
}

async function fetchDailyWeather(point, past, ahead) {
  const params = new URLSearchParams({
    latitude: point.latitude.toFixed(4),
    longitude: point.longitude.toFixed(4),
    daily: DAILY_FIELDS,
    past_days: String(past),
    // Open-Meteo counts today among the forecast days.
    forecast_days: String(ahead + 1),
    timezone: 'auto',
  });
  try {
    const payload = await fetchRegionalJson(
      `https://api.open-meteo.com/v1/forecast?${params}`,
      { maxBytes: WEATHER_DAILY_MAX_RESPONSE_BYTES, redirect: 'error' },
    );
    return normalizeDailyWeather(payload, past);
  } catch {
    return null;
  }
}

function weatherDailyProxy() {
  async function refresh(point, past, ahead, key) {
    const daily = await fetchDailyWeather(point, past, ahead);
    if (!daily) throw new Error('Daily weather unavailable');
    const payload = {
      status: 'ready',
      retrievedAt: new Date().toISOString(),
      coordinates: point,
      ...daily,
    };
    _weatherDailyCache.set(key, { payload, cachedAt: Date.now() });
    trimWeatherDailyCache();
    return payload;
  }

  function install(middlewares) {
    middlewares.use('/api/weather-daily', async (req, res) => {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method Not Allowed' }));
        return;
      }
      if (!_weatherDailyRateLimiter(clientKey(req))) {
        res.writeHead(429, {
          'Content-Type': 'application/json',
          'Retry-After': '10',
        });
        res.end(JSON.stringify({ error: 'Rate limit exceeded' }));
        return;
      }
      const url = new URL(req.url || '', 'http://localhost');
      const point = validRegionalPoint(url.searchParams);
      if (!point) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: 'Valid latitude and longitude are required',
          }),
        );
        return;
      }
      const past = clampInt(url.searchParams.get('past'), 0, MAX_DAYS, 1);
      const ahead = clampInt(url.searchParams.get('ahead'), 0, MAX_DAYS, 1);
      const key = `${(Math.round(point.latitude * 10) / 10).toFixed(1)},${(Math.round(point.longitude * 10) / 10).toFixed(1)}:${past}:${ahead}`;
      const now = Date.now();
      const cached = _weatherDailyCache.get(key);
      if (cached && now - cached.cachedAt <= WEATHER_DAILY_CACHE_MS) {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=300',
          'X-Weather-Daily': 'HIT',
        });
        res.end(JSON.stringify({ ...cached.payload, status: 'cached' }));
        return;
      }
      const request = coalesceProxyRequest(_weatherDailyInFlight, key, () =>
        refresh(point, past, ahead, key),
      );
      try {
        const payload = await request.promise;
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=300',
          'X-Weather-Daily': request.shared ? 'INFLIGHT' : 'MISS',
        });
        res.end(JSON.stringify(payload));
      } catch {
        if (cached && now - cached.cachedAt <= WEATHER_DAILY_STALE_MS) {
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            'X-Weather-Daily': 'STALE',
          });
          res.end(JSON.stringify({ ...cached.payload, status: 'stale' }));
          return;
        }
        res.writeHead(503, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(
          JSON.stringify({ error: 'Daily weather is temporarily unavailable' }),
        );
      }
    });
  }

  return {
    name: 'weather-daily-proxy',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}

export { weatherDailyProxy };
