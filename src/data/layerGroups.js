/**
 * The sections layers are listed under, in order: the layer panel's
 * headings and the chat view's Layers tab both read them, so a layer added
 * here shows in both.
 *
 * Pure: imports only i18n, no DOM.
 * @module data/layerGroups
 */
import { msg } from '../i18n/index.js';

const group = (id, label, ids) =>
  Object.freeze({ id, label, ids: Object.freeze(ids) });

export const LAYER_GROUPS = Object.freeze([
  group('movement', msg('Movement'), [
    'satellites',
    'flights',
    'military',
    'local-adsb',
    'ais-live-vessels',
    'traffic',
    'transit',
    'rail',
    'bikeshare',
  ]),
  group('cameras', msg('Cameras'), ['cctv', 'recent-imagery', 'street-level']),
  group('infrastructure', msg('Infrastructure'), [
    'alpr-cameras',
    'military-installations',
    'drone-airspace',
    'local-datacenters',
    'telegeography-submarine-cables',
    'local-dams',
    'sea-marks',
    'ski-pistes',
  ]),
  group('events', msg('Events'), [
    'rocket-launches',
    'earthquakes',
    'local-firms',
    'fire-perimeters',
    'gnss-integrity',
    's2-ghostmaps',
    'shipwrecks',
    'news',
  ]),
  group('wildlife', msg('Wildlife'), ['wildlife-sightings']),
  group('weather', msg('Weather'), [
    'air-quality',
    'wind',
    'weather-radar',
    'weather-satellite',
    'weather-lightning',
    'weather-cyclones',
  ]),
  group('utilities', msg('Utilities'), ['directions', 'osm-places']),
  group('audio', msg('Audio'), ['radio']),
]);
