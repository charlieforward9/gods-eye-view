import { mapChatTool } from '../../voice/mapChatTools.js';
import { msg, t } from '../../i18n/index.js';

// Where aircraft most often report jammed or spoofed GPS: [name, lat, lon].
const GNSS_HOTSPOTS = Object.freeze([
  [msg('Baltic Sea'), 58, 21],
  [msg('Kaliningrad'), 55, 20.5],
  [msg('Eastern Mediterranean'), 34.5, 33],
  [msg('Israel and Lebanon'), 32.8, 35.3],
  [msg('Black Sea'), 44, 34],
  [msg('Ukraine–Russia border'), 50, 38],
  [msg('Persian Gulf'), 27, 52],
  [msg('Red Sea'), 21, 39],
  [msg('Caucasus'), 41.5, 45],
  [msg('Myanmar'), 21, 96],
]);

/**
 * Where GPS is degraded right now: the aircraft-reported navigation
 * integrity around each usual hotspot, worst first, then the camera goes to
 * the worst one with the GPS layer on.
 */
export const gpsJamming = Object.freeze({
  name: 'find_gps_jamming',
  tool: mapChatTool('find_gps_jamming'),
  async run(_args, ctx, { signal } = {}) {
    const checked = [];
    for (let i = 0; i < GNSS_HOTSPOTS.length; i += 4) {
      const batch = GNSS_HOTSPOTS.slice(i, i + 4).map(
        async ([place, lat, lon]) => {
          const data = await ctx.fetchJson(
            `/api/gnss-integrity?lat=${lat}&lon=${lon}`,
            { signal },
          );
          if (!data) return null;
          const rows = data.rows || [];
          return {
            layerKey: 'gnss-region',
            id: place,
            name: t(place),
            lat,
            lon,
            total: rows.length,
            degraded: rows.filter((row) => row.degraded || row.gpsLost).length,
          };
        },
      );
      checked.push(...(await Promise.all(batch)).filter(Boolean));
      if (signal?.aborted) return { ok: false, cancelled: true };
    }
    if (!checked.length)
      return {
        ok: false,
        error: t('The GPS integrity feed is unreachable right now.'),
      };
    const items = checked.sort(
      (a, b) => b.degraded - a.degraded || b.total - a.total,
    );
    const worst = items[0];
    await ctx
      .run('fly_to_location', {
        latitude: worst.lat,
        longitude: worst.lon,
        viewMode: 'overview',
        rangeM: 1_400_000,
        waitForArrival: false,
      })
      .catch(() => {});
    await ctx
      .run('set_layer_visibility', {
        layerId: 'gnss-integrity',
        enabled: true,
      })
      .catch(() => {});
    return {
      ok: true,
      items,
      say: worst.degraded
        ? t(
            '{place}: {degraded} of {total} aircraft report degraded GPS right now, the most of {count} hotspots. That points to jamming; it does not prove it.',
            {
              place: worst.name,
              degraded: worst.degraded,
              total: worst.total,
              count: items.length,
            },
          )
        : t(
            'None of the {count} usual hotspots shows degraded GPS right now.',
            { count: items.length },
          ),
    };
  },
  forAgent: (result) =>
    result.ok
      ? {
          ok: true,
          summary: result.say,
          hotspots: result.items.map(({ name, total, degraded }) => ({
            name,
            aircraft: total,
            degraded,
          })),
        }
      : result,
});
