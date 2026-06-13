'use strict';

// Decide whether to hit the API. Refresh once per local calendar day, or
// immediately when the nearest station changed (the user moved). See
// CONTEXT.md ("the week") and the #3 caching model.

function shouldRefresh(todayStr, currentStationId, blobVersion, last) {
  if (!last) {
    return true;
  }
  return last.date !== todayStr ||
    last.stationId !== currentStationId ||
    last.version !== blobVersion; // an app update that bumps the blob format
}

// Region staleness (#61). A region's predictions are static per date, but its
// rangeDays window runs out as time passes. On an online launch we extend it by
// re-downloading the whole region once the window has aged past a threshold.
// Stale when the remaining window (rangeDays - ageInDays) is at or below
// minDaysRemaining. A null/missing fetchedAt counts as stale (never anchored).
// ageInDays is the UTC calendar-day diff between two 'YYYY-MM-DD' strings.
function daysBetweenUTC(fromStr, toStr) {
  var DAY_MS = 24 * 60 * 60 * 1000;
  var from = Date.parse(fromStr + 'T00:00:00Z');
  var to = Date.parse(toStr + 'T00:00:00Z');
  return Math.round((to - from) / DAY_MS);
}

function regionNeedsRefresh(fetchedAt, todayStr, rangeDays, minDaysRemaining) {
  if (!fetchedAt) {
    return true;
  }
  var threshold = (minDaysRemaining === undefined) ? 30 : minDaysRemaining;
  var ageInDays = daysBetweenUTC(fetchedAt, todayStr);
  return (rangeDays - ageInDays) <= threshold;
}

module.exports = { shouldRefresh: shouldRefresh, regionNeedsRefresh: regionNeedsRefresh };
