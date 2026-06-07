#include <pebble.h>
#include <string.h>

// Issue #3: receive a versioned week-of-tides blob in chunks, persist it across
// 256-byte persist fields, reload it on launch (draw-cache-then-refresh), and
// compute the next tide locally so the watch works offline. The graph and
// navigation arrive in later slices; this still renders the next tide as text.

#define BLOB_VERSION 1
#define CHUNK_SIZE 64            // must match CHUNK_SIZE in src/pkjs/index.js
#define MAX_BLOB_BYTES 2048
#define MAX_EXTREMA 64
#define RECORD_BYTES 7
#define FAR_WARNING_KM 500

#define PERSIST_BLOB_LEN 10
#define PERSIST_BLOB_BASE 11     // chunks at 11, 12, 13, ... (256 bytes each)

static Window *s_window;
static TextLayer *s_station_layer;
static TextLayer *s_headline_layer;
static TextLayer *s_height_layer;
static TextLayer *s_status_layer;

// Parsed cache state
static bool s_has_data = false;
static char s_station_name[64] = "";
static int s_distance_km = 0;
static bool s_far = false;
static int s_extrema_count = 0;
static int32_t s_ext_epoch[MAX_EXTREMA];
static int16_t s_ext_height_cm[MAX_EXTREMA];
static uint8_t s_ext_type[MAX_EXTREMA]; // 1 = HIGH, 0 = LOW

// Chunk reassembly state
static uint8_t s_rx_buf[MAX_BLOB_BYTES];
static int s_rx_total = -1;
static int s_rx_count = 0;
static int s_rx_len = 0;

static char s_headline_text[32];
static char s_height_text[16];

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

static bool prv_parse_blob(const uint8_t *buf, int len) {
  if (len < 7) {
    return false;
  }
  if (buf[0] != BLOB_VERSION) {
    APP_LOG(APP_LOG_LEVEL_WARNING, "Blob version %d != %d; discarding", buf[0], BLOB_VERSION);
    return false;
  }
  int o = 0;
  o += 1; // version
  uint8_t flags = buf[o]; o += 1;
  uint16_t distance_km;
  memcpy(&distance_km, buf + o, 2); o += 2;
  uint16_t count;
  memcpy(&count, buf + o, 2); o += 2;
  uint8_t name_len = buf[o]; o += 1;

  if (o + name_len + (int)count * RECORD_BYTES > len) {
    APP_LOG(APP_LOG_LEVEL_ERROR, "Blob truncated");
    return false;
  }
  if (count > MAX_EXTREMA) {
    count = MAX_EXTREMA;
  }

  int copy = name_len < (int)sizeof(s_station_name) - 1 ? name_len : (int)sizeof(s_station_name) - 1;
  memcpy(s_station_name, buf + o, copy);
  s_station_name[copy] = '\0';
  o += name_len;

  s_distance_km = distance_km;
  s_far = (flags & 1) == 1;
  s_extrema_count = count;
  for (int i = 0; i < (int)count; i++) {
    memcpy(&s_ext_epoch[i], buf + o, 4); o += 4;
    memcpy(&s_ext_height_cm[i], buf + o, 2); o += 2;
    s_ext_type[i] = buf[o]; o += 1;
  }
  s_has_data = s_extrema_count > 0;
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
    if (n > PERSIST_DATA_MAX_LENGTH) {
      n = PERSIST_DATA_MAX_LENGTH;
    }
    persist_write_data(PERSIST_BLOB_BASE + chunk, buf + off, n);
    chunk++;
  }
}

static void prv_load_persisted(void) {
  if (!persist_exists(PERSIST_BLOB_LEN)) {
    return;
  }
  int len = persist_read_int(PERSIST_BLOB_LEN);
  if (len <= 0 || len > MAX_BLOB_BYTES) {
    return;
  }
  // Reassemble into the static rx buffer; the app stack is too small (~2 KB)
  // to hold a blob-sized local array.
  int chunk = 0;
  for (int off = 0; off < len; off += PERSIST_DATA_MAX_LENGTH) {
    int n = len - off;
    if (n > PERSIST_DATA_MAX_LENGTH) {
      n = PERSIST_DATA_MAX_LENGTH;
    }
    if (!persist_exists(PERSIST_BLOB_BASE + chunk)) {
      return;
    }
    persist_read_data(PERSIST_BLOB_BASE + chunk, s_rx_buf + off, n);
    chunk++;
  }
  prv_parse_blob(s_rx_buf, len); // version mismatch leaves s_has_data false
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

static int prv_next_extremum_index(void) {
  time_t now = time(NULL);
  for (int i = 0; i < s_extrema_count; i++) {
    if (s_ext_epoch[i] >= now) {
      return i;
    }
  }
  return -1; // all in the past
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

static void prv_update_display(void) {
  if (!s_has_data) {
    text_layer_set_text(s_station_layer, "");
    text_layer_set_text(s_headline_layer, "Loading…");
    text_layer_set_text(s_height_layer, "");
    prv_update_status();
    return;
  }

  int idx = prv_next_extremum_index();
  if (idx < 0) {
    idx = s_extrema_count - 1; // fall back to the last known extremum
  }

  time_t t = (time_t)s_ext_epoch[idx];
  struct tm *lt = localtime(&t);
  char time_text[12];
  strftime(time_text, sizeof(time_text),
           clock_is_24h_style() ? "%H:%M" : "%I:%M %p", lt);

  snprintf(s_headline_text, sizeof(s_headline_text), "%s %s",
           s_ext_type[idx] ? "HIGH" : "LOW", time_text);
  snprintf(s_height_text, sizeof(s_height_text), "%d.%02d m",
           s_ext_height_cm[idx] / 100, abs(s_ext_height_cm[idx] % 100));

  text_layer_set_text(s_station_layer, s_station_name);
  text_layer_set_text(s_headline_layer, s_headline_text);
  text_layer_set_text(s_height_layer, s_height_text);
  prv_update_status();
}

// ---------------------------------------------------------------------------
// AppMessage chunk reassembly
// ---------------------------------------------------------------------------

static void prv_inbox_received(DictionaryIterator *iter, void *context) {
  Tuple *idx_t = dict_find(iter, MESSAGE_KEY_CHUNK_INDEX);
  Tuple *total_t = dict_find(iter, MESSAGE_KEY_CHUNK_TOTAL);
  Tuple *data_t = dict_find(iter, MESSAGE_KEY_CHUNK_DATA);
  if (!idx_t || !total_t || !data_t) {
    return;
  }

  int index = idx_t->value->int32;
  int total = total_t->value->int32;
  int dlen = data_t->length;
  int offset = index * CHUNK_SIZE;
  if (offset + dlen > MAX_BLOB_BYTES) {
    APP_LOG(APP_LOG_LEVEL_ERROR, "Chunk overflow");
    return;
  }

  if (index == 0) { // start of a fresh blob
    s_rx_total = total;
    s_rx_count = 0;
    s_rx_len = 0;
  }
  memcpy(s_rx_buf + offset, data_t->value->data, dlen);
  if (offset + dlen > s_rx_len) {
    s_rx_len = offset + dlen;
  }
  s_rx_count++;

  if (s_rx_total > 0 && s_rx_count >= s_rx_total) {
    if (prv_parse_blob(s_rx_buf, s_rx_len)) {
      prv_persist_blob(s_rx_buf, s_rx_len);
      prv_update_display();
      APP_LOG(APP_LOG_LEVEL_INFO, "Cache updated: %d extrema, %s",
              s_extrema_count, s_station_name);
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
  Layer *root = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(root);
  int cy = bounds.size.h / 2;

  s_station_layer = text_layer_create(GRect(0, cy - 52, bounds.size.w, 24));
  text_layer_set_text_alignment(s_station_layer, GTextAlignmentCenter);
  text_layer_set_font(s_station_layer, fonts_get_system_font(FONT_KEY_GOTHIC_18));
  layer_add_child(root, text_layer_get_layer(s_station_layer));

  s_headline_layer = text_layer_create(GRect(0, cy - 24, bounds.size.w, 34));
  text_layer_set_text_alignment(s_headline_layer, GTextAlignmentCenter);
  text_layer_set_font(s_headline_layer, fonts_get_system_font(FONT_KEY_GOTHIC_28_BOLD));
  layer_add_child(root, text_layer_get_layer(s_headline_layer));

  s_height_layer = text_layer_create(GRect(0, cy + 14, bounds.size.w, 28));
  text_layer_set_text_alignment(s_height_layer, GTextAlignmentCenter);
  text_layer_set_font(s_height_layer, fonts_get_system_font(FONT_KEY_GOTHIC_24));
  layer_add_child(root, text_layer_get_layer(s_height_layer));

  s_status_layer = text_layer_create(GRect(0, bounds.size.h - 26, bounds.size.w, 20));
  text_layer_set_text_alignment(s_status_layer, GTextAlignmentCenter);
  text_layer_set_font(s_status_layer, fonts_get_system_font(FONT_KEY_GOTHIC_14));
  layer_add_child(root, text_layer_get_layer(s_status_layer));

  prv_update_display();
}

static void prv_window_unload(Window *window) {
  text_layer_destroy(s_station_layer);
  text_layer_destroy(s_headline_layer);
  text_layer_destroy(s_height_layer);
  text_layer_destroy(s_status_layer);
}

static void prv_init(void) {
  prv_load_persisted(); // draw cache first

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
