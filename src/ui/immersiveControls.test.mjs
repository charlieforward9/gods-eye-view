import test from 'node:test';
import assert from 'node:assert/strict';
import { describeImmersion, controlImmersion } from './immersiveControls.js';

function fixture(kind = 'satellite') {
  const calls = [];
  const subjects = {
    satellite: { noradId: 25544, name: 'ISS', layerId: 'satellites' },
    vessel: {
      mmsi: '211000000',
      name: 'NORDIC STAR',
      layerId: 'ais-live-vessels',
    },
    aircraft: { icao24: 'abc123', callsign: 'UAL123', layerId: 'flights' },
  };
  const record =
    (name, value = true) =>
    (...args) => {
      calls.push([name, ...args]);
      return value;
    };
  const controller = {
    active: false,
    destroyed: false,
    subjectKind: null,
    subjectId: null,
    resolveEntryKind: () => kind,
    readSatelliteInfo: () => subjects.satellite,
    readVesselInfo: () => subjects.vessel,
    readAircraftInfo: () => subjects.aircraft,
    isEntryAllowed: () => true,
    isBridgeEntryAllowed: () => true,
    isOrbitEntryAllowed: () => true,
    enter: record('enter'),
    exit: record('exit'),
    stepOrbitalZoom: record('zoom'),
    jumpToSensorSwath: record('sensor'),
    orbitalNadir: record('nadir'),
    turnOrbitalLook: record('orbitLook'),
    turnLook: record('bridgeLook'),
    lookAhead: record('ahead'),
    cycleRadarRange: record('radar'),
    rideOrbitalSatellite: record('ride'),
    toggleOrbitalFocus: record('focus'),
    navigateContext: record('navigate'),
    instruments: { look: { offset: true, readout: 'LEFT 5°' } },
    signalItems: [],
    immersivePresentation: {
      orbital: {
        zoom: 2,
        maxZoom: 8,
        sensor: { label: 'Sensor', zoom: 4 },
        look: { offset: true, readout: 'OFF NADIR', focus: null },
      },
      radar: {
        rangeLabel: '5 NM',
        contacts: [{ id: '1', name: 'Neighbour', distanceNm: 2, stale: false }],
      },
    },
    services: {
      militaryAwarenessLayer: {
        getContextSnapshot: () => ({
          navigation: { canPrevious: false, canNext: true },
        }),
        focusTarget: record('contact'),
      },
    },
  };
  const activate = () => {
    const entry = describeImmersion(controller).entry;
    controller.active = true;
    controller.subjectKind = kind;
    controller.subjectId = entry.id;
    return entry;
  };
  return { controller, subjects, calls, activate };
}

test('entry uses the shared candidate and gate, and rejects a replaced target', () => {
  for (const kind of ['satellite', 'vessel', 'aircraft']) {
    const { controller, subjects, calls } = fixture(kind);
    const entry = describeImmersion(controller).entry;
    controller[
      kind === 'satellite'
        ? 'isOrbitEntryAllowed'
        : kind === 'vessel'
          ? 'isBridgeEntryAllowed'
          : 'isEntryAllowed'
    ] = () => false;
    assert.equal(
      controlImmersion(controller, 'enter', entry).code,
      'UNAVAILABLE',
    );
    assert.deepEqual(calls, []);
    controller[
      kind === 'satellite'
        ? 'isOrbitEntryAllowed'
        : kind === 'vessel'
          ? 'isBridgeEntryAllowed'
          : 'isEntryAllowed'
    ] = () => true;
    assert.deepEqual(controlImmersion(controller, 'enter', entry), {
      ok: true,
    });
    assert.deepEqual(calls, [['enter', { kind }]]);
    subjects[kind] = null;
    assert.equal(describeImmersion(controller).entry, null);
    assert.equal(
      controlImmersion(controller, 'enter', entry).code,
      'STALE_TARGET',
    );
    assert.equal(calls.length, 1);
  }
});

test('a snapshot is frozen plain data and does not freeze the live controller', () => {
  const { controller, activate } = fixture();
  activate();
  controller.immersivePresentation.orbital.cesium = () => {};
  const state = describeImmersion(controller);
  assert.deepEqual(structuredClone(state), state);
  assert.deepEqual(JSON.parse(JSON.stringify(state)), state);
  assert.equal(Object.isFrozen(state), true);
  assert.equal(Object.isFrozen(state.orbital.look), true);
  assert.equal(
    Object.isFrozen(controller.immersivePresentation.orbital),
    false,
  );
  assert.equal(state.controls.zoomIn, true);
  assert.equal(state.controls.sensor, true);
  controller.immersivePresentation.orbital.zoom = 8;
  assert.equal(describeImmersion(controller).controls.zoomIn, false);
});

test('orbital and bridge controls delegate to their own shared owner and refuse other modes', () => {
  const orbit = fixture();
  orbit.activate();
  for (const action of ['zoomIn', 'zoomOut', 'sensor', 'nadir', 'lookLeft'])
    assert.equal(controlImmersion(orbit.controller, action).ok, true);
  assert.deepEqual(orbit.calls, [
    ['zoom', 1],
    ['zoom', -1],
    ['sensor'],
    ['nadir'],
    ['orbitLook', { axis: 'yaw', sign: -1, stepDeg: 5 }],
  ]);
  assert.equal(
    controlImmersion(orbit.controller, 'radarRange').code,
    'UNAVAILABLE',
  );

  const ship = fixture('vessel');
  ship.activate();
  assert.equal(controlImmersion(ship.controller, 'lookRight').ok, true);
  assert.equal(controlImmersion(ship.controller, 'lookAhead').ok, true);
  assert.equal(controlImmersion(ship.controller, 'radarRange').ok, true);
  assert.equal(controlImmersion(ship.controller, 'zoomIn').code, 'UNAVAILABLE');
  assert.equal(controlImmersion(ship.controller, 'next').code, 'UNAVAILABLE');
  assert.deepEqual(ship.calls, [
    ['bridgeLook', { axis: 'yaw', sign: 1, stepDeg: 5 }],
    ['ahead'],
    ['radar'],
  ]);
});

test('live signals and satellite navigation accept only currently offered identities', () => {
  const { controller, calls, activate } = fixture();
  activate();
  controller.signalItems = [
    {
      key: 'satellite-return:1',
      title: 'Return',
      target: { layerId: 'satellites', id: '1' },
    },
    {
      key: 'satellite:2',
      title: 'Next',
      target: { layerId: 'satellites', id: '2' },
    },
    {
      key: 'site:a',
      title: 'Site',
      target: { layerId: 'military-installations', id: 'a' },
    },
  ];
  assert.equal(controlImmersion(controller, 'previous').ok, true);
  assert.equal(controlImmersion(controller, 'next').ok, true);
  assert.equal(
    controlImmersion(controller, 'signal', {
      key: 'site:a',
      layerId: 'military-installations',
      id: 'a',
    }).ok,
    true,
  );
  const before = calls.length;
  assert.equal(
    controlImmersion(controller, 'signal', {
      key: 'site:a',
      layerId: 'military-installations',
      id: 'b',
    }).code,
    'STALE_TARGET',
  );
  controller.signalItems = [];
  assert.equal(
    controlImmersion(controller, 'signal', {
      key: 'site:a',
      layerId: 'military-installations',
      id: 'a',
    }).code,
    'STALE_TARGET',
  );
  assert.equal(calls.length, before);
  assert.deepEqual(calls, [
    ['ride', '1'],
    ['ride', '2'],
    ['focus', 'a'],
  ]);
});

test('a dropped active subject disables controls but still permits leaving', () => {
  const { controller, subjects, calls, activate } = fixture();
  const subject = activate();
  subjects.satellite = null;
  const state = describeImmersion(controller);
  assert.equal(state.active, true);
  assert.equal(state.subject, null);
  assert.ok(Object.values(state.controls).every((value) => value === false));
  assert.equal(
    controlImmersion(controller, 'zoomIn', { subject }).code,
    'STALE_TARGET',
  );
  assert.equal(controlImmersion(controller, 'exit', { subject }).ok, true);
  assert.deepEqual(calls, [['exit']]);
  controller.destroyed = true;
  assert.equal(
    controlImmersion(controller, 'enter', subject).code,
    'UNAVAILABLE',
  );
  assert.equal(describeImmersion(controller).active, false);
});
