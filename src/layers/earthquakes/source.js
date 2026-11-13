import { normalizeEarthquakeSnapshot } from './records.js';
// USGS's summary feeds: the past day, or the past week for a caller that
// looks further back.
const FEED_URLS = Object.freeze({
  day: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson',
  week: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_week.geojson',
});
/** Request and validate a complete USGS snapshot before it can replace displayed events. */
export function createUsgsEarthquakeSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async getSnapshot({ signal, feed = 'day' } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl(FEED_URLS[feed] || FEED_URLS.day, {
        signal,
      });
      if (!response.ok) throw new Error(`USGS HTTP ${response.status}`);
      const payload = await response.json();
      signal?.throwIfAborted();
      const rows = normalizeEarthquakeSnapshot(payload);
      if (!rows) throw new Error('Malformed USGS response');
      return rows;
    },
  };
}
