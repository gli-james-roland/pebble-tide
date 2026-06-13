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

test('pageUrl shows the cached region and pre-selects region mode', () => {
  const url = config.pageUrl({ mode: 'region', place: 'Hobart', radiusKm: 150, rangeDays: 30, stations: [{ id: 'a' }, { id: 'b' }], truncated: false });
  const html = decodeURIComponent(url.replace('data:text/html;charset=utf-8,', ''));
  assert.ok(html.indexOf('Cached 2 stations near "Hobart"') !== -1, 'shows cached count');
  assert.ok(html.indexOf('value="region" checked') !== -1, 'region mode pre-selected');
  assert.ok(html.indexOf('value="150" checked') !== -1, 'radius pre-selected');
});

test('pageUrl flags a truncated (capped) region', () => {
  const url = config.pageUrl({ mode: 'region', place: 'Seattle', radiusKm: 300, rangeDays: 45, stations: [{ id: 'a' }], truncated: true });
  const html = decodeURIComponent(url.replace('data:text/html;charset=utf-8,', ''));
  assert.ok(html.indexOf('(capped)') !== -1);
});

test('pageUrl shows a region error when present', () => {
  const url = config.pageUrl({ mode: 'region', place: 'Nowhere', radiusKm: 75, rangeDays: 15, stations: [], error: "Couldn't find \"Nowhere\"" });
  const html = decodeURIComponent(url.replace('data:text/html;charset=utf-8,', ''));
  assert.ok(html.indexOf("Couldn't find") !== -1);
});

test('pageUrl labels the radius and offline-days groups as sub-headings', () => {
  const url = config.pageUrl({ mode: 'region', place: 'Hobart', radiusKm: 75, rangeDays: 45, stations: [{ id: 'a' }] });
  const html = decodeURIComponent(url.replace('data:text/html;charset=utf-8,', ''));
  assert.ok(html.indexOf('Search radius') !== -1, 'radius sub-heading');
  assert.ok(html.indexOf('Offline days') !== -1, 'offline-days sub-heading');
});

test('pageUrl status reports the radius and cap when capped', () => {
  const url = config.pageUrl({ mode: 'region', place: 'Seattle', radiusKm: 300, rangeDays: 45, cap: 400, stations: new Array(400).fill({ id: 'a' }), truncated: true });
  const html = decodeURIComponent(url.replace('data:text/html;charset=utf-8,', ''));
  assert.ok(html.indexOf('Cached 400 stations') !== -1, 'cached count');
  assert.ok(html.indexOf('300 km') !== -1, 'radius in status');
  assert.ok(html.indexOf('capped at 400') !== -1, 'cap surfaced');
});

test('pageUrl tolerates a missing region record (auto default)', () => {
  const url = config.pageUrl();
  assert.ok(url.indexOf('data:text/html') === 0);
  const html = decodeURIComponent(url.replace('data:text/html;charset=utf-8,', ''));
  assert.ok(html.indexOf('value="auto" checked') !== -1, 'auto mode default');
});

test('pageUrl escapes HTML in place and error', () => {
  const url = config.pageUrl({ mode: 'region', place: 'A<b>&"c', radiusKm: 75, rangeDays: 7, stations: [{ id: 'a' }] });
  const html = decodeURIComponent(url.replace('data:text/html;charset=utf-8,', ''));
  assert.ok(html.indexOf('A&lt;b&gt;&amp;&quot;c') !== -1, 'place escaped in status + attribute');
  const errUrl = config.pageUrl({ mode: 'region', place: 'x', radiusKm: 75, rangeDays: 7, stations: [], error: '<script>x</script>' });
  const errHtml = decodeURIComponent(errUrl.replace('data:text/html;charset=utf-8,', ''));
  assert.ok(errHtml.indexOf('<script>x</script>') === -1, 'error must be escaped');
});
