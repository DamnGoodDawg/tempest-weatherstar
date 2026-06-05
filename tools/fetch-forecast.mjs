// Fetch the WeatherFlow Tempest "Better Forecast" (hourly + daily) for the station and emit a
// token-free JSON snapshot to stdout. Server-side only (GitHub Action) — token never ships.
//
//   TEMPEST_TOKEN=... node tools/fetch-forecast.mjs > dist/tempest-forecast.json
//
// Exits non-zero (printing nothing to stdout) on failure. Never logs the token or request URL.
// Units requested explicitly so the client mapping is deterministic: temps °C, wind m/s.

const TOKEN = process.env.TEMPEST_TOKEN;
const STATION_ID = process.env.TEMPEST_STATION_ID || '219397';

const fail = (msg) => { process.stderr.write(`fetch-forecast: ${msg}\n`); process.exit(1); };
if (!TOKEN) fail('TEMPEST_TOKEN not set');

const params = new URLSearchParams({
	station_id: STATION_ID,
	token: TOKEN,
	units_temp: 'c',
	units_wind: 'mps',
	units_pressure: 'mb',
	units_precip: 'mm',
	units_distance: 'km',
});
const endpoint = `https://swd.weatherflow.com/swd/rest/better_forecast?${params.toString()}`;

let resp;
try {
	resp = await fetch(endpoint, { headers: { Accept: 'application/json' } });
} catch (e) {
	fail(`network error: ${e && e.message}`);
}
if (!resp.ok) fail(`HTTP ${resp.status}`); // never echo the URL (carries the token)

const body = await resp.json();
const fc = body && body.forecast ? body.forecast : null;
if (!fc || !Array.isArray(fc.hourly) || !Array.isArray(fc.daily)) fail('no forecast in response');

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v) => (typeof v === 'string' && v ? v : null);

const hourly = fc.hourly.slice(0, 36).map((h) => ({
	time: num(h.time),                              // epoch seconds (top of hour)
	air_temperature: num(h.air_temperature),        // C
	feels_like: num(h.feels_like),                  // C
	relative_humidity: num(h.relative_humidity),    // %
	dew_point: num(h.dew_point),                    // C (if provided)
	wind_avg: num(h.wind_avg),                      // m/s
	wind_gust: num(h.wind_gust),                    // m/s
	wind_direction: num(h.wind_direction),          // deg
	precip_probability: num(h.precip_probability),  // %
	precip_type: str(h.precip_type),                // rain/snow/...
	conditions: str(h.conditions),                  // text
	icon: str(h.icon),                              // tempest icon key
	uv: num(h.uv),
}));

const daily = fc.daily.slice(0, 8).map((d) => ({
	day_start_local: num(d.day_start_local),        // epoch seconds (local midnight)
	air_temp_high: num(d.air_temp_high),            // C
	air_temp_low: num(d.air_temp_low),              // C
	precip_probability: num(d.precip_probability),  // %
	precip_type: str(d.precip_type),
	conditions: str(d.conditions),                  // text, e.g. "Partly Cloudy"
	icon: str(d.icon),
	sunrise: num(d.sunrise),
	sunset: num(d.sunset),
}));

const snapshot = {
	fetched_at: new Date().toISOString(),
	station_id: Number(STATION_ID),
	station_name: body.station_name || (body.location_name || null),
	units: { temp: 'c', wind: 'mps', precip_prob: 'percent' },
	hourly,
	daily,
};

process.stdout.write(`${JSON.stringify(snapshot)}\n`);
