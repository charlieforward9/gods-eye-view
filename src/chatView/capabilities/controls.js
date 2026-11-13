import { t } from '../../i18n/index.js';

/**
 * The chat view's own controls: the map picker and Reset. They are `local`:
 * the rule planner answers them and GEV's agent is never asked to.
 */
export const basemap = Object.freeze({
  name: 'chat_basemap',
  local: true,
  run: (args, ctx) => ctx.basemaps.switchTo(args.stack),
});

/** Every layer off, nothing followed, live time, the home map, the whole Earth. */
export const reset = Object.freeze({
  name: 'chat_reset',
  local: true,
  async run(_args, ctx) {
    // A clean stage is a clean conversation too.
    ctx.agent?.reset();
    await ctx.clearStage();
    ctx.setTime({ mode: 'live' });
    const home = ctx.basemaps.home();
    const active = ctx.basemaps.activeId();
    if (active !== null && active !== home)
      await ctx.basemaps.switchTo(home).catch(() => {});
    await ctx.run('zoom_to_globe', {}).catch(() => {});
    return {
      ok: true,
      say: t(
        'Back to normal: every layer off, nothing followed, live time, the whole Earth.',
      ),
    };
  },
});
