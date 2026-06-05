// Tempest fork customization (loaded by getCustomCode() as a classic script).
//
// Goal: show the real WeatherFlow Tempest "Home" station (Statham, GA) data on the screens it
// can legitimately drive, while leaving NOAA for everything else.
//   • Current Conditions  <- live station sensors (tempest-current.json)
//   • Hourly Forecast     <- Tempest "Better Forecast" hourly (tempest-forecast.json)
//   • Local + Extended    <- Tempest "Better Forecast" daily   (tempest-forecast.json)
// A station can't forecast, so the forecast screens use WeatherFlow's Better Forecast for the
// station's location (the same forecast shown in the Tempest app).
//
// How: a scheduled GitHub Action publishes token-free JSON next to this page (~every 10 min).
// We poll it and patch window.fetch so when the app requests the matching NWS endpoint we splice
// Tempest data into the response. The app then renders/format/unit-converts it through its own
// code path, so the override survives every redraw and auto-refresh.
//
// Degrades cleanly: if a snapshot is missing/stale (e.g. before the token is set), the NWS
// response is returned untouched and that screen simply shows NOAA data.

(() => {
	'use strict';

	const CURRENT_URL = 'tempest-current.json';
	const FORECAST_URL = 'tempest-forecast.json';
	const POLL_MS = 60_000;             // client refresh cadence (JSON refreshes server-side ~10 min)
	const MAX_AGE_MS = 60 * 60 * 1000;  // ignore current obs older than 1h

	// un-patched reference so our own polling never recurses through the patched fetch
	const nativeFetch = window.fetch.bind(window);

	let obsCache = { at: 0, data: null };
	let fcCache = { at: 0, data: null };

	const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
	const cToF = (c) => Math.round((c * 9) / 5 + 32);

	const pollJson = async (url, pick) => {
		const now = Date.now();
		try {
			const resp = await nativeFetch(`${url}?_=${Math.floor(now / POLL_MS)}`, { cache: 'no-store' });
			if (resp.ok) return pick(await resp.json());
		} catch (e) { /* fall through */ }
		return null;
	};

	// Latest station observation, or null if unavailable/stale.
	const getCurrent = async () => {
		const now = Date.now();
		if (obsCache.data && now - obsCache.at < POLL_MS) return obsCache.data;
		const obs = await pollJson(CURRENT_URL, (j) => (j && j.obs ? j.obs : null));
		const tsMs = obs && obs.timestamp ? obs.timestamp * 1000 : 0;
		obsCache = { at: now, data: (tsMs && now - tsMs > MAX_AGE_MS) ? null : obs };
		return obsCache.data;
	};

	// Better Forecast (hourly + daily), or null if unavailable.
	const getForecast = async () => {
		const now = Date.now();
		if (fcCache.data && now - fcCache.at < POLL_MS) return fcCache.data;
		const fc = await pollJson(FORECAST_URL, (j) => (j && Array.isArray(j.hourly) && Array.isArray(j.daily) ? j : null));
		fcCache = { at: now, data: fc };
		return fcCache.data;
	};

	const jsonResponse = (data, resp) => new Response(JSON.stringify(data), {
		status: resp.status,
		statusText: resp.statusText,
		headers: { 'content-type': 'application/geo+json' },
	});

	// ---- Current Conditions: merge station sensors into the NWS observation ----
	const mergeCurrent = (geo, t) => {
		const props = geo && geo.features && geo.features[0] && geo.features[0].properties;
		if (!props || !t) return false;
		const set = (key, value) => {
			if (value === null || value === undefined || Number.isNaN(value)) return;
			if (props[key] && typeof props[key] === 'object') props[key].value = value;
			else props[key] = { value, unitCode: '', qualityControl: 'tempest' };
		};
		set('temperature', num(t.air_temperature));                              // C
		set('dewpoint', num(t.dew_point));                                       // C
		set('relativeHumidity', num(t.relative_humidity));                       // %
		set('windDirection', num(t.wind_direction));                             // deg
		set('windSpeed', t.wind_avg == null ? null : num(t.wind_avg) * 3.6);     // m/s -> km/h
		set('windGust', t.wind_gust == null ? null : num(t.wind_gust) * 3.6);    // m/s -> km/h
		if (t.station_pressure != null) {
			const pa = num(t.station_pressure) * 100;                            // hPa -> Pa
			set('barometricPressure', pa);
			const p1 = geo.features[1] && geo.features[1].properties && geo.features[1].properties.barometricPressure;
			if (p1) p1.value = pa;                                               // avoid a fabricated pressure trend
		}
		if (t.timestamp) { try { props.timestamp = new Date(t.timestamp * 1000).toISOString(); } catch (e) { /* keep */ } }
		window.__tempest = { appliedAt: new Date().toISOString(), obs: t };
		return true;
	};

	// ---- Hourly: overwrite the NWS gridpoint value-series with Tempest hourly ----
	// Keeps NWS skyCover/weather (cloud icons); replaces the displayed numbers + rain chance.
	const applyHourly = (grid, fc) => {
		const props = grid && grid.properties;
		const hours = fc && fc.hourly;
		if (!props || !hours || !hours.length) return false;
		const startOfHour = new Date(); startOfHour.setUTCMinutes(0, 0, 0);
		const series = (mapFn) => {
			const vals = hours.map(mapFn);
			if (vals.some((v) => v === null || v === undefined || Number.isNaN(v))) return null; // leave NWS
			return vals.map((value, k) => ({
				validTime: `${new Date(startOfHour.getTime() + k * 3_600_000).toISOString()}/PT1H`,
				value,
			}));
		};
		const set = (key, mapFn) => { const s = series(mapFn); if (props[key] && s) props[key].values = s; };
		set('temperature', (h) => num(h.air_temperature));                                   // C
		set('apparentTemperature', (h) => num(h.feels_like));                                // C
		set('windSpeed', (h) => (h.wind_avg == null ? null : num(h.wind_avg) * 3.6));        // m/s -> km/h
		set('windDirection', (h) => num(h.wind_direction));                                  // deg
		set('probabilityOfPrecipitation', (h) => num(h.precip_probability));                 // %
		window.__tempestHourly = { appliedAt: new Date().toISOString(), hours: hours.length };
		return true;
	};

	// ---- Local + Extended: build NWS-style day/night periods from Tempest daily ----
	const tempestToNwsCode = (icon) => {
		const i = (icon || '').toLowerCase();
		if (i.indexOf('thunder') >= 0) return 'tsra';
		if (i.indexOf('snow') >= 0) return 'snow';
		if (i.indexOf('sleet') >= 0) return 'sleet';
		if (i.indexOf('rain') >= 0 || i.indexOf('drizzle') >= 0) return 'rain';
		if (i.indexOf('fog') >= 0) return 'fog';
		if (i.indexOf('partly') >= 0 || i.indexOf('mostly-clear') >= 0) return 'sct';
		if (i.indexOf('cloudy') >= 0 || i.indexOf('overcast') >= 0) return 'ovc';
		if (i.indexOf('clear') >= 0 || i.indexOf('sunny') >= 0) return 'skc';
		return 'skc';
	};
	const nwsIconUrl = (icon, isDay) => `https://api.weather.gov/icons/land/${isDay ? 'day' : 'night'}/${tempestToNwsCode(icon)}?size=medium`;
	const narrative = (cond, temp, isDay, pop) => {
		let s = cond ? `${cond}.` : '';
		if (temp != null) s += isDay ? ` High near ${temp}.` : ` Low around ${temp}.`;
		if (pop != null && pop > 0) s += ` Chance of precipitation ${pop}%.`;
		return s.trim();
	};
	const weekday = (ms) => new Date(ms).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'America/New_York' });

	const buildPeriods = (fc) => {
		const daily = fc && fc.daily;
		if (!daily || !daily.length) return null;
		const periods = [];
		let n = 1;
		daily.forEach((d, idx) => {
			const dayStart = (d.day_start_local || 0) * 1000;
			if (!dayStart) return;
			const sunrise = (d.sunrise || 0) * 1000 || dayStart + 6 * 3_600_000;
			const sunset = (d.sunset || 0) * 1000 || dayStart + 19 * 3_600_000;
			const nextStart = daily[idx + 1] && daily[idx + 1].day_start_local
				? daily[idx + 1].day_start_local * 1000 : dayStart + 86_400_000;
			const cond = d.conditions || '';
			const pop = num(d.precip_probability);
			const dow = weekday(dayStart);
			const hi = d.air_temp_high != null ? cToF(d.air_temp_high) : null;
			const lo = d.air_temp_low != null ? cToF(d.air_temp_low) : null;
			if (hi != null) {
				periods.push({
					number: n++, name: idx === 0 ? 'Today' : dow, isDaytime: true,
					startTime: new Date(sunrise).toISOString(), endTime: new Date(sunset).toISOString(),
					temperature: hi, temperatureUnit: 'F',
					probabilityOfPrecipitation: { unitCode: 'wmoUnit:percent', value: pop },
					icon: nwsIconUrl(d.icon, true), shortForecast: cond,
					detailedForecast: narrative(cond, hi, true, pop),
				});
			}
			if (lo != null) {
				periods.push({
					number: n++, name: idx === 0 ? 'Tonight' : `${dow} Night`, isDaytime: false,
					startTime: new Date(sunset).toISOString(), endTime: new Date(nextStart).toISOString(),
					temperature: lo, temperatureUnit: 'F',
					probabilityOfPrecipitation: { unitCode: 'wmoUnit:percent', value: pop },
					icon: nwsIconUrl(d.icon, false), shortForecast: cond,
					detailedForecast: narrative(cond, lo, false, pop),
				});
			}
		});
		return periods;
	};

	// ---- URL matchers ----
	const reqUrl = (input) => {
		try { return typeof input === 'string' ? input : (input && input.url) ? input.url : String(input); } catch (e) { return ''; }
	};
	const isObservation = (u) => /\/stations\/[^/]+\/observations(\b|\?|$)/.test(u) && /api\.weather\.gov|\/api\//.test(u);
	const isGridpoint = (u) => /\/gridpoints\/[^/]+\/-?\d+,-?\d+(?:\?.*)?$/.test(u);
	const isForecastPeriods = (u) => /\/gridpoints\/[^/]+\/-?\d+,-?\d+\/forecast(?:\?.*)?$/.test(u);

	// ---- fetch dispatch ----
	window.fetch = async (input, init) => {
		const url = reqUrl(input);

		if (isObservation(url)) {
			const resp = await nativeFetch(input, init);
			try {
				const obs = await getCurrent();
				if (!obs || !resp.ok) return resp;
				const data = await resp.clone().json();
				return mergeCurrent(data, obs) ? jsonResponse(data, resp) : resp;
			} catch (e) { return resp; }
		}

		if (isGridpoint(url)) {
			const resp = await nativeFetch(input, init);
			try {
				const fc = await getForecast();
				if (!fc || !resp.ok) return resp;
				const data = await resp.clone().json();
				return applyHourly(data, fc) ? jsonResponse(data, resp) : resp;
			} catch (e) { return resp; }
		}

		if (isForecastPeriods(url)) {
			const resp = await nativeFetch(input, init);
			try {
				const fc = await getForecast();
				if (!fc || !resp.ok) return resp;
				const data = await resp.clone().json();
				const periods = buildPeriods(fc);
				if (periods && periods.length && data.properties) { data.properties.periods = periods; return jsonResponse(data, resp); }
				return resp;
			} catch (e) { return resp; }
		}

		return nativeFetch(input, init);
	};

	// ---- Branding: "Powered by Tempest" on station-sourced screens ----
	// Header text replaces the NOAA badge where there is one (Current Conditions, Local Forecast,
	// Latest Observations); a small corner ribbon marks the screens without a badge (Hourly,
	// Hourly Graph, Extended). Latest Observations also gets the Tempest "Home" station as its top row.
	const NOAA_LOGO = 'images/logos/noaa.gif';
	const SOURCE_TITLE = 'Source: Tempest “Home” — Statham, GA';

	const style = document.createElement('style');
	style.textContent = ''
		+ ".tempest-powered{font-family:'Star4000',monospace;text-align:center;line-height:1.05;text-shadow:2px 2px 0 #000}"
		+ '.tempest-powered .pb{font-size:12px;color:#fff;letter-spacing:.5px}'
		+ '.tempest-powered .tm{font-size:20px;color:#ffe000}'
		+ ".tempest-ribbon{position:absolute;bottom:42px;right:10px;z-index:60;font-family:'Star4000',monospace;"
		+ 'font-size:13px;color:#ffe000;background:rgba(0,0,52,.66);padding:2px 8px;text-shadow:1px 1px 0 #000;pointer-events:none}';
	document.head.appendChild(style);

	const POWERED_HTML = '<div class="tempest-powered"><div class="pb">POWERED BY</div><div class="tm">TEMPEST</div></div>';

	// Swap the NOAA badge for "Powered by Tempest" header text (or back).
	const headerTreatment = (screenSel, active) => {
		const slot = document.querySelector(`${screenSel} .noaa-logo`);
		if (!slot) return;
		const has = !!slot.querySelector('.tempest-powered');
		if (active && !has) { slot.innerHTML = POWERED_HTML; slot.title = SOURCE_TITLE; }
		else if (!active && has) { slot.innerHTML = `<img src="${NOAA_LOGO}" />`; slot.removeAttribute('title'); }
	};

	// Small corner ribbon for screens that have no header badge.
	const ribbonTreatment = (screenSel, active) => {
		const screen = document.querySelector(screenSel);
		if (!screen) return;
		const r = screen.querySelector(':scope > .tempest-ribbon');
		if (active && !r) {
			const el = document.createElement('div');
			el.className = 'tempest-ribbon';
			el.textContent = 'POWERED BY TEMPEST';
			screen.appendChild(el);
		} else if (!active && r) { r.remove(); }
	};

	const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
	const deg16 = (deg) => COMPASS[Math.round((deg % 360) / 22.5) % 16];

	// Inject the Tempest "Home" station as the top row of Latest Observations (mirrors a real row).
	const homeRow = (active) => {
		const lines = document.querySelector('#latest-observations-html .observation-lines');
		if (!lines) return;
		const existing = lines.querySelector('.tempest-home-row');
		const obs = obsCache.data;
		if (!active || !obs) { if (existing) existing.remove(); return; }
		if (existing) return;
		const sample = lines.firstElementChild;
		if (!sample) return; // need a rendered row to copy the structure
		const row = sample.cloneNode(true);
		row.classList.add('tempest-home-row');
		const tempF = obs.air_temperature != null ? cToF(obs.air_temperature) : '';
		const likeF = obs.feels_like != null ? cToF(obs.feels_like) : '';
		const mph = obs.wind_avg != null ? Math.round((obs.wind_avg * 3.6) / 1.609) : 0;
		const dir = obs.wind_direction != null ? deg16(obs.wind_direction) : '';
		const cond = (fcCache.data && fcCache.data.hourly && fcCache.data.hourly[0] && fcCache.data.hourly[0].conditions) || '';
		const setF = (sel, val) => { const e = row.querySelector(sel); if (e) e.textContent = val; };
		setF('.location', 'Home');
		setF('.temp', tempF === '' ? '' : String(tempF));
		const likeEl = row.querySelector('.like');
		if (likeEl) { likeEl.className = 'like'; likeEl.textContent = (likeF === '' || likeF === tempF) ? '' : String(likeF); }
		setF('.weather', cond.substr(0, 9));
		setF('.wind', mph > 0 ? `${dir} ${mph}` : 'Calm');
		lines.insertBefore(row, lines.firstChild);
	};

	// Relabel our nearest NWS station (KWDR — physically in Winder) to our actual town, so the
	// "Conditions at …" scroll, Current Conditions, and Headend all read Statham. The app derives
	// the on-screen city from StationInfo[stationId].city (our Tempest station is in Statham anyway).
	const HOME_STATION = 'KWDR';
	const HOME_CITY = 'Statham';
	const relabelStation = () => {
		const info = window.StationInfo;
		if (info && typeof info === 'object') {
			const cur = info[HOME_STATION];
			if (!cur || cur.city !== HOME_CITY) info[HOME_STATION] = Object.assign({}, cur, { city: HOME_CITY });
		}
	};

	const updateBranding = () => {
		relabelStation();
		const cur = !!obsCache.data;
		const fc = !!fcCache.data;
		homeRow(cur);
		headerTreatment('#current-weather-html', cur);
		headerTreatment('#local-forecast-html', fc);
		headerTreatment('#latest-observations-html', cur);
		ribbonTreatment('#hourly-html', fc);
		ribbonTreatment('#hourly-graph-html', fc);
		ribbonTreatment('#extended-forecast-html', fc);
	};

	// Set the Statham label as early as possible — before the app resolves the station.
	relabelStation();
	const relabelBoot = setInterval(relabelStation, 100);
	setTimeout(() => clearInterval(relabelBoot), 15_000);

	// Warm both caches so the first matching request already has data, then keep fresh.
	Promise.all([getCurrent(), getForecast()]).then(([obs, fc]) => {
		console.log(`[tempest] current: ${obs ? 'live' : 'NOAA'} · forecast: ${fc ? 'live' : 'NOAA'}`);
		updateBranding();
	});
	setInterval(() => { Promise.all([getCurrent(), getForecast()]).then(updateBranding); }, POLL_MS);
	setInterval(updateBranding, 3000); // screen elements appear only after each screen first builds
})();
