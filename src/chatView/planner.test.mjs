import test from 'node:test';
import assert from 'node:assert/strict';
import { GEV_ACTION_SCHEMAS } from '../voice/actionSchemas.js';
import { validateValue } from '../tools/schema.js';
import { SUGGESTIONS, hoursOf, placeOf, planQuestion } from './planner.js';
import { capabilityOf } from './capabilities/index.js';
import { createContext } from './context.js';

const SCHEMAS = new Map(
  GEV_ACTION_SCHEMAS.map((schema) => [schema.name, schema.parameters]),
);
const names = (plan) => plan.calls.map((call) => call.name);
const call = (plan, name) => plan.calls.find((entry) => entry.name === name);

test('every planned call is a known action with arguments its schema accepts', () => {
  const questions = [
    'What’s flying over the Gulf of Mexico?',
    'how many flights in view',
    'any emergencies?',
    'emergencies near Texas',
    'highest military flights over Europe',
    'earthquakes above 4 in the last 6 hours',
    'quakes M5+ near Japan',
    'follow it',
    'follow the second one',
    'follow UAL123',
    'where is the ISS?',
    'when does the ISS pass over Austin?',
    'cameras near London',
    'show me Tokyo',
    'whole earth',
    'make it thermal',
    'mark it',
    'stop',
    'zoom in a little',
    'orbit',
    'satellites overhead',
    'rain over Florida',
    '/go Paris',
    '/find fastest flights over Texas',
    '/follow the ISS',
    '/frame ships',
    '/look noir',
    '/passes ISS over Austin',
    '/cameras near Austin',
    '/radio Tokyo',
    '/scenes',
    '/mark Eiffel Tower',
    ...SUGGESTIONS,
    'Show me the undersea cables landing in the Bahamas',
    'Replay the Bhote Koshi flood',
    'Is there a hurricane right now?',
  ];
  const context = {
    chips: [
      {
        kind: 'object',
        layerId: 'flights',
        id: 'abc123',
        label: 'UAL123',
        lat: 30,
        lon: -97,
      },
    ],
    hasRows: true,
  };
  for (const question of questions) {
    const plan = planQuestion(question, context);
    assert.notEqual(plan.intent, 'unknown', question);
    assert.ok(plan.calls.length, question);
    // Every step is an app action or a chat view capability, with
    // arguments its schema takes; the chat view's own controls have none.
    for (const { name, args } of plan.calls.filter(
      (entry) => !capabilityOf(entry.name)?.local,
    )) {
      const schema = SCHEMAS.get(name) || capabilityOf(name)?.tool?.parameters;
      assert.ok(schema, `${question}: ${name}`);
      assert.deepEqual(validateValue(schema, args), [], `${question}: ${name}`);
    }
  }
});

test('a layer question flies there first, turns the layer on and queries it', () => {
  const plan = planQuestion('What’s flying over the Gulf of Mexico?');
  assert.deepEqual(names(plan), [
    'fly_to_location',
    'set_layer_visibility',
    'analyst_query',
  ]);
  assert.deepEqual(plan.layers, ['flights']);
  assert.deepEqual(plan.query.scope, {
    kind: 'region',
    name: 'Gulf of Mexico',
  });
  assert.equal(plan.query.sortBy, 'altitudeM');
  assert.equal(plan.title, 'Flights · Gulf of Mexico');
});

test('a layer whose key is missing here answers through its keyless stand-in', () => {
  const keyed = planQuestion('Biggest wildfires right now?');
  assert.deepEqual(keyed.layers, ['local-firms']);
  assert.equal(keyed.standIn, null);
  const plan = planQuestion('Biggest wildfires right now?', {
    unavailable: new Set(['local-firms']),
  });
  assert.deepEqual(plan.layers, ['fire-perimeters']);
  assert.deepEqual(plan.standIn, {
    from: 'local-firms',
    to: 'fire-perimeters',
  });
  assert.equal(plan.query.sortBy, 'acres');
});

test('the map under the layers switches by name, and satellites stay a layer', () => {
  const map = (question) =>
    planQuestion(question).calls.find((call) => call.name === 'chat_basemap')
      ?.args.stack ?? null;
  assert.equal(map('satellite map'), 'esri-imagery');
  assert.equal(map('go back to satellite'), 'esri-imagery');
  assert.equal(map('switch the map to 3D'), 'photoreal');
  assert.equal(map('Switch to streets'), 'osm');
  assert.equal(map('/map streets'), 'osm');
  assert.equal(map('show me satellites'), null);
  assert.equal(map('street view of Paris'), null);
  assert.equal(map('what is flying over the streets of Paris'), null);
});

test('earthquake thresholds and time spans become filters and a watchable tool', () => {
  const plan = planQuestion('earthquakes above 4 in the last 6 hours');
  assert.deepEqual(plan.query.filters, [
    { field: 'magnitude', op: 'gte', value: 4 },
    { field: 'ageHours', op: 'lte', value: 6 },
  ]);
  assert.deepEqual(plan.query.scope, { kind: 'anywhere' });
  assert.equal(plan.hours, 6);
  assert.equal(plan.background.tool, 'get_earthquakes');
  assert.equal(plan.background.args.min_magnitude, 4);
});

test('military flights are military, not both feeds', () => {
  assert.deepEqual(planQuestion('military flights over Europe').layers, [
    'military',
  ]);
});

test('emergencies search both aircraft feeds for the emergency flag', () => {
  const plan = planQuestion('any emergencies?');
  assert.deepEqual(plan.query.layers, ['flights', 'military']);
  assert.deepEqual(plan.query.filters, [
    { field: 'emergency', op: 'eq', value: true },
  ]);
});

test('follow resolves a tapped object, an ordinal, the ISS or a callsign', () => {
  const chip = {
    kind: 'object',
    layerId: 'flights',
    id: 'abc123',
    label: 'UAL123',
  };
  assert.deepEqual(planQuestion('follow it', { chips: [chip] }).follow, {
    query: 'abc123',
    layerId: 'flights',
  });
  assert.deepEqual(planQuestion('follow the second one').follow, {
    referent: 2,
  });
  assert.deepEqual(planQuestion('where is the ISS?').follow, {
    query: 'ISS',
    layerId: 'satellites',
  });
  assert.deepEqual(planQuestion('track dal42').follow, { query: 'dal42' });
  assert.equal(planQuestion('follow it').intent, 'unknown');
});

test('places, spans and the absence of a place', () => {
  assert.deepEqual(placeOf('flights over the gulf of mexico right now'), {
    name: 'Gulf of Mexico',
  });
  assert.deepEqual(placeOf('flights in view'), { view: true });
  assert.deepEqual(placeOf('ships near me'), { here: true });
  assert.equal(placeOf('earthquakes in the last 6 hours'), null);
  assert.equal(hoursOf('in the last 30 minutes'), 0.5);
  assert.equal(hoursOf('over the past day'), 24);
  assert.equal(hoursOf('in the last hour'), 1);
});

test('device-relative CCTV uses the real location or requests one without using the view', async () => {
  const florida = { lat: 25.76, lon: -80.19 };
  const cameraState = () => ({ lat: 57.99, lon: 26.63 });
  const granted = createContext({
    cameraState,
    geolocate: async () => florida,
  });
  const denied = createContext({ cameraState });
  const view = denied.viewChip();
  for (const question of [
    'CCTV cameras around me',
    'Nearest CCTV to me?',
    'Find CCTV near me for the ISS livestream',
    '/cameras close to me',
    '/find webcams near me',
  ]) {
    const located = await granted.implied(question, [view]);
    assert.deepEqual(planQuestion(question, { chips: located }).calls, [
      {
        name: 'show_nearest_camera_to_device',
        args: { latitude: florida.lat, longitude: florida.lon },
      },
    ]);
    const unavailable = await denied.implied(question, [view]);
    assert.deepEqual(unavailable, [view]);
    assert.deepEqual(planQuestion(question, { chips: unavailable }).calls, [
      { name: 'show_nearest_camera_to_device', args: {} },
    ]);
  }
  assert.deepEqual(await granted.implied('Cameras near Miami', []), []);
  assert.deepEqual(await granted.implied('/look CCTV near me', [view]), [view]);
  assert.equal(
    call(planQuestion('Cameras near Miami'), 'show_nearest_camera').args.place,
    'Miami',
  );
  assert.deepEqual(
    call(planQuestion('Cameras in view'), 'show_nearest_camera').args,
    {},
  );
});

test('nearest CCTV to a named place anchors the lookup to the place', () => {
  for (const question of [
    'Nearest CCTV to tequesta florida?',
    'What is the closest traffic camera to Tequesta, Florida?',
    '/cameras nearest to Tequesta Florida',
  ]) {
    const planned = planQuestion(question);
    assert.equal(planned.place, 'Tequesta Florida');
    assert.deepEqual(planned.calls, [
      {
        name: 'show_nearest_camera',
        args: { place: 'Tequesta Florida' },
        fill: 'place',
      },
    ]);
  }
});

test('a bare place flies there; an unknown question says so', () => {
  assert.deepEqual(names(planQuestion('Tokyo')), ['fly_to_location']);
  const unknown = planQuestion('what is the meaning of life?');
  assert.equal(unknown.intent, 'unknown');
  assert.ok(unknown.suggestions.length);
});

test('a question of several asks runs them in order on what came before', () => {
  const plan = planQuestion(
    'Take me to LAX, follow a plane, then switch to thermal',
  );
  assert.deepEqual(names(plan), [
    'fly_to_location',
    'select_nearest_aircraft',
    'set_visual_style',
  ]);
  // The nearest aircraft is found around the place the first part named,
  // geocoded as an airport rather than the Swiss village "Lax".
  assert.equal(call(plan, 'select_nearest_aircraft').fill, 'place');
  assert.equal(plan.place, 'LAX airport');
  assert.equal(call(plan, 'fly_to_location').args.latitude, 33.9425);
  assert.equal(
    planQuestion('ships near rotterdam').calls[0].args.query,
    'Rotterdam',
  );
  // "At sea" is where ships are, not a place to fly to.
  assert.equal(planQuestion('ships at sea').place, null);
  const cockpit = planQuestion(
    'Military aircraft over the Middle East, then put me in the cockpit',
  );
  assert.deepEqual(call(cockpit, 'track_entity').args, { referent: 1 });
  assert.deepEqual(call(cockpit, 'control_cockpit').args, {
    action: 'enter',
    targetLayer: 'military',
  });
  const there = planQuestion(
    'Strongest earthquake in the last 24 hours? Fly me there.',
  );
  assert.equal(there.query.sortBy, 'magnitude');
  assert.deepEqual(call(there, 'fly_to_location').args.referent, 1);
});

test('everyday phrasings go where a person means them', () => {
  const plan = (text, context) => planQuestion(text, context);
  // Reset means everything only when it is the whole ask.
  assert.deepEqual(names(plan('clear all marks')), ['clear_annotations']);
  assert.deepEqual(names(plan('reset the time')), ['set_timeline']);
  assert.deepEqual(names(plan('reset view')), ['zoom_to_globe']);
  assert.deepEqual(names(plan('reset everything')), ['chat_reset']);
  assert.deepEqual(call(plan('stop the replay'), 'control_scene').args, {
    action: 'stop',
  });
  // Weeks and months are spans, not places.
  assert.equal(plan('earthquakes in the last week').hours, 168);
  assert.equal(plan('earthquakes in the last week').place, null);
  assert.equal(plan('rockets launched in the last month').hours, 720);
  // Abbreviations do not end a sentence.
  assert.equal(plan('flights over St. Louis').place, 'St Louis');
  assert.equal(
    plan('flights over Washington D.C. right now').place,
    'Washington D.C.',
  );
  assert.equal(plan('earthquakes near Mt. Fuji').calls.length, 3);
  // Countries and cities in capitals are not airports.
  assert.equal(plan('flights over the USA').place, 'USA');
  assert.equal(plan('flights over NYC').place, 'NYC');
  // Where things are is not a place to fly to.
  for (const text of [
    'planes in the air',
    'satellites in orbit',
    'flights above 30000 feet',
  ])
    assert.equal(plan(text).place, null, text);
  // Small talk, bare words and unknown commands are not geocoded.
  for (const text of ['help', 'thanks', 'ok', 'pause', '/unknown', '/'])
    assert.equal(plan(text).intent, 'unknown', text);
  assert.deepEqual(call(plan('3D'), 'chat_basemap').args, {
    stack: 'photoreal',
  });
  assert.deepEqual(call(plan('normal'), 'set_visual_style').args, {
    style: 'normal',
  });
  // A question fragment is never a place.
  assert.deepEqual(names(plan('Is it raining? Show me radar')), [
    'set_layer_visibility',
  ]);
  // Stations that are not radio, and radio that names a city.
  assert.equal(plan('police stations in Paris').place, 'Paris');
  assert.equal(
    call(plan('radio Tokyo please'), 'control_radio').args.locationQuery,
    'Tokyo',
  );
  // Layers the words name.
  assert.deepEqual(plan('show me the jet stream').layers, ['wind']);
  assert.deepEqual(plan('is it raining in Seattle?').layers, ['weather-radar']);
  assert.deepEqual(plan('air quality in Delhi').layers, ['air-quality']);
  assert.deepEqual(plan('military and civilian aircraft over Germany').layers, [
    'military',
    'flights',
  ]);
  assert.equal(plan('live cams in Times Square').layers[0], 'cctv');
  // Passes, Starlink and scenes reach their own plans.
  assert.ok(call(plan('is the ISS visible tonight?'), 'next_iss_pass'));
  assert.equal(
    call(plan('next starlink pass'), 'next_satellite_pass').args.target,
    'starlink',
  );
  assert.equal(plan('/passes ISS over Austin').place, 'Austin');
  assert.equal(plan('Starlink over Europe').place, 'Europe');
  assert.ok(call(plan('run the thermal threat board'), 'control_scene'));
  // The place survives the map and the frame.
  assert.equal(plan('satellite view of Paris').place, 'Paris');
  assert.equal(plan('frame vessels near Rotterdam').place, 'Rotterdam');
  // An ordinal with nothing listed asks instead of geocoding.
  assert.equal(plan('mark the first one').intent, 'unknown');
  // "Follow the highest one" sorts a fresh list, then follows its top.
  const top = plan('follow the highest one');
  assert.equal(top.query.sortBy, 'altitudeM');
  assert.deepEqual(call(top, 'track_entity').args, { referent: 1 });
});

test('a pasted page or a wall of spaces plans fast and bounded', () => {
  const started = performance.now();
  planQuestion(' '.repeat(80_000));
  const many = planQuestion('a. '.repeat(10_000));
  assert.ok(performance.now() - started < 200);
  assert.ok(many.calls.length <= 4);
});
