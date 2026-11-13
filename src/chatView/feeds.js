/**
 * What the layers' feeds say right now, read from `dataManager.getAll()`:
 * whether a layer has landed its records, why it can't (a key nobody set,
 * an outage, a regional fallback), and what a layer with nothing to count
 * shows. Answers and the open answer's refresh read feeds only through here.
 */
import { keySetupRequirementEnvVars } from '../keySetupCore.mjs';
import { formatNumber, t } from '../i18n/index.js';
import { drawsTiles, layerLabel } from './layers.js';
import { delay } from './wait.js';

// An environment variable a feed says is missing: "AISSTREAM_API_KEY not set".
const NAMED_KEY = /\b([A-Z][A-Z0-9_]*_(?:KEY|TOKEN|SECRET))\b[^.]*\bnot set\b/;
const REGIONAL = /regional fallback/i;

/**
 * @param {{dataManager: object, camera: {still: () => Promise<void>}}} options
 */
export function createFeeds({ dataManager, camera }) {
  const row = (id) => dataManager.getAll().find((entry) => entry.id === id);

  // Resolves once every named layer has landed a fetch since `since` (or
  // failed, or the wait times out), checked a few times a second.
  const waitForData = async (
    layerIds,
    signal,
    since = 0,
    timeoutMs = 12_000,
  ) => {
    const ready = () =>
      layerIds.every((id) => {
        const entry = row(id);
        if (!entry?.enabled || drawsTiles(id)) return true;
        const stats = entry.stats || {};
        return (
          (Number.isFinite(stats.lastUpdate) && stats.lastUpdate >= since) ||
          Boolean(stats.error)
        );
      });
    const until = Date.now() + timeoutMs;
    while (!ready() && Date.now() < until && !signal?.aborted)
      await delay(200, signal);
  };

  // A feed answering from a regional fallback covers where the camera was
  // when it fetched. After a flight, fetch it again where the question is.
  const prepare = async (layerIds, { flew, signal }) => {
    await waitForData(layerIds, signal);
    const regional = layerIds.filter((id) =>
      REGIONAL.test(String(row(id)?.stats?.coverage || '')),
    );
    if (!flew || !regional.length || signal?.aborted) return;
    await camera.still();
    const since = Date.now();
    for (const id of regional) dataManager.refreshLayer(id);
    await waitForData(regional, signal, since);
  };

  // Some feeds flag a missing key; others only name it in their error.
  const errorOf = (entry) => String(entry?.stats?.error || '');
  const lacksKey = (entry) =>
    entry?.stats?.keyRequired === true ||
    NAMED_KEY.test(errorOf(entry)) ||
    (Boolean(entry?.requiresKeyId) && /key required/i.test(errorOf(entry)));
  const keyOf = (entry) =>
    keySetupRequirementEnvVars(entry?.requiresKeyId) ||
    NAMED_KEY.exec(errorOf(entry))?.[1] ||
    t('API key');
  // A feed that needs a key nobody set is not down; it says which key.
  const keyMissing = (entry, name) =>
    t('No {envVars} is set up for {layer}, so it can’t load here.', {
      envVars: keyOf(entry),
      layer: name,
    });
  // A layer's error is English in data; the page shows it translated.
  const downSay = (name, stats) =>
    t('{layer} feed is down right now: {error}', {
      layer: name,
      error: t(stats.error),
    });

  return {
    row,
    waitForData,
    prepare,
    /** The key a layer's feed is missing, as its environment variable. */
    keyOf: (id) => keyOf(row(id)),
    /** Layers whose feed answered that its key is missing here. */
    needsKey: () =>
      new Set(
        dataManager
          .getAll()
          .filter(lacksKey)
          .map((entry) => entry.id),
      ),
    /** What is wrong with each layer's feed, in words a person can act on. */
    issuesFor: (layerIds) =>
      layerIds
        .map((id) => {
          const entry = row(id);
          if (!entry?.enabled) return null;
          const stats = entry.stats || {};
          const name = layerLabel(id);
          if (lacksKey(entry)) return keyMissing(entry, name);
          if (stats.error) return downSay(name, stats);
          if (REGIONAL.test(String(stats.coverage || '')))
            return t(
              '{layer} are limited right now: the worldwide feed is rate-limited, so only about 250 nm around the camera is covered.',
              { layer: name },
            );
          if (stats.stale)
            return t('{layer} data is stale; the feed has not refreshed.', {
              layer: name,
            });
          return null;
        })
        .filter(Boolean),
    /** What a layer without countable records shows right now. */
    describeFor: (layerIds) =>
      layerIds
        .map((id) => {
          const entry = row(id);
          const stats = entry?.stats || {};
          const name = layerLabel(id);
          if (lacksKey(entry)) return keyMissing(entry, name);
          if (stats.error) return downSay(name, stats);
          if (drawsTiles(id))
            return t('{layer} on the map. Zoom in to see the detail.', {
              layer: name,
            });
          if (id === 'gnss-integrity' && stats.levels) {
            const { high = 0, medium = 0 } = stats.levels;
            return high + medium
              ? t(
                  '{high} areas of strong and {medium} of moderate GPS interference in view, from aircraft reporting degraded navigation. It points to jamming; it does not prove it.',
                  { high, medium },
                )
              : t(
                  'No GPS interference in view right now. Try the Baltic or the eastern Mediterranean.',
                );
          }
          return Number.isFinite(stats.count) && stats.count
            ? t('{layer}: {count} on the globe.', {
                layer: name,
                count: formatNumber(stats.count),
              })
            : null;
        })
        .filter(Boolean),
    /** Whether every layer loaded without trouble and holds no records. */
    emptyFor: (layerIds) =>
      layerIds.every((id) => {
        const entry = row(id);
        const stats = entry?.stats || {};
        return (
          entry?.enabled &&
          Number.isFinite(stats.lastUpdate) &&
          !stats.error &&
          !stats.stale &&
          !REGIONAL.test(String(stats.coverage || ''))
        );
      }),
  };
}
