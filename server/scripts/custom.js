// Tempest fork customization (loaded by getCustomCode() as a classic script).
//
// Goal: show the real WeatherFlow Tempest "Home" station (Statham, GA) readings on the
// Current Conditions screen, while keeping NOAA/NWS for everything the station can't measure
// (sky condition text, icon, visibility, ceiling) and for all forecast/radar screens.
//
// How: a scheduled GitHub Action publishes a token-free `tempest-current.json` next to this
// page (~every 10 min). We poll it client-side and patch window.fetch so that when the app
// requests the NWS station observation, we merge Tempest's sensor values into the response.
// The app then renders, formats, and unit-converts Tempest data through its own code path,
// so the override survives every redraw and auto-refresh.
//
// Degrades cleanly: if tempest-current.json is missing or stale (e.g. before the token is set),
// the NWS observation is returned untouched and the screen simply shows NOAA data.
//
// Units (NWS observation `properties.*.value` are metric; Tempest REST is metric too):
//   temperature/dewpoint  °C            <- air_temperature / dew_point   (direct)
//   relativeHumidity      %             <- relative_humidity             (direct)
//   windSpeed/windGust    km/h          <- wind_avg / wind_gust  (m/s)   (* 3.6)
//   windDirection         degrees       <- wind_direction               (direct)
//   barometricPressure    pascals       <- station_pressure (hPa)        (* 100)

(() => {
	'use strict';

	const TEMPEST_URL = 'tempest-current.json'; // same-origin, relative -> works under the /tempest-weatherstar/ subpath
	const POLL_MS = 60_000;                     // client refresh cadence; the JSON itself refreshes server-side (~10 min)
	const MAX_AGE_MS = 60 * 60 * 1000;          // ignore Tempest data older than 1h (treat as unavailable)

	// keep an un-patched reference so our own polling never recurses through the patched fetch
	const nativeFetch = window.fetch.bind(window);

	let cache = { at: 0, obs: null };

	// Poll the published snapshot. Returns the latest obs object, or null if unavailable/stale.
	const getTempest = async () => {
		const now = Date.now();
		if (cache.obs && now - cache.at < POLL_MS) return cache.obs;
		try {
			// cache-bust per minute so a long-lived tab still picks up new snapshots
			const resp = await nativeFetch(`${TEMPEST_URL}?_=${Math.floor(now / POLL_MS)}`, { cache: 'no-store' });
			if (resp.ok) {
				const json = await resp.json();
				const obs = json && json.obs ? json.obs : null;
				const tsMs = obs && obs.timestamp ? obs.timestamp * 1000 : 0;
				cache = { at: now, obs: (tsMs && now - tsMs > MAX_AGE_MS) ? null : obs };
			} else {
				cache = { at: now, obs: null };
			}
		} catch (e) {
			cache = { at: now, obs: null };
		}
		return cache.obs;
	};

	// Merge Tempest sensor values into an NWS GeoJSON observation (mutates in place).
	const mergeTempest = (geo, t) => {
		const props = geo && geo.features && geo.features[0] && geo.features[0].properties;
		if (!props || !t) return false;

		const set = (key, value) => {
			if (value === null || value === undefined || Number.isNaN(value)) return;
			if (props[key] && typeof props[key] === 'object') props[key].value = value;
			else props[key] = { value, unitCode: '', qualityControl: 'tempest' };
		};
		const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

		set('temperature', num(t.air_temperature));                                   // C
		set('dewpoint', num(t.dew_point));                                            // C
		set('relativeHumidity', num(t.relative_humidity));                            // %
		set('windDirection', num(t.wind_direction));                                  // deg
		set('windSpeed', t.wind_avg == null ? null : num(t.wind_avg) * 3.6);          // m/s -> km/h
		set('windGust', t.wind_gust == null ? null : num(t.wind_gust) * 3.6);         // m/s -> km/h

		// Pressure: use station_pressure to match the NWS `barometricPressure` semantics
		// (station pressure, not sea-level). Swap to t.sea_level_pressure for an altimeter-style reading.
		if (t.station_pressure != null) {
			const pa = num(t.station_pressure) * 100; // hPa -> Pa
			set('barometricPressure', pa);
			// The app derives a pressure trend from features[0] vs features[1]; align [1] so we
			// don't fabricate a rising/falling arrow from a Tempest-vs-NWS delta.
			const p1 = geo.features[1] && geo.features[1].properties && geo.features[1].properties.barometricPressure;
			if (p1) p1.value = pa;
		}

		// Stamp the observation time so the header reads "Current" rather than "Recent".
		if (t.timestamp) {
			try { props.timestamp = new Date(t.timestamp * 1000).toISOString(); } catch (e) { /* leave as-is */ }
		}

		// expose for debugging / verification
		window.__tempest = { appliedAt: new Date().toISOString(), obs: t };
		return true;
	};

	const isObservationRequest = (url) => /\/stations\/[^/]+\/observations(\b|\?|$)/.test(url) && /api\.weather\.gov|\/api\//.test(url);

	// Patch fetch: transparently enrich the NWS station observation with Tempest data.
	window.fetch = async (input, init) => {
		let url = '';
		try { url = typeof input === 'string' ? input : (input && input.url) ? input.url : String(input); } catch (e) { url = ''; }

		if (!isObservationRequest(url)) return nativeFetch(input, init);

		const resp = await nativeFetch(input, init);
		try {
			const obs = await getTempest();
			if (!obs || !resp.ok) return resp;
			const data = await resp.clone().json();
			if (!mergeTempest(data, obs)) return resp;
			return new Response(JSON.stringify(data), {
				status: resp.status,
				statusText: resp.statusText,
				headers: { 'content-type': 'application/geo+json' },
			});
		} catch (e) {
			console.warn('[tempest] merge skipped:', e && e.message);
			return resp;
		}
	};

	// --- Branding: call out when the Current Conditions screen is sourced from the station ---
	// Only that screen renders Tempest data, so only its NOAA badge is swapped for a Georgia "G".
	// Every other screen (Latest Observations, Local Forecast, forecasts, radar) keeps NOAA.
	// Drop the real logo at server/images/logos/uga-g.png and it's used automatically;
	// if it's missing we fall back to the placeholder uga-g.svg so the screen never breaks.
	const UGA_LOGO = 'images/logos/uga-g.png';
	const UGA_LOGO_FALLBACK = 'images/logos/uga-g.svg';
	const NOAA_LOGO = 'images/logos/noaa.gif';
	const SOURCE_TITLE = 'Source: Tempest “Home” — Statham, GA';

	const updateBranding = () => {
		const img = document.querySelector('#current-weather-html .noaa-logo img');
		if (!img) return;
		const live = !!cache.obs;
		const src = img.getAttribute('src') || '';
		if (live && !/uga-g/.test(src)) {
			img.onerror = () => { img.onerror = null; img.src = UGA_LOGO_FALLBACK; };
			img.setAttribute('src', UGA_LOGO);
			img.title = SOURCE_TITLE;
			img.classList.add('tempest-source');
		} else if (!live && /uga-g/.test(src)) {
			img.onerror = null;
			img.setAttribute('src', NOAA_LOGO);
			img.removeAttribute('title');
			img.classList.remove('tempest-source');
		}
	};

	// Warm the cache and keep it fresh so the first observation request already has data.
	getTempest().then((obs) => {
		console.log(obs ? '[tempest] live station data active' : '[tempest] no live data yet (showing NOAA) — set TEMPEST_TOKEN to enable');
		updateBranding();
	});
	setInterval(() => { getTempest().then(updateBranding); }, POLL_MS);
	// The Current Conditions element only exists after that screen first builds; re-apply lightly.
	setInterval(updateBranding, 3000);
})();
