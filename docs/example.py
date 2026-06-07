import appdaemon.plugins.hass.hassapi as hass
import json
from math import radians, sin, cos, sqrt, atan2
import requests
from datetime import datetime, timedelta, timezone


class OmnibusDepthsTides(hass.Hass):

    def initialize(self):
        self.tide_data = []
        self.depth_listener = None
        self.hourly_run = None
        self.tide_refresh_run = None

        # Existing manual triggers
        self.listen_state(self.get_station_triggered, "input_boolean.get_stations_with_omnibus", new="on")
        self.listen_state(self.get_tides_triggered, "input_boolean.get_tide_api_with_omnibus", new="on")
        self.listen_state(self.depth_toggle_changed, "input_boolean.send_depths_to_omnibus")

        # NEW: periodic tide refresh + graph publish (prevents stale/flat graph)
        # every 15 minutes, aligned to the next quarter-hour
        now = datetime.now(timezone.utc)
        next_q = (now.replace(second=0, microsecond=0, minute=(now.minute // 15) * 15) + timedelta(minutes=15))
        self.tide_refresh_run = self.run_every(self._scheduled_tide_refresh, next_q, 15 * 60)

    # -----------------------------
    # Stage 1: closest station
    # -----------------------------
    def get_station_triggered(self, entity, attribute, old, new, kwargs):
        stations_file = "/config/www/stations.json"
        lat_sensor = "sensor.navicomputer_latitude"
        lon_sensor = "sensor.navicomputer_longitude"
        closest_id_entity = "sensor.closest_station_id"
        closest_name_entity = "sensor.closest_station_name"

        try:
            lat = float(self.get_state(lat_sensor))
            lon = float(self.get_state(lon_sensor))
        except Exception as e:
            self.log(f"Failed to get latitude/longitude: {e}", level="ERROR")
            self._toggle_off_if_needed(entity, "input_boolean.get_stations_with_omnibus")
            return

        try:
            with open(stations_file, "r") as f:
                stations = json.load(f)
        except Exception as e:
            self.log(f"Failed to load stations file: {e}", level="ERROR")
            self._toggle_off_if_needed(entity, "input_boolean.get_stations_with_omnibus")
            return

        closest_station = None
        min_dist = float("inf")

        for s in stations:
            try:
                s_lat = float(s.get("latitude"))
                s_lon = float(s.get("longitude"))
            except (TypeError, ValueError):
                continue

            dist = self.haversine(lat, lon, s_lat, s_lon)
            if dist < min_dist:
                min_dist = dist
                closest_station = s

        if not closest_station:
            self._toggle_off_if_needed(entity, "input_boolean.get_stations_with_omnibus")
            return

        station_id = closest_station.get("id", "")
        station_name = closest_station.get("officialName", "")

        try:
            self.set_state(closest_id_entity, state=station_id)
            self.set_state(closest_name_entity, state=station_name)
        except Exception as e:
            self.log(f"Failed to set states: {e}", level="ERROR")

        self._toggle_off_if_needed(entity, "input_boolean.get_stations_with_omnibus")

    # -----------------------------
    # Stage 2: fetch tides + publish graph
    # -----------------------------
    def _scheduled_tide_refresh(self, kwargs):
        # periodic refresh; don’t touch booleans
        self._fetch_and_publish_tides(turn_off_toggle=False)

    def get_tides_triggered(self, entity, attribute, old, new, kwargs):
        # manual refresh via boolean
        self._fetch_and_publish_tides(turn_off_toggle=True)

    def _fetch_and_publish_tides(self, turn_off_toggle: bool):
        station_id = self.get_state("sensor.closest_station_id")
        if not station_id or station_id.strip() == "":
            self.get_station_triggered(None, None, None, None, {})
            station_id = self.get_state("sensor.closest_station_id")
            if not station_id or station_id.strip() == "":
                if turn_off_toggle:
                    self.set_state("input_boolean.get_tide_api_with_omnibus", state="off")
                return

        now = datetime.now(timezone.utc).replace(microsecond=0)
        now_iso = now.isoformat().replace("+00:00", "Z")

        url_recent = (
            f"https://api.iwls-sine.azure.cloud-nuage.dfo-mpo.gc.ca/api/v1/stations/"
            f"{station_id}/data?time-series-code=wlp"
            f"&from={(now - timedelta(minutes=10)).isoformat().replace('+00:00','Z')}"
            f"&to={now_iso}&resolution=ALL"
        )

        url_72h = (
            f"https://api.iwls-sine.azure.cloud-nuage.dfo-mpo.gc.ca/api/v1/stations/"
            f"{station_id}/data?time-series-code=wlp"
            f"&from={now_iso}"
            f"&to={(now + timedelta(hours=72)).isoformat().replace('+00:00','Z')}"
            f"&resolution=ALL"
        )

        # Update "now" tide level (input_number.tide_level_now)
        last_value_m = self.fetch_latest_value(url_recent)
        if last_value_m is not None:
            feet = last_value_m * 3.28084
            self.set_state("input_number.tide_level_now", state=round(feet, 2))

        data_72h = self.fetch_data(url_72h)
        if not data_72h:
            self.tide_data = []
            if turn_off_toggle:
                self.set_state("input_boolean.get_tide_api_with_omnibus", state="off")
            return

        # Build tide_data list
        tide_data = []
        for entry in data_72h:
            try:
                t = datetime.fromisoformat(entry["eventDate"].replace("Z", "+00:00"))
                ft = float(entry["value"]) * 3.28084
                tide_data.append({"time": t, "level_ft": ft})
            except Exception:
                continue

        tide_data.sort(key=lambda x: x["time"])
        self.tide_data = tide_data

        # Compute high/low next 24h
        cutoff_24h = now + timedelta(hours=24)
        data_24h = [e for e in self.tide_data if now < e["time"] <= cutoff_24h]
        if data_24h:
            high = max(data_24h, key=lambda x: x["level_ft"])
            low = min(data_24h, key=lambda x: x["level_ft"])

            self.set_state("input_number.high_tide_level", state=round(high["level_ft"], 2))
            self.set_state("input_datetime.high_tide_time", state=high["time"].isoformat().replace("+00:00", "Z"))

            self.set_state("input_number.low_tide_level", state=round(low["level_ft"], 2))
            self.set_state("input_datetime.low_tide_time", state=low["time"].isoformat().replace("+00:00", "Z"))

        # Publish graph points (always refreshes; prevents flatline)
        self._publish_tide_graph(now)

        if turn_off_toggle:
            self.set_state("input_boolean.get_tide_api_with_omnibus", state="off")

    def _publish_tide_graph(self, now_utc: datetime):
        try:
            end = now_utc + timedelta(hours=36)
            points = [
                {
                    "time": e["time"].isoformat().replace("+00:00", "Z"),
                    "level_ft": e["level_ft"],
                }
                for e in self.tide_data
                if now_utc <= e["time"] <= end
            ]

            # Make state change every publish (helps some cards that are finicky about attributes-only changes)
            self.set_state(
                "sensor.omnibus_tide_graph",
                state=now_utc.isoformat().replace("+00:00", "Z"),
                attributes={"points": points}
            )
        except Exception as e:
            self.log(f"Failed to publish tide graph data: {e}", level="ERROR")

    def fetch_data(self, url):
        try:
            resp = requests.get(url, timeout=10)
            resp.raise_for_status()
            data = resp.json()
            if isinstance(data, list):
                return data
            return data.get("data", [])
        except Exception as e:
            self.log(f"Failed fetching data: {e}", level="ERROR")
            return None

    def fetch_latest_value(self, url):
        data = self.fetch_data(url)
        if data:
            try:
                return float(data[-1]["value"])
            except Exception as e:
                self.log(f"Error extracting latest value: {e}", level="ERROR")
        return None

    # -----------------------------
    # Stage 3: Live depth monitoring
    # -----------------------------
    def depth_toggle_changed(self, entity, attribute, old, new, kwargs):
        if new == "on":
            if not self.tide_data:
                self._fetch_and_publish_tides(turn_off_toggle=False)

            if not self.depth_listener:
                self.depth_listener = self.listen_state(self.depth_updated, "sensor.sonar_depth")

            # Keep your hourly high/low refresh, but it no longer blocks or sleeps
            if not self.hourly_run:
                now_local = datetime.now()
                next_hour = now_local.replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)
                self.hourly_run = self.run_every(self.update_hourly_high_low, next_hour, 3600)

        else:
            if self.depth_listener:
                self.cancel_listen_state(self.depth_listener)
                self.depth_listener = None
            if self.hourly_run:
                self.cancel_timer(self.hourly_run)
                self.hourly_run = None

    def update_hourly_high_low(self, kwargs):
        # Instead of sleeping / partial refresh, just do a clean refresh+publish if coverage is short
        if not self.tide_data:
            return

        now = datetime.now(timezone.utc).replace(microsecond=0)
        cutoff_24h = now + timedelta(hours=24)

        data_24h = [e for e in self.tide_data if now < e["time"] <= cutoff_24h]
        if not data_24h:
            # refresh tides & graph
            self._fetch_and_publish_tides(turn_off_toggle=False)
            return

        max_time = max(data_24h, key=lambda x: x["time"])["time"]
        if max_time < cutoff_24h:
            self._fetch_and_publish_tides(turn_off_toggle=False)
            return

        # otherwise just recompute high/low from existing data_24h
        high = max(data_24h, key=lambda x: x["level_ft"])
        low = min(data_24h, key=lambda x: x["level_ft"])

        self.set_state("input_number.high_tide_level", state=round(high["level_ft"], 2))
        self.set_state("input_datetime.high_tide_time", state=high["time"].isoformat().replace("+00:00", "Z"))

        self.set_state("input_number.low_tide_level", state=round(low["level_ft"], 2))
        self.set_state("input_datetime.low_tide_time", state=low["time"].isoformat().replace("+00:00", "Z"))

        # also republish graph so the card stays “alive”
        self._publish_tide_graph(now)

    def depth_updated(self, entity, attribute, old, new, kwargs):
        if new is None or not self.tide_data:
            return

        try:
            sonar_depth = float(new)
            high_tide = float(self.get_state("input_number.high_tide_level") or 0)
            low_tide = float(self.get_state("input_number.low_tide_level") or 0)
        except Exception as e:
            self.log(f"Error reading depth or tide: {e}", level="ERROR")
            return

        now = datetime.now(timezone.utc).replace(microsecond=0)
        try:
            closest = min(self.tide_data, key=lambda x: abs((x["time"] - now).total_seconds()))
        except Exception as e:
            self.log(f"Error finding closest tide time: {e}", level="ERROR")
            return

        tide_now = closest["level_ft"]
        self.set_state("input_number.tide_level_now", state=round(tide_now, 2))

        depth_at_high = sonar_depth - tide_now + high_tide
        depth_at_low = sonar_depth - tide_now + low_tide

        self.set_state("input_number.depth_at_high", state=round(depth_at_high, 2))
        self.set_state("input_number.depth_at_low", state=round(depth_at_low, 2))

    # -----------------------------
    # utilities
    # -----------------------------
    def _toggle_off_if_needed(self, entity, bool_entity_id: str):
        # AppDaemon passes entity name when triggered by listen_state; None when called internally.
        if entity:
            self.set_state(bool_entity_id, state="off")

    def haversine(self, lat1, lon1, lat2, lon2):
        R = 6371e3
        phi1, phi2 = radians(lat1), radians(lat2)
        d_phi = radians(lat2 - lat1)
        d_lambda = radians(lon2 - lon1)
        a = sin(d_phi / 2) ** 2 + cos(phi1) * cos(phi2) * sin(d_lambda / 2) ** 2
        c = 2 * atan2(sqrt(a), sqrt(1 - a))
        return R * c
