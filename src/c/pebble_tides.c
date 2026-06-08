#include <pebble.h>
#include <string.h>

// Issue #4: render the inline-labeled tide graph for the next-tide window.
// The blob (v2) carries the merged curve+extrema polyline; we draw the curve
// with a water fill, a datum line, and filled/hollow markers with time labels
// at the highs and lows. Static focus on the next upcoming extremum;
// navigation and the now-state arrive in #5/#6.

#define BLOB_VERSION 3
#define CHUNK_SIZE 64            // must match CHUNK_SIZE in src/pkjs/index.js
#define MAX_BLOB_BYTES 2048
#define MAX_POINTS 256
#define MAX_SUN_DAYS 16          // per-day sunrise/sunset; window is ~9 days
#define MAX_WIN_POINTS 96
#define MAX_DENSE 800            // smoothed (Catmull-Rom) curve samples
#define SMOOTH_STEPS 8           // sub-samples per control segment
#define RECORD_BYTES 7
#define FAR_WARNING_KM 500
#define WINDOW_SECONDS (24 * 3600)  // full day, centered on the Focused Tide

#define PERSIST_BLOB_LEN 10
#define PERSIST_BLOB_BASE 11

// Issue #9: phone-config display prefs, persisted on their own keys (the blob
// owns 10-18). Defaults below apply until the phone sends config.
//   units: 0 = feet (default), 1 = metres
//   clock: 0 = 12-hour AM/PM (default), 1 = 24-hour
#define PERSIST_CONFIG_UNITS 20
#define PERSIST_CONFIG_CLOCK 21
#define PERSIST_CONFIG_MIDTIDE 22
#define UNITS_FEET 0
#define UNITS_METRES 1
#define CLOCK_12H 0
#define CLOCK_24H 1

static Window *s_window;
static Layer *s_graph_layer;
static TextLayer *s_title_layer;
static TextLayer *s_station_layer;
static TextLayer *s_status_layer;
static TextLayer *s_sub_layer;
static GPath *s_up_arrow;
static GPath *s_down_arrow;

static const GPathInfo UP_ARROW_PTS = { 3, (GPoint[]) { {-4, 3}, {4, 3}, {0, -4} } };
static const GPathInfo DOWN_ARROW_PTS = { 3, (GPoint[]) { {-4, -3}, {4, -3}, {0, 4} } };

// Parsed cache state
static bool s_has_data = false;
static char s_station_name[64] = "";
static int s_distance_km = 0;
static bool s_far = false;
static int s_point_count = 0;
static int32_t s_pt_epoch[MAX_POINTS];
static int16_t s_pt_height[MAX_POINTS];
static uint8_t s_pt_kind[MAX_POINTS]; // 0 plain, 1 HIGH, 2 LOW
static int s_min_cm = 0;
static int s_max_cm = 0;
// Per-day sunrise/sunset (unix secs, UTC) for night shading (issue #8).
static int s_sun_count = 0;
static int32_t s_sun_rise[MAX_SUN_DAYS];
static int32_t s_sun_set[MAX_SUN_DAYS];

// Display config (defaults: feet + 12-hour), overridden by the phone.
static int s_units = UNITS_FEET;
static int s_clock = CLOCK_12H;
static int s_show_midtide = 0;   // mid-tide labels off by default

// Chunk reassembly state
static uint8_t s_rx_buf[MAX_BLOB_BYTES];
static int s_rx_total = -1;
static int s_rx_count = 0;
static int s_rx_len = 0;

static char s_title_text[24];

// Graph scratch, kept off the small (~2 KB) app stack.
static int16_t s_sx[MAX_WIN_POINTS], s_sy[MAX_WIN_POINTS];
static uint8_t s_sk[MAX_WIN_POINTS];
static int16_t s_dx[MAX_DENSE], s_dy[MAX_DENSE];

// Mid-tide scratch: at most one crossing on each side of the Focused Tide.
static int32_t s_mid_epoch[2];
static int s_mid_cm[2];
static int s_mid_ext_x[2];   // screen x of the adjacent extremum (label-collision guard)
static int s_mid_count = 0;

// Navigation + curve-pan animation state
static int s_focus_idx = -1;        // index into points of the Focused Tide
static int32_t s_center_epoch = 0;  // animated window-center time
static Animation *s_pan_anim = NULL;
static int32_t s_pan_from = 0, s_pan_to = 0;
static bool s_pan_active = false;  // true while a curve-pan animation runs

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

static bool prv_parse_blob(const uint8_t *buf, int len) {
  if (len < 8 || buf[0] != BLOB_VERSION) {
    APP_LOG(APP_LOG_LEVEL_WARNING, "Blob version/len rejected (%d)", len < 1 ? -1 : buf[0]);
    return false;
  }
  int o = 1;
  uint8_t flags = buf[o]; o += 1;
  uint16_t distance_km; memcpy(&distance_km, buf + o, 2); o += 2;
  uint8_t name_len = buf[o]; o += 1;

  int copy = name_len < (int)sizeof(s_station_name) - 1 ? name_len : (int)sizeof(s_station_name) - 1;
  memcpy(s_station_name, buf + o, copy);
  s_station_name[copy] = '\0';
  o += name_len;

  uint16_t count; memcpy(&count, buf + o, 2); o += 2;
  if (o + (int)count * RECORD_BYTES > len) {
    APP_LOG(APP_LOG_LEVEL_ERROR, "Blob truncated");
    return false;
  }
  if (count > MAX_POINTS) {
    count = MAX_POINTS;
  }

  s_distance_km = distance_km;
  s_far = (flags & 1) == 1;
  s_point_count = count;
  s_min_cm = 32767;
  s_max_cm = -32768;
  for (int i = 0; i < (int)count; i++) {
    memcpy(&s_pt_epoch[i], buf + o, 4); o += 4;
    memcpy(&s_pt_height[i], buf + o, 2); o += 2;
    s_pt_kind[i] = buf[o]; o += 1;
    if (s_pt_height[i] < s_min_cm) { s_min_cm = s_pt_height[i]; }
    if (s_pt_height[i] > s_max_cm) { s_max_cm = s_pt_height[i]; }
  }

  // Sun section (v3): u8 day count, then per day i32 sunrise, i32 sunset.
  s_sun_count = 0;
  if (o < len) {
    int sun_days = buf[o]; o += 1;
    for (int i = 0; i < sun_days; i++) {
      if (o + 8 > len) { break; }
      int32_t rise, set;
      memcpy(&rise, buf + o, 4); o += 4;
      memcpy(&set, buf + o, 4); o += 4;
      if (s_sun_count < MAX_SUN_DAYS) {
        s_sun_rise[s_sun_count] = rise;
        s_sun_set[s_sun_count] = set;
        s_sun_count++;
      }
    }
  }

  s_has_data = s_point_count > 0;
  return true;
}

// ---------------------------------------------------------------------------
// Persistence (split across 256-byte persist fields)
// ---------------------------------------------------------------------------

static void prv_persist_blob(const uint8_t *buf, int len) {
  persist_write_int(PERSIST_BLOB_LEN, len);
  int chunk = 0;
  for (int off = 0; off < len; off += PERSIST_DATA_MAX_LENGTH) {
    int n = len - off;
    if (n > PERSIST_DATA_MAX_LENGTH) { n = PERSIST_DATA_MAX_LENGTH; }
    persist_write_data(PERSIST_BLOB_BASE + chunk, buf + off, n);
    chunk++;
  }
}

static void prv_load_persisted(void) {
  if (!persist_exists(PERSIST_BLOB_LEN)) { return; }
  int len = persist_read_int(PERSIST_BLOB_LEN);
  if (len <= 0 || len > MAX_BLOB_BYTES) { return; }
  int chunk = 0;
  for (int off = 0; off < len; off += PERSIST_DATA_MAX_LENGTH) {
    int n = len - off;
    if (n > PERSIST_DATA_MAX_LENGTH) { n = PERSIST_DATA_MAX_LENGTH; }
    if (!persist_exists(PERSIST_BLOB_BASE + chunk)) { return; }
    persist_read_data(PERSIST_BLOB_BASE + chunk, s_rx_buf + off, n);
    chunk++;
  }
  prv_parse_blob(s_rx_buf, len);
}

// ---------------------------------------------------------------------------
// Display config (issue #9): persist + format helpers
// ---------------------------------------------------------------------------

static void prv_load_config(void) {
  s_units = persist_exists(PERSIST_CONFIG_UNITS)
      ? persist_read_int(PERSIST_CONFIG_UNITS) : UNITS_FEET;
  s_clock = persist_exists(PERSIST_CONFIG_CLOCK)
      ? persist_read_int(PERSIST_CONFIG_CLOCK) : CLOCK_12H;
  s_show_midtide = persist_exists(PERSIST_CONFIG_MIDTIDE)
      ? persist_read_int(PERSIST_CONFIG_MIDTIDE) : 0;
}

// Format a height (stored in cm, metric source of truth) into buf per s_units.
// Feet: cm -> ft via *3.28084/100, one decimal ("x.x ft").
// Metres: two decimals ("x.xx m"). Handles negative levels.
static void prv_format_height(int height_cm, char *buf, int buf_len) {
  if (s_units == UNITS_FEET) {
    // tenths of a foot, rounded: cm * 3.28084 / 100 * 10 = cm * 0.328084
    int neg = height_cm < 0;
    int acm = neg ? -height_cm : height_cm;
    int tenths = (int)(((long)acm * 328084L + 500000L) / 1000000L);
    snprintf(buf, buf_len, "%s%d.%d ft", neg ? "-" : "", tenths / 10, tenths % 10);
  } else {
    int neg = height_cm < 0;
    int acm = neg ? -height_cm : height_cm;
    snprintf(buf, buf_len, "%s%d.%02d m", neg ? "-" : "", acm / 100, acm % 100);
  }
}

// strftime format string for a tide time per s_clock.
static const char *prv_time_fmt(void) {
  return s_clock == CLOCK_24H ? "%H:%M" : "%l:%M %p";
}

// ---------------------------------------------------------------------------
// Focus + text
// ---------------------------------------------------------------------------

static int prv_focus_index(void) {
  time_t now = time(NULL);
  int last_ext = -1;
  for (int i = 0; i < s_point_count; i++) {
    if (s_pt_kind[i] != 0) {
      last_ext = i;
      if (s_pt_epoch[i] >= now) { return i; }
    }
  }
  return last_ext; // all extrema in the past -> last known
}

// Snap focus (no animation) to the next upcoming extremum. Used on launch and
// whenever fresh data arrives.
static void prv_reset_focus(void) {
  s_focus_idx = prv_focus_index();
  if (s_focus_idx >= 0) {
    s_center_epoch = s_pt_epoch[s_focus_idx];
  }
}

static void prv_update_status(void) {
  static char buf[40];
  if (!connection_service_peek_pebble_app_connection()) {
    text_layer_set_text(s_status_layer, "No phone · cached");
    return;
  }
  if (s_far) {
    snprintf(buf, sizeof(buf), "Nearest %d km away", s_distance_km);
    text_layer_set_text(s_status_layer, buf);
    return;
  }
  if (s_focus_idx >= 0) {
    int nb = -1;
    for (int i = s_focus_idx - 1; i >= 0; i--) { if (s_pt_kind[i] != 0) { nb = i; break; } }
    if (nb < 0) { for (int i = s_focus_idx + 1; i < s_point_count; i++) { if (s_pt_kind[i] != 0) { nb = i; break; } } }
    if (nb >= 0) {
      int r = s_pt_height[s_focus_idx] - s_pt_height[nb];
      if (r < 0) { r = -r; }
      char rstr[16];
      prv_format_height(r, rstr, sizeof(rstr));
      snprintf(buf, sizeof(buf), "Range %s", rstr);
      text_layer_set_text(s_status_layer, buf);
      return;
    }
  }
  text_layer_set_text(s_status_layer, "");
}

static void prv_update_chrome(void) {
  if (!s_has_data || s_focus_idx < 0) {
    text_layer_set_text(s_title_layer, "Loading…");
    text_layer_set_text(s_sub_layer, "");
    text_layer_set_text(s_station_layer, "");
    prv_update_status();
    return;
  }
  int f = s_focus_idx;
  time_t ft = (time_t)s_pt_epoch[f];
  struct tm *lt = localtime(&ft);
  // Header is the focused day's date; high/low times are already on the graph.
  strftime(s_title_text, sizeof(s_title_text), "%a %b %e", lt);
  text_layer_set_text(s_title_layer, s_title_text);
  text_layer_set_text(s_sub_layer, "");

  text_layer_set_text(s_station_layer, s_station_name);
  prv_update_status();
}

// ---------------------------------------------------------------------------
// Graph rendering
// ---------------------------------------------------------------------------

static int prv_step_extremum(int from, int dir); // defined with navigation

static int prv_map_y(int height_cm, int y_top, int y_bottom, int lo, int hi) {
  if (hi <= lo) { return y_bottom; }
  int span = hi - lo;
  return y_bottom - (int)((long)(height_cm - lo) * (y_bottom - y_top) / span);
}

static int prv_level_cm_at(int32_t e) {
  for (int i = 0; i < s_point_count - 1; i++) {
    if (s_pt_epoch[i] <= e && e <= s_pt_epoch[i + 1]) {
      int32_t span = s_pt_epoch[i + 1] - s_pt_epoch[i];
      if (span <= 0) { return s_pt_height[i]; }
      int32_t ha = s_pt_height[i], hb = s_pt_height[i + 1];
      int32_t angle = (TRIG_MAX_ANGLE / 2) * (e - s_pt_epoch[i]) / span; // 0..pi
      int32_t c = cos_lookup(angle);
      return (ha + hb) / 2 + (int)(((long)(ha - hb) * c) / (2 * TRIG_MAX_RATIO));
    }
  }
  return s_point_count > 0 ? s_pt_height[0] : 0;
}

// Find where the piecewise-linear curve between cached points [a..b] crosses
// level_cm. Returns the crossing epoch (or 0 if none in range). a < b assumed.
static int32_t prv_cross_epoch(int a, int b, int level_cm) {
  for (int i = a; i < b; i++) {
    int h0 = s_pt_height[i], h1 = s_pt_height[i + 1];
    int lo = h0 < h1 ? h0 : h1, hi = h0 < h1 ? h1 : h0;
    if (level_cm < lo || level_cm > hi) { continue; }
    if (h1 == h0) { return s_pt_epoch[i]; }
    int32_t span = s_pt_epoch[i + 1] - s_pt_epoch[i];
    return s_pt_epoch[i] + (int32_t)((long)(level_cm - h0) * span / (h1 - h0));
  }
  return 0;
}

static bool prv_rising_at(int32_t e) {
  for (int i = 0; i < s_point_count - 1; i++) {
    if (s_pt_epoch[i] <= e && e <= s_pt_epoch[i + 1]) {
      return s_pt_height[i + 1] >= s_pt_height[i];
    }
  }
  return true;
}

// Night if the epoch falls outside every day's daylight span. Spans are
// [sunrise, sunset]; sunset can run past UTC midnight, so spans are checked
// directly rather than bucketed by calendar day. Returns true when no daylight
// span contains the time. With no sun data we report daylight (no shading).
static bool prv_is_night(int32_t e) {
  if (s_sun_count == 0) { return false; }
  for (int i = 0; i < s_sun_count; i++) {
    if (e >= s_sun_rise[i] && e <= s_sun_set[i]) { return false; }
  }
  return true;
}

#define TIDE_COLOR GColorVividCerulean
#if defined(PBL_COLOR)
static const uint8_t BAYER4[4][4] = {
  { 0, 8, 2, 10 }, { 12, 4, 14, 6 }, { 3, 11, 1, 9 }, { 15, 7, 13, 5 }
};
#endif
static int16_t s_sh[MAX_WIN_POINTS];   // control-point heights (cm), for labels

// EXPERIMENT: build the curve as a cosine between consecutive extrema (the
// classic tide shape) instead of the merged hourly polyline. Returns 0 if
// there are too few extrema in range, so the caller can fall back.
static int prv_build_cosine(time_t t0, time_t t1, int x0, int plot_w,
                            int y_top, int y_bottom, int lo, int hi) {
  static int16_t exx[40], exy[40];
  int ex = 0;
  for (int i = 0; i < s_point_count && ex < 40; i++) {
    if (s_pt_kind[i] == 0) { continue; }
    if (s_pt_epoch[i] < (int32_t)t0 - 8 * 3600 || s_pt_epoch[i] > (int32_t)t1 + 8 * 3600) { continue; }
    exx[ex] = x0 + (int)((long)(s_pt_epoch[i] - t0) * plot_w / WINDOW_SECONDS);
    exy[ex] = prv_map_y(s_pt_height[i], y_top, y_bottom, lo, hi);
    ex++;
  }
  if (ex < 2) { return 0; }
  int dn = 0;
  for (int i = 0; i < ex - 1 && dn < MAX_DENSE - 1; i++) {
    int xa = exx[i], ya = exy[i], xb = exx[i + 1], yb = exy[i + 1];
    int steps = SMOOTH_STEPS * 2;
    for (int st = 0; st < steps && dn < MAX_DENSE - 1; st++) {
      int32_t angle = (TRIG_MAX_ANGLE / 2) * st / steps; // 0..pi
      int32_t c = cos_lookup(angle);                     // [-RATIO, RATIO]
      s_dx[dn] = xa + (xb - xa) * st / steps;
      s_dy[dn] = (ya + yb) / 2 + (int)(((long)(ya - yb) * c) / (2 * TRIG_MAX_RATIO));
      dn++;
    }
  }
  s_dx[dn] = exx[ex - 1];
  s_dy[dn] = exy[ex - 1];
  dn++;
  return dn;
}

static void prv_graph_update(Layer *layer, GContext *ctx) {
  GRect b = layer_get_bounds(layer);
  graphics_context_set_fill_color(ctx, GColorBlack);
  graphics_fill_rect(ctx, b, 0, GCornerNone);
  if (!s_has_data || s_point_count < 2) { return; }

  if (s_focus_idx < 0) { return; }
  time_t t0 = (time_t)s_center_epoch - WINDOW_SECONDS / 2;
  time_t t1 = (time_t)s_center_epoch + WINDOW_SECONDS / 2;

  // Draw the curve and fill edge-to-edge horizontally; on a round screen the
  // bezel clips the corners (intended). Only the inline labels clamp inward.
  int x0 = 0, x1 = b.size.w;
  int y_top = PBL_IF_ROUND_ELSE(34, 26);
  int y_bottom = b.size.h - PBL_IF_ROUND_ELSE(40, 30);
  int plot_w = x1 - x0;

  // Fixed weekly vertical scale with padding.
  int pad = (s_max_cm - s_min_cm) / 10;
  if (pad < 15) { pad = 15; }
  int lo = s_min_cm - pad, hi = s_max_cm + pad;

  // Mid-tides: 50% crossings between the Focused Tide and each adjacent
  // extremum. Computed in data space here; drawn as subordinate ticks below.
  s_mid_count = 0;
  int focus_x = x0 + (int)((long)(s_pt_epoch[s_focus_idx] - t0) * plot_w / WINDOW_SECONDS);
  if (s_pt_kind[s_focus_idx] != 0) {
    int prev_ext = prv_step_extremum(s_focus_idx, -1);
    int next_ext = prv_step_extremum(s_focus_idx, +1);
    int adj[2] = { prev_ext, next_ext };
    for (int k = 0; k < 2 && s_mid_count < 2; k++) {
      int j = adj[k];
      if (j < 0) { continue; }
      int a = j < s_focus_idx ? j : s_focus_idx;
      int b = j < s_focus_idx ? s_focus_idx : j;
      int mid_cm = (s_pt_height[s_focus_idx] + s_pt_height[j]) / 2;
      int32_t ce = prv_cross_epoch(a, b, mid_cm);
      if (ce == 0) { continue; }
      if (ce < (int32_t)t0 || ce > (int32_t)t1) { continue; }
      s_mid_epoch[s_mid_count] = ce;
      s_mid_cm[s_mid_count] = mid_cm;
      s_mid_ext_x[s_mid_count] =
          x0 + (int)((long)(s_pt_epoch[j] - t0) * plot_w / WINDOW_SECONDS);
      s_mid_count++;
    }
  }

  // Project points in (and just past) the window to screen space.
  int n = 0;
  for (int i = 0; i < s_point_count && n < MAX_WIN_POINTS; i++) {
    if (s_pt_epoch[i] < t0 - 3600 || s_pt_epoch[i] > t1 + 3600) { continue; }
    int x = x0 + (int)((long)(s_pt_epoch[i] - t0) * plot_w / WINDOW_SECONDS);
    if (x < x0) { x = x0; }
    if (x > x1) { x = x1; }
    s_sx[n] = x;
    s_sy[n] = prv_map_y(s_pt_height[i], y_top, y_bottom, lo, hi);
    s_sk[n] = s_pt_kind[i];
    s_sh[n] = s_pt_height[i];
    n++;
  }
  if (n < 2) { return; }

  // Curve: cosine between consecutive extrema (the tide shape; see ADR 0002).
  int dn = prv_build_cosine(t0, t1, x0, plot_w, y_top, y_bottom, lo, hi);

  // Water fill: light-to-dark vertical gradient under the curve, with a grey
  // night-sky tint above it during dark hours. (B&W keeps a simple night
  // stipple and no fill; full B&W styling is issue #10.)
  // Water: one blue, fading to transparent (sparser dither) with depth, over
  // the black background. Grey night-sky tint above the curve. (Dark-theme
  // experiment; B&W keeps a simple night stipple.)
  for (int i = 0; i < dn - 1; i++) {
    int xa = s_dx[i], xb = s_dx[i + 1];
    if (xb < xa) { continue; }
    int dxw = xb - xa;
    for (int x = xa; x <= xb; x++) {
      int y = dxw > 0 ? s_dy[i] + (s_dy[i + 1] - s_dy[i]) * (x - xa) / dxw : s_dy[i];
      bool night = s_sun_count > 0 &&
        prv_is_night((int32_t)(t0 + (long)(x - x0) * WINDOW_SECONDS / plot_w));
#if defined(PBL_COLOR)
      if (night && y > y_top) {
        graphics_context_set_stroke_color(ctx, GColorDarkGray);
        for (int yy = y_top; yy < y; yy++) { if (((x + yy) & 1) == 0) graphics_draw_pixel(ctx, GPoint(x, yy)); }
      }
      graphics_context_set_stroke_color(ctx, TIDE_COLOR);
      if (s_pan_active) {
        // Cheap solid fill during the pan; full Bayer gradient when settled.
        graphics_draw_line(ctx, GPoint(x, y), GPoint(x, y_bottom));
      } else {
        int ph = y_bottom - y_top;
        for (int yy = y; yy <= y_bottom; yy++) {
          int op = ph > 0 ? 16 - (yy - y_top) * 16 / ph : 16;
          if (BAYER4[yy & 3][x & 3] < op) { graphics_draw_pixel(ctx, GPoint(x, yy)); }
        }
      }
#else
      if (night && y > y_top) {
        graphics_context_set_stroke_color(ctx, GColorWhite);
        for (int yy = y_top + (x & 3); yy < y; yy += 4) {
          graphics_draw_pixel(ctx, GPoint(x, yy));
        }
      }
      // B&W water: sparse white speckle below the curve (skipped while panning).
      if (!s_pan_active) {
        graphics_context_set_stroke_color(ctx, GColorWhite);
        for (int yy = y; yy <= y_bottom; yy++) {
          if (((x * 2 + yy) & 7) == 0) { graphics_draw_pixel(ctx, GPoint(x, yy)); }
        }
      }
#endif
    }
  }

  // Datum (0 m) line when in range.
  if (lo <= 0 && 0 <= hi) {
    int y0 = prv_map_y(0, y_top, y_bottom, lo, hi);
    graphics_context_set_stroke_color(ctx, PBL_IF_COLOR_ELSE(GColorLightGray, GColorBlack));
    for (int x = x0; x <= x1; x += 4) {
      graphics_draw_pixel(ctx, GPoint(x, y0));
    }
  }

  // Smoothed curve line.
  graphics_context_set_stroke_color(ctx, PBL_IF_COLOR_ELSE(GColorElectricBlue, GColorWhite));
  graphics_context_set_stroke_width(ctx, 4);
  for (int i = 0; i < dn - 1; i++) {
    graphics_draw_line(ctx, GPoint(s_dx[i], s_dy[i]), GPoint(s_dx[i + 1], s_dy[i + 1]));
  }
  graphics_context_set_stroke_width(ctx, 1);

  // Mid-tide ticks: subordinate to the high/low markers. A short vertical tick
  // sits on the curve at each 50% crossing; the small time label appears only
  // when it clears the neighbouring extremum labels and the clipped edge zone.
  GFont mid_font = fonts_get_system_font(FONT_KEY_GOTHIC_14);
  for (int i = 0; s_show_midtide && i < s_mid_count; i++) {
    int mx = x0 + (int)((long)(s_mid_epoch[i] - t0) * plot_w / WINDOW_SECONDS);
    int my = prv_map_y(s_mid_cm[i], y_top, y_bottom, lo, hi);

    graphics_context_set_stroke_color(ctx, PBL_IF_COLOR_ELSE(GColorLightGray, GColorWhite));
    graphics_context_set_stroke_width(ctx, 1);
    graphics_draw_circle(ctx, GPoint(mx, my), 2);

    // Suppress the label near either neighbouring extremum or in the edge zone.
    int edge = PBL_IF_ROUND_ELSE(32, 6);
    if (mx < edge || mx > b.size.w - edge) { continue; }
    int df = mx - focus_x; if (df < 0) { df = -df; }
    int de = mx - s_mid_ext_x[i]; if (de < 0) { de = -de; }
    if (df < 18 || de < 18) { continue; }

    time_t mt = (time_t)s_mid_epoch[i];
    struct tm *mlt = localtime(&mt);
    char mlbl[12];
    strftime(mlbl, sizeof(mlbl), prv_time_fmt(), mlt);
    int mw = 64, mlx = mx - mw / 2;
    if (mlx < 0) { mlx = 0; }
    if (mlx + mw > b.size.w) { mlx = b.size.w - mw; }
    graphics_context_set_text_color(ctx, GColorWhite);
    graphics_draw_text(ctx, mlbl, mid_font, GRect(mlx, my - 20, mw, 16),
                       GTextOverflowModeFill, GTextAlignmentCenter, NULL);
  }

  // Now overlay: only when the current time falls inside the visible window.
  time_t now_t = time(NULL);
  if (now_t >= t0 && now_t <= t1) {
    int nx = x0 + (int)((long)(now_t - t0) * plot_w / WINDOW_SECONDS);
    int level = prv_level_cm_at((int32_t)now_t);
    int ny = prv_map_y(level, y_top, y_bottom, lo, hi);

    graphics_context_set_stroke_color(ctx, GColorWhite);
    graphics_context_set_stroke_width(ctx, 2);
    graphics_draw_line(ctx, GPoint(nx, y_top), GPoint(nx, y_bottom));
    graphics_context_set_stroke_width(ctx, 1);

    graphics_context_set_fill_color(ctx, GColorWhite);
    graphics_fill_circle(ctx, GPoint(nx, ny), 4);

    // Current height + trend at the TOP of the now-line, clear of the curve dot.
    char hstr[16];
    prv_format_height(level, hstr, sizeof(hstr));
    int hw = 56;
    bool left_side = (nx + 14 + hw > b.size.w);
    int hx = left_side ? nx - 12 - hw : nx + 14;
    if (hx < 0) { hx = 0; }
    GPath *arrow = prv_rising_at((int32_t)now_t) ? s_up_arrow : s_down_arrow;
    gpath_move_to(arrow, GPoint(left_side ? nx - 5 : nx + 5, y_top + 8));
    graphics_context_set_fill_color(ctx, GColorWhite);
    gpath_draw_filled(ctx, arrow);
    graphics_context_set_text_color(ctx, GColorWhite);
    graphics_draw_text(ctx, hstr, fonts_get_system_font(FONT_KEY_GOTHIC_14),
                       GRect(hx, y_top + 1, hw, 18), GTextOverflowModeFill,
                       left_side ? GTextAlignmentRight : GTextAlignmentLeft, NULL);
  }

  // Markers + pill labels drawn LAST so they sit above the now-line and curve.
  // Markers: black centre, tide-coloured ring. Labels are coloured pills
  // (HIGH = tide blue, LOW = pink) with white time + height. (Dark-theme
  // experiment.)
  GFont pill_font = fonts_get_system_font(FONT_KEY_GOTHIC_14);
  bool small_screen = b.size.w < 160;  // 144px rect: show only the focused pill
  for (int i = 0; i < n; i++) {
    if (s_sk[i] == 0) { continue; }
    bool high = s_sk[i] == 1;
    GPoint p = GPoint(s_sx[i], s_sy[i]);
#if defined(PBL_COLOR)
    graphics_context_set_fill_color(ctx, GColorBlack);
    graphics_fill_circle(ctx, p, 5);
    graphics_context_set_stroke_color(ctx, TIDE_COLOR);
    graphics_context_set_stroke_width(ctx, 2);
    graphics_draw_circle(ctx, p, 5);
    graphics_context_set_stroke_width(ctx, 1);
#else
    // B&W: shape carries high/low -- HIGH filled, LOW hollow.
    graphics_context_set_fill_color(ctx, high ? GColorWhite : GColorBlack);
    graphics_fill_circle(ctx, p, 5);
    if (!high) {
      graphics_context_set_stroke_color(ctx, GColorWhite);
      graphics_context_set_stroke_width(ctx, 2);
      graphics_draw_circle(ctx, p, 5);
      graphics_context_set_stroke_width(ctx, 1);
    }
#endif

    int edge = PBL_IF_ROUND_ELSE(32, 6);
    if (s_sx[i] < edge || s_sx[i] > b.size.w - edge) { continue; }

    // Small screens are too dense for every pill: show only the centred
    // (Focused) tide; the other markers keep just their dots.
    bool focused = s_sx[i] >= focus_x - 2 && s_sx[i] <= focus_x + 2;
    if (small_screen && !focused) { continue; }

    time_t pt = (time_t)(t0 + (long)(s_sx[i] - x0) * WINDOW_SECONDS / plot_w);
    struct tm *lt = localtime(&pt);
    char tstr[12], hstr[12];
    strftime(tstr, sizeof(tstr), prv_time_fmt(), lt);
    prv_format_height(s_sh[i], hstr, sizeof(hstr));

    int pw = 72, ph = 36;
    int px = s_sx[i] - pw / 2;
    if (px < 0) { px = 0; }
    if (px + pw > b.size.w) { px = b.size.w - pw; }
    int py = high ? s_sy[i] - ph - 8 : s_sy[i] + 8;
    GColor pill_fill = PBL_IF_COLOR_ELSE(high ? TIDE_COLOR : GColorFolly, GColorBlack);
    if (small_screen) {              // centred tide: red pill below the dot
      pill_fill = PBL_IF_COLOR_ELSE(GColorRed, GColorBlack);
      py = s_sy[i] + 8;
      if (py + ph > y_bottom) { py = s_sy[i] - ph - 8; }
    }
    // Keep the pill inside the plot so it never overlaps the date header or footer.
    if (py < y_top) { py = y_top; }
    if (py + ph > y_bottom) { py = y_bottom - ph; }
    graphics_context_set_fill_color(ctx, pill_fill);
    graphics_fill_rect(ctx, GRect(px, py, pw, ph), 6, GCornersAll);
#if !defined(PBL_COLOR)
    graphics_context_set_stroke_color(ctx, GColorWhite);
    graphics_draw_round_rect(ctx, GRect(px, py, pw, ph), 6);
#endif
    graphics_context_set_text_color(ctx, GColorWhite);
    graphics_draw_text(ctx, tstr, pill_font, GRect(px, py + 1, pw, 16),
                       GTextOverflowModeFill, GTextAlignmentCenter, NULL);
    graphics_draw_text(ctx, hstr, pill_font, GRect(px, py + 18, pw, 16),
                       GTextOverflowModeFill, GTextAlignmentCenter, NULL);
  }
}

// ---------------------------------------------------------------------------
// AppMessage chunk reassembly
// ---------------------------------------------------------------------------

// Issue #9: a display-config message (independent of the blob). Presence of
// MESSAGE_KEY_CONFIG_UNITS marks it. Store, persist, redraw — no refetch.
static bool prv_handle_config(DictionaryIterator *iter) {
  Tuple *units_t = dict_find(iter, MESSAGE_KEY_CONFIG_UNITS);
  if (!units_t) { return false; }
  s_units = units_t->value->int32 == UNITS_METRES ? UNITS_METRES : UNITS_FEET;
  Tuple *clock_t = dict_find(iter, MESSAGE_KEY_CONFIG_CLOCK);
  if (clock_t) {
    s_clock = clock_t->value->int32 == CLOCK_24H ? CLOCK_24H : CLOCK_12H;
  }
  Tuple *mid_t = dict_find(iter, MESSAGE_KEY_CONFIG_MIDTIDE);
  if (mid_t) {
    s_show_midtide = mid_t->value->int32 ? 1 : 0;
  }
  persist_write_int(PERSIST_CONFIG_UNITS, s_units);
  persist_write_int(PERSIST_CONFIG_CLOCK, s_clock);
  persist_write_int(PERSIST_CONFIG_MIDTIDE, s_show_midtide);
  prv_update_chrome();
  layer_mark_dirty(s_graph_layer);
  APP_LOG(APP_LOG_LEVEL_INFO, "Config: units=%d clock=%d mid=%d", s_units, s_clock, s_show_midtide);
  return true;
}

static void prv_inbox_received(DictionaryIterator *iter, void *context) {
  if (prv_handle_config(iter)) { return; }

  Tuple *idx_t = dict_find(iter, MESSAGE_KEY_CHUNK_INDEX);
  Tuple *total_t = dict_find(iter, MESSAGE_KEY_CHUNK_TOTAL);
  Tuple *data_t = dict_find(iter, MESSAGE_KEY_CHUNK_DATA);
  if (!idx_t || !total_t || !data_t) { return; }

  int index = idx_t->value->int32;
  int total = total_t->value->int32;
  int dlen = data_t->length;
  int offset = index * CHUNK_SIZE;
  if (offset + dlen > MAX_BLOB_BYTES) {
    APP_LOG(APP_LOG_LEVEL_ERROR, "Chunk overflow");
    return;
  }

  if (index == 0) {
    s_rx_total = total;
    s_rx_count = 0;
    s_rx_len = 0;
  }
  memcpy(s_rx_buf + offset, data_t->value->data, dlen);
  if (offset + dlen > s_rx_len) { s_rx_len = offset + dlen; }
  s_rx_count++;

  if (s_rx_total > 0 && s_rx_count >= s_rx_total) {
    if (prv_parse_blob(s_rx_buf, s_rx_len)) {
      prv_persist_blob(s_rx_buf, s_rx_len);
      prv_reset_focus();
      prv_update_chrome();
      layer_mark_dirty(s_graph_layer);
      APP_LOG(APP_LOG_LEVEL_INFO, "Cache updated: %d points, %s",
              s_point_count, s_station_name);
    }
    s_rx_total = -1;
  }
}

static void prv_connection_handler(bool connected) {
  prv_update_status();
}

// ---------------------------------------------------------------------------
// Navigation + curve-pan animation
// ---------------------------------------------------------------------------

static void prv_anim_update(Animation *a, AnimationProgress prog) {
  s_center_epoch = s_pan_from +
    (int32_t)((int64_t)(s_pan_to - s_pan_from) * prog / ANIMATION_NORMALIZED_MAX);
  layer_mark_dirty(s_graph_layer);
}

static void prv_anim_teardown(Animation *a) {
  s_pan_active = false;          // settled: redraw at full water quality
  layer_mark_dirty(s_graph_layer);
}

static const AnimationImplementation s_anim_impl = {
  .update = prv_anim_update, .teardown = prv_anim_teardown
};

// Pan the window center toward target_epoch. A press mid-pan cancels and
// retargets from the current interpolated center (no queueing).
static void prv_pan_to(int32_t target_epoch) {
  if (s_pan_anim) {
    animation_unschedule(s_pan_anim);
    animation_destroy(s_pan_anim);
    s_pan_anim = NULL;
  }
  s_pan_from = s_center_epoch;
  s_pan_to = target_epoch;
  s_pan_anim = animation_create();
  animation_set_implementation(s_pan_anim, &s_anim_impl);
  animation_set_duration(s_pan_anim, 250);
  animation_set_curve(s_pan_anim, AnimationCurveEaseInOut);
  s_pan_active = true;
  animation_schedule(s_pan_anim);
}

static int prv_step_extremum(int from, int dir) {
  for (int i = from + dir; i >= 0 && i < s_point_count; i += dir) {
    if (s_pt_kind[i] != 0) { return i; }
  }
  return -1; // no further extremum in that direction (clamp, no wrap)
}

static int prv_extremum_near(int32_t target_epoch) {
  int best = -1; int32_t best_d = 0;
  for (int i = 0; i < s_point_count; i++) {
    if (s_pt_kind[i] == 0) { continue; }
    int32_t d = s_pt_epoch[i] > target_epoch
        ? s_pt_epoch[i] - target_epoch : target_epoch - s_pt_epoch[i];
    if (best < 0 || d < best_d) { best = i; best_d = d; }
  }
  return best;
}

static void prv_focus_to(int idx) {
  if (idx < 0 || idx >= s_point_count) { return; }
  s_focus_idx = idx;
  prv_pan_to(s_pt_epoch[idx]);
  prv_update_chrome();
}

static void prv_click_up(ClickRecognizerRef r, void *ctx) {
  prv_focus_to(prv_step_extremum(s_focus_idx, -1)); // previous tide
}

static void prv_click_down(ClickRecognizerRef r, void *ctx) {
  prv_focus_to(prv_step_extremum(s_focus_idx, +1)); // next tide
}

static void prv_click_select(ClickRecognizerRef r, void *ctx) {
  prv_focus_to(prv_focus_index()); // Now Jump: back to the next upcoming tide
}

static void prv_long_up(ClickRecognizerRef r, void *ctx) {
  if (s_focus_idx >= 0) { prv_focus_to(prv_extremum_near(s_pt_epoch[s_focus_idx] - 86400)); }
}

static void prv_long_down(ClickRecognizerRef r, void *ctx) {
  if (s_focus_idx >= 0) { prv_focus_to(prv_extremum_near(s_pt_epoch[s_focus_idx] + 86400)); }
}

static void prv_click_config(void *ctx) {
  window_single_click_subscribe(BUTTON_ID_UP, prv_click_up);
  window_single_click_subscribe(BUTTON_ID_DOWN, prv_click_down);
  window_single_click_subscribe(BUTTON_ID_SELECT, prv_click_select);
  window_long_click_subscribe(BUTTON_ID_UP, 0, prv_long_up, NULL);
  window_long_click_subscribe(BUTTON_ID_DOWN, 0, prv_long_down, NULL);
}

// ---------------------------------------------------------------------------
// Window / app lifecycle
// ---------------------------------------------------------------------------

static void prv_window_load(Window *window) {
  window_set_background_color(window, GColorBlack);
  Layer *root = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(root);

  // Graph at the bottom of the z-order; text chrome drawn on top of it.
  s_graph_layer = layer_create(bounds);
  layer_set_update_proc(s_graph_layer, prv_graph_update);
  layer_add_child(root, s_graph_layer);

  s_title_layer = text_layer_create(GRect(0, PBL_IF_ROUND_ELSE(8, 2), bounds.size.w, 20));
  text_layer_set_text_alignment(s_title_layer, GTextAlignmentCenter);
  text_layer_set_background_color(s_title_layer, GColorClear);
  text_layer_set_font(s_title_layer, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD));
  text_layer_set_text_color(s_title_layer, GColorWhite);
  layer_add_child(root, text_layer_get_layer(s_title_layer));

  s_sub_layer = text_layer_create(GRect(0, PBL_IF_ROUND_ELSE(30, 22), bounds.size.w, 18));
  text_layer_set_text_alignment(s_sub_layer, GTextAlignmentCenter);
  text_layer_set_background_color(s_sub_layer, GColorClear);
  text_layer_set_font(s_sub_layer, fonts_get_system_font(FONT_KEY_GOTHIC_14));
  text_layer_set_text_color(s_sub_layer, GColorWhite);
  layer_add_child(root, text_layer_get_layer(s_sub_layer));

  s_station_layer = text_layer_create(GRect(0, bounds.size.h - PBL_IF_ROUND_ELSE(34, 28), bounds.size.w, 18));
  text_layer_set_text_alignment(s_station_layer, GTextAlignmentCenter);
  text_layer_set_background_color(s_station_layer, GColorClear);
  text_layer_set_font(s_station_layer, fonts_get_system_font(FONT_KEY_GOTHIC_14));
  text_layer_set_text_color(s_station_layer, GColorWhite);
  layer_add_child(root, text_layer_get_layer(s_station_layer));

  s_status_layer = text_layer_create(GRect(0, bounds.size.h - PBL_IF_ROUND_ELSE(18, 14), bounds.size.w, 14));
  text_layer_set_text_alignment(s_status_layer, GTextAlignmentCenter);
  text_layer_set_background_color(s_status_layer, GColorClear);
  text_layer_set_font(s_status_layer, fonts_get_system_font(FONT_KEY_GOTHIC_14));
  text_layer_set_text_color(s_status_layer, GColorWhite);
  layer_add_child(root, text_layer_get_layer(s_status_layer));

  prv_update_chrome();
}

static void prv_window_unload(Window *window) {
  layer_destroy(s_graph_layer);
  text_layer_destroy(s_title_layer);
  text_layer_destroy(s_sub_layer);
  text_layer_destroy(s_station_layer);
  text_layer_destroy(s_status_layer);
}

static void prv_tick(struct tm *tick_time, TimeUnits units_changed) {
  prv_update_chrome();
  layer_mark_dirty(s_graph_layer);
}

static void prv_init(void) {
  prv_load_config();
  prv_load_persisted();
  prv_reset_focus();

  s_window = window_create();
  window_set_window_handlers(s_window, (WindowHandlers) {
    .load = prv_window_load,
    .unload = prv_window_unload,
  });
  window_set_click_config_provider(s_window, prv_click_config);
  window_stack_push(s_window, true);

  s_up_arrow = gpath_create(&UP_ARROW_PTS);
  s_down_arrow = gpath_create(&DOWN_ARROW_PTS);
  tick_timer_service_subscribe(MINUTE_UNIT, prv_tick);

  app_message_register_inbox_received(prv_inbox_received);
  app_message_open(app_message_inbox_size_maximum(), app_message_outbox_size_maximum());

  connection_service_subscribe((ConnectionHandlers) {
    .pebble_app_connection_handler = prv_connection_handler,
  });
}

static void prv_deinit(void) {
  if (s_pan_anim) {
    animation_unschedule(s_pan_anim);
    animation_destroy(s_pan_anim);
    s_pan_anim = NULL;
  }
  tick_timer_service_unsubscribe();
  gpath_destroy(s_up_arrow);
  gpath_destroy(s_down_arrow);
  connection_service_unsubscribe();
  window_destroy(s_window);
}

int main(void) {
  prv_init();
  app_event_loop();
  prv_deinit();
}
