'use strict';

// Sunrise/sunset via the NOAA solar-position equations. Pure math, no network,
// so the watch's cached blob carries daylight bounds and night shading works
// offline. Inputs are a UTC instant (any time on the target day) and the
// station's latitude/longitude; outputs are unix seconds (UTC) for that day's
// sunrise and sunset at sea level (standard 90.833 deg zenith, refraction
// included). See https://gml.noaa.gov/grad/solcalc/solareqns.PDF.

var RAD = Math.PI / 180;
var DEG = 180 / Math.PI;
var DAY_MS = 86400000;
var ZENITH = 90.833; // official sunrise/sunset, includes atmospheric refraction

// Julian day for 00:00 UTC of the day containing dateUtcMillis.
function julianDay(dateUtcMillis) {
  var d = new Date(dateUtcMillis);
  var y = d.getUTCFullYear();
  var m = d.getUTCMonth() + 1;
  var day = d.getUTCDate();
  if (m <= 2) { y -= 1; m += 12; }
  var a = Math.floor(y / 100);
  var b = 2 - a + Math.floor(a / 4);
  return Math.floor(365.25 * (y + 4716)) +
    Math.floor(30.6001 * (m + 1)) + day + b - 1524.5;
}

// Hour angle (degrees) of the sun at the given zenith for this declination/lat.
// Returns NaN when the sun never reaches the zenith that day (polar day/night).
function hourAngle(latDeg, declDeg) {
  var cosH = (Math.cos(ZENITH * RAD) -
      Math.sin(latDeg * RAD) * Math.sin(declDeg * RAD)) /
      (Math.cos(latDeg * RAD) * Math.cos(declDeg * RAD));
  if (cosH > 1 || cosH < -1) { return NaN; }
  return Math.acos(cosH) * DEG;
}

function sunTimes(dateUtcMillis, lat, lon) {
  var jd = julianDay(dateUtcMillis);
  // Julian centuries since J2000.0.
  var t = (jd - 2451545.0) / 36525.0;

  var L0 = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360; // mean longitude
  if (L0 < 0) { L0 += 360; }
  var M = 357.52911 + t * (35999.05029 - 0.0001537 * t);          // mean anomaly
  var e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);     // eccentricity

  var C = Math.sin(M * RAD) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
      Math.sin(2 * M * RAD) * (0.019993 - 0.000101 * t) +
      Math.sin(3 * M * RAD) * 0.000289;
  var trueLong = L0 + C;
  var omega = 125.04 - 1934.136 * t;
  var appLong = trueLong - 0.00569 - 0.00478 * Math.sin(omega * RAD);

  var obliq = 23 + (26 + ((21.448 - t * (46.815 + t * (0.00059 - t * 0.001813)))) / 60) / 60;
  var obliqCorr = obliq + 0.00256 * Math.cos(omega * RAD);

  var decl = Math.asin(Math.sin(obliqCorr * RAD) * Math.sin(appLong * RAD)) * DEG;

  // Equation of time (minutes).
  var y = Math.tan(obliqCorr / 2 * RAD); y = y * y;
  var eot = 4 * DEG * (
      y * Math.sin(2 * L0 * RAD) -
      2 * e * Math.sin(M * RAD) +
      4 * e * y * Math.sin(M * RAD) * Math.cos(2 * L0 * RAD) -
      0.5 * y * y * Math.sin(4 * L0 * RAD) -
      1.25 * e * e * Math.sin(2 * M * RAD));

  var ha = hourAngle(lat, decl); // degrees
  // Solar noon in minutes from UTC midnight at this longitude.
  var solarNoonMin = 720 - 4 * lon - eot;

  var midnight = Math.floor(dateUtcMillis / DAY_MS) * DAY_MS; // UTC midnight, ms
  if (isNaN(ha)) {
    // Polar day or night: no real crossing. Fall back to solar noon for both so
    // downstream code stays defined; the watch treats the whole day uniformly.
    var noonEpoch = Math.round((midnight + solarNoonMin * 60000) / 1000);
    return { sunriseEpoch: noonEpoch, sunsetEpoch: noonEpoch };
  }
  var sunriseMin = solarNoonMin - ha * 4; // 4 minutes per degree
  var sunsetMin = solarNoonMin + ha * 4;
  return {
    sunriseEpoch: Math.round((midnight + sunriseMin * 60000) / 1000),
    sunsetEpoch: Math.round((midnight + sunsetMin * 60000) / 1000),
  };
}

module.exports = { sunTimes };
