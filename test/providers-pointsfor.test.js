'use strict';

// `pointsFor` is the seam index.js's fetchWeek uses to turn a raw hilo response
// into blob-ready points. It must route by the station's provider WITHOUT
// assuming a response shape: DFO returns a bare array, NOAA returns a
// {predictions:[...]} object. A provider-agnostic caller cannot pre-validate
// the payload as an array -- that is each adapter's job via parseHilo.
// Regression guard for the NOAA "stuck on Loading" bug (issue: NOAA hilo
// responses were rejected by a DFO-shaped Array.isArray guard in fetchWeek).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const providers = require('../src/pkjs/providers');

test('pointsFor decodes a NOAA {predictions:[...]} object for a noaa station', () => {
  const station = { id: '9447130', provider: 'noaa' };
  const raw = {
    predictions: [
      { t: '2026-06-08 01:23', v: '3.21', type: 'H' },
      { t: '2026-06-08 07:45', v: '0.42', type: 'L' },
    ],
  };
  const points = providers.pointsFor(station, null, raw);
  assert.deepEqual(points.map((p) => p.kind), [1, 2]);
  assert.deepEqual(points.map((p) => p.heightCm), [321, 42]);
});

test('pointsFor decodes a DFO bare array for a dfo station', () => {
  const station = { id: '5cebf1de3d0f4a073c4bb94c', provider: 'dfo' };
  const raw = [
    { eventDate: '2026-06-08T01:23:00Z', value: 3.21 },
    { eventDate: '2026-06-08T07:45:00Z', value: 1.05 },
    { eventDate: '2026-06-08T13:50:00Z', value: 3.40 },
    { eventDate: '2026-06-08T20:10:00Z', value: 0.90 },
  ];
  const points = providers.pointsFor(station, null, raw);
  assert.deepEqual(points.map((p) => p.kind), [1, 2, 1, 2]);
});

test('pointsFor returns [] on transport error so the caller keeps cache', () => {
  const station = { id: '9447130', provider: 'noaa' };
  assert.deepEqual(providers.pointsFor(station, new Error('boom'), null), []);
});

test('pointsFor returns [] on a null/empty payload', () => {
  const station = { id: '9447130', provider: 'noaa' };
  assert.deepEqual(providers.pointsFor(station, null, null), []);
  assert.deepEqual(providers.pointsFor(station, null, { predictions: [] }), []);
});
