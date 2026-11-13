/**
 * What a tap on a layer row's control does, for every shell that draws the
 * rows: the layer panel (src/ui/layerPanel.js) and the chat view's Layers
 * tab (src/chatView). A layer describes its controls with
 * `getRowControls()`: `chips`, a one-of-many `segmented` switch, a `slider`,
 * a `legend`, an `info` line and an ordered `list`. A tap resolves against
 * the live descriptor, never a rendered copy, so a stale row can never apply
 * an inverted toggle.
 */

/**
 * A row chip or switch option by id; a switch option carries the same
 * fields as a chip.
 * @param {object|null} controls The layer's `getRowControls()`.
 * @param {string} chipId
 * @returns {object|null}
 */
export function findRowChip(controls, chipId) {
  return (
    [...(controls?.chips || []), ...(controls?.segmented?.options || [])].find(
      (entry) => entry.id === chipId,
    ) || null
  );
}

/**
 * Use a chip or switch option: its own handler, or its params.
 * @param {object|null} chip From findRowChip.
 * @param {(params: object) => unknown} setParams
 * @returns {boolean} Whether the chip acted.
 */
export function applyRowChip(chip, setParams) {
  if (!chip || chip.disabled) return false;
  if (typeof chip.onClick === 'function') chip.onClick();
  else if (chip.params) setParams(chip.params);
  else return false;
  return true;
}

/**
 * The params a row slider's position maps to (e.g. the Active Fires
 * minimum-FRP filter), or null when the row has no such slider.
 * @param {object|null} controls The layer's `getRowControls()`.
 * @param {string} sliderId
 * @param {number} value The slider's position.
 * @returns {object|null}
 */
export function rowSliderParams(controls, sliderId, value) {
  const slider = controls?.slider;
  if (!slider || slider.id !== sliderId || typeof slider.params !== 'function')
    return null;
  return slider.params(value);
}

/**
 * An ordered list item's params, or null when it is gone, disabled or
 * carries none.
 * @param {object|null} controls The layer's `getRowControls()`.
 * @param {string} itemId
 * @returns {object|null}
 */
export function rowListItemParams(controls, itemId) {
  const item = controls?.list?.items?.find((entry) => entry.id === itemId);
  return item && !item.disabled && item.params ? item.params : null;
}
