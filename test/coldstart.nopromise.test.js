'use strict';
// Regression for issue #90: a fresh install (no cache) cold-starts through
// coldStartThenLocate. The on-device PebbleKit JS runtime is ES5-style and has
// no Promise (the pypkjs emulator does, which masked this). If the cold-start
// path depends on Promise it throws on the watch and locate() never runs, so
// the app hangs forever on "Loading…". This test runs the launch with Promise
// removed and asserts locate() still fires and ready() does not throw.
const { test } = require('node:test');
const assert = require('node:assert');

function fakeLocalStorage() {
  const m = {};
  return {
    getItem: (k) => (k in m ? m[k] : null),
    setItem: (k, v) => { m[k] = String(v); },
    removeItem: (k) => { delete m[k]; },
  };
}

test('cold start (no cache) runs locate() without depending on Promise', () => {
  const ls = fakeLocalStorage(); // empty: no region, no catalog cache -> cold start

  let located = false;
  const listeners = {};
  global.localStorage = ls;
  // Every catalog fetch fails fast (offline). fetchCatalogSlice must still
  // resolve via callback so the cold-start fan-in reaches locate().
  global.XMLHttpRequest = function () {
    this.open = function () {};
    this.setRequestHeader = function () {};
    this.send = function () { if (this.onerror) { this.onerror(); } };
  };
  Object.defineProperty(global, 'navigator', {
    value: { geolocation: { getCurrentPosition: () => { located = true; } } },
    configurable: true, writable: true,
  });
  global.Pebble = {
    addEventListener: (name, fn) => { listeners[name] = fn; },
    sendAppMessage: (msg, ok) => { if (ok) { ok(); } },
  };

  delete require.cache[require.resolve('../src/pkjs/index.js')];
  require('../src/pkjs/index.js'); // module load must not touch Promise

  // Simulate the device runtime: no Promise. Restore before returning so the
  // node:test framework (which uses Promise) is unaffected.
  const savedPromise = global.Promise;
  let readyErr = null;
  try {
    global.Promise = undefined;
    listeners.ready();
  } catch (e) {
    readyErr = e;
  } finally {
    global.Promise = savedPromise;
  }

  assert.strictEqual(readyErr, null,
    'ready() must not throw when Promise is unavailable: ' + (readyErr && readyErr.message));
  assert.ok(located, 'cold start must call geolocation.getCurrentPosition (locate ran)');

  delete global.localStorage; delete global.XMLHttpRequest; delete global.Pebble;
});
