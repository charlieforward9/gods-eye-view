import test from 'node:test';
import assert from 'node:assert/strict';
import { GEV_ACTION_SCHEMAS } from '../voice/actionSchemas.js';
import {
  COMMANDS,
  LAYER_ACTIONS,
  PANEL_ONLY_ACTIONS,
  matchCommands,
  parseSlash,
} from './commands.js';
import {
  LAYER_CATEGORIES,
  describeControls,
  describeLayers,
} from './layers.js';
import { LAYER_STATE_REGISTRY } from '../data/layerState.js';

test('the + menu reaches every map action exactly once', () => {
  const reached = [
    ...COMMANDS.flatMap((command) => command.actions),
    ...LAYER_ACTIONS,
    ...PANEL_ONLY_ACTIONS,
  ];
  assert.deepEqual(
    [...reached].sort(),
    GEV_ACTION_SCHEMAS.map((schema) => schema.name).sort(),
  );
});

test('a leading /verb names its command; other text is not a command', () => {
  assert.equal(parseSlash('/follow the ISS').command.id, 'follow');
  assert.equal(parseSlash('/follow the ISS').rest, 'the ISS');
  assert.equal(parseSlash('/nope x'), null);
  assert.equal(parseSlash('follow it'), null);
  assert.deepEqual(
    matchCommands('/f').map((command) => command.id),
    ['find', 'follow', 'frame'],
  );
});

test('every layer a person can turn on has a category', () => {
  const categorized = new Set(LAYER_CATEGORIES.flatMap((c) => c.ids));
  const hidden = new Set([
    'military-awareness',
    'bhote-koshi-2026',
    'bhote-koshi-locator',
  ]);
  for (const { id } of LAYER_STATE_REGISTRY)
    if (!hidden.has(id)) assert.ok(categorized.has(id), id);
});

test("a layer's state follows its row", () => {
  const layers = describeLayers([
    { id: 'flights', enabled: false, stats: {} },
    { id: 'earthquakes', enabled: true, lifecycleState: 'enabling', stats: {} },
    {
      id: 'satellites',
      enabled: true,
      lifecycleState: 'enabled',
      stats: { count: 840, lastUpdate: Date.now(), source: 'CelesTrak' },
    },
    { id: 'military-awareness', enabled: false, showInTogglePanel: false },
  ]);
  const byId = (id) => layers.find((layer) => layer.id === id);
  const [off, loading, live] = ['flights', 'earthquakes', 'satellites'].map(
    byId,
  );
  const missing = byId('military-awareness');
  // The layer panel's order: Movement before Events.
  assert.deepEqual(
    layers.map((layer) => layer.id),
    ['satellites', 'flights', 'earthquakes'],
  );
  assert.equal(off.state, 'off');
  assert.equal(off.label, 'Flights');
  assert.equal(off.cost, 'stream');
  assert.equal(loading.state, 'loading');
  assert.equal(live.state, 'live');
  assert.equal(live.count, 840);
  assert.equal(missing, undefined);
});

test('a layer row carries its row controls only while it is on', () => {
  const asked = [];
  const controlsOf = (id) => {
    asked.push(id);
    return { chips: [{ id: 'dots', label: 'Dots', active: true, params: {} }] };
  };
  const layers = describeLayers(
    [
      { id: 'traffic', enabled: true, stats: {} },
      { id: 'flights', enabled: false, stats: {} },
    ],
    { controlsOf },
  );
  assert.deepEqual(asked, ['traffic']);
  const [traffic, flights] = ['traffic', 'flights'].map((id) =>
    layers.find((layer) => layer.id === id),
  );
  assert.deepEqual(traffic.controls.chips[0], {
    id: 'dots',
    label: 'Dots',
    title: '',
    active: true,
    disabled: false,
    busy: false,
    state: 'active',
    color: null,
  });
  assert.equal(flights.controls, null);
  // Desktop shows a readout on its rail, and hides an empty block.
  assert.equal(describeControls({ readout: true, chips: [{ id: 'a' }] }), null);
  assert.equal(describeControls({ chips: [], legend: [], info: '' }), null);
  assert.equal(describeControls(null), null);
});
