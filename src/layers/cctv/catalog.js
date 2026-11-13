import { greatCircleKm } from '../../geoDistance.js';
import { CAMERA_SEEDS } from './policy.js';
import {
  lookupModelSpec,
  horizontalFovRangeDeg,
  fixedHorizontalFovDeg,
} from './modelSpecs.js';

/**
 * Applies datasheet enrichment to a camera in place: when it names a known
 * hardware `model` (and, when published, a matching `manufacturer`), the spec
 * record is attached for the HUD and the datasheet's horizontal FOV range
 * rides along as `specFovMinDeg`/`specFovMaxDeg`. Only fixed-lens hardware
 * fills the FOV, and only when none was given: an explicit source/seed
 * `fovDeg` or a curated pose is never overwritten. A PTZ/varifocal range says
 * what the lens CAN do, not where it is zoomed now.
 * Unknown models — the common case — change nothing.
 * @param {Object} camera - Camera being built (mutated).
 * @param {{model?:string, manufacturer?:string, explicitFov?:boolean}} hardware
 *   - Hardware model/manufacturer from a source or seed, and whether that
 *   source or seed stated its own `fovDeg`.
 * @param {(v:number,min:number,max:number)=>number} clamp - Pose clamp helper.
 */
function applyModelEnrichment(camera, hardware, clamp) {
  const { model, manufacturer, explicitFov } = hardware;
  const spec = model ? lookupModelSpec(model, manufacturer) : null;
  if (!spec) return;
  const range = horizontalFovRangeDeg(spec);
  if (range) {
    camera.specFovMinDeg = range.minDeg;
    camera.specFovMaxDeg = range.maxDeg;
  }
  const fixedFov = fixedHorizontalFovDeg(spec);
  if (fixedFov && !explicitFov && camera.poseSource !== 'curated') {
    camera.fovDeg = clamp(fixedFov, 20, 125);
    camera.fovSource = 'datasheet';
  }
  camera.spec = spec;
}

export function createCatalog({ state: layerState, services, parts, source }) {
  const { CITY_POIS } = services.locations;

  /**
   * Builds the initial camera catalog from CAMERA_SEEDS definitions.
   * Each seed is resolved against its city's POI coordinates, offset, and
   * passed through ensureCameraPose to populate derived fields.
   * @returns {Object[]} Array of fully-initialized camera objects.
   */

  function seedCatalog() {
    const catalog = [];
    for (const seed of CAMERA_SEEDS) {
      const city = CITY_POIS[seed.cityId];
      const poi = city?.pois?.[seed.poiIndex];
      if (!city || !poi) continue;
      const { latOffset, lonOffset } = parts.model.offsetDegrees(
        poi.lat,
        seed.offsetNorthM || 0,
        seed.offsetEastM || 0,
      );
      const camera = {
        id: seed.id,
        name: seed.label,
        cityId: seed.cityId,
        city: city.name,
        provider: 'OSM Camera Grid',
        sourceKind: 'seed',
        feedType: 'image',
        feedConfigured: false,
        headingConfidence: 'medium',
        lat: poi.lat + latOffset,
        lon: poi.lon + lonOffset,
        headingDeg: parts.model.normalizeHeading(
          seed.headingDeg ?? poi.heading ?? 0,
        ),
        fovDeg: parts.model.clamp(seed.fovDeg ?? 70, 20, 120),
        rangeM: parts.model.clamp(seed.rangeM ?? 700, 260, 1800),
        mountHeightM: parts.model.clamp(seed.elevationM ?? 22, 8, 80),
        groundElevationM: Number(city.groundElevation) || 0,
        absoluteHeightM:
          (Number(city.groundElevation) || 0) +
          parts.model.clamp(seed.elevationM ?? 22, 8, 80),
        pitchDeg: parts.model.clamp(seed.pitchDeg ?? -17, -40, -4),
      };
      applyModelEnrichment(
        camera,
        { model: seed.model, explicitFov: seed.fovDeg != null },
        parts.model.clamp,
      );
      parts.model.ensureCameraPose(camera);
      catalog.push(camera);
    }
    return catalog;
  }

  /**
   * Looks up a city ID from CITY_POIS by exact or partial name match.
   * @param {string} cityName
   * @returns {string|null} Matching city ID or null.
   */

  function cityIdByName(cityName) {
    const probe = String(cityName || '')
      .trim()
      .toLowerCase();
    if (!probe) return null;
    for (const [cityId, city] of Object.entries(CITY_POIS)) {
      if (city.name.toLowerCase() === probe) return cityId;
    }
    for (const [cityId, city] of Object.entries(CITY_POIS)) {
      if (
        city.name.toLowerCase().includes(probe) ||
        probe.includes(city.name.toLowerCase())
      )
        return cityId;
    }
    return null;
  }

  /**
   * Fetches configured camera sources from the backend.
   * @returns {Promise<Object[]>} Array of raw source objects, or empty on failure.
   */

  async function loadCameraSources(signal) {
    try {
      const data = await source.getCatalog({ signal });
      signal?.throwIfAborted();
      if (!Array.isArray(data?.sources)) return [];
      return data.sources;
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      return [];
    }
  }

  /**
   * Merges raw backend sources with seed data to produce the final camera catalog.
   * Seeds provide fallback values for heading, FOV, range, etc. when not specified
   * by the source. Each camera is passed through ensureCameraPose.
   * @param {Object[]} rawSources - Raw source objects from the backend.
   * @returns {Object[]} Array of fully-initialized camera objects.
   */

  function buildCatalogFromSources(rawSources) {
    const sources = Array.isArray(rawSources) ? rawSources : [];
    if (!sources.length) return [];

    const seeded = seedCatalog();
    const seedById = new Map(seeded.map((camera) => [camera.id, camera]));

    const catalog = [];
    for (const source of sources) {
      if (!source || typeof source !== 'object') continue;
      const id = String(source.id || '').trim();
      if (!id) continue;
      const seed = seedById.get(id);
      const cityId =
        String(source.cityId || '').trim() ||
        cityIdByName(source.city) ||
        seed?.cityId ||
        '';
      const city = cityId && CITY_POIS[cityId] ? CITY_POIS[cityId] : null;

      const lat = parts.model.safeNumber(source.lat, seed?.lat ?? NaN);
      const lon = parts.model.safeNumber(source.lon, seed?.lon ?? NaN);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

      const sourceHeading = parts.model.safeNumber(source.headingDeg, NaN);
      const headingDeg = parts.model.normalizeHeading(
        Number.isFinite(sourceHeading)
          ? sourceHeading
          : (seed?.headingDeg ?? parts.model.headingFromId(id)),
      );
      const fovDeg = parts.model.clamp(
        parts.model.safeNumber(source.fovDeg, seed?.fovDeg ?? 74),
        20,
        125,
      );
      // Same floor as the pose model (model.js): the packs' 145/210 m ranges
      // are intentional, and inflating them to 220 m pushed the monitor
      // plane's far edge into higher ground (owner field test 2026-09-13).
      const rangeM = parts.model.clamp(
        parts.model.safeNumber(source.rangeM, seed?.rangeM ?? 700),
        120,
        2200,
      );
      const mountHeightM = parts.model.clamp(
        parts.model.safeNumber(source.mountHeightM, seed?.mountHeightM ?? 24),
        6,
        120,
      );
      const pitchDeg = parts.model.clamp(
        parts.model.safeNumber(source.pitchDeg, seed?.pitchDeg ?? -17),
        -55,
        -2,
      );
      const groundElevationM = parts.model.safeNumber(
        source.groundElevationM,
        city?.groundElevation ?? seed?.groundElevationM ?? 0,
      );
      const feedType = parts.model.normalizeFeedType(
        source.feedType || source.type || 'image',
      );
      const headingConfidence = String(
        source.headingConfidence || (seed ? 'high' : 'low'),
      ).toLowerCase();
      // CAL badge input (design §3b passthrough): hand-authored file/env source
      // entries may carry poseSource:'curated'. Austin Open Data rows never set
      // this — they stay RAW PRIOR until a human manually calibrates them.
      const poseSource =
        source.poseSource === 'curated' ? 'curated' : seed?.poseSource || null;

      const camera = {
        id,
        name: String(source.name || seed?.name || id),
        cityId,
        city: String(source.city || city?.name || seed?.city || 'Global'),
        provider: String(
          source.provider || seed?.provider || 'Configured CCTV Source',
        ),
        sourceKind: String(
          source.sourceKind ||
            source.kind ||
            (source.url ? 'configured' : 'seed'),
        ).toLowerCase(),
        feedType,
        feedConfigured: typeof source.url === 'string' && !!source.url.trim(),
        lat,
        lon,
        headingDeg,
        headingConfidence,
        fovDeg,
        rangeM,
        mountHeightM,
        groundElevationM,
        absoluteHeightM: groundElevationM + mountHeightM,
        pitchDeg,
        frameRefreshMs: parts.model.safeNumber(source.frameRefreshMs, NaN),
        license: String(source.license || source.licenseNote || ''),
        credit: String(source.credit || ''),
        code: String(source.code || ''),
        sourceUrl: String(source.sourceUrl || ''),
        browserMediaUrl: String(source.browserMediaUrl || ''),
        accuracyM: parts.model.safeNumber(source.accuracyM, NaN),
        positionSource: String(source.positionSource || ''),
        // Shipped precompute (see server/providers/cctv/groundHeights.js).
        groundHeights:
          source.groundHeights && typeof source.groundHeights === 'object'
            ? source.groundHeights
            : null,
        poseSource,
        model: String(source.model || ''),
        manufacturer: String(source.manufacturer || ''),
      };
      applyModelEnrichment(
        camera,
        {
          model: source.model || seed?.model,
          manufacturer: source.model ? source.manufacturer : '',
          explicitFov:
            (source.fovDeg != null && Number.isFinite(Number(source.fovDeg))) ||
            CAMERA_SEEDS.some(
              (entry) => entry.id === id && entry.fovDeg != null,
            ),
        },
        parts.model.clamp,
      );
      parts.model.ensureCameraPose(camera);
      catalog.push(camera);
    }

    return catalog;
  }
  async function loadCatalog(signal) {
    const cameras = buildCatalogFromSources(await loadCameraSources(signal));
    return cameras.length ? cameras : seedCatalog();
  }

  // Probe only the closest cameras before enabling or moving the map.
  async function findNearestLiveCamera(point, { signal, radiusKm } = {}) {
    const search = AbortSignal.any(
      [signal, AbortSignal.timeout(24_000)].filter(Boolean),
    );
    const cameras = layerState._records.length
      ? layerState._records.map(({ camera }) => camera)
      : await loadCatalog(search);
    signal?.throwIfAborted();
    if (search.aborted) return null;
    const closest = cameras
      .map((camera) => ({ camera, distanceKm: greatCircleKm(point, camera) }))
      .filter(({ distanceKm }) => distanceKm <= radiusKm)
      .sort((a, b) => a.distanceKm - b.distanceKm)
      .slice(0, 6);
    if (!closest.length) return null;
    // Custom sources can use their existing health contract when they do not
    // expose an active probe. Only current provider media counts as ready.
    if (typeof source.isLive !== 'function') {
      const health = await source.getHealth({ signal: search });
      signal?.throwIfAborted();
      if (search.aborted) return null;
      const freshAfter = Date.now() - 60_000;
      const liveIds = new Set(
        health.cameras
          .filter(
            ({ status, sourceKind, updatedAt }) =>
              status === 'ok' &&
              ['snapshot', 'live', 'upstream-image', 'hls-pull'].includes(
                sourceKind,
              ) &&
              updatedAt >= freshAfter,
          )
          .map(({ id }) => id),
      );
      const best = closest.find(({ camera }) => liveIds.has(camera.id));
      return best ? { id: best.camera.id, distanceKm: best.distanceKm } : null;
    }
    const budget = AbortSignal.timeout(12_000);
    for (const { camera, distanceKm } of closest) {
      signal?.throwIfAborted();
      if (search.aborted || budget.aborted) break;
      const deadline = AbortSignal.any([
        search,
        budget,
        AbortSignal.timeout(3500),
      ]);
      try {
        if (
          (await source.isLive(camera, { signal: deadline })) &&
          !deadline.aborted
        ) {
          signal?.throwIfAborted();
          return { id: camera.id, distanceKm };
        }
      } catch {
        signal?.throwIfAborted();
      }
    }
    return null;
  }

  return {
    seedCatalog,
    cityIdByName,
    loadCatalog,
    buildCatalogFromSources,
    findNearestLiveCamera,
  };
}
