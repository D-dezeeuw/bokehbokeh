import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  F_STOPS, ISOS, SHUTTERS,
  sunElevation, clearSkyEV, sceneEV, daylightFactor,
  conditionFromWeather, shutterSeconds, snapShutter, pickIso,
  bokehScore, bokehLabel, sunPhase,
  localParts, utcMsAt, fmtTime, parseQuery,
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

test('scales are well-formed', () => {
  assert.equal(F_STOPS.length, 26);
  assert.equal(ISOS[0], 100);
  for (let i = 1; i < SHUTTERS.length; i++) {
    assert.ok(SHUTTERS[i].t < SHUTTERS[i - 1].t, `shutter ladder out of order at ${i}`);
  }
});
