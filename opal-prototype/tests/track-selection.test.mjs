import test from 'node:test';
import assert from 'node:assert/strict';
import { selectTrackRange, insertTrackSelection } from '../src/track-selection.js';
const order = ['a', 'b', 'c', 'd', 'e'];
test('range follows visible order and supports additive Ctrl/Cmd ranges', () => {
  assert.deepEqual([...selectTrackRange(order, new Set(), 'd', 'b', { range: true })], ['b', 'c', 'd']);
  assert.deepEqual([...selectTrackRange(order, new Set(['a']), 'd', 'e', { range: true, toggle: true })], ['a', 'd', 'e']);
  assert.deepEqual([...selectTrackRange(order, new Set(['a', 'c']), 'a', 'c', { toggle: true })], ['a']);
});
test('dragging disjoint selected rows preserves their visible order and the remaining rows', () => {
  const selected = new Set(['d', 'b']);
  assert.deepEqual(insertTrackSelection(order, selected, 'e', true), ['a', 'c', 'e', 'b', 'd']);
  assert.deepEqual(insertTrackSelection(order, selected, 'a'), ['b', 'd', 'a', 'c', 'e']);
  assert.deepEqual(insertTrackSelection(order, selected, 'b'), order);
  assert.deepEqual(insertTrackSelection(order, selected, 'missing'), order);
  assert.deepEqual(order, ['a', 'b', 'c', 'd', 'e']);
});
