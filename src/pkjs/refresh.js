'use strict';

// Decide whether to hit the API. Refresh once per local calendar day, or
// immediately when the nearest station changed (the user moved). See
// CONTEXT.md ("the week") and the #3 caching model.

function shouldRefresh(todayStr, currentStationId, last) {
  if (!last) {
    return true;
  }
  return last.date !== todayStr || last.stationId !== currentStationId;
}

module.exports = { shouldRefresh };
