'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const config = require('../src/pkjs/config');

test('pageUrl renders the Tide location section with range options', () => {
  const url = config.pageUrl({ mode: 'auto' });
  const html = decodeURIComponent(url.replace('data:text/html;charset=utf-8,', ''));
  assert.ok(html.indexOf('Tide location') !== -1);
  assert.ok(html.indexOf('name="locationMode"') !== -1);
  assert.ok(html.indexOf('name="place"') !== -1);
  [7, 15, 30, 45].forEach((d) => assert.ok(html.indexOf('value="' + d + '"') !== -1, 'range ' + d));
});

test('pageUrl shows the current pin and pre-selects pinned mode', () => {
  const url = config.pageUrl({ mode: 'pinned', place: 'Hobart', rangeDays: 30, distanceKm: 8, station: { officialName: 'Hobart' } });
  const html = decodeURIComponent(url.replace('data:text/html;charset=utf-8,', ''));
  assert.ok(html.indexOf('Pinned: Hobart') !== -1, 'shows resolved station');
  assert.ok(html.indexOf('8 km') !== -1, 'shows distance');
});

test('pageUrl shows a pin error when present', () => {
  const url = config.pageUrl({ mode: 'pinned', place: 'Nowhere', rangeDays: 15, station: null, error: "Couldn't find \"Nowhere\"" });
  const html = decodeURIComponent(url.replace('data:text/html;charset=utf-8,', ''));
  assert.ok(html.indexOf("Couldn't find") !== -1);
});

test('pageUrl tolerates a missing pin record (auto default)', () => {
  const url = config.pageUrl();
  assert.ok(url.indexOf('data:text/html') === 0);
});
