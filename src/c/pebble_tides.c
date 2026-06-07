#include <pebble.h>

// Issue #1 skeleton: receive the next tide from the phone, persist it, and
// render it as text. The graph, navigation, and caching arrive in later slices.

#define PERSIST_HAS_DATA 1
#define PERSIST_EPOCH 2
#define PERSIST_TYPE 3
#define PERSIST_HEIGHT_CM 4
#define PERSIST_STATION 5

static Window *s_window;
static TextLayer *s_station_layer;
static TextLayer *s_headline_layer;
static TextLayer *s_height_layer;

static bool s_has_data = false;
static int s_tide_epoch = 0;
static int s_tide_type = 0; // 1 = HIGH, 0 = LOW
static int s_tide_height_cm = 0;
static char s_station_name[64] = "";

static char s_headline_text[32];
static char s_height_text[16];

static void prv_update_display(void) {
  if (!s_has_data) {
    text_layer_set_text(s_station_layer, "");
    text_layer_set_text(s_headline_layer, "Loading…");
    text_layer_set_text(s_height_layer, "");
    return;
  }

  time_t t = (time_t)s_tide_epoch;
  struct tm *lt = localtime(&t);
  char time_text[12];
  strftime(time_text, sizeof(time_text),
           clock_is_24h_style() ? "%H:%M" : "%I:%M %p", lt);

  snprintf(s_headline_text, sizeof(s_headline_text), "%s %s",
           s_tide_type ? "HIGH" : "LOW", time_text);
  snprintf(s_height_text, sizeof(s_height_text), "%d.%02d m",
           s_tide_height_cm / 100, s_tide_height_cm % 100);

  text_layer_set_text(s_station_layer, s_station_name);
  text_layer_set_text(s_headline_layer, s_headline_text);
  text_layer_set_text(s_height_layer, s_height_text);
}

static void prv_load_persisted(void) {
  s_has_data = persist_exists(PERSIST_HAS_DATA) && persist_read_bool(PERSIST_HAS_DATA);
  if (!s_has_data) {
    return;
  }
  s_tide_epoch = persist_read_int(PERSIST_EPOCH);
  s_tide_type = persist_read_int(PERSIST_TYPE);
  s_tide_height_cm = persist_read_int(PERSIST_HEIGHT_CM);
  if (persist_exists(PERSIST_STATION)) {
    persist_read_string(PERSIST_STATION, s_station_name, sizeof(s_station_name));
  }
}

static void prv_persist_current(void) {
  persist_write_bool(PERSIST_HAS_DATA, true);
  persist_write_int(PERSIST_EPOCH, s_tide_epoch);
  persist_write_int(PERSIST_TYPE, s_tide_type);
  persist_write_int(PERSIST_HEIGHT_CM, s_tide_height_cm);
  persist_write_string(PERSIST_STATION, s_station_name);
}

static void prv_inbox_received(DictionaryIterator *iter, void *context) {
  Tuple *epoch_t = dict_find(iter, MESSAGE_KEY_NEXT_TIDE_EPOCH);
  Tuple *type_t = dict_find(iter, MESSAGE_KEY_NEXT_TIDE_TYPE);
  Tuple *height_t = dict_find(iter, MESSAGE_KEY_NEXT_TIDE_HEIGHT_CM);
  Tuple *station_t = dict_find(iter, MESSAGE_KEY_STATION_NAME);

  if (!epoch_t || !type_t || !height_t) {
    APP_LOG(APP_LOG_LEVEL_WARNING, "Incomplete tide message");
    return;
  }

  s_tide_epoch = epoch_t->value->int32;
  s_tide_type = type_t->value->int32;
  s_tide_height_cm = height_t->value->int32;
  if (station_t) {
    strncpy(s_station_name, station_t->value->cstring, sizeof(s_station_name) - 1);
    s_station_name[sizeof(s_station_name) - 1] = '\0';
  }
  s_has_data = true;

  prv_persist_current();
  prv_update_display();
}

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

  prv_update_display();
}

static void prv_window_unload(Window *window) {
  text_layer_destroy(s_station_layer);
  text_layer_destroy(s_headline_layer);
  text_layer_destroy(s_height_layer);
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
}

static void prv_deinit(void) {
  window_destroy(s_window);
}

int main(void) {
  prv_init();
  app_event_loop();
  prv_deinit();
}
