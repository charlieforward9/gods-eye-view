/**
 * Body classes that mean "another surface owns the screen": cockpit, scene
 * playback, recording, clean view and the chat view. First run yields to them
 * and the phone shell closes its sheets for them.
 */
export const EXCLUSIVE_SURFACE_CLASSES = Object.freeze([
  'cockpit-mode',
  'scene-playback-mode',
  'recording-mode',
  'ui-clean-view',
  'chat-view-mode',
]);
