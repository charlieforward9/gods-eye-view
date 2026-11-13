/**
 * Everything a shell can ask the kernel to do, by name. Each is
 * `kernel.act(name, ...args)`, which always resolves (to the intent's
 * result, if it has one), so a shell across a message bridge needs only
 * names, JSON arguments and replies. kernel.test.mjs keeps this list and
 * the kernel in step.
 */
export const INTENTS = Object.freeze([
  // Questions
  'ask',
  'stop',
  'warm',
  'pickRow',
  'restoreTurn',
  'play',
  'markSeen',
  // Sessions
  'openSession',
  'newSession',
  'renameSession',
  'deleteSession',
  'moveSession',
  'addProject',
  'setGroupBy',
  'toggleWatch',
  'dismissSignal',
  // The stage
  'setTime',
  'timePlayback',
  'toggleLayer',
  'pickLayerChip',
  'setLayerSlider',
  'setBasemap',
  'setLook',
  'playScene',
  'cockpit',
  'immersive',
  'setProvider',
  'setAuthMode',
  'camera',
  'setMapOnly',
  'clearFocus',
  // Context chips for the composer
  'viewChip',
  'hereChip',
]);
