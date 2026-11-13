import test from 'node:test';
import assert from 'node:assert/strict';
import { periodDays } from '../web/ui/period.js';

test('periodDays keeps supported windows, including string values from a select', () => {
  assert.equal(periodDays('7'), 7);
  assert.equal(periodDays(90, 28), 90);
});

test('periodDays falls back to the site default, then 28, for unsupported values', () => {
  assert.equal(periodDays(30, 90), 90);
  assert.equal(periodDays(undefined, 14), 28);
});
