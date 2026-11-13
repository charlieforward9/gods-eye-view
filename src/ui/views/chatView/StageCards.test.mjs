import '../../../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, h, nextTick, shallowRef } from 'vue';
import StageCards from './StageCards.vue';

function mount(t, immersion) {
  document.body.replaceChildren();
  const state = shallowRef(immersion);
  const calls = [];
  const host = document.body.appendChild(document.createElement('div'));
  const app = createApp({
    render: () =>
      h(StageCards, {
        stage: { immersion: state.value },
        onImmersion: (...args) => calls.push(args),
      }),
  });
  app.mount(host);
  t.after(() => app.unmount());
  const button = (label) =>
    [...host.querySelectorAll('button')].find(
      (el) =>
        el.getAttribute('aria-label') === label ||
        el.textContent.trim() === label,
    );
  return { state, calls, host, button };
}

const subject = Object.freeze({
  kind: 'satellite',
  layerId: 'satellites',
  id: '25544',
  label: 'ISS',
});
const controls = Object.freeze({
  previous: false,
  next: false,
  zoomIn: true,
  zoomOut: true,
  sensor: true,
  nadir: true,
  look: true,
  radar: false,
});
const orbit = () => ({
  active: true,
  subjectKind: 'satellite',
  subject,
  entry: null,
  controls,
  orbital: {
    zoom: 2,
    maxZoom: 8,
    sensorLabel: 'Imager',
    look: { offset: true, readout: 'OFF-NADIR', focus: null },
  },
  bridge: null,
  signals: [
    {
      key: 'site:a',
      title: 'Site A',
      detail: 'In reach',
      target: {
        layerId: 'military-installations',
        id: 'a',
        label: 'Keep the camera on Site A',
      },
    },
  ],
});

test('a shared selected target offers ORBIT or BRIDGE and sends its exact identity', async (t) => {
  const { state, button, calls } = mount(t, {
    active: false,
    entry: { ...subject, enabled: true },
  });
  button('ORBIT').click();
  assert.deepEqual(calls[0], ['enter', { ...subject, enabled: true }]);
  state.value = {
    active: false,
    entry: {
      kind: 'vessel',
      layerId: 'ais-live-vessels',
      id: '211000000',
      label: 'Ship',
      enabled: false,
    },
  };
  await nextTick();
  assert.equal(button('BRIDGE').disabled, true);
  button('BRIDGE').click();
  assert.equal(calls.length, 1);
});

test('orbital controls carry the ridden identity and a disappearing signal leaves focus safely', async (t) => {
  const { state, host, button, calls } = mount(t, orbit());
  button('Zoom in').click();
  assert.deepEqual(calls.at(-1), ['zoomIn', { subject }]);
  button('Zoom to the imaging sensor swath').click();
  assert.deepEqual(calls.at(-1), ['sensor', { subject }]);
  button('Look left').click();
  assert.deepEqual(calls.at(-1), ['lookLeft', { subject }]);
  const row = button('Keep the camera on Site A');
  row.click();
  assert.deepEqual(calls.at(-1), [
    'signal',
    {
      key: 'site:a',
      layerId: 'military-installations',
      id: 'a',
      label: 'Keep the camera on Site A',
      subject,
    },
  ]);
  host.querySelector('details').open = true;
  row.focus();
  state.value = {
    ...state.value,
    signals: [
      { key: 'status', title: 'Standby', detail: 'No site', target: null },
    ],
  };
  await nextTick();
  assert.equal(document.activeElement, button('Exit orbital view'));
});

test('bridge controls show supported look and radar actions without orbital or contact navigation', (t) => {
  const vessel = {
    kind: 'vessel',
    layerId: 'ais-live-vessels',
    id: '211000000',
    label: 'Ship',
  };
  const { button, calls, host } = mount(t, {
    active: true,
    subjectKind: 'vessel',
    subject: vessel,
    entry: null,
    controls: {
      previous: false,
      next: false,
      zoomIn: false,
      zoomOut: false,
      sensor: false,
      nadir: false,
      look: true,
      radar: true,
    },
    orbital: null,
    bridge: {
      look: { offset: true, readout: 'RIGHT 5°' },
      rangeLabel: '5 NM',
      contacts: [{ id: '2', name: 'Neighbour', distanceNm: 2, stale: true }],
    },
    signals: [],
  });
  assert.equal(button('Zoom in'), undefined);
  assert.equal(button('Next'), undefined);
  assert.match(host.textContent, /Neighbour.*2 NM.*STALE/s);
  button('Radar range 5 NM. Select for the next range.').click();
  assert.deepEqual(calls.at(-1), ['radarRange', { subject: vessel }]);
  button('LOOK AHEAD').click();
  assert.deepEqual(calls.at(-1), ['lookAhead', { subject: vessel }]);
  button('Exit bridge view').click();
  assert.deepEqual(calls.at(-1), ['exit', { subject: vessel }]);
});

test('a zoom limit and a removed sensor return focus to the exit control', async (t) => {
  const { state, button } = mount(t, orbit());
  button('Zoom in').focus();
  state.value = { ...state.value, controls: { ...controls, zoomIn: false } };
  await nextTick();
  assert.equal(document.activeElement, button('Exit orbital view'));
  button('Zoom to the imaging sensor swath').focus();
  state.value = { ...state.value, controls: { ...controls, sensor: false } };
  await nextTick();
  assert.equal(document.activeElement, button('Exit orbital view'));
});
