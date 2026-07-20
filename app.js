import spektrum, {
  setValue, defineFn, watch, bindDOM, run, appState, computed, addAsync,
} from 'spektrum';
import {
  F_STOPS, ISOS, CONDITIONS,
  sunElevation, sceneEV, conditionFromWeather,
  shutterSeconds, snapShutter, pickIso,
  bokehScore, bokehLabel, sunPhase,
  localParts, utcMsAt, fmtTime, parseQuery,
  LP_ZONES, LP_CLASSES, classifyLpPixel, trailLimit, astroIso,
  moonPhase, darknessWindow,
  analyzePixels, parseExif, exifEV, exposureOffset, SCENES, classifyScene,
  meterAngle, trackEV, streakAmount, motionLabel, fmtSeconds,
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

/**
 * Zenith light pollution from David Lorenz's Light Pollution Atlas
 * (djlorenz.github.io), served from GitHub Pages with open CORS. The
 * atlas publishes 1024px tiles on the standard XYZ grid at z 0–6 (its
 * Leaflet overlays use tileSize 1024 with zoomOffset −2, so map zoom 8
 * maps to URL z 6). We read the single pixel under the location off a
 * canvas and classify its color into an atlas zone.
 */
const LP_TILE = (z, x, y) =>
  `https://djlorenz.github.io/astronomy/image_tiles/tiles2024/tile_${z}_${x}_${y}.png`;

const lpZoneAt = async (lat, lon, z) => {
  const n = 2 ** z;
  const xf = ((lon + 180) / 360) * n;
  const latR = (Math.max(-85, Math.min(85, lat)) * Math.PI) / 180;
  const yf = ((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2) * n;
  const x = Math.min(n - 1, Math.max(0, Math.floor(xf)));
  const y = Math.min(n - 1, Math.max(0, Math.floor(yf)));
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.src = LP_TILE(z, x, y);
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const px = Math.min(img.naturalWidth - 1, Math.floor((xf - x) * img.naturalWidth));
  const py = Math.min(img.naturalHeight - 1, Math.floor((yf - y) * img.naturalHeight));
  ctx.drawImage(img, px, py, 1, 1, 0, 0, 1, 1);
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
  return classifyLpPixel(r, g, b, a);
};

const fetchLpZone = async (lat, lon) => {
  try {
    return await lpZoneAt(lat, lon, 6);
  } catch {
    return await lpZoneAt(lat, lon, 4); // coarser fallback
  }
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

const UI_KEY = 'bokehbokeh:ui';
const SCENE_KEY = 'bokehbokeh:scene';

const loadLevel = () => {
  try {
    const v = parseInt(localStorage.getItem(UI_KEY), 10);
    return v >= 0 && v <= 2 ? v : 0;
  } catch { return 0; }
};

const loadScene = () => {
  try {
    const sc = JSON.parse(localStorage.getItem(SCENE_KEY));
    return sc?.markers && sc.ev != null ? sc : null;
  } catch { return null; }
};

const saveScene = (sc) => {
  try {
    if (sc) localStorage.setItem(SCENE_KEY, JSON.stringify(sc));
    else localStorage.removeItem(SCENE_KEY);
  } catch {}
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
setValue('lpZone', null); // atlas zone index once fetched
setValue('lpOverride', -1); // -1 = auto (from atlas)
setValue('focal', 20);
const restoredScene = loadScene();
setValue('scene', restoredScene); // photo light-check result survives refresh
setValue('meteredEV', restoredScene?.ev ?? null);
setValue('sceneError', '');
setValue('live', null); // live viewfinder reading while the camera runs
setValue('ndStops', 0); // 0 / 3 / 6 / 10 = none / ND8 / ND64 / ND1000
setValue('timer', null); // running long-exposure countdown
setValue('uiLevel', loadLevel()); // Basic / Advanced / Expert
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

computed('exposure', ['sun', 'cond', 'apertureIdx', 'isoIdx', 'meteredEV', 'ndStops'], (s) => {
  if (!s.sun) return null;
  const N = F_STOPS[s.apertureIdx ?? 3] ?? 1.8;
  const iso = ISOS[s.isoIdx ?? 0] ?? 100;
  const ev = s.meteredEV ?? Math.round(sceneEV(s.sun.elev, s.cond?.penalty ?? 0) * 10) / 10;
  const nd = s.ndStops ?? 0;
  const exact = shutterSeconds(ev - nd, N, iso);
  const snap = snapShutter(exact);
  const warnings = [];
  if (exact < 1 / 8000) warnings.push('Too bright for 1/8000 — stop down or add an ND filter.');
  if (snap.t >= 1) warnings.push('Tripod territory — handheld shots will blur.');
  else if (snap.t > 1 / 50) warnings.push('Slowish shutter — brace the camera or raise ISO.');
  if (iso >= 6400) warnings.push('High ISO — expect visible noise.');
  return {
    N, iso, ev, nd,
    shutter: snap.label,
    t: snap.t,
    motion: motionLabel(snap.t),
    warning: warnings.join(' '),
  };
});

computed('timerLabel', ['timer'], (s) =>
  (s.timer ? fmtSeconds(Math.ceil(s.timer.left)) : ''));

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

computed('lp', ['lpZone', 'lpOverride'], (s) => {
  const ov = s.lpOverride ?? -1;
  if (ov >= 0) {
    const c = LP_CLASSES[ov];
    return { ...c, auto: false, known: true };
  }
  const zone = s.lpZone;
  if (zone == null) {
    // Auto not available (tile unreachable / no fix yet): assume suburban.
    return { ...LP_CLASSES[2], auto: true, known: false };
  }
  const zi = LP_ZONES[zone];
  const c = LP_CLASSES[zi.cls];
  return { ...c, sqm: zi.sqm, bortle: zi.bortle, auto: true, known: true };
});

computed('astro', ['lp', 'focal', 'place', 'wx.data', 'dayIndex'], (s) => {
  const p = s.place;
  if (p?.lat == null) return null;
  const off = s.wx?.data?.offsetSec ?? browserOffsetSec();
  const day = s.dayIndex ?? 0;
  const focal = s.focal ?? 20;
  const N = 2.8;
  const t = trailLimit(focal);
  const sqm = s.lp?.sqm ?? 20.9;
  const { iso, clipped } = astroIso(sqm, N, t);
  const win = darknessWindow(off, Date.now(), day, p.lat, p.lon);
  // Moon checked at the midnight that follows the selected day.
  const moon = moonPhase(utcMsAt(off, Date.now(), day + 1, 0));
  const darkLine = win.astro
    ? `Dark sky ${win.from}–${win.to}`
    : `No full darkness — deepest ${win.deepest}° at ${win.deepestAt}`;
  const notes = [];
  if (moon.illum >= 60) notes.push(`${moon.icon} Bright moon (${moon.illum}%) washes out faint stars.`);
  if (clipped) notes.push('Needs more than ISO 12800 — use a star tracker or stack frames.');
  if (sqm < 19.3) notes.push('Bright skyglow here — for the Milky Way, head somewhere darker.');
  return {
    shutter: t >= 10 ? `${Math.round(t)}s` : `${t}s`,
    N, iso, darkLine,
    moonIcon: moon.icon,
    moonIllum: moon.illum,
    note: notes.join(' '),
  };
});

computed('liveView', ['live'], (s) => {
  const lv = s.live;
  if (!lv) return null;
  return { ...SCENES[lv.cls], ev: lv.ev, measured: lv.measured };
});

computed('sceneView', ['scene'], (s) => {
  const sc = s.scene;
  if (!sc) return null;
  const c = SCENES[sc.cls];
  return {
    ...c,
    ev: sc.ev,
    exif: sc.exif,
    rawEv: sc.rawEv,
    renderLabel: sc.offset == null ? '' : `${sc.offset >= 0 ? '+' : ''}${sc.offset}`,
    mean: sc.markers.mean,
    contrast: sc.markers.contrast,
    warmth: sc.markers.warmth,
    clipHi: sc.markers.clipHi,
  };
});

// === Presets & auto-solve ===

const PRESET_APERTURE = { bokeh: 1.8, deep: 11 };

/** Scene EV read straight from state — `exposure` may not have
 *  re-derived yet when a watch fires in the same tick pass. A photo-
 *  metered EV overrides the sun/weather model until cleared. */
const currentEV = () =>
  appState.meteredEV ?? sceneEV(appState.sun?.elev ?? 30, appState.cond?.penalty ?? 0);

const applyPreset = (kind) => {
  const N = PRESET_APERTURE[kind];
  if (!N) return;
  setValue('apertureIdx', F_STOPS.indexOf(N));
  setValue('isoIdx', ISOS.indexOf(pickIso(currentEV(), N)));
};

/**
 * Re-solve settings for the current light. In a preset, the preset
 * owns aperture + ISO; in custom mode the aperture is the user's
 * creative choice, so only ISO is solved (auto-ISO, like a camera).
 */
const autoSolve = () => {
  const kind = appState.preset;
  if (kind === 'bokeh' || kind === 'deep') {
    applyPreset(kind);
    return;
  }
  const N = F_STOPS[appState.apertureIdx ?? 3] ?? 1.8;
  setValue('isoIdx', ISOS.indexOf(pickIso(currentEV(), N)));
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

defineFn('setCond', (_el, _state, _delta, value) => {
  setValue('wxOverride', value);
  // Commit so cond (and sun) reflect the new pick, then re-solve the
  // settings for the light under these conditions.
  spektrum.tick();
  autoSolve();
});

defineFn('presetBokeh', () => { setValue('preset', 'bokeh'); applyPreset('bokeh'); });
defineFn('presetDeep', () => { setValue('preset', 'deep'); applyPreset('deep'); });

/** Any manual slider move drops out of preset mode. */
defineFn('unpreset', () => {
  if (appState.preset !== 'custom') setValue('preset', 'custom');
});

defineFn('setLp', (_el, _state, _delta, value) => setValue('lpOverride', value));

// --- Photo light check ---

/** Paint a frame source (image or video), center-cropped square, onto the thumb canvas. */
const drawThumb = (src, sw, sh) => {
  const th = spektrum.refs.sceneThumb;
  if (!th || !src || !sw || !sh) return;
  const s = Math.min(sw, sh);
  th.getContext('2d').drawImage(src, (sw - s) / 2, (sh - s) / 2, s, s, 0, 0, th.width, th.height);
};

const drawHist = (hist) => {
  const hc = spektrum.refs.sceneHist;
  if (!hc || !hist) return;
  const ctx = hc.getContext('2d');
  ctx.clearRect(0, 0, hc.width, hc.height);
  const max = Math.max(...hist, 1);
  const bw = hc.width / hist.length;
  for (let i = 0; i < hist.length; i++) {
    const h = (hist[i] / max) * (hc.height - 3);
    const shade = 60 + Math.round((i / hist.length) * 180);
    ctx.fillStyle = `rgb(${shade + 15}, ${Math.round(shade * 0.75)}, ${Math.round(shade * 0.3)})`;
    ctx.fillRect(i * bw + 0.5, hc.height - h, bw - 1, h);
  }
};

/** Restore the thumb + histogram of a persisted scene after a refresh. */
const restoreScenePreview = (sc) => {
  if (!sc) return;
  drawHist(sc.markers?.hist);
  if (!sc.thumb) return;
  const img = new Image();
  img.src = sc.thumb;
  img.decode().then(() => drawThumb(img, img.naturalWidth, img.naturalHeight)).catch(() => {});
};

defineFn('analyzePhoto', async (el) => {
  const file = el?.files?.[0];
  if (!file) return;
  setValue('sceneError', '');
  try {
    // EXIF says which exposure the camera applied; only combined with
    // how bright the frame actually rendered do we know the scene light.
    let rawEv = null;
    try {
      const exif = parseExif(await file.arrayBuffer());
      if (exif) rawEv = exifEV(exif);
    } catch {}

    const url = URL.createObjectURL(file);
    const img = new Image();
    img.src = url;
    await img.decode();
    // Downscale for analysis — markers are resolution-independent.
    const scale = 96 / Math.max(img.naturalWidth, img.naturalHeight);
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    const markers = analyzePixels(ctx.getImageData(0, 0, w, h));

    // A dark render means less scene light than the settings imply; a
    // bright render (beach whites) means more. Correct the EXIF EV by
    // the rendered offset before classifying.
    let ev = null;
    let offset = null;
    if (rawEv != null) {
      offset = exposureOffset(markers.mean, markers.clipHi, markers.clipLo);
      ev = Math.round((rawEv + offset) * 10) / 10;
    }
    const cls = classifyScene(markers, ev);
    const scene = { cls, ev: ev ?? SCENES[cls].ev, exif: ev != null, rawEv, offset, markers };
    drawThumb(img, img.naturalWidth, img.naturalHeight);
    drawHist(markers.hist);
    URL.revokeObjectURL(url);
    // Persist the whole analysis (incl. the small thumb) so a refresh
    // brings the light check straight back.
    try { scene.thumb = spektrum.refs.sceneThumb?.toDataURL('image/jpeg', 0.72); } catch {}
    setValue('scene', scene);
    setValue('meteredEV', scene.ev);
    saveScene(scene);
    spektrum.tick();
    autoSolve();
  } catch {
    setValue('sceneError', 'Could not read that photo — try a JPG or PNG.');
  }
  el.value = ''; // same file can be re-picked later
});

/** Manual scene correction. A measured (EXIF) EV stays authoritative;
 *  pixel-estimated photos adopt the chosen class's representative EV. */
defineFn('setScene', (_el, _state, _delta, value) => {
  const sc = appState.scene;
  if (!sc) return;
  const next = { ...sc, cls: value, ev: sc.exif ? sc.ev : SCENES[value].ev };
  setValue('scene', next);
  setValue('meteredEV', next.ev);
  saveScene(next);
  spektrum.tick();
  autoSolve();
});

defineFn('clearScene', () => {
  setValue('scene', null);
  setValue('meteredEV', null);
  saveScene(null);
  spektrum.tick();
  autoSolve();
});

defineFn('setLevel', (_el, _state, _delta, value) => setValue('uiLevel', value));

defineFn('setNd', (_el, _state, _delta, value) => setValue('ndStops', value));

// --- Long-exposure countdown timer ---

let timerInterval = 0;
let wakeLock = null;

const releaseWakeLock = () => {
  wakeLock?.release?.().catch(() => {});
  wakeLock = null;
};

const acquireWakeLock = async () => {
  try { wakeLock = await navigator.wakeLock?.request?.('screen'); } catch {}
};

const beep = () => {
  try {
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.connect(gain);
    gain.connect(ac.destination);
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.25, ac.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.7);
    osc.start();
    osc.stop(ac.currentTime + 0.7);
  } catch {}
};

const stopTimer = (finished) => {
  clearInterval(timerInterval);
  timerInterval = 0;
  releaseWakeLock();
  if (appState.timer) setValue('timer', null);
  if (finished) beep();
};

defineFn('startTimer', () => {
  const t = appState.exposure?.t;
  if (!t || t < 1 || timerInterval) return;
  const end = Date.now() + t * 1000;
  setValue('timer', { total: t, left: t });
  acquireWakeLock();
  timerInterval = setInterval(() => {
    const left = (end - Date.now()) / 1000;
    if (left <= 0) {
      stopTimer(true);
      return;
    }
    setValue('timer', { total: t, left });
  }, 100);
});

defineFn('cancelTimer', () => stopTimer(false));

// --- Live viewfinder meter ---

let liveStream = null;
let liveTimer = 0;
let lastLiveMarkers = null;
const liveCanvas = document.createElement('canvas');

const stopLive = () => {
  clearInterval(liveTimer);
  liveTimer = 0;
  liveStream?.getTracks().forEach((t) => t.stop());
  liveStream = null;
  lastLiveMarkers = null;
  const video = spektrum.refs.liveVideo;
  if (video) video.srcObject = null;
  if (appState.live) setValue('live', null);
};

/** Sample the viewfinder ~2×/s through the same pipeline as photos. */
const liveAnalyze = () => {
  const video = spektrum.refs.liveVideo;
  if (!video || !liveStream || video.readyState < 2 || !video.videoWidth) return;
  const scale = 96 / Math.max(video.videoWidth, video.videoHeight);
  const w = Math.max(1, Math.round(video.videoWidth * scale));
  const h = Math.max(1, Math.round(video.videoHeight * scale));
  liveCanvas.width = w;
  liveCanvas.height = h;
  const ctx = liveCanvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(video, 0, 0, w, h);
  const markers = analyzePixels(ctx.getImageData(0, 0, w, h));
  lastLiveMarkers = markers;
  // Android Chrome can report the sensor's actual exposure; combined with
  // the rendered brightness that's a real meter. Elsewhere: look-based.
  let ev = null;
  let measured = false;
  const raw = trackEV(liveStream.getVideoTracks()[0]?.getSettings?.() ?? {});
  if (raw != null) {
    ev = Math.round((raw + exposureOffset(markers.mean, markers.clipHi, markers.clipLo)) * 10) / 10;
    measured = true;
  }
  const cls = classifyScene(markers, ev);
  ev = ev ?? SCENES[cls].ev;
  const prev = appState.live;
  if (!prev || prev.ev !== ev || prev.cls !== cls) {
    setValue('live', { ev, cls, measured });
  }
};

defineFn('startLive', async () => {
  setValue('sceneError', '');
  stopLive();
  try {
    liveStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' },
      audio: false,
    });
    const video = spektrum.refs.liveVideo;
    video.srcObject = liveStream;
    await video.play();
    liveAnalyze();
    if (!appState.live) setValue('live', { ev: appState.exposure?.ev ?? 12, cls: 1, measured: false });
    liveTimer = setInterval(liveAnalyze, 500);
  } catch {
    stopLive();
    setValue('sceneError', 'Camera unavailable — allow access, or use a photo instead.');
  }
});

defineFn('stopLive', stopLive);

/** Freeze the current viewfinder reading into the scene pipeline. */
defineFn('useLiveReading', () => {
  const lv = appState.live;
  const video = spektrum.refs.liveVideo;
  if (!lv || !lastLiveMarkers || !video) return;
  const scene = {
    cls: lv.cls,
    ev: lv.ev,
    exif: lv.measured,
    rawEv: null,
    offset: null,
    markers: lastLiveMarkers,
    live: true,
  };
  drawThumb(video, video.videoWidth, video.videoHeight);
  drawHist(scene.markers.hist);
  try { scene.thumb = spektrum.refs.sceneThumb?.toDataURL('image/jpeg', 0.72); } catch {}
  stopLive();
  setValue('scene', scene);
  setValue('meteredEV', scene.ev);
  saveScene(scene);
  spektrum.tick();
  autoSolve();
});

// The camera has no business running while hidden; the wake lock is
// auto-released on hide, so re-acquire it if a countdown is still going.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopLive();
  else if (timerInterval && !wakeLock) acquireWakeLock();
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

// Light pollution lookup per unique lat/lon. Failure (offline, tile
// missing) leaves lpZone null → the lp computed reports auto-unavailable
// and the manual chips take over.
let lastLpKey = '';
const refreshLp = () => {
  const p = appState.place;
  const k = wxKey(p);
  if (!k || k === lastLpKey) return;
  lastLpKey = k;
  fetchLpZone(p.lat, p.lon)
    .then((zone) => setValue('lpZone', zone))
    .catch(() => setValue('lpZone', null));
};
watch(['place'], refreshLp);

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

// Fresh forecast in (page load with a known location, geolocation
// resolving, or a new city searched) → solve settings for that light.
watch(['wx.data'], () => {
  if (appState.wx?.data) autoSolve();
});

// Aperture drives the bokeh blur everywhere (preview strip + page backdrop).
const paintBokeh = () => {
  document.documentElement.style.setProperty('--bk', String((appState.bokeh?.score ?? 60) / 100));
};
watch(['bokeh'], paintBokeh);

// ISO drives the preview's exposure look: higher ISO lifts brightness
// and fades in sensor grain.
const paintIso = () => {
  const el = spektrum.refs.stage;
  if (!el) return;
  const t = (appState.isoIdx ?? 0) / (ISOS.length - 1);
  el.style.setProperty('--bright', (1 + t * 0.5).toFixed(3));
  el.style.setProperty('--noise', (t * t * 0.55).toFixed(3));
};
watch(['isoIdx'], paintIso);

// Interface level: a class on the card root drives which sections CSS
// shows (`.adv` at Advanced+, `.exp` at Expert). Persisted per device.
const paintLevel = () => {
  const card = spektrum.refs.card;
  const lvl = appState.uiLevel ?? 0;
  if (card) {
    card.classList.remove('level-0', 'level-1', 'level-2');
    card.classList.add(`level-${lvl}`);
  }
  if (lvl === 0) stopLive(); // Basic hides the viewfinder — release the camera
  try { localStorage.setItem(UI_KEY, String(lvl)); } catch {}
};
watch(['uiLevel'], paintLevel);

// The analog meter needle follows the active scene EV — the sun/weather
// model normally, the photo measurement while one is loaded.
const paintMeter = () => {
  const el = spektrum.refs.meterNeedle;
  if (!el) return;
  const ev = appState.live?.ev ?? appState.exposure?.ev;
  el.style.transform = `rotate(${meterAngle(ev ?? -2)}deg)`;
};
watch(['exposure', 'live'], paintMeter);

// Shutter speed draws the preview's moving lights out into streaks —
// the third leg of the exposure triangle next to blur (--bk) and grain.
const paintStreak = () => {
  const el = spektrum.refs.stage;
  if (!el) return;
  el.style.setProperty('--mb', String(streakAmount(appState.exposure?.t ?? 1 / 250)));
};
watch(['exposure'], paintStreak);

// Countdown progress bar drains with the running exposure.
const paintTimer = () => {
  const el = spektrum.refs.timerFill;
  const t = appState.timer;
  if (el && t?.total) el.style.width = `${Math.max(0, (t.left / t.total) * 100)}%`;
};
watch(['timer'], paintTimer);

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
paintIso();
paintMeter();
paintStreak();
paintLevel();
restoreScenePreview(restoredScene);
refreshLp(); // restored place doesn't fire the place watch

// First visit: ask the browser for a location. Return visits reuse the
// saved place (the 📍 button re-asks at any time).
if (!restored) tryGeolocate();
