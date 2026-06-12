'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const pin = require('../src/pkjs/pin');

function fakeStorage() {
  const m = {};
  return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = v; }, removeItem: (k) => { delete m[k]; } };
}

test('read returns auto mode when nothing stored', () => {
  assert.deepStrictEqual(pin.read(fakeStorage()), { mode: 'auto' });
});

test('write then read round-trips a pinned record', () => {
  const s = fakeStorage();
  const rec = { mode: 'pinned', place: 'Hobart', station: { id: 'TAS_TP003' }, rangeDays: 30, distanceKm: 8, error: null };
  pin.write(s, rec);
  assert.deepStrictEqual(pin.read(s), rec);
});

test('clear returns to auto and removes the record', () => {
  const s = fakeStorage();
  pin.write(s, { mode: 'pinned', place: 'X', rangeDays: 7 });
  assert.deepStrictEqual(pin.clear(s), { mode: 'auto' });
  assert.deepStrictEqual(pin.read(s), { mode: 'auto' });
});

test('normalizeRange snaps invalid values to the default', () => {
  assert.strictEqual(pin.normalizeRange(15), 15);
  assert.strictEqual(pin.normalizeRange(99), pin.DEFAULT_RANGE);
  assert.strictEqual(pin.normalizeRange(undefined), pin.DEFAULT_RANGE);
});

test('parseResponse extracts location fields from the config JSON', () => {
  const r = pin.parseResponse(JSON.stringify({ units: 1, locationMode: 'pinned', place: '  Sydney  ', range: 45 }));
  assert.deepStrictEqual(r, { mode: 'pinned', place: 'Sydney', rangeDays: 45 });
});

test('parseResponse returns null on garbage and defaults to auto otherwise', () => {
  assert.strictEqual(pin.parseResponse('{'), null);
  assert.strictEqual(pin.parseResponse(JSON.stringify({})).mode, 'auto');
});
