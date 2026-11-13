import * as Cesium from 'cesium';
import {
  EARTHQUAKE_OVERLAY_SOURCE_ID,
  EARTHQUAKE_OVERLAY_COHORT_LIMIT,
  EARTHQUAKE_OVERLAY_COLLISION_CAPACITY,
  depthColor,
  createEarthquakeOverlayEntry,
  selectEarthquakeOverlayCohort,
  mapAnalystRecord,
} from './model.js';
export * from './model.js';
export { createUsgsEarthquakeSource } from './source.js';

// A portable package (no i18n): the error stays English data and the layer
// panel shows it translated.
const msg = (text) => text;

/** Own one earthquake display and its refresh lifecycle. */
export function createEarthquakesLayer({ source, overlayHost } = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Earthquakes require a snapshot source');
  if (!overlayHost) throw new TypeError('Earthquakes require an overlay host');
  let _viewer = null;
  let _request = null;
  let _dataSource = null;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _enabled = false;
  // A caller's time range ({fromMs, toMs}); null shows the whole feed.
  let _window = null;
  // A caller's magnitude floor; 0 shows every event the feed has.
  let _minMagnitude = 0;
  // Which USGS feed loads: the past 'day', or the 'week' for a caller that
  // looks further back.
  let _feed = 'day';
  // Each event's overlay entry with its time and magnitude, so new params
  // refilter without a fetch.
  let _overlay = [];

  const inWindow = (time, magnitude) =>
    (!_minMagnitude || magnitude >= _minMagnitude) &&
    (!_window ||
      (Number.isFinite(time) &&
        time >= _window.fromMs &&
        time <= _window.toMs));

  const showWindow = () => {
    if (!_dataSource) return;
    const now = Cesium.JulianDate.now();
    for (const entity of _dataSource.entities.values)
      entity.show = inWindow(
        entity.properties?.time?.getValue(now),
        entity.properties?.mag?.getValue(now),
      );
    if (!_enabled) return;
    overlayHost.setEntries(
      EARTHQUAKE_OVERLAY_SOURCE_ID,
      selectEarthquakeOverlayCohort(
        _overlay
          .filter(({ time, magnitude }) => inWindow(time, magnitude))
          .map(({ entry }) => entry),
      ),
      {
        cohortLimit: EARTHQUAKE_OVERLAY_COHORT_LIMIT,
        collisionCapacity: EARTHQUAKE_OVERLAY_COLLISION_CAPACITY,
        moving: false,
      },
    );
  };

  const layer = {
    id: 'earthquakes',
    name: 'Earthquakes (24h)',
    icon: '🌋',
    source: 'USGS',
    updateInterval: 60000,

    init(viewer) {
      if (_viewer) throw new Error('Earthquake layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('earthquakes');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _enabled = false;
      overlayHost.setVisible(EARTHQUAKE_OVERLAY_SOURCE_ID, false);
      console.log('[Data:Earthquakes] Initialized');
    },

    enable(viewer) {
      _enabled = true;
      // No continuous-render hold: the discs are static geometry now, so the
      // layer has no per-frame animator to keep the render loop alive for.
      if (_dataSource) _dataSource.show = true;
      overlayHost.setVisible(EARTHQUAKE_OVERLAY_SOURCE_ID, true);
    },

    disable(viewer) {
      _request?.abort();
      _request = null;
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      overlayHost.clearSource(EARTHQUAKE_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(EARTHQUAKE_OVERLAY_SOURCE_ID, false);
    },

    async update(viewer) {
      if (!_enabled || !_dataSource) return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      try {
        const rows = await source.getSnapshot({
          signal: request.signal,
          feed: _feed,
        });
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;

        const nextEntities = [];
        let count = 0;
        const overlayEntries = [];

        for (const {
          stableId,
          usgsId,
          lon,
          lat,
          depthKm,
          mag,
          place,
          time,
        } of rows) {
          count++;
          const baseRadius = Math.pow(2, mag) * 1000;
          const color = depthColor(depthKm || 0);
          const isSignificant = mag >= 5.0;
          const fillAlpha = isSignificant ? 0.4 : 0.3;
          const outlineAlpha = isSignificant ? 1.0 : 0.8;

          const position = Cesium.Cartesian3.fromDegrees(lon, lat);
          nextEntities.push(
            new Cesium.Entity({
              id: `earthquake:${stableId}`,
              position,
              ellipse: {
                // Static axes — see the module header. A CallbackProperty here
                // re-tessellates the clamped ground geometry every frame.
                semiMajorAxis: baseRadius,
                semiMinorAxis: baseRadius,
                material: new Cesium.ColorMaterialProperty(
                  color.withAlpha(fillAlpha),
                ),
                outline: true,
                outlineColor: color.withAlpha(outlineAlpha),
                outlineWidth: isSignificant ? 3 : 2,
                heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
              },
              properties: {
                // Analyst seam (additive): the USGS event id (e.g. "us7000abcd").
                usgsId,
                mag,
                place,
                time,
                depth: depthKm,
              },
            }),
          );
          overlayEntries.push({
            time,
            magnitude: mag,
            entry: createEarthquakeOverlayEntry({
              id: String(stableId),
              position,
              magnitude: mag,
              accent: color.toCssColorString(),
            }),
          });
        }

        _dataSource.entities.removeAll();
        for (const entity of nextEntities) _dataSource.entities.add(entity);
        _overlay = overlayEntries;
        showWindow();

        _count = count;
        _lastUpdate = Date.now();
        _lastError = null;
        console.log(`[Data:Earthquakes] Updated: ${_count} events (M2.5+)`);
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:Earthquakes] Fetch error:', e);
        _lastError = e?.message || msg('Earthquake source unavailable');
        return false;
      } finally {
        if (_request === request) _request = null;
      }
    },

    destroy(viewer = _viewer) {
      _request?.abort();
      _request = null;
      _viewer = null;
      _enabled = false;
      overlayHost.clearSource(EARTHQUAKE_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(EARTHQUAKE_OVERLAY_SOURCE_ID, false);
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _overlay = [];
    },

    /**
     * Show only the events inside a time range, `{fromMs, toMs}`, and at or
     * above `minMagnitude`. A key a call leaves out keeps its value, and
     * null clears it (the whole feed, every magnitude). `feed: 'week'` loads
     * the past week from the next update on; 'day' or null the past day.
     * Analyst records stay unfiltered: a query names its own filters.
     * @param {{fromMs?: number|null, toMs?: number|null,
     *   minMagnitude?: number|null, feed?: 'day'|'week'|null}} [params]
     * @returns {boolean}
     */
    setParams(params = {}) {
      const given = (key) => Object.hasOwn(params, key);
      const number = (key) =>
        params[key] === null || params[key] === undefined
          ? NaN
          : Number(params[key]);
      if (given('feed')) {
        const feed = params.feed === 'week' ? 'week' : 'day';
        if (feed !== _feed) {
          _feed = feed;
          // Keep the prior map records visible during the switch, while
          // consumers waiting on a refresh require the requested feed.
          _request?.abort();
          _lastUpdate = null;
          _lastError = null;
        }
      }
      if (given('fromMs') || given('toMs')) {
        const fromMs = number('fromMs');
        const toMs = number('toMs');
        _window =
          Number.isFinite(fromMs) && Number.isFinite(toMs) && fromMs <= toMs
            ? { fromMs, toMs }
            : null;
      }
      if (given('minMagnitude')) {
        const minMagnitude = number('minMagnitude');
        _minMagnitude = Number.isFinite(minMagnitude) ? minMagnitude : 0;
      }
      showWindow();
      return true;
    },

    getParams() {
      return {
        ...(_window ? { ..._window } : {}),
        ...(_minMagnitude ? { minMagnitude: _minMagnitude } : {}),
        ...(_feed === 'week' ? { feed: 'week' } : {}),
      };
    },

    /**
     * Snapshot the layer's in-memory earthquake records as plain JSON-safe
     * objects for the analyst query engine. On-demand only (called at most
     * once per spoken query) — zero per-frame cost, no listeners, no caching.
     * Returns [] while the layer is disabled or empty.
     * @param {number} [maxCount=2000] - Maximum records to return (truncation).
     * @returns {Array<Object>} See mapAnalystRecord for the record shape.
     */
    getAnalystRecords(maxCount = 2000) {
      if (!_dataSource || !_dataSource.show) return [];
      const entities = _dataSource.entities.values;
      if (!entities.length) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 2000;
      const now = Cesium.JulianDate.now();
      const result = [];
      for (const entity of entities) {
        if (result.length >= limit) break;
        const cartesian = entity.position
          ? entity.position.getValue(now)
          : null;
        const carto = cartesian
          ? Cesium.Cartographic.fromCartesian(cartesian)
          : null;
        const p = entity.properties;
        result.push(
          mapAnalystRecord(
            {
              id: p?.usgsId?.getValue(now) ?? null,
              mag: p?.mag?.getValue(now),
              place: p?.place?.getValue(now),
              time: p?.time?.getValue(now),
              depth: p?.depth?.getValue(now),
              lat: carto ? Cesium.Math.toDegrees(carto.latitude) : null,
              lon: carto ? Cesium.Math.toDegrees(carto.longitude) : null,
            },
            result.length,
          ),
        );
      }
      return result;
    },

    getStats() {
      return {
        count: _count,
        lastUpdate: _lastUpdate,
        error: _lastError,
      };
    },
  };
  return layer;
}
