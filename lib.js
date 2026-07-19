/*
  bokehbokeh — pure calculation library.

  Everything here is side-effect free: solar position, a clear-sky
  exposure-value model, weather → light-loss mapping, and standard
  camera math (f-stops, ISO, shutter snapping). app.js wires these
  into spektrum state; test/lib.test.js exercises them directly.
*/

const RAD = Math.PI / 180;

// === Camera scales ===

/** Aperture third-stops, wide → narrow. */
export const F_STOPS = [
  1.2, 1.4, 1.6, 1.8, 2, 2.2, 2.5, 2.8, 3.2, 3.5, 4, 4.5, 5,
  5.6, 6.3, 7.1, 8, 9, 10, 11, 13, 14, 16, 18, 20, 22,
];

/** ISO full stops. */
export const ISOS = [100, 200, 400, 800, 1600, 3200, 6400, 12800];

/** Standard shutter speeds (seconds), slow → fast, third-stop ladder. */
const SLOW = [30, 25, 20, 15, 13, 10, 8, 6, 5, 4, 3.2, 2.5, 2, 1.6, 1.3, 1, 0.8, 0.6, 0.5, 0.4, 0.3];
const DENOMS = [
  4, 5, 6, 8, 10, 13, 15, 20, 25, 30, 40, 50, 60, 80, 100, 125, 160, 200,
  250, 320, 400, 500, 640, 800, 1000, 1250, 1600, 2000, 2500, 3200, 4000,
  5000, 6400, 8000,
];
export const SHUTTERS = [
  ...SLOW.map((t) => ({ t, label: `${t}s` })),
  ...DENOMS.map((d) => ({ t: 1 / d, label: `1/${d}` })),
];

// === Solar position ===

/**
 * Sun elevation in degrees for a UTC timestamp (ms) at lat/lon.
 * Low-precision NOAA-style algorithm — accurate to well under a
 * degree, which is far tighter than any exposure decision needs.
 */
export const sunElevation = (utcMs, lat, lon) => {
  const n = utcMs / 86400000 - 10957.5; // days since J2000.0
  const L = (280.46 + 0.9856474 * n) % 360; // mean longitude
  const g = ((357.528 + 0.9856003 * n) % 360) * RAD; // mean anomaly
  const lambda = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD;
  const eps = (23.439 - 0.0000004 * n) * RAD; // obliquity
  const sinDec = Math.sin(eps) * Math.sin(lambda);
  const dec = Math.asin(sinDec);
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
  const gmst = (280.46061837 + 360.98564736629 * n) % 360;
  const ha = (gmst + lon) * RAD - ra; // hour angle
  const latR = lat * RAD;
  const sinAlt = Math.sin(latR) * sinDec + Math.cos(latR) * Math.cos(dec) * Math.cos(ha);
  return Math.asin(sinAlt) / RAD;
};

// === Light model ===

/**
 * Clear-sky scene EV at ISO 100 as a function of sun elevation.
 * Anchors: sunny-16 midday (EV 15), golden hour ~11, sunset ambient
 * ~9, blue hour 5–9, astronomical night ~-6. Piecewise-linear.
 */
const EV_CURVE = [
  [-90, -6], [-18, -5], [-12, -3], [-6, 1], [-3, 5], [0, 9],
  [5, 11.5], [10, 12.5], [20, 14], [35, 15], [90, 15.3],
];

export const clearSkyEV = (elev) => {
  if (elev <= EV_CURVE[0][0]) return EV_CURVE[0][1];
  for (let i = 1; i < EV_CURVE.length; i++) {
    const [x1, y1] = EV_CURVE[i - 1];
    const [x2, y2] = EV_CURVE[i];
    if (elev <= x2) return y1 + ((elev - x1) / (x2 - x1)) * (y2 - y1);
  }
  return EV_CURVE.at(-1)[1];
};

/** Manual/auto weather conditions with light loss in stops. */
export const CONDITIONS = [
  { key: 'clear', label: 'Clear', icon: '☀️', penalty: 0 },
  { key: 'partly', label: 'Partly', icon: '🌤️', penalty: 0.7 },
  { key: 'mostly', label: 'Cloudy', icon: '⛅', penalty: 1.3 },
  { key: 'overcast', label: 'Overcast', icon: '☁️', penalty: 2 },
  { key: 'rain', label: 'Rain', icon: '🌧️', penalty: 3 },
  { key: 'fog', label: 'Fog', icon: '🌫️', penalty: 2.5 },
];

/** Map an Open-Meteo WMO weather code + cloud cover % to a CONDITIONS index. */
export const conditionFromWeather = (code, cloud) => {
  if (code >= 45 && code <= 48) return 5; // fog
  if (code >= 51) return 4; // drizzle, rain, snow, showers, thunder
  if (cloud == null) return 0;
  if (cloud < 25) return 0;
  if (cloud < 50) return 1;
  if (cloud < 85) return 2;
  return 3;
};

/**
 * Clouds only steal light while the sun contributes any — fade the
 * penalty in across the twilight band so night EV isn't punished.
 */
export const daylightFactor = (elev) => Math.min(1, Math.max(0, (elev + 6) / 12));

/** Scene EV at ISO 100 for a sun elevation + condition penalty (stops). */
export const sceneEV = (elev, penalty) => clearSkyEV(elev) - penalty * daylightFactor(elev);

// === Exposure math ===

/** Required shutter time (s) for scene EV100, aperture N, ISO. */
export const shutterSeconds = (ev100, N, iso) =>
  (N * N) / Math.pow(2, ev100 + Math.log2(iso / 100));

/** Nearest standard shutter speed (by stop distance), clamped to the ladder. */
export const snapShutter = (t) => {
  let best = SHUTTERS[0];
  let bestD = Infinity;
  for (const s of SHUTTERS) {
    const d = Math.abs(Math.log2(s.t / t));
    if (d < bestD) { bestD = d; best = s; }
  }
  return best;
};

/**
 * Lowest ISO that keeps the shutter at or faster than maxT
 * (default 1/60 — the classic handheld threshold). Falls back to the
 * highest ISO when even that can't get there.
 */
export const pickIso = (ev100, N, maxT = 1 / 60) => {
  for (const iso of ISOS) {
    if (shutterSeconds(ev100, N, iso) <= maxT) return iso;
  }
  return ISOS.at(-1);
};

/** 0 (everything sharp, f/22) → 100 (max background blur, f/1.2). */
export const bokehScore = (N) =>
  Math.round((100 * Math.log2(F_STOPS.at(-1) / N)) / Math.log2(F_STOPS.at(-1) / F_STOPS[0]));

export const bokehLabel = (score) => {
  if (score >= 80) return 'Creamy';
  if (score >= 60) return 'Strong';
  if (score >= 40) return 'Moderate';
  if (score >= 20) return 'Subtle';
  return 'Deep focus';
};

export const sunPhase = (elev) => {
  if (elev >= 6) return { phase: 'Daylight', phaseIcon: '🌞' };
  if (elev >= -4) return { phase: 'Golden hour', phaseIcon: '🌅' };
  if (elev >= -6) return { phase: 'Blue hour', phaseIcon: '🌆' };
  if (elev >= -12) return { phase: 'Twilight', phaseIcon: '🌇' };
  if (elev >= -18) return { phase: 'Astro twilight', phaseIcon: '🌌' };
  return { phase: 'Night', phaseIcon: '🌙' };
};

// === Time helpers ===

/** Break a UTC timestamp into wall-clock parts at a UTC offset (seconds). */
export const localParts = (utcMs, offsetSec) => {
  const d = new Date(utcMs + offsetSec * 1000);
  return {
    y: d.getUTCFullYear(),
    m: d.getUTCMonth(),
    d: d.getUTCDate(),
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
  };
};

/**
 * UTC timestamp for "day of baseUtcMs at the location, plus dayOffset
 * days, at `minutes` past local midnight".
 */
export const utcMsAt = (offsetSec, baseUtcMs, dayOffset, minutes) => {
  const p = localParts(baseUtcMs, offsetSec);
  return Date.UTC(p.y, p.m, p.d + dayOffset, 0, minutes) - offsetSec * 1000;
};

export const fmtTime = (minutes) =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/** "Amsterdam, NL" → {name, country}; bare "Amsterdam" → country ''. */
export const parseQuery = (raw) => {
  const [name, country = ''] = raw.split(',').map((s) => s.trim());
  return { name, country: country.toUpperCase() };
};
