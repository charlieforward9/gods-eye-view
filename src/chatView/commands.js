/**
 * The commands the composer's + menu and `/` list: one plain verb per line,
 * each covering the map actions (src/voice/actionSchemas.js) it plans to.
 * Picking one writes `/verb ` into the composer; the planner reads it back.
 * Labels and hints are English data (`msg`); the menu shows them through t().
 */
import { msg } from '../i18n/marker.js';

export const COMMANDS = Object.freeze([
  Object.freeze({
    id: 'reset',
    label: msg('Reset'),
    hint: msg('everything back to normal'),
    example: '',
    // Every layer off, no follow, live time, the whole Earth:
    // the kernel's own reset, not one action.
    actions: Object.freeze([]),
  }),
  Object.freeze({
    id: 'go',
    label: msg('Go to'),
    hint: msg('a place, or the whole Earth'),
    example: 'Tokyo',
    actions: Object.freeze([
      'fly_to_location',
      'zoom_to_globe',
      'adjust_camera_zoom',
      'move_camera',
      'fly_route',
    ]),
  }),
  Object.freeze({
    id: 'find',
    label: msg('Find'),
    hint: msg('what, and where'),
    example: 'the highest flights over Texas',
    actions: Object.freeze([
      'analyst_query',
      'get_entity_context',
      'select_nearest_aircraft',
      'get_current_view_state',
      'osm_query',
      'find_imagery',
    ]),
  }),
  Object.freeze({
    id: 'follow',
    label: msg('Follow'),
    hint: msg('a flight, a satellite, or the first one'),
    example: 'the ISS',
    actions: Object.freeze([
      'track_entity',
      'stop_tracking',
      'control_cockpit',
    ]),
  }),
  Object.freeze({
    id: 'frame',
    label: msg('Frame'),
    hint: msg('flights, military, ships or satellites around here'),
    example: 'flights',
    actions: Object.freeze(['frame_overhead']),
  }),
  Object.freeze({
    id: 'mark',
    label: msg('Mark'),
    hint: msg('what you are looking at'),
    example: 'them',
    actions: Object.freeze([
      'annotate_map',
      'clear_annotations',
      'resolve_area',
    ]),
  }),
  Object.freeze({
    id: 'passes',
    label: msg('Passes'),
    hint: msg('a satellite over a place'),
    example: 'ISS over Austin',
    actions: Object.freeze(['next_iss_pass', 'next_satellite_pass']),
  }),
  Object.freeze({
    id: 'look',
    label: msg('Look'),
    hint: msg('normal, thermal, noir, retro, anime, surveillance'),
    example: 'thermal',
    actions: Object.freeze([
      'set_visual_style',
      'set_hud',
      'set_post_processing',
      'set_detection',
      'set_cyber_sonar',
    ]),
  }),
  Object.freeze({
    id: 'map',
    label: msg('Map'),
    hint: msg('3D, satellite or streets'),
    example: 'satellite',
    actions: Object.freeze(['set_map_stack']),
  }),
  Object.freeze({
    id: 'cameras',
    label: msg('Cameras'),
    hint: msg('live cameras near a place'),
    example: 'near London',
    actions: Object.freeze(['control_cctv']),
  }),
  Object.freeze({
    id: 'radio',
    label: msg('Radio'),
    hint: msg('stations in a place'),
    example: 'Tokyo',
    actions: Object.freeze(['control_radio']),
  }),
  Object.freeze({
    id: 'scenes',
    label: msg('Scenes'),
    hint: msg('play a saved scene'),
    example: 'list',
    actions: Object.freeze(['control_scene']),
  }),
]);

/**
 * Actions the + menu reaches as Layers rather than commands, and the ones
 * that drive stock panels the chat view hides.
 */
export const LAYER_ACTIONS = Object.freeze([
  'set_layer_visibility',
  'show_data_layers_menu',
]);
export const PANEL_ONLY_ACTIONS = Object.freeze([
  'set_panel_open',
  'set_context_mode',
  'set_voice_inactivity_timeout',
  'show_street_level',
]);

const BY_ID = new Map(COMMANDS.map((command) => [command.id, command]));

/**
 * Split a leading `/verb` off composer text.
 * @param {string} text
 * @returns {{command: object, rest: string}|null}
 */
export function parseSlash(text) {
  const match = /^\s*\/([a-z]+)\b\s*(.*)$/is.exec(String(text || ''));
  if (!match) return null;
  const command = BY_ID.get(match[1].toLowerCase());
  return command ? { command, rest: match[2].trim() } : null;
}

/** Commands whose id or label starts with a typed prefix, for `/` typing. */
export function matchCommands(prefix = '') {
  const typed = String(prefix).replace(/^\//, '').trim().toLowerCase();
  if (!typed) return COMMANDS;
  return COMMANDS.filter(
    (command) =>
      command.id.startsWith(typed) ||
      command.label.toLowerCase().startsWith(typed),
  );
}
