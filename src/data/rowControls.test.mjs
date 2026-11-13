import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyRowChip,
  findRowChip,
  rowListItemParams,
  rowSliderParams,
} from './rowControls.js';

const controls = (clicked = []) => ({
  chips: [
    { id: 'lines', active: true, params: { lines: false } },
    { id: 'nearest', onClick: () => clicked.push('nearest') },
    { id: 'pending', disabled: true, params: { taxa: 'birds' } },
    { id: 'label-only' },
  ],
  segmented: {
    id: 'confidence',
    options: [{ id: 'confidence-high', params: { confidence: 'high' } }],
  },
  slider: { id: 'min-frp', params: (value) => ({ minFrp: value * 2 }) },
  list: {
    items: [
      { id: 'step-1', params: { step: 1 } },
      { id: 'note', disabled: true, params: { step: 9 } },
    ],
  },
});

test('a row chip or switch option resolves by id, and acts as the row does', () => {
  const clicked = [];
  const applied = [];
  const live = controls(clicked);
  const use = (id) =>
    applyRowChip(findRowChip(live, id), (params) => applied.push(params));
  assert.equal(use('lines'), true);
  assert.equal(use('confidence-high'), true);
  assert.equal(use('nearest'), true);
  assert.equal(use('pending'), false);
  assert.equal(use('label-only'), false);
  assert.equal(use('gone'), false);
  assert.equal(findRowChip(null, 'lines'), null);
  assert.deepEqual(applied, [{ lines: false }, { confidence: 'high' }]);
  assert.deepEqual(clicked, ['nearest']);
});

test('a row slider and list item map to params only for their own ids', () => {
  const live = controls();
  assert.deepEqual(rowSliderParams(live, 'min-frp', 21), { minFrp: 42 });
  assert.equal(rowSliderParams(live, 'opacity', 21), null);
  assert.equal(
    rowSliderParams({ slider: { id: 'min-frp' } }, 'min-frp', 1),
    null,
  );
  assert.deepEqual(rowListItemParams(live, 'step-1'), { step: 1 });
  assert.equal(rowListItemParams(live, 'note'), null);
  assert.equal(rowListItemParams(null, 'step-1'), null);
});
