import { mapChatTool } from '../../voice/mapChatTools.js';
import { t } from '../../i18n/index.js';
import { layerLabel } from '../layers.js';
import { delay } from '../wait.js';

// The dense catalog adds the Starlink shell: thousands of points.
const DENSE_EXTRA = 500;
const DENSE_WAIT_MS = 25_000;

/**
 * The satellites layer's catalog: the core set, or the dense one with the
 * whole Starlink shell. An answer about every Starlink needs the dense one.
 */
export const satelliteCatalog = Object.freeze({
  name: 'set_satellite_catalog',
  tool: mapChatTool('set_satellite_catalog'),
  async run(args, ctx, { signal } = {}) {
    const catalog = args.catalog === 'core' ? 'core' : 'dense';
    const count = () => Number(ctx.feeds.row('satellites')?.stats?.count) || 0;
    await ctx
      .run(
        'set_layer_visibility',
        { layerId: 'satellites', enabled: true },
        { signal },
      )
      .catch(() => {});
    // The core catalog lands first; the dense one counts from there.
    await ctx.feeds.waitForData(['satellites'], signal);
    const before = count();
    if (!ctx.dataManager.setLayerParams('satellites', { catalog }))
      return {
        ok: false,
        error: t('{layer} refused that.', { layer: layerLabel('satellites') }),
      };
    if (catalog === 'dense') {
      const until = Date.now() + DENSE_WAIT_MS;
      while (Date.now() < until && !signal?.aborted) {
        if (ctx.feeds.row('satellites')?.stats?.error) break;
        if (count() > before + DENSE_EXTRA) break;
        await delay(300, signal);
      }
    }
    return { ok: true, catalog, count: count() };
  },
});
