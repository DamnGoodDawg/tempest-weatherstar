// Fetch current conditions for the Tempest "Home" station and emit a token-free JSON
// snapshot to stdout. Run server-side only (GitHub Action) so the token never ships to clients.
//
//   TEMPEST_TOKEN=... node tools/fetch-tempest.mjs > dist/tempest-current.json
//
// Exits non-zero (and prints nothing to stdout) on any failure, so the workflow can decide
// whether to publish without live data. Never logs the token or the request URL.

const TOKEN = process.env.TEMPEST_TOKEN;
const STATION_ID = process.env.TEMPEST_STATION_ID || '219397'; // station "Home" (Statham, GA)

const fail = (msg) => { process.stderr.write(`fetch-tempest: ${msg}\n`); process.exit(1); };

if (!TOKEN) fail('TEMPEST_TOKEN not set');

const endpoint = `https://swd.weatherflow.com/swd/rest/observations/station/${STATION_ID}?token=${TOKEN}`;

let resp;
try {
	resp = await fetch(endpoint, { headers: { Accept: 'application/json' } });
} catch (e) {
	fail(`network error: ${e && e.message}`);
}
if (!resp.ok) fail(`HTTP ${resp.status}`); // do NOT echo the URL (carries the token)

const body = await resp.json();
const o = body && Array.isArray(body.obs) && body.obs[0] ? body.obs[0] : null;
if (!o) fail('no observation in response');

// Whitelist only the fields the client needs (and that are safe to publish).
const pick = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const snapshot = {
	fetched_at: new Date().toISOString(),
	station_id: Number(STATION_ID),
	station_name: body.station_name || null,
	obs: {
		timestamp: pick(o.timestamp),                 // epoch seconds
		air_temperature: pick(o.air_temperature),     // C
		relative_humidity: pick(o.relative_humidity), // %
		dew_point: pick(o.dew_point),                 // C
		feels_like: pick(o.feels_like),               // C
		wind_avg: pick(o.wind_avg),                   // m/s
		wind_gust: pick(o.wind_gust),                 // m/s
		wind_direction: pick(o.wind_direction),       // deg
		station_pressure: pick(o.station_pressure),   // hPa
		sea_level_pressure: pick(o.sea_level_pressure), // hPa
		uv: pick(o.uv),                               // index
		solar_radiation: pick(o.solar_radiation),     // W/m^2
		brightness: pick(o.brightness),               // lux
		precip_accum_local_day: pick(o.precip_accum_local_day), // mm
	},
};

process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
