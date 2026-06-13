'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const blobcache = require('../src/pkjs/blobcache');

function fakeStorage() {
  const m = {};
  return {
    getItem: (k) => (k in m ? m[k] : null),
    setItem: (k, v) => { m[k] = String(v); },
    removeItem: (k) => { delete m[k]; },
    _keys: () => Object.keys(m),
  };
}

function seed(s, ids) {
  ids.forEach((id) => blobcache.setBytes(s, id, new Uint8Array([1, 2, 3]), '2026-06-13', 3));
}

test('evict removes only old ids absent from the keep set, keeps shared ones', () => {
  const s = fakeStorage();
  seed(s, ['A', 'B', 'C']);
  const removed = blobcache.evict(s, ['A', 'B', 'C'], ['B', 'C', 'D']);
  assert.strictEqual(removed, 1);                       // only A removed
  assert.strictEqual(blobcache.getBytes(s, 'A'), null); // A gone
  assert.ok(blobcache.getBytes(s, 'B'));                // shared kept
  assert.ok(blobcache.getBytes(s, 'C'));                // shared kept
});

test('evict with an empty keep set removes every old blob (clear-region)', () => {
  const s = fakeStorage();
  seed(s, ['A', 'B', 'C']);
  const removed = blobcache.evict(s, ['A', 'B', 'C'], []);
  assert.strictEqual(removed, 3);
  assert.deepStrictEqual(s._keys(), []);
});

test('evict leaves untracked blobs and never iterates storage keys', () => {
  const s = fakeStorage();
  seed(s, ['A', 'KEEP']);            // KEEP not in oldIds -> must survive
  blobcache.evict(s, ['A'], []);     // only A is authoritative-old
  assert.strictEqual(blobcache.getBytes(s, 'A'), null);
  assert.ok(blobcache.getBytes(s, 'KEEP'), 'blob outside oldIds must be untouched');
});

test('evict tolerates missing oldIds / keepIds args', () => {
  const s = fakeStorage();
  seed(s, ['A']);
  assert.strictEqual(blobcache.evict(s), 0);          // nothing to do
  assert.strictEqual(blobcache.evict(s, ['A']), 1);   // keepIds defaults to none
  assert.strictEqual(blobcache.getBytes(s, 'A'), null);
});
