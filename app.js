import spektrum, {
  setValue, defineFn, watch, bindDOM, run, appState, computed, addAsync,
} from 'spektrum';
import {
  F_STOPS, ISOS, CONDITIONS,
  sunElevation, sceneEV, conditionFromWeather,
  shutterSeconds, snapShutter, pickIso,
  bokehScore, bokehLabel, sunPhase,
  localParts, utcMsAt, fmtTime, parseQuery,
} from './lib.js';

// === External services ===

const geocode = async ({ name, country }) => {
  const url = new URL('https://geocoding-api.open-meteo.com/v1/search');
  url.searchParams.set('name', name);
  url.searchParams.set('count', '5');
  url.searchParams.set('language', 'en');
  url.searchParams.set('format', 'json');
  const res = await fetch(url);
  if (!res.ok) throw new Error('Geocoding failed');
  const { results } = await res.json();
  if (!results || results.length === 0) throw new Error(`No matches for "${name}"`);
  if (country) {
    const filtered = results.filter((r) => r.country_code === country);
    if (filtered.length) return filtered[0];
  }
  return results[0];
};

/** addAsync fn: reads `place` from state, returns 48h of sky data. */
const buildWeather = async () => {
  const p = appState.place;
  if (p?.lat == null) return null;
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', p.lat);
  url.searchParams.set('longitude', p.lon);
  url.searchParams.set('hourly', 'cloud_cover,weather_code,temperature_2m');
  url.searchParams.set('daily', 'sunrise,sunset');
  url.searchParams.set('timezone', 'auto');
  url.searchParams.set('forecast_days', '2');
  const res = await fetch(url);
  if (!res.ok) throw new Error('Weather fetch failed');
  const data = await res.json();
  return {
    offsetSec: data.utc_offset_seconds,
    cloud: data.hourly.cloud_cover,
    code: data.hourly.weather_code,
    temp: data.hourly.temperature_2m,
    sunrise: data.daily.sunrise,
    sunset: data.daily.sunset,
  };
};

// === Place persistence ===

const PLACE_KEY = 'bokehbokeh:place';

const loadPlace = () => {
  try {
    const p = JSON.parse(localStorage.getItem(PLACE_KEY));
    return p?.lat != null ? p : null;
  } catch { return null; }
};

const savePlace = (p) => {
  if (p?.lat == null) return;
  try { localStorage.setItem(PLACE_KEY, JSON.stringify(p)); } catch {}
};

/** Browser-timezone offset fallback until weather tells us the location's. */
const browserOffsetSec = () => -new Date().getTimezoneOffset() * 60;

const offsetSec = () => appState.wx?.data?.offsetSec ?? browserOffsetSec();

const nowMinutes = (off) => Math.min(1425, Math.round(localParts(Date.now(), off).minutes / 15) * 15);

// === Initial state ===

const restored = loadPlace();
setValue('place', restored);
setValue('dayIndex', 0);
setValue('timeMinutes', nowMinutes(browserOffsetSec()));
setValue('apertureIdx', F_STOPS.indexOf(1.8));
setValue('isoIdx', 0);
setValue('wxOverride', -1); // -1 = auto (from forecast)
setValue('preset', 'bokeh');
setValue('geoStatus', 'idle');
setValue('searchError', '');
spektrum.tick();

// addAsync owns `wx.{loading,data,error}` and auto-runs once on registration.
const refetchWx = addAsync('wx', buildWeather);
const wxKey = (p) => (p?.lat != null ? `${p.lat},${p.lon}` : '');
let lastWxKey = wxKey(restored);

// === Derived state ===

computed('wxLoading', ['wx.loading'], (s) => s.wx?.loading ?? false);
computed('wxError', ['wx.error'], (s) => s.wx?.error ?? null);

computed('cond', ['wx.data', 'dayIndex', 'timeMinutes', 'wxOverride'], (s) => {
  const ov = s.wxOverride ?? -1;
  if (ov >= 0) return { ...CONDITIONS[ov], auto: false, temp: null, cloud: null };
  const d = s.wx?.data;
  const i = (s.dayIndex ?? 0) * 24 + Math.floor((s.timeMinutes ?? 720) / 60);
  if (!d || d.code?.[i] == null) {
    return { ...CONDITIONS[0], auto: true, temp: null, cloud: null };
  }
  const ci = conditionFromWeather(d.code[i], d.cloud[i]);
  return {
    ...CONDITIONS[ci],
    auto: true,
    temp: Math.round(d.temp[i]),
    cloud: Math.round(d.cloud[i]),
  };
});

computed('sun', ['place', 'wx.data', 'dayIndex', 'timeMinutes'], (s) => {
  const p = s.place;
  if (p?.lat == null) return null;
  const off = s.wx?.data?.offsetSec ?? browserOffsetSec();
  const utc = utcMsAt(off, Date.now(), s.dayIndex ?? 0, s.timeMinutes ?? 720);
  const elev = sunElevation(utc, p.lat, p.lon);
  return { elev: Math.round(elev * 10) / 10, ...sunPhase(elev) };
});

computed('exposure', ['sun', 'cond', 'apertureIdx', 'isoIdx'], (s) => {
  if (!s.sun) return null;
  const N = F_STOPS[s.apertureIdx ?? 3] ?? 1.8;
  const iso = ISOS[s.isoIdx ?? 0] ?? 100;
  const ev = Math.round(sceneEV(s.sun.elev, s.cond?.penalty ?? 0) * 10) / 10;
  const exact = shutterSeconds(ev, N, iso);
  const snap = snapShutter(exact);
  const warnings = [];
  if (exact < 1 / 8000) warnings.push('Too bright for 1/8000 — stop down or add an ND filter.');
  if (snap.t >= 1) warnings.push('Tripod territory — handheld shots will blur.');
  else if (snap.t > 1 / 50) warnings.push('Slowish shutter — brace the camera or raise ISO.');
  if (iso >= 6400) warnings.push('High ISO — expect visible noise.');
  return { N, iso, ev, shutter: snap.label, warning: warnings.join(' ') };
});

computed('bokeh', ['apertureIdx'], (s) => {
  const score = bokehScore(F_STOPS[s.apertureIdx ?? 3] ?? 1.8);
  return { score, label: bokehLabel(score) };
});

computed('timeLabel', ['timeMinutes'], (s) => fmtTime(s.timeMinutes ?? 720));

computed('dateLabel', ['wx.data', 'dayIndex'], (s) => {
  const off = s.wx?.data?.offsetSec ?? browserOffsetSec();
  const utc = utcMsAt(off, Date.now(), s.dayIndex ?? 0, 720);
  return new Date(utc + off * 1000).toLocaleDateString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC',
  });
});

computed('sunTimes', ['wx.data', 'dayIndex'], (s) => {
  const d = s.wx?.data;
  const i = s.dayIndex ?? 0;
  const rise = d?.sunrise?.[i]?.slice(11, 16) ?? '';
  const set = d?.sunset?.[i]?.slice(11, 16) ?? '';
  const toPct = (hm) =>
    hm ? `${(((+hm.slice(0, 2)) * 60 + (+hm.slice(3, 5))) / 1440 * 100).toFixed(1)}%` : null;
  return { rise, set, risePct: toPct(rise), setPct: toPct(set) };
});

// === Presets ===

const PRESET_APERTURE = { bokeh: 1.8, deep: 11 };

const applyPreset = (kind) => {
  const N = PRESET_APERTURE[kind];
  if (!N) return;
  const ev = appState.exposure?.ev ?? 12;
  setValue('apertureIdx', F_STOPS.indexOf(N));
  setValue('isoIdx', ISOS.indexOf(pickIso(ev, N)));
};

// === Actions ===

const tryGeolocate = () => {
  if (!navigator.geolocation) {
    setValue('geoStatus', 'denied');
    return;
  }
  setValue('geoStatus', 'asking');
  navigator.geolocation.getCurrentPosition(
    async ({ coords }) => {
      const lat = +coords.latitude.toFixed(4);
      const lon = +coords.longitude.toFixed(4);
      const label = `${Math.abs(lat)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon)}°${lon >= 0 ? 'E' : 'W'}`;
      setValue('place', { name: label, country: '', lat, lon });
      setValue('geoStatus', 'ok');
      // Best-effort reverse geocode for a friendly name; lat/lon are
      // unchanged so this never triggers a second weather fetch.
      try {
        const res = await fetch(
          `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`,
        );
        if (res.ok) {
          const d = await res.json();
          const name = d.city || d.locality || d.principalSubdivision;
          if (name) setValue('place', { name, country: d.countryCode || '', lat, lon });
        }
      } catch {}
    },
    () => {
      setValue('geoStatus', 'denied');
      if (appState.place?.lat == null) {
        setValue('place', { name: 'Rotterdam', country: 'NL', lat: 51.9244, lon: 4.4777 });
      }
    },
    { timeout: 8000, maximumAge: 600000 },
  );
};

defineFn('useMyLocation', tryGeolocate);

defineFn('searchCity', async () => {
  const input = spektrum.refs.searchInput;
  const raw = (input?.value || '').trim();
  if (!raw) return;
  setValue('searchError', '');
  try {
    const hit = await geocode(parseQuery(raw));
    setValue('place', {
      name: hit.name,
      country: hit.country_code || '',
      lat: hit.latitude,
      lon: hit.longitude,
    });
    setValue('geoStatus', 'ok');
  } catch (err) {
    setValue('searchError', err.message || 'Search failed');
  }
});

defineFn('selectDay', (_el, _state, _delta, value) => setValue('dayIndex', value));

defineFn('setNow', () => {
  setValue('dayIndex', 0);
  setValue('timeMinutes', nowMinutes(offsetSec()));
});

defineFn('setCond', (_el, _state, _delta, value) => setValue('wxOverride', value));

defineFn('presetBokeh', () => { setValue('preset', 'bokeh'); applyPreset('bokeh'); });
defineFn('presetDeep', () => { setValue('preset', 'deep'); applyPreset('deep'); });

/** Any manual slider move drops out of preset mode. */
defineFn('unpreset', () => {
  if (appState.preset !== 'custom') setValue('preset', 'custom');
});

defineFn('retryWx', () => refetchWx?.());

// === Watches ===

watch(['place'], () => {
  const p = appState.place;
  savePlace(p);
  const k = wxKey(p);
  if (k && k !== lastWxKey) {
    lastWxKey = k;
    refetchWx();
  }
});

// Keep the search box mirroring the resolved place (unless the user is typing).
watch(['place'], () => {
  const input = spektrum.refs.searchInput;
  const p = appState.place;
  if (!input || !p?.name || document.activeElement === input) return;
  input.value = p.country ? `${p.name}, ${p.country}` : p.name;
});

// While a preset is active, light changes (time scrub, weather, day flip)
// re-solve ISO so the look survives the new EV.
watch(['sun', 'cond'], () => {
  const p = appState.preset;
  if (p === 'bokeh' || p === 'deep') applyPreset(p);
});

// Aperture drives the bokeh blur everywhere (preview strip + page backdrop).
const paintBokeh = () => {
  document.documentElement.style.setProperty('--bk', String((appState.bokeh?.score ?? 60) / 100));
};
watch(['bokeh'], paintBokeh);

// Sunrise/sunset shift the day-gradient on the time slider track.
const paintSunTrack = () => {
  const el = spektrum.refs.timeCtl;
  const st = appState.sunTimes;
  if (!el || !st?.risePct) return;
  el.style.setProperty('--rise', st.risePct);
  el.style.setProperty('--set', st.setPct);
};
watch(['sunTimes'], paintSunTrack);

// === Boot ===

bindDOM();
run();
paintBokeh();
paintSunTrack();

// First visit: ask the browser for a location. Return visits reuse the
// saved place (the 📍 button re-asks at any time).
if (!restored) tryGeolocate();
