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

// === Night sky / light pollution ===

/**
 * Light Pollution Atlas zones (David Lorenz, djlorenz.github.io).
 * Zone N+1 is 3× brighter than zone N; artificial = natural sky (LPI 1)
 * at the zone 3/4 (green→yellow) boundary. `sqm` is total zenith sky
 * brightness (mag/arcsec², natural sky 22.0) at each zone's geometric
 * midpoint LPI.
 */
export const LP_ZONES = [
  { hue: 'black', sqm: 21.94, bortle: '1–2', cls: 0 },
  { hue: 'blue', sqm: 21.81, bortle: '3', cls: 1 },
  { hue: 'green', sqm: 21.5, bortle: '4', cls: 1 },
  { hue: 'yellow', sqm: 20.91, bortle: '5', cls: 2 },
  { hue: 'orange', sqm: 20.02, bortle: '6', cls: 3 },
  { hue: 'red', sqm: 18.95, bortle: '7', cls: 3 },
  { hue: 'magenta', sqm: 17.8, bortle: '8', cls: 4 },
  { hue: 'white', sqm: 16.6, bortle: '9', cls: 4 },
];

/** Coarse display classes — also the manual override choices. */
export const LP_CLASSES = [
  { key: 'pristine', label: 'Pristine', icon: '🌌', sqm: 21.95, bortle: '1–2' },
  { key: 'rural', label: 'Rural', icon: '🏞️', sqm: 21.6, bortle: '3–4' },
  { key: 'suburban', label: 'Suburban', icon: '🏘️', sqm: 20.9, bortle: '5' },
  { key: 'city', label: 'City', icon: '🌆', sqm: 19.5, bortle: '6–7' },
  { key: 'metro', label: 'Metro', icon: '🏙️', sqm: 17.5, bortle: '8–9' },
];

/**
 * Map an atlas overlay pixel to an LP_ZONES index. Classified by hue —
 * robust to the a/b lightness sub-shades and edge anti-aliasing.
 * Transparent or near-black pixels mean no measurable light pollution.
 */
export const classifyLpPixel = (r, g, b, a = 255) => {
  if (a < 40) return 0;
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const light = (mx + mn) / 2;
  const sat = mx === mn ? 0 : (mx - mn) / (255 - Math.abs(2 * light - 255));
  if (sat < 0.15) {
    if (light < 64) return 0; // black
    if (light > 200) return 7; // white core
    return 1; // gray-ish → dark rural
  }
  const d = mx - mn;
  let hue;
  if (mx === r) hue = ((g - b) / d + 6) % 6;
  else if (mx === g) hue = (b - r) / d + 2;
  else hue = (r - g) / d + 4;
  hue *= 60;
  if (hue >= 340 || hue < 20) return 5; // red
  if (hue < 52) return 4; // orange
  if (hue < 70) return 3; // yellow
  if (hue < 195) return 2; // green
  if (hue < 280) return 1; // blue
  return 6; // magenta / pink
};

/** Longest trail-free shutter (s) for a full-frame focal length — 500 rule. */
export const trailLimit = (focal) => Math.min(30, Math.round((500 / focal) * 10) / 10);

/**
 * ISO that renders the sky ~3 stops under mid-gray (the classic astro
 * exposure) for a given zenith brightness, aperture and shutter.
 * SQM → luminance: L = 10.8e4 × 10^(-0.4·sqm) cd/m²; EV100 = log2(8L).
 */
export const astroIso = (sqm, N, t) => {
  const L = 108000 * Math.pow(10, -0.4 * sqm);
  const ev = Math.log2(8 * L) + 3;
  const exact = (100 * N * N) / (t * Math.pow(2, ev));
  let best = ISOS[0];
  let bestD = Infinity;
  for (const iso of ISOS) {
    const dist = Math.abs(Math.log2(iso / exact));
    if (dist < bestD) { bestD = dist; best = iso; }
  }
  return { iso: best, clipped: exact > ISOS.at(-1) * 1.4 };
};

/** Moon age (days) and illuminated fraction (%) — anchor: new moon 2000-01-06 18:14 UTC. */
export const moonPhase = (utcMs) => {
  const synodic = 29.530588853;
  const days = (utcMs - Date.UTC(2000, 0, 6, 18, 14)) / 86400000;
  const age = ((days % synodic) + synodic) % synodic;
  const illum = Math.round(((1 - Math.cos((2 * Math.PI * age) / synodic)) / 2) * 100);
  const icons = ['🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘'];
  const icon = icons[Math.round((age / synodic) * 8) % 8];
  return { age, illum, icon };
};

/**
 * Scan the night following the selected day (local noon → next noon)
 * for astronomical darkness (sun ≤ -18°). Falls back to reporting the
 * deepest twilight when the sun never gets that low (midsummer at
 * high latitudes).
 */
export const darknessWindow = (offsetSec, baseUtcMs, dayOffset, lat, lon) => {
  let from = null;
  let to = null;
  let deepest = 90;
  let deepestAt = 720;
  for (let m = 720; m < 2160; m += 10) {
    const e = sunElevation(utcMsAt(offsetSec, baseUtcMs, dayOffset, m), lat, lon);
    if (e < deepest) { deepest = e; deepestAt = m; }
    if (e <= -18) {
      if (from === null) from = m;
      to = m;
    }
  }
  const fmt = (m) => fmtTime(((m % 1440) + 1440) % 1440);
  return {
    astro: from !== null,
    from: from !== null ? fmt(from) : null,
    to: from !== null ? fmt(to) : null,
    deepest: Math.round(deepest * 10) / 10,
    deepestAt: fmt(deepestAt),
  };
};

// === Photo light check ===

/**
 * Pixel statistics for a (downscaled) ImageData-shaped object.
 * All markers are resolution-independent:
 *  - mean:     average luma 0–255
 *  - contrast: luma standard deviation / 128
 *  - warmth:   mean R / mean B (tungsten light ≫ 1, daylight ≈ 1)
 *  - sat:      average HSV-style saturation 0–1
 *  - clipHi/clipLo: % of pixels at the histogram ends
 *  - topRatio: top-30%-of-frame luma vs whole frame (open sky ≫ 1)
 *  - hist:     32-bin luma histogram
 */
export const analyzePixels = ({ data, width, height }) => {
  const n = width * height;
  const topRows = Math.max(1, Math.floor(height * 0.3));
  let sumY = 0;
  let sumY2 = 0;
  let sumR = 0;
  let sumB = 0;
  let sumSat = 0;
  let topSum = 0;
  let topN = 0;
  let hi = 0;
  let lo = 0;
  const hist = new Array(32).fill(0);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const r = data[o];
    const g = data[o + 1];
    const b = data[o + 2];
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    sumY += y;
    sumY2 += y * y;
    sumR += r;
    sumB += b;
    const mx = Math.max(r, g, b);
    sumSat += mx === 0 ? 0 : (mx - Math.min(r, g, b)) / mx;
    if (y > 248) hi++;
    if (y < 8) lo++;
    hist[Math.min(31, y >> 3)]++;
    if (i < topRows * width) {
      topSum += y;
      topN++;
    }
  }
  const mean = sumY / n;
  const std = Math.sqrt(Math.max(0, sumY2 / n - mean * mean));
  const r2 = (x) => Math.round(x * 100) / 100;
  return {
    mean: Math.round(mean),
    contrast: r2(std / 128),
    warmth: r2((sumR + 1) / (sumB + 1)),
    sat: r2(sumSat / n),
    clipHi: Math.round((hi / n) * 1000) / 10,
    clipLo: Math.round((lo / n) * 1000) / 10,
    topRatio: r2(topSum / Math.max(1, topN) / Math.max(1, mean)),
    hist,
  };
};

/**
 * Minimal JPEG EXIF reader for the three exposure tags. Returns
 * {t, N, iso} (missing tags null) or null when there is no parsable
 * EXIF (PNG, HEIC, stripped files).
 */
export const parseExif = (buffer) => {
  try {
    const v = new DataView(buffer);
    if (v.byteLength < 12 || v.getUint16(0) !== 0xffd8) return null;
    let off = 2;
    while (off + 10 < v.byteLength) {
      const marker = v.getUint16(off);
      if ((marker & 0xff00) !== 0xff00) return null;
      const size = v.getUint16(off + 2);
      if (marker === 0xffe1 && v.getUint32(off + 4) === 0x45786966) {
        return parseTiff(v, off + 10);
      }
      if (marker === 0xffda) return null; // start of scan — no EXIF ahead
      off += 2 + size;
    }
  } catch {}
  return null;
};

const parseTiff = (v, base) => {
  const le = v.getUint16(base) === 0x4949; // "II" little-endian
  const u16 = (o) => v.getUint16(base + o, le);
  const u32 = (o) => v.getUint32(base + o, le);
  const rational = (o) => {
    const num = u32(o);
    const den = u32(o + 4);
    return den ? num / den : null;
  };
  const out = {};
  const readIfd = (ifd) => {
    const count = u16(ifd);
    for (let i = 0; i < count; i++) {
      const e = ifd + 2 + i * 12;
      const tag = u16(e);
      const type = u16(e + 2);
      if (tag === 0x8769) out.exifIfd = u32(e + 8); // ExifIFD pointer
      else if (tag === 0x829a && type === 5) out.t = rational(u32(e + 8));
      else if (tag === 0x829d && type === 5) out.N = rational(u32(e + 8));
      else if (tag === 0x8827) out.iso = type === 3 ? u16(e + 8) : u32(e + 8);
    }
  };
  readIfd(u32(4));
  if (out.exifIfd) readIfd(out.exifIfd);
  return out.t || out.N || out.iso
    ? { t: out.t ?? null, N: out.N ?? null, iso: out.iso ?? null }
    : null;
};

/** Scene EV at ISO 100 implied by EXIF exposure values — what the camera
 *  ASSUMED, i.e. only correct if the photo rendered at mid-gray. */
export const exifEV = ({ N, t, iso }) => {
  if (!N || !t || !iso) return null;
  return Math.round(Math.log2((N * N) / (t * (iso / 100))) * 10) / 10;
};

/**
 * How far the photo actually rendered from mid-gray, in stops. The EXIF
 * EV assumes the exposure landed on 18% gray (sRGB luma ≈ 118); a photo
 * that came out darker means the scene had LESS light than the settings
 * imply (dim room the camera couldn't lift), brighter means MORE (beach
 * whites pushing the frame up). Clipped ends hide additional range, so
 * heavy clipping nudges the estimate further. Clamped to ±3 stops so
 * silhouettes and other artistic exposures can't run away.
 */
export const exposureOffset = (mean, clipHi = 0, clipLo = 0) => {
  const lin = Math.pow(Math.max(1, mean) / 255, 2.2); // sRGB → linear (γ2.2)
  let off = Math.log2(lin / 0.18);
  if (clipHi > 8) off += 0.5;
  if (clipLo > 8) off -= 0.5;
  return Math.max(-3, Math.min(3, Math.round(off * 10) / 10));
};

/** Scene classes for the photo light check, with representative EVs. */
export const SCENES = [
  { key: 'sun', icon: '☀️', short: 'Sun', label: 'Outdoors · bright sun', ev: 14.5, tip: 'Hard light and deep shadows — watch for blown highlights.' },
  { key: 'overcast', icon: '⛅', short: 'Overcast', label: 'Outdoors · overcast', ev: 12, tip: 'Soft, even light — flattering for portraits.' },
  { key: 'shade', icon: '🌳', short: 'Shade', label: 'Outdoors · shade / dusk', ev: 9, tip: 'Gentle light that fades fast — keep an eye on your shutter.' },
  { key: 'indoor', icon: '💡', short: 'Indoors', label: 'Indoors · well lit', ev: 6, tip: 'Move close to window light; expect a warm cast from bulbs.' },
  { key: 'dim', icon: '🕯️', short: 'Dim', label: 'Indoors · dim / night', ev: 3, tip: 'Open wide, raise ISO, brace the camera or use a tripod.' },
];

/**
 * Classify a photo into a SCENES index. With an EXIF EV the light level
 * is measured (bands, with color warmth splitting indoor/outdoor at the
 * boundaries). Without EXIF the camera has already normalized exposure,
 * so we judge by look: sky-bright top, cool colors, saturation and
 * clipped highlights vote "outdoors"; a strong warm cast votes indoors.
 */
export const classifyScene = (m, ev = null) => {
  if (ev != null) {
    if (ev >= 13.5) return 0;
    if (ev >= 10.5) return 1;
    if (ev >= 7.5) return (m?.warmth ?? 1) > 1.28 ? 3 : 2;
    if (ev >= 4.5) return (m?.warmth ?? 1.2) < 1.05 ? 2 : 3;
    return 4;
  }
  if (m.mean < 60) return 4;
  let outdoor = 0;
  if (m.topRatio > 1.12) outdoor++;
  if (m.warmth < 1.12) outdoor++;
  if (m.sat > 0.3) outdoor++;
  if (m.clipHi > 1.5) outdoor++;
  if (m.warmth > 1.3) outdoor -= 2;
  if (outdoor >= 2) {
    if (m.contrast >= 0.34 || m.clipHi > 3) return 0;
    if (m.mean >= 115) return 1;
    return 2;
  }
  return m.mean < 95 ? 4 : 3;
};

/**
 * Scene EV implied by a live camera track's reported exposure settings
 * (MediaStreamTrack.getSettings() on supporting devices — mostly Android
 * Chrome). The spec puts exposureTime in 100 µs units, but some
 * implementations report seconds; values ≤ 1 are treated as seconds.
 * Phone apertures aren't exposed, so assume a typical f/1.8 main camera.
 */
export const trackEV = ({ exposureTime, iso } = {}, N = 1.8) => {
  if (!exposureTime || !iso) return null;
  const t = exposureTime > 1 ? exposureTime / 10000 : exposureTime;
  return Math.round(Math.log2((N * N) / (t * (iso / 100))) * 10) / 10;
};

/**
 * How pronounced moving lights streak at a given shutter time, 0–1:
 * frozen at 1/1000 and faster, fully drawn-out streaks at 1/15 and
 * slower. Log-scaled like everything exposure.
 */
export const streakAmount = (t) => {
  const f = (Math.log2(t) - Math.log2(1 / 1000)) / (Math.log2(1 / 15) - Math.log2(1 / 1000));
  return Math.max(0, Math.min(1, Math.round(f * 100) / 100));
};

export const motionLabel = (t) => {
  if (t >= 1 / 15) return 'motion streaks';
  if (t >= 1 / 60) return 'visible motion blur';
  if (t >= 1 / 250) return 'slight motion blur';
  return 'motion frozen';
};

/**
 * Needle angle (degrees, 0 = straight up) for the analog light meter:
 * EV −2 (candle) at −80° through EV 18 (blazing sun) at +80°.
 */
export const meterAngle = (ev) => Math.max(-80, Math.min(80, -80 + (ev + 2) * 8));

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

/** "8s" under a minute, "2:05" above — for the long-exposure countdown. */
export const fmtSeconds = (s) => {
  const v = Math.max(0, Math.round(s));
  if (v < 60) return `${v}s`;
  return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, '0')}`;
};

/** "Amsterdam, NL" → {name, country}; bare "Amsterdam" → country ''. */
export const parseQuery = (raw) => {
  const [name, country = ''] = raw.split(',').map((s) => s.trim());
  return { name, country: country.toUpperCase() };
};
