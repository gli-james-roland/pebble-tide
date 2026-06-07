'use strict';

// Issue #9: hand-rolled phone config (no Clay — it has no prebuilt library for
// this app's gabbro/flint targets). A self-contained data: URI HTML page lets
// the user pick height units and clock format; the page returns the choice as
// JSON via the pebblejs://close fragment, which webviewclosed parses.
//
// Settings are stored in localStorage as 0/1 ints, the same encoding sent to
// the watch:
//   units: 0 = feet (default), 1 = metres
//   clock: 0 = 12-hour AM/PM (default), 1 = 24-hour
var STORE_KEY = 'tideConfig';
var DEFAULTS = { units: 0, clock: 0 };

function read() {
  try {
    var raw = localStorage.getItem(STORE_KEY);
    if (!raw) { return { units: DEFAULTS.units, clock: DEFAULTS.clock }; }
    var s = JSON.parse(raw);
    return {
      units: s.units === 1 ? 1 : 0,
      clock: s.clock === 1 ? 1 : 0,
    };
  } catch (e) {
    return { units: DEFAULTS.units, clock: DEFAULTS.clock };
  }
}

// Parse the webviewclosed response (URL-encoded JSON) and persist it.
function save(response) {
  try {
    var decoded = response.match(/^\{/) ? response : decodeURIComponent(response);
    var parsed = JSON.parse(decoded);
    var next = {
      units: parsed.units === 1 ? 1 : 0,
      clock: parsed.clock === 1 ? 1 : 0,
    };
    localStorage.setItem(STORE_KEY, JSON.stringify(next));
    return next;
  } catch (e) {
    console.log('Config parse failed: ' + e);
    return read();
  }
}

// Build the configuration page as a data: URI. Current settings are inlined so
// the controls open pre-selected.
function pageUrl() {
  var s = read();
  var html =
    '<!DOCTYPE html><html><head><meta name="viewport" ' +
    'content="width=device-width, initial-scale=1, user-scalable=no">' +
    '<title>Pebble Tides</title><style>' +
    'body{font-family:-apple-system,Helvetica,Arial,sans-serif;margin:0;' +
    'padding:16px;background:#f4f4f4;color:#222}' +
    'h1{font-size:20px;margin:0 0 4px}p.sub{color:#666;font-size:13px;margin:0 0 20px}' +
    'fieldset{border:none;background:#fff;border-radius:10px;padding:12px 16px;' +
    'margin:0 0 16px}legend{font-weight:600;padding:0 4px}' +
    'label{display:flex;align-items:center;padding:10px 0;font-size:16px}' +
    'label input{margin-right:12px;transform:scale(1.3)}' +
    'button{width:100%;padding:14px;font-size:17px;border:none;border-radius:10px;' +
    'background:#ff4700;color:#fff;font-weight:600}' +
    '</style></head><body>' +
    '<h1>Pebble Tides</h1>' +
    '<p class="sub">Changes apply on the watch without refetching tide data.</p>' +
    '<fieldset><legend>Height units</legend>' +
    '<label><input type="radio" name="units" value="0"' + (s.units === 0 ? ' checked' : '') + '>Feet</label>' +
    '<label><input type="radio" name="units" value="1"' + (s.units === 1 ? ' checked' : '') + '>Metres</label>' +
    '</fieldset>' +
    '<fieldset><legend>Clock format</legend>' +
    '<label><input type="radio" name="clock" value="0"' + (s.clock === 0 ? ' checked' : '') + '>12-hour (AM/PM)</label>' +
    '<label><input type="radio" name="clock" value="1"' + (s.clock === 1 ? ' checked' : '') + '>24-hour</label>' +
    '</fieldset>' +
    '<button id="save">Save</button>' +
    '<script>' +
    'function pick(n){var e=document.getElementsByName(n);' +
    'for(var i=0;i<e.length;i++){if(e[i].checked){return parseInt(e[i].value,10);}}return 0;}' +
    'document.getElementById("save").addEventListener("click",function(){' +
    'var out={units:pick("units"),clock:pick("clock")};' +
    'document.location="pebblejs://close#"+encodeURIComponent(JSON.stringify(out));});' +
    '</script></body></html>';
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

module.exports = { read: read, save: save, pageUrl: pageUrl };
