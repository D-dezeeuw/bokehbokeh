import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  F_STOPS, ISOS, SHUTTERS,
  sunElevation, clearSkyEV, sceneEV, daylightFactor,
  conditionFromWeather, shutterSeconds, snapShutter, pickIso,
  bokehScore, bokehLabel, sunPhase,
  localParts, utcMsAt, fmtTime, parseQuery,
  LP_ZONES, LP_CLASSES, classifyLpPixel, trailLimit, astroIso,
  moonPhase, darknessWindow,
} from '../lib.js';

test('sunElevation: high at summer noon, below horizon at midnight (Rotterdam)', () => {
  const noon = Date.UTC(2026, 5, 21, 11, 42); // ~solar noon at 4.5°E
  const midnight = Date.UTC(2026, 5, 21, 23, 42);
  const elevNoon = sunElevation(noon, 51.92, 4.48);
  const elevMidnight = sunElevation(midnight, 51.92, 4.48);
  assert.ok(elevNoon > 58 && elevNoon < 63, `noon elevation ${elevNoon}`);
  assert.ok(elevMidnight < -10, `midnight elevation ${elevMidnight}`);
});

test('sunElevation: near-zenith at equinox noon on the equator', () => {
  const elev = sunElevation(Date.UTC(2026, 2, 20, 12, 8), 0, 0);
  assert.ok(elev > 86, `equinox equator elevation ${elev}`);
});

test('clearSkyEV: hits sunny-16 anchors and is monotonic in elevation', () => {
  assert.equal(clearSkyEV(35), 15);
  assert.equal(clearSkyEV(90), 15.3);
  assert.equal(clearSkyEV(-90), -6);
  let prev = -Infinity;
  for (let e = -90; e <= 90; e += 1) {
    const v = clearSkyEV(e);
    assert.ok(v >= prev, `EV curve dipped at ${e}°`);
    prev = v;
  }
});

test('daylightFactor fades cloud penalty out at night', () => {
  assert.equal(daylightFactor(20), 1);
  assert.equal(daylightFactor(-6), 0);
  assert.equal(sceneEV(-20, 3), clearSkyEV(-20)); // clouds ignored at night
  assert.equal(sceneEV(35, 2), 13); // overcast midday: EV 15 - 2
});

test('sunny 16: EV 15 at f/16 ISO 100 snaps to 1/125', () => {
  const t = shutterSeconds(15, 16, 100);
  assert.ok(Math.abs(t - 1 / 128) < 1e-9);
  assert.equal(snapShutter(t).label, '1/125');
});

test('shutterSeconds: one stop of ISO halves the time', () => {
  const a = shutterSeconds(12, 2.8, 100);
  const b = shutterSeconds(12, 2.8, 200);
  assert.ok(Math.abs(a / b - 2) < 1e-9);
});

test('snapShutter clamps to the ladder ends', () => {
  assert.equal(snapShutter(120).label, '30s');
  assert.equal(snapShutter(1 / 20000).label, '1/8000');
});

test('pickIso keeps shutter handheld-fast, falls back to max ISO', () => {
  assert.equal(pickIso(9, 1.8), 100); // sunset, wide open: base ISO fine
  assert.equal(pickIso(9, 11), 1600); // sunset, stopped down: needs ISO 1600
  assert.equal(pickIso(-5, 2.8), ISOS.at(-1)); // night: even max ISO too slow
});

test('bokehScore spans 100 → 0 across the aperture range', () => {
  assert.equal(bokehScore(F_STOPS[0]), 100);
  assert.equal(bokehScore(F_STOPS.at(-1)), 0);
  assert.equal(bokehScore(2.8), 71);
  assert.equal(bokehLabel(bokehScore(1.4)), 'Creamy');
  assert.equal(bokehLabel(bokehScore(16)), 'Deep focus');
});

test('conditionFromWeather maps WMO codes and cloud cover', () => {
  assert.equal(conditionFromWeather(0, 10), 0); // clear
  assert.equal(conditionFromWeather(2, 40), 1); // partly
  assert.equal(conditionFromWeather(3, 70), 2); // cloudy
  assert.equal(conditionFromWeather(3, 95), 3); // overcast
  assert.equal(conditionFromWeather(61, 100), 4); // rain
  assert.equal(conditionFromWeather(45, 50), 5); // fog
});

test('sunPhase bands', () => {
  assert.equal(sunPhase(30).phase, 'Daylight');
  assert.equal(sunPhase(2).phase, 'Golden hour');
  assert.equal(sunPhase(-5).phase, 'Blue hour');
  assert.equal(sunPhase(-25).phase, 'Night');
});

test('time helpers respect the UTC offset', () => {
  const base = Date.UTC(2026, 6, 19, 22, 30); // 22:30 UTC = 00:30 CEST next day
  const p = localParts(base, 7200);
  assert.equal(p.d, 20);
  assert.equal(p.minutes, 30);
  // 10:00 local on that same local day → 08:00 UTC
  const utc = utcMsAt(7200, base, 0, 600);
  assert.equal(new Date(utc).getUTCHours(), 8);
  assert.equal(new Date(utc).getUTCDate(), 20);
  assert.equal(fmtTime(75), '01:15');
});

test('parseQuery splits city and country', () => {
  assert.deepEqual(parseQuery('Amsterdam, nl'), { name: 'Amsterdam', country: 'NL' });
  assert.deepEqual(parseQuery('Tokyo'), { name: 'Tokyo', country: '' });
});

test('classifyLpPixel maps atlas hues to zones', () => {
  assert.equal(classifyLpPixel(0, 0, 0, 0), 0); // transparent = pristine
  assert.equal(classifyLpPixel(10, 10, 10), 0); // black
  assert.equal(classifyLpPixel(40, 70, 200), 1); // blue
  assert.equal(classifyLpPixel(40, 160, 60), 2); // green
  assert.equal(classifyLpPixel(230, 230, 40), 3); // yellow
  assert.equal(classifyLpPixel(240, 140, 20), 4); // orange
  assert.equal(classifyLpPixel(210, 30, 30), 5); // red
  assert.equal(classifyLpPixel(230, 60, 200), 6); // magenta
  assert.equal(classifyLpPixel(250, 250, 250), 7); // white core
});

test('LP zones are ordered dark → bright and map to classes', () => {
  for (let i = 1; i < LP_ZONES.length; i++) {
    assert.ok(LP_ZONES[i].sqm < LP_ZONES[i - 1].sqm);
    assert.ok(LP_ZONES[i].cls >= LP_ZONES[i - 1].cls);
  }
  assert.equal(LP_CLASSES.length, 5);
});

test('trailLimit follows the 500 rule, capped at 30s', () => {
  assert.equal(trailLimit(20), 25);
  assert.equal(trailLimit(50), 10);
  assert.equal(trailLimit(14), 30);
});

test('astroIso hits the classic astro anchors', () => {
  // Pristine sky, 20mm f/2.8: the textbook 25s / ISO 3200
  assert.equal(astroIso(21.94, 2.8, 25).iso, 3200);
  // Bright metro sky: skyglow saturates fast — base ISO
  assert.equal(astroIso(17.5, 2.8, 25).iso, 100);
  // Pristine sky, slow lens, short telephoto shutter: beyond the ISO ladder
  assert.equal(astroIso(21.94, 4, 6).clipped, true);
});

test('moonPhase: anchor new moon is dark, +14.77d is full', () => {
  const newMoon = Date.UTC(2000, 0, 6, 18, 14);
  assert.ok(moonPhase(newMoon).illum < 2);
  assert.ok(moonPhase(newMoon + 14.765 * 86400000).illum > 98);
});

test('darknessWindow: Dutch midsummer has no astro dark, midwinter does', () => {
  const july = Date.UTC(2026, 6, 19, 12);
  const summer = darknessWindow(7200, july, 0, 51.92, 4.48);
  assert.equal(summer.astro, false);
  assert.ok(summer.deepest > -18 && summer.deepest < -15, `deepest ${summer.deepest}`);
  const jan = Date.UTC(2026, 0, 15, 12);
  const winter = darknessWindow(3600, jan, 0, 51.92, 4.48);
  assert.equal(winter.astro, true);
  assert.ok(winter.from && winter.to);
});

test('scales are well-formed', () => {
  assert.equal(F_STOPS.length, 26);
  assert.equal(ISOS[0], 100);
  for (let i = 1; i < SHUTTERS.length; i++) {
    assert.ok(SHUTTERS[i].t < SHUTTERS[i - 1].t, `shutter ladder out of order at ${i}`);
  }
});
