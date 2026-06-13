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

test('setBytes then getBytes round-trips the byte payload', () => {
  const s = fakeStorage();
  const u8 = new Uint8Array([0, 1, 2, 254, 255, 128, 7]);
  blobcache.setBytes(s, 'STN1', u8, '2026-06-13', 3);
  const got = blobcache.getBytes(s, 'STN1');
  assert.deepStrictEqual(Array.from(got.u8), Array.from(u8));
  assert.strictEqual(got.date, '2026-06-13');
  assert.strictEqual(got.version, 3);
});

test('getBytes returns null for an absent station', () => {
  assert.strictEqual(blobcache.getBytes(fakeStorage(), 'NOPE'), null);
});

test('clear removes a cached blob', () => {
  const s = fakeStorage();
  blobcache.setBytes(s, 'STN1', new Uint8Array([1, 2, 3]), '2026-06-13', 3);
  blobcache.clear(s, 'STN1');
  assert.strictEqual(blobcache.getBytes(s, 'STN1'), null);
});

test('base64 round-trips every remainder length (padding correctness)', () => {
  // lengths mod 3 = 0,1,2 exercise the "==", "=", and no-pad branches.
  for (let len = 0; len <= 9; len++) {
    const arr = [];
    for (let i = 0; i < len; i++) { arr.push((i * 37 + 11) & 0xff); }
    const u8 = new Uint8Array(arr);
    assert.deepStrictEqual(Array.from(blobcache.decode(blobcache.encode(u8))), arr,
      'failed at length ' + len);
  }
});

test('setBytes stores under the tideBlob:<id> key', () => {
  const s = fakeStorage();
  blobcache.setBytes(s, 'ABC', new Uint8Array([9]), '2026-06-13', 3);
  assert.deepStrictEqual(s._keys(), ['tideBlob:ABC']);
});

// #59: setBytes returns the stored base64 length so the region download loop
// can account bytes against the budget without re-encoding the blob (it is
// truthy on success, falsy 0 on a quota failure, so the bool contract holds).
test('setBytes returns the stored base64 length on success', () => {
  const s = fakeStorage();
  const u8 = new Uint8Array([1, 2, 3, 4, 5, 6]);
  assert.strictEqual(blobcache.setBytes(s, 'ABC', u8, '2026-06-13', 3), blobcache.encode(u8).length);
});

test('setBytes returns 0 when the write fails (quota)', () => {
  const full = { getItem: () => null, setItem: () => { throw new Error('quota'); }, removeItem: () => {} };
  assert.strictEqual(blobcache.setBytes(full, 'ABC', new Uint8Array([1]), '2026-06-13', 3), 0);
});

// #59: setB64 stores an already-encoded blob so the region loop encodes each
// station once (gate the budget on the length, then store the same string).
test('setB64 stores a pre-encoded blob that getBytes round-trips', () => {
  const s = fakeStorage();
  const u8 = new Uint8Array([7, 8, 9, 10]);
  const b64 = blobcache.encode(u8);
  assert.strictEqual(blobcache.setB64(s, 'STN1', b64, '2026-06-13', 3), b64.length);
  assert.deepStrictEqual(Array.from(blobcache.getBytes(s, 'STN1').u8), Array.from(u8));
});

test('setB64 returns 0 when the write fails (quota)', () => {
  const full = { getItem: () => null, setItem: () => { throw new Error('quota'); }, removeItem: () => {} };
  assert.strictEqual(blobcache.setB64(full, 'ABC', 'AAAA', '2026-06-13', 3), 0);
});
