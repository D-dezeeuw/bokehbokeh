# BokehBokeh 📷✨

**The right camera settings for your light, instantly.**

A fully client-side web app that calculates shutter speed, aperture and ISO
from your location, the time of day and the weather — with interactive
sliders and one-tap presets for maximum or minimum bokeh.

## How it works

1. **Location** — asks the browser for your position (or search any city
   manually, e.g. `Amsterdam, NL`).
2. **Light model** — computes the sun's elevation for the selected time and
   maps it to a scene exposure value (EV at ISO 100): sunny-16 at midday,
   through golden hour, blue hour and twilight down to night.
3. **Weather** — fetches cloud cover and conditions from
   [Open-Meteo](https://open-meteo.com) (48 h, no API key) and subtracts the
   light the clouds steal. A manual override row works offline too.
4. **Exposure** — you pick the look with the aperture/ISO sliders or the
   **Max bokeh** (f/1.8) / **Deep focus** (f/11) presets; the app solves the
   shutter speed and warns about handheld blur, ND-filter territory and
   high-ISO noise. While a preset is active, ISO re-solves automatically as
   you scrub through the day.

Everything runs in the browser — no build step, no backend, no keys.
Templating/reactivity by [Spektrum](https://www.npmjs.com/package/spektrum)
straight from the CDN.

## Running locally

```sh
npm start        # serves the app at http://localhost:3000
npm test         # unit tests for the exposure/solar math (node --test)
```

Or open `index.html` with any static file server.

## Hosting on GitHub Pages

Live at **<https://d-dezeeuw.github.io/bokehbokeh/>**.

The app is a single `index.html` at the repo root with relative asset
paths. Every push to `main` runs the tests and then mirrors `main` to the
`gh-pages` branch (`.github/workflows/pages.yml`), which GitHub Pages
serves.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | UI — Spektrum templates, no build step |
| `styles.css` | Warm dark theme; bokeh blur is driven by one `--bk` CSS var |
| `app.js` | State wiring: geolocation, weather fetch, presets, watches |
| `lib.js` | Pure math: solar position, EV model, f-stop/ISO/shutter ladders |
| `test/lib.test.js` | Unit tests for `lib.js` |

## Credits

Weather & geocoding by [Open-Meteo](https://open-meteo.com) · reverse
geocoding by [BigDataCloud](https://www.bigdatacloud.com) · reactive engine
[Spektrum](https://www.npmjs.com/package/spektrum).
