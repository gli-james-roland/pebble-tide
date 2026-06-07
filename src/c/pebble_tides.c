#include <pebble.h>
#include <string.h>

// Issue #4: render the inline-labeled tide graph for the next-tide window.
// The blob (v2) carries the merged curve+extrema polyline; we draw the curve
// with a water fill, a datum line, and filled/hollow markers with time labels
// at the highs and lows. Static focus on the next upcoming extremum;
// navigation and the now-state arrive in #5/#6.

#define BLOB_VERSION 2
#define CHUNK_SIZE 64            // must match CHUNK_SIZE in src/pkjs/index.js
#define MAX_BLOB_BYTES 2048
#define MAX_POINTS 256
#define MAX_WIN_POINTS 96
#define RECORD_BYTES 7
#define FAR_WARNING_KM 500
#define WINDOW_SECONDS (14 * 3600)

#define PERSIST_BLOB_LEN 10
#define PERSIST_BLOB_BASE 11

static Window *s_window;
static Layer *s_graph_layer;
static TextLayer *s_title_layer;
static TextLayer *s_station_layer;
static TextLayer *s_status_layer;

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

// Chunk reassembly state
static uint8_t s_rx_buf[MAX_BLOB_BYTES];
static int s_rx_total = -1;
static int s_rx_count = 0;
static int s_rx_len = 0;

static char s_title_text[24];

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

static void prv_update_status(void) {
  static char far_text[28];
  if (!connection_service_peek_pebble_app_connection()) {
    text_layer_set_text(s_status_layer, "No phone · cached");
  } else if (s_far) {
    snprintf(far_text, sizeof(far_text), "Nearest %d km away", s_distance_km);
    text_layer_set_text(s_status_layer, far_text);
  } else {
    text_layer_set_text(s_status_layer, "");
  }
}

static void prv_update_chrome(void) {
  if (!s_has_data) {
    text_layer_set_text(s_title_layer, "Loading…");
    text_layer_set_text(s_station_layer, "");
  } else {
    int f = prv_focus_index();
    time_t t = (time_t)(f >= 0 ? s_pt_epoch[f] : time(NULL));
    struct tm *lt = localtime(&t);
    strftime(s_title_text, sizeof(s_title_text), "%a %b %e", lt);
    text_layer_set_text(s_title_layer, s_title_text);
    text_layer_set_text(s_station_layer, s_station_name);
  }
  prv_update_status();
}

// ---------------------------------------------------------------------------
// Graph rendering
// ---------------------------------------------------------------------------

static int prv_map_y(int height_cm, int y_top, int y_bottom, int lo, int hi) {
  if (hi <= lo) { return y_bottom; }
  int span = hi - lo;
  return y_bottom - (int)((long)(height_cm - lo) * (y_bottom - y_top) / span);
}

static void prv_graph_update(Layer *layer, GContext *ctx) {
  GRect b = layer_get_bounds(layer);
  graphics_context_set_fill_color(ctx, GColorWhite);
  graphics_fill_rect(ctx, b, 0, GCornerNone);
  if (!s_has_data || s_point_count < 2) { return; }

  int focus = prv_focus_index();
  if (focus < 0) { return; }
  time_t t0 = (time_t)s_pt_epoch[focus] - WINDOW_SECONDS / 2;
  time_t t1 = (time_t)s_pt_epoch[focus] + WINDOW_SECONDS / 2;

  // Draw the curve and fill edge-to-edge horizontally; on a round screen the
  // bezel clips the corners (intended). Only the inline labels clamp inward.
  int x0 = 0, x1 = b.size.w;
  int y_top = PBL_IF_ROUND_ELSE(40, 26);
  int y_bottom = b.size.h - PBL_IF_ROUND_ELSE(40, 30);
  int plot_w = x1 - x0;

  // Fixed weekly vertical scale with padding.
  int pad = (s_max_cm - s_min_cm) / 10;
  if (pad < 15) { pad = 15; }
  int lo = s_min_cm - pad, hi = s_max_cm + pad;

  // Project points in (and just past) the window to screen space.
  int16_t sx[MAX_WIN_POINTS], sy[MAX_WIN_POINTS];
  uint8_t sk[MAX_WIN_POINTS];
  int n = 0;
  for (int i = 0; i < s_point_count && n < MAX_WIN_POINTS; i++) {
    if (s_pt_epoch[i] < t0 - 3600 || s_pt_epoch[i] > t1 + 3600) { continue; }
    int x = x0 + (int)((long)(s_pt_epoch[i] - t0) * plot_w / WINDOW_SECONDS);
    if (x < x0) { x = x0; }
    if (x > x1) { x = x1; }
    sx[n] = x;
    sy[n] = prv_map_y(s_pt_height[i], y_top, y_bottom, lo, hi);
    sk[n] = s_pt_kind[i];
    n++;
  }
  if (n < 2) { return; }

  // Water fill: for each column, interpolate the curve y and fill down.
  GColor water = PBL_IF_COLOR_ELSE(GColorVividCerulean, GColorClear);
  if (!gcolor_equal(water, GColorClear)) {
    graphics_context_set_stroke_color(ctx, water);
    int seg = 0;
    for (int x = sx[0]; x <= sx[n - 1]; x++) {
      while (seg < n - 2 && sx[seg + 1] < x) { seg++; }
      int dx = sx[seg + 1] - sx[seg];
      int y = dx > 0
        ? sy[seg] + (sy[seg + 1] - sy[seg]) * (x - sx[seg]) / dx
        : sy[seg];
      graphics_draw_line(ctx, GPoint(x, y), GPoint(x, y_bottom));
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

  // Curve line.
  graphics_context_set_stroke_color(ctx, PBL_IF_COLOR_ELSE(GColorDukeBlue, GColorBlack));
  graphics_context_set_stroke_width(ctx, 2);
  for (int i = 0; i < n - 1; i++) {
    graphics_draw_line(ctx, GPoint(sx[i], sy[i]), GPoint(sx[i + 1], sy[i + 1]));
  }
  graphics_context_set_stroke_width(ctx, 1);

  // Markers + inline time labels at the extrema.
  GFont font = fonts_get_system_font(FONT_KEY_GOTHIC_14);
  for (int i = 0; i < n; i++) {
    if (sk[i] == 0) { continue; }
    bool high = sk[i] == 1;
    GPoint p = GPoint(sx[i], sy[i]);
    graphics_context_set_fill_color(ctx, GColorBlack);
    graphics_context_set_stroke_color(ctx, GColorBlack);
    if (high) {
      graphics_fill_circle(ctx, p, 3);
    } else {
      graphics_draw_circle(ctx, p, 3);
    }

    // Look the point's epoch back up for the label time.
    time_t pt = (time_t)(t0 + (long)(sx[i] - x0) * WINDOW_SECONDS / plot_w);
    struct tm *lt = localtime(&pt);
    char lbl[8];
    strftime(lbl, sizeof(lbl), clock_is_24h_style() ? "%H:%M" : "%l:%M", lt);

    int lw = 40;
    int lx = sx[i] - lw / 2;
    if (lx < 0) { lx = 0; }
    if (lx + lw > b.size.w) { lx = b.size.w - lw; }
    int ly = high ? sy[i] - 22 : sy[i] + 6;
    graphics_context_set_text_color(ctx, GColorBlack);
    graphics_draw_text(ctx, lbl, font, GRect(lx, ly, lw, 16),
                       GTextOverflowModeFill, GTextAlignmentCenter, NULL);
  }
}

// ---------------------------------------------------------------------------
// AppMessage chunk reassembly
// ---------------------------------------------------------------------------

static void prv_inbox_received(DictionaryIterator *iter, void *context) {
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
// Window / app lifecycle
// ---------------------------------------------------------------------------

static void prv_window_load(Window *window) {
  window_set_background_color(window, GColorWhite);
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
  layer_add_child(root, text_layer_get_layer(s_title_layer));

  s_station_layer = text_layer_create(GRect(0, bounds.size.h - PBL_IF_ROUND_ELSE(34, 28), bounds.size.w, 18));
  text_layer_set_text_alignment(s_station_layer, GTextAlignmentCenter);
  text_layer_set_background_color(s_station_layer, GColorClear);
  text_layer_set_font(s_station_layer, fonts_get_system_font(FONT_KEY_GOTHIC_14));
  layer_add_child(root, text_layer_get_layer(s_station_layer));

  s_status_layer = text_layer_create(GRect(0, bounds.size.h - PBL_IF_ROUND_ELSE(18, 14), bounds.size.w, 14));
  text_layer_set_text_alignment(s_status_layer, GTextAlignmentCenter);
  text_layer_set_background_color(s_status_layer, GColorClear);
  text_layer_set_font(s_status_layer, fonts_get_system_font(FONT_KEY_GOTHIC_14));
  layer_add_child(root, text_layer_get_layer(s_status_layer));

  prv_update_chrome();
}

static void prv_window_unload(Window *window) {
  layer_destroy(s_graph_layer);
  text_layer_destroy(s_title_layer);
  text_layer_destroy(s_station_layer);
  text_layer_destroy(s_status_layer);
}

static void prv_init(void) {
  prv_load_persisted();

  s_window = window_create();
  window_set_window_handlers(s_window, (WindowHandlers) {
    .load = prv_window_load,
    .unload = prv_window_unload,
  });
  window_stack_push(s_window, true);

  app_message_register_inbox_received(prv_inbox_received);
  app_message_open(app_message_inbox_size_maximum(), app_message_outbox_size_maximum());

  connection_service_subscribe((ConnectionHandlers) {
    .pebble_app_connection_handler = prv_connection_handler,
  });
}

static void prv_deinit(void) {
  connection_service_unsubscribe();
  window_destroy(s_window);
}

int main(void) {
  prv_init();
  app_event_loop();
  prv_deinit();
}
